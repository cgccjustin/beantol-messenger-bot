/**
 * Persistent chat history backed by Google Sheets.
 *
 * Design:
 *  - In-memory Map is the primary read/write path (fast, no latency).
 *  - Google Sheet "ChatHistory" tab is the persistence layer (survives restarts).
 *  - On first message from a sender each server lifetime → warm cache from sheet (one API call).
 *  - After each exchange → async debounced write to sheet (non-blocking, 8s debounce).
 *  - TTL: rows older than CHAT_HISTORY_TTL_HOURS are ignored on load.
 *  - Max messages kept: CHAT_HISTORY_MAX_MESSAGES (default 20).
 */

const { google } = require("googleapis");
const { getGoogleAuth, hasGoogleCredentials } = require("./google-auth");
const { getLeadsSheetId, getChatHistorySheetTab } = require("./tenant-google");
const { scopeKey } = require("./tenant-context");

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const MAX_MESSAGES = Number(process.env.CHAT_HISTORY_MAX_MESSAGES || 20);
const TTL_MS = Number(process.env.CHAT_HISTORY_TTL_HOURS || 24) * 60 * 60 * 1000;
const SAVE_DEBOUNCE_MS = Number(process.env.CHAT_HISTORY_SAVE_DEBOUNCE_MS || 8000);

const HEADERS = ["SenderKey", "LastUpdated", "HistoryJSON"];
const COL = { SENDER_KEY: 0, LAST_UPDATED: 1, HISTORY_JSON: 2 };

/** In-memory cache: senderKey → { messages[], updatedAt } */
const cache = new Map();

/** Sheet row index: senderKey → 1-based row number */
const rowIndex = new Map();

/** Senders whose history has been loaded from sheet this server lifetime */
const warmedKeys = new Set();

/** Pending debounced saves: senderKey → timeout handle */
const pendingSaves = new Map();

function isConfigured() {
  return Boolean(getLeadsSheetId() && hasGoogleCredentials());
}

async function getSheetsClient() {
  const auth = getGoogleAuth([SHEETS_SCOPE]);
  return google.sheets({ version: "v4", auth });
}

async function ensureTab(sheets, spreadsheetId, tabName) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties.title",
  });
  const titles = (meta.data.sheets || []).map((s) => s.properties?.title);
  if (titles.includes(tabName)) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tabName}!A1:C1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });
  console.log(`ChatHistory: tab "${tabName}" created in Google Sheet`);
}

