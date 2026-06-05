const { google } = require("googleapis");
const { getGoogleAuth, hasGoogleCredentials } = require("./google-auth");
const { mergeStage } = require("./lead-capture");

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const HEADERS = [
  "Created",
  "Updated",
  "Platform",
  "Sender ID",
  "Name",
  "Phone",
  "Interest",
  "Stage",
  "Last message",
  "Trigger",
];

const COL = {
  CREATED: 0,
  UPDATED: 1,
  PLATFORM: 2,
  SENDER_ID: 3,
  NAME: 4,
  PHONE: 5,
  INTEREST: 6,
  STAGE: 7,
  LAST_MESSAGE: 8,
  TRIGGER: 9,
};

function isLeadCaptureConfigured() {
  if (process.env.LEAD_CAPTURE_ENABLED === "false") return false;
  return Boolean(process.env.GOOGLE_LEADS_SHEET_ID?.trim() && hasGoogleCredentials());
}

function getSheetTab() {
  return process.env.GOOGLE_LEADS_SHEET_TAB?.trim() || "Leads";
}

async function getSheetsClient() {
  const auth = getGoogleAuth([SHEETS_SCOPE]);
  return google.sheets({ version: "v4", auth });
}

async function ensureHeaders(sheets, spreadsheetId, tab) {
  const range = `${tab}!A1:J1`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });
  const first = res.data.values?.[0] || [];
  if (first.length >= HEADERS.length && first[0] === HEADERS[0]) return;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });
}

function rowToLead(row) {
  if (!row || !row[COL.SENDER_ID]) return null;
  return {
    created: row[COL.CREATED] || "",
    updated: row[COL.UPDATED] || "",
    platform: row[COL.PLATFORM] || "",
    senderId: row[COL.SENDER_ID] || "",
    name: row[COL.NAME] || "",
    phone: row[COL.PHONE] || "",
    interest: row[COL.INTEREST] || "",
    stage: row[COL.STAGE] || "",
    lastMessage: row[COL.LAST_MESSAGE] || "",
    trigger: row[COL.TRIGGER] || "",
  };
}

function truncate(text, max = 500) {
  const s = String(text || "").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

async function readAllRows(sheets, spreadsheetId, tab) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A:J`,
  });
  return res.data.values || [];
}

async function recordLead(payload) {
  const spreadsheetId = process.env.GOOGLE_LEADS_SHEET_ID?.trim();
  if (!isLeadCaptureConfigured()) {
    return { skipped: true, reason: "Lead capture not configured" };
  }

  const {
    senderId,
    platform = "messenger",
    name = "",
    phone = "",
    interest = "",
    stage = "browsing",
    lastMessage = "",
    trigger = "",
  } = payload;

  if (!senderId || !stage) {
    return { skipped: true, reason: "Missing senderId or stage" };
  }

  const sheets = await getSheetsClient();
  const tab = getSheetTab();
  await ensureHeaders(sheets, spreadsheetId, tab);

  const rows = await readAllRows(sheets, spreadsheetId, tab);
  const now = new Date().toISOString();
  let rowIndex = -1;
  let existing = null;

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][COL.SENDER_ID]) === String(senderId)) {
      rowIndex = i;
      existing = rows[i];
      break;
    }
  }

  const mergedStage = mergeStage(existing?.[COL.STAGE], stage);
  const mergedRow = [
    existing?.[COL.CREATED] || now,
    now,
    platform || existing?.[COL.PLATFORM] || "",
    String(senderId),
    name || existing?.[COL.NAME] || "",
    phone || existing?.[COL.PHONE] || "",
    interest || existing?.[COL.INTEREST] || "",
    mergedStage,
    truncate(lastMessage) || existing?.[COL.LAST_MESSAGE] || "",
    trigger || existing?.[COL.TRIGGER] || "",
  ];

  const isNew = rowIndex === -1;
  const stageChanged = !isNew && existing?.[COL.STAGE] !== mergedStage;

  if (isNew) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${tab}!A:J`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [mergedRow] },
    });
  } else {
    const sheetRow = rowIndex + 1;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tab}!A${sheetRow}:J${sheetRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [mergedRow] },
    });
  }

  const lead = rowToLead(mergedRow);
  console.log(
    `Lead ${isNew ? "created" : "updated"}: ${senderId} stage=${mergedStage} (${trigger || "—"})`
  );

  return {
    ok: true,
    isNew,
    stageChanged,
    lead,
    notify:
      isNew ||
      stageChanged ||
      Boolean(phone && phone !== (existing?.[COL.PHONE] || "")),
  };
}

async function listLeads(limit = 50) {
  const spreadsheetId = process.env.GOOGLE_LEADS_SHEET_ID?.trim();
  if (!isLeadCaptureConfigured()) {
    return { configured: false, leads: [] };
  }

  const sheets = await getSheetsClient();
  const tab = getSheetTab();
  const rows = await readAllRows(sheets, spreadsheetId, tab);
  const leads = rows
    .slice(1)
    .map(rowToLead)
    .filter(Boolean)
    .reverse()
    .slice(0, Math.max(1, Math.min(limit, 200)));

  return {
    configured: true,
    sheetId: spreadsheetId,
    tab,
    count: leads.length,
    leads,
  };
}

module.exports = {
  isLeadCaptureConfigured,
  recordLead,
  listLeads,
  getSheetTab,
};
