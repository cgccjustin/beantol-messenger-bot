const { google } = require("googleapis");
const { getGoogleAuth, hasGoogleCredentials } = require("./google-auth");

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

const HEADERS = ["Timestamp", "Platform", "Sender ID", "Event", "Detail"];

const COL = { TS: 0, PLATFORM: 1, SENDER_ID: 2, EVENT: 3, DETAIL: 4 };

function isEventsLogConfigured() {
  if (process.env.EVENTS_LOG_ENABLED === "false") return false;
  return Boolean(process.env.GOOGLE_LEADS_SHEET_ID?.trim() && hasGoogleCredentials());
}

function getEventsTab() {
  return process.env.GOOGLE_EVENTS_SHEET_TAB?.trim() || "Events";
}

function getSpreadsheetId() {
  return process.env.GOOGLE_LEADS_SHEET_ID?.trim();
}

async function getSheetsClient() {
  const auth = getGoogleAuth([SHEETS_SCOPE]);
  return google.sheets({ version: "v4", auth });
}

async function ensureTabExists(sheets, spreadsheetId, tabName) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties.title",
  });
  const titles = (meta.data.sheets || []).map((s) => s.properties?.title);
  if (titles.includes(tabName)) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: tabName } } }],
    },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tabName}!A1:E1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });
  console.log(`Google Sheet tab created: ${tabName}`);
}

function truncate(text, max = 200) {
  const s = String(text || "").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function queueLogEvent(payload) {
  if (!isEventsLogConfigured()) return;
  logEvent(payload).catch((err) => {
    console.warn("Events log failed:", err.message);
  });
}

async function logEvent({ platform = "messenger", senderId, event = "message", detail = "" }) {
  if (!isEventsLogConfigured() || !senderId) return { skipped: true };

  const spreadsheetId = getSpreadsheetId();
  const sheets = await getSheetsClient();
  const tab = getEventsTab();
  await ensureTabExists(sheets, spreadsheetId, tab);

  const row = [
    new Date().toISOString(),
    platform,
    String(senderId),
    event,
    truncate(detail),
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tab}!A:E`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });

  return { ok: true };
}

async function listEvents(limit = 500) {
  if (!isEventsLogConfigured()) {
    return { configured: false, events: [] };
  }

  const spreadsheetId = getSpreadsheetId();
  const sheets = await getSheetsClient();
  const tab = getEventsTab();

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tab}!A:E`,
    });
    const rows = res.data.values || [];
    const events = rows
      .slice(1)
      .map((row) => ({
        timestamp: row[COL.TS] || "",
        platform: row[COL.PLATFORM] || "",
        senderId: row[COL.SENDER_ID] || "",
        event: row[COL.EVENT] || "",
        detail: row[COL.DETAIL] || "",
      }))
      .reverse()
      .slice(0, Math.min(limit, 2000));

    return { configured: true, tab, count: events.length, events };
  } catch (err) {
    if (String(err.message).includes("Unable to parse range")) {
      return { configured: true, tab, count: 0, events: [] };
    }
    throw err;
  }
}

module.exports = {
  isEventsLogConfigured,
  getEventsTab,
  queueLogEvent,
  logEvent,
  listEvents,
};
