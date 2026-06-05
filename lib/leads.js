const { google } = require("googleapis");
const { getGoogleAuth, hasGoogleCredentials } = require("./google-auth");
const { mergeStage } = require("./lead-capture");

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const DEFAULT_TEAM_STATUS = "New";
const TEAM_STATUSES = ["New", "Contacted", "Follow-up", "Won", "Lost"];

const HEADERS = [
  "Created",
  "Updated",
  "Platform",
  "Sender ID",
  "Name",
  "Phone",
  "Interest",
  "Bot stage",
  "Last message",
  "Trigger",
  "Team status",
  "Assigned to",
  "Notes",
  "Next action",
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
  TEAM_STATUS: 10,
  ASSIGNED: 11,
  NOTES: 12,
  NEXT_ACTION: 13,
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
  const range = `${tab}!A1:N1`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
  });
  const first = res.data.values?.[0] || [];
  if (!first.length || first[0] !== HEADERS[0]) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tab}!A1:N1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADERS] },
    });
    return;
  }
  if (first.length < HEADERS.length) {
    const padded = [...first];
    while (padded.length < HEADERS.length) {
      padded.push(HEADERS[padded.length]);
    }
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tab}!A1:N1`,
      valueInputOption: "RAW",
      requestBody: { values: [padded] },
    });
  }
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
    teamStatus: row[COL.TEAM_STATUS] || "",
    assignedTo: row[COL.ASSIGNED] || "",
    notes: row[COL.NOTES] || "",
    nextAction: row[COL.NEXT_ACTION] || "",
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
    range: `${tab}!A:N`,
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
  const isNew = rowIndex === -1;
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
    existing?.[COL.TEAM_STATUS] || DEFAULT_TEAM_STATUS,
    existing?.[COL.ASSIGNED] || "",
    existing?.[COL.NOTES] || "",
    existing?.[COL.NEXT_ACTION] || "",
  ];

  const stageChanged = !isNew && existing?.[COL.STAGE] !== mergedStage;

  if (isNew) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${tab}!A:N`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [mergedRow] },
    });
  } else {
    const sheetRow = rowIndex + 1;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tab}!A${sheetRow}:N${sheetRow}`,
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

async function findLeadRow(senderId) {
  const spreadsheetId = process.env.GOOGLE_LEADS_SHEET_ID?.trim();
  if (!isLeadCaptureConfigured() || !senderId) return null;

  const sheets = await getSheetsClient();
  const tab = getSheetTab();
  const rows = await readAllRows(sheets, spreadsheetId, tab);

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][COL.SENDER_ID]) === String(senderId)) {
      return { rowIndex: i, row: rows[i], lead: rowToLead(rows[i]) };
    }
  }
  return null;
}

async function updateLeadTeamFields(senderId, fields = {}) {
  const spreadsheetId = process.env.GOOGLE_LEADS_SHEET_ID?.trim();
  if (!isLeadCaptureConfigured()) {
    return { skipped: true, reason: "Lead capture not configured" };
  }

  const found = await findLeadRow(senderId);
  if (!found) return { skipped: true, reason: "Lead not found" };

  const { teamStatus, assignedTo, notes, nextAction } = fields;
  const existing = found.row;
  const now = new Date().toISOString();

  if (teamStatus && !TEAM_STATUSES.includes(teamStatus)) {
    return { skipped: true, reason: `Invalid team status: ${teamStatus}` };
  }

  const merged = [...existing];
  merged[COL.UPDATED] = now;
  if (teamStatus !== undefined) merged[COL.TEAM_STATUS] = teamStatus;
  if (assignedTo !== undefined) merged[COL.ASSIGNED] = assignedTo;
  if (notes !== undefined) merged[COL.NOTES] = notes;
  if (nextAction !== undefined) merged[COL.NEXT_ACTION] = nextAction;

  const sheetRow = found.rowIndex + 1;
  const sheets = await getSheetsClient();
  const tab = getSheetTab();
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tab}!A${sheetRow}:N${sheetRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [merged] },
  });

  const lead = rowToLead(merged);
  console.log(`Lead team fields updated: ${senderId} status=${lead.teamStatus}`);
  return { ok: true, lead };
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
  findLeadRow,
  updateLeadTeamFields,
  getSheetTab,
  DEFAULT_TEAM_STATUS,
  TEAM_STATUSES,
};