async function readAllRows(sheets, spreadsheetId, tab) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A:C`,
  });
  return res.data.values || [];
}

function parseMessages(json) {
  try {
    const arr = JSON.parse(json || "[]");
    if (!Array.isArray(arr)) return [];
    return sanitizeMessagesForOpenAi(arr);
  } catch {
    return [];
  }
}

/** OpenAI rejects null/non-string content — normalize rows from sheet or cache. */
function normalizeMessageContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content.trim();
  if (typeof content === "number" || typeof content === "boolean") {
    return String(content).trim();
  }
  return "";
}

function sanitizeMessagesForOpenAi(messages) {
  const validRoles = new Set(["user", "assistant"]);
  return (messages || [])
    .map((m) => {
      if (!m || !validRoles.has(m.role)) return null;
      const content = normalizeMessageContent(m.content);
      if (!content) return null;
      return { role: m.role, content };
    })
    .filter(Boolean);
}

/**
 * Load all rows from sheet once, warm rowIndex and optionally the target sender's cache.
 * Called once per sender per server lifetime.
 */
async function warmFromSheet(senderKey) {
  if (!isConfigured() || warmedKeys.has(senderKey)) return;
  warmedKeys.add(senderKey);

  try {
    const spreadsheetId = getLeadsSheetId();
    const tab = getChatHistorySheetTab();
    const sheets = await getSheetsClient();
    await ensureTab(sheets, spreadsheetId, tab);
    const rows = await readAllRows(sheets, spreadsheetId, tab);

    for (let i = 1; i < rows.length; i++) {
      const key = rows[i]?.[COL.SENDER_KEY];
      if (key) rowIndex.set(key, i + 1);
    }

    const rowIdx = rows.findIndex((r, i) => i > 0 && r?.[COL.SENDER_KEY] === senderKey);
    if (rowIdx < 0) return;

    const row = rows[rowIdx];
    const lastUpdated = new Date(row[COL.LAST_UPDATED] || 0).getTime();
    if (Number.isNaN(lastUpdated) || Date.now() - lastUpdated > TTL_MS) return;

    if (!cache.has(senderKey)) {
      const messages = parseMessages(row[COL.HISTORY_JSON]);
      cache.set(senderKey, { messages, updatedAt: lastUpdated });
      if (messages.length) {
        console.log(`ChatHistory: restored ${messages.length} msgs for ${senderKey}`);
      }
    }
  } catch (err) {
    console.error("ChatHistory: warmFromSheet error:", err.message);
  }
}

async function flushToSheet(senderKey) {
  pendingSaves.delete(senderKey);
  if (!isConfigured()) return;

  const entry = cache.get(senderKey);
  if (!entry || !entry.messages.length) return;

  try {
    const spreadsheetId = getLeadsSheetId();
    const tab = getChatHistorySheetTab();
    const sheets = await getSheetsClient();
    await ensureTab(sheets, spreadsheetId, tab);

    const now = new Date().toISOString();
    const historyJson = JSON.stringify(entry.messages);
    const rowValues = [senderKey, now, historyJson];

    const existing = rowIndex.get(senderKey);
    if (existing) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${tab}!A${existing}:C${existing}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [rowValues] },
      });
    } else {
      const res = await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${tab}!A:C`,
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [rowValues] },
      });
      const updatedRange = res.data.updates?.updatedRange || "";
      const match = updatedRange.match(/!A(\d+)/);
      if (match) rowIndex.set(senderKey, Number(match[1]));
    }
  } catch (err) {
    console.error("ChatHistory: flushToSheet error:", err.message);
  }
}

function scheduleSave(senderKey) {
  if (pendingSaves.has(senderKey)) clearTimeout(pendingSaves.get(senderKey));
  const t = setTimeout(() => flushToSheet(senderKey), SAVE_DEBOUNCE_MS);
  pendingSaves.set(senderKey, t);
}

// ─── Public API (mirrors existing server.js interface exactly) ──────────────

/**
 * Call this at the very start of handleMessage, before getChatHistory.
 * Warms the in-memory cache from sheet if not already loaded this server lifetime.
 * Non-blocking if already warmed (resolves immediately).
 */
async function prewarmHistory(senderId, timeoutMs = 6000) {
  const key = scopeKey(senderId);
  if (warmedKeys.has(key)) return;

  let timeoutId;
  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([warmFromSheet(key), timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Returns the cached messages for this sender (sync, fast).
 * Always call prewarmHistory first on new messages.
 */
function getChatHistory(senderId) {
  const key = scopeKey(senderId);
  const entry = cache.get(key);
  if (!entry) return [];
  if (Date.now() - entry.updatedAt > TTL_MS) {
    cache.delete(key);
    return [];
  }
  return sanitizeMessagesForOpenAi(entry.messages);
}

/**
 * Appends a user/assistant exchange to in-memory cache and schedules a sheet write.
 */
function appendChatHistory(senderId, userText, assistantReply) {
  const key = scopeKey(senderId);
  let entry = cache.get(key);
  if (!entry) entry = { messages: [], updatedAt: Date.now() };

  const user = String(userText || "").trim();
  const assistant = String(assistantReply || "").trim();
  if (user) entry.messages.push({ role: "user", content: user });
  if (assistant) entry.messages.push({ role: "assistant", content: assistant });
  if (entry.messages.length > MAX_MESSAGES) {
    entry.messages = entry.messages.slice(-MAX_MESSAGES);
  }
  entry.updatedAt = Date.now();
  cache.set(key, entry);
  scheduleSave(key);
}

/**
 * Clear history for a sender (e.g. on explicit reset).
 */
function clearChatHistory(senderId) {
  const key = scopeKey(senderId);
  cache.delete(key);
}

module.exports = {
  prewarmHistory,
  getChatHistory,
  appendChatHistory,
  clearChatHistory,
  sanitizeMessagesForOpenAi,
};
