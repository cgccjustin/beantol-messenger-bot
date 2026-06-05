const { google } = require("googleapis");
const { getGoogleAuth, hasGoogleCredentials } = require("./google-auth");

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const SESSION_TTL_MS = Number(process.env.APPOINTMENT_SESSION_HOURS || 24) * 60 * 60 * 1000;

const HEADERS = [
  "Appointment ID",
  "Created",
  "Updated",
  "Platform",
  "Sender ID",
  "Name",
  "Phone",
  "Type",
  "Preferred date",
  "Preferred time",
  "Status",
  "Notes",
];

const COL = {
  ID: 0,
  CREATED: 1,
  UPDATED: 2,
  PLATFORM: 3,
  SENDER_ID: 4,
  NAME: 5,
  PHONE: 6,
  TYPE: 7,
  DATE: 8,
  TIME: 9,
  STATUS: 10,
  NOTES: 11,
};

const APPOINTMENT_TYPES = {
  shop: "Shop visit",
  cupping: "Cupping session",
  callback: "Phone callback",
};

const VALID_STATUSES = ["requested", "confirmed", "completed", "cancelled"];

/** @type {Map<string, { step: string, type?: string, date?: string, time?: string, updatedAt: number }>} */
const bookingSessions = new Map();

const APPOINTMENT_INTENT =
  /\b(?:appointment|book(?:ing)?|schedule|visit(?: the)? shop|cupping|callback|call me back|drop by|moadto sa shop|tan(-)?aw sa shop)\b/i;

function isAppointmentCaptureConfigured() {
  if (process.env.APPOINTMENT_CAPTURE_ENABLED === "false") return false;
  return Boolean(process.env.GOOGLE_LEADS_SHEET_ID?.trim() && hasGoogleCredentials());
}

function getAppointmentsTab() {
  return process.env.GOOGLE_APPOINTMENTS_SHEET_TAB?.trim() || "Appointments";
}

function getSpreadsheetId() {
  return process.env.GOOGLE_LEADS_SHEET_ID?.trim();
}

function isAppointmentIntent(text) {
  return APPOINTMENT_INTENT.test(String(text || "").trim());
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
    range: `${tabName}!A1:L1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });
  console.log(`Google Sheet tab created: ${tabName}`);
}

async function readAllRows(sheets, spreadsheetId, tab) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A:L`,
  });
  return res.data.values || [];
}

function rowToAppointment(row) {
  if (!row || !row[COL.ID]) return null;
  return {
    appointmentId: row[COL.ID] || "",
    created: row[COL.CREATED] || "",
    updated: row[COL.UPDATED] || "",
    platform: row[COL.PLATFORM] || "",
    senderId: row[COL.SENDER_ID] || "",
    name: row[COL.NAME] || "",
    phone: row[COL.PHONE] || "",
    type: row[COL.TYPE] || "",
    preferredDate: row[COL.DATE] || "",
    preferredTime: row[COL.TIME] || "",
    status: row[COL.STATUS] || "requested",
    notes: row[COL.NOTES] || "",
  };
}

function generateAppointmentId(rows) {
  const d = new Date();
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, "");
  const todayPrefix = d.toISOString().slice(0, 10);
  let count = 0;
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][COL.CREATED] || "").startsWith(todayPrefix)) count += 1;
  }
  return `AP-${ymd}-${String(count + 1).padStart(4, "0")}`;
}

function getBookingSession(senderId) {
  const s = bookingSessions.get(senderId);
  if (!s) return null;
  if (Date.now() - s.updatedAt > SESSION_TTL_MS) {
    bookingSessions.delete(senderId);
    return null;
  }
  return s;
}

function parseTypeChoice(text) {
  const t = String(text || "").toLowerCase();
  if (/^[1a]|shop|visit|store/i.test(t)) return "shop";
  if (/^[2b]|cupping/i.test(t)) return "cupping";
  if (/^[3c]|call|phone|callback/i.test(t)) return "callback";
  if (/\bcupping\b/i.test(t)) return "cupping";
  if (/\b(?:shop|visit|store)\b/i.test(t)) return "shop";
  if (/\b(?:call|callback|phone)\b/i.test(t)) return "callback";
  return null;
}

function parseDate(text) {
  const t = String(text || "").trim();
  const iso = t.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  const slash = t.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
  if (slash) {
    const y = slash[3] ? (slash[3].length === 2 ? `20${slash[3]}` : slash[3]) : String(new Date().getFullYear());
    const m = slash[1].padStart(2, "0");
    const d = slash[2].padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  if (/\btomorrow\b/i.test(t)) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  if (/\btoday\b/i.test(t)) return new Date().toISOString().slice(0, 10);
  if (t.length >= 3 && t.length <= 40) return t;
  return null;
}

function parseTime(text) {
  const t = String(text || "").trim();
  const match = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (match) {
    let h = Number(match[1]);
    const m = match[2] || "00";
    const ap = (match[3] || "").toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:${m}`;
  }
  if (/\bmorning\b/i.test(t)) return "09:00";
  if (/\bafternoon\b/i.test(t)) return "14:00";
  if (t.length >= 2 && t.length <= 30) return t;
  return null;
}

const TYPE_QUESTION = `Happy to help you book with Beantol. What would you like?

• Reply 1 — Visit the shop (Mon–Fri)
• Reply 2 — Cupping session (great for cafés exploring beans)
• Reply 3 — Phone callback from our team`;

const DATE_QUESTION = `What date works for you? (e.g. 2026-06-10, 6/10, or "tomorrow")`;

const TIME_QUESTION = `What time works best? (e.g. 10am, 2:30pm, or "morning")`;

async function recordAppointment(payload) {
  if (!isAppointmentCaptureConfigured()) {
    return { skipped: true, reason: "Appointment capture not configured" };
  }

  const {
    senderId,
    platform = "messenger",
    name = "",
    phone = "",
    type = "shop",
    preferredDate = "",
    preferredTime = "",
    notes = "",
  } = payload;

  if (!senderId) return { skipped: true, reason: "Missing senderId" };

  const spreadsheetId = getSpreadsheetId();
  const sheets = await getSheetsClient();
  const tab = getAppointmentsTab();
  await ensureTabExists(sheets, spreadsheetId, tab);

  const rows = await readAllRows(sheets, spreadsheetId, tab);
  const now = new Date().toISOString();
  const appointmentId = generateAppointmentId(rows);

  const mergedRow = [
    appointmentId,
    now,
    now,
    platform,
    String(senderId),
    name,
    phone,
    APPOINTMENT_TYPES[type] || type,
    preferredDate,
    preferredTime,
    "requested",
    notes,
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tab}!A:L`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [mergedRow] },
  });

  const appointment = rowToAppointment(mergedRow);
  console.log(`Appointment created: ${appointmentId} sender=${senderId}`);
  return { ok: true, appointment };
}

async function processAppointmentFlow(senderId, userText, options = {}) {
  const text = String(userText || "").trim();
  let session = getBookingSession(senderId);
  const { name = "", phone = "" } = options;

  if (!session && isAppointmentIntent(text)) {
    const type = parseTypeChoice(text);
    if (type) {
      session = { step: "date", type, updatedAt: Date.now() };
      bookingSessions.set(senderId, session);
      return { handled: true, reply: DATE_QUESTION };
    }
    session = { step: "type", updatedAt: Date.now() };
    bookingSessions.set(senderId, session);
    return { handled: true, reply: TYPE_QUESTION };
  }

  if (!session) return { handled: false };

  session.updatedAt = Date.now();

  if (session.step === "type") {
    const type = parseTypeChoice(text);
    if (!type) {
      return { handled: true, reply: `Please reply 1, 2, or 3.\n\n${TYPE_QUESTION}` };
    }
    session.type = type;
    session.step = "date";
    return { handled: true, reply: DATE_QUESTION };
  }

  if (session.step === "date") {
    const date = parseDate(text);
    if (!date) {
      return { handled: true, reply: `Please send a date (e.g. tomorrow, 6/15, or 2026-06-15).\n\n${DATE_QUESTION}` };
    }
    session.date = date;
    session.step = "time";
    return { handled: true, reply: TIME_QUESTION };
  }

  if (session.step === "time") {
    const time = parseTime(text);
    if (!time) {
      return { handled: true, reply: `Please send a time (e.g. 10am, 2pm, morning).\n\n${TIME_QUESTION}` };
    }
    session.time = time;
    bookingSessions.delete(senderId);

    const result = await recordAppointment({
      senderId,
      platform: options.platform,
      name,
      phone,
      type: session.type || "shop",
      preferredDate: session.date,
      preferredTime: time,
      notes: text,
    });

    if (!result?.ok) {
      return {
        handled: true,
        reply:
          "I noted your preferred visit time. Our team will confirm shortly.\n\nShop: Mon–Fri, 9 AM–6 PM · Holy Family Village 2, Governor Cuenco Ave., Banilad, Cebu City.\n\nLive agents on chat daily 9 AM–9 PM if you need someone now.",
      };
    }

    const ap = result.appointment;
    return {
      handled: true,
      reply:
        `Thanks — your request is logged (${ap.appointmentId}).\n\n` +
        `• Type: ${ap.type}\n` +
        `• Preferred: ${ap.preferredDate} around ${ap.preferredTime}\n\n` +
        `Our team will confirm by chat or phone.\n\n` +
        `Shop: Mon–Fri, 9 AM–6 PM (closed weekends)\n` +
        `Holy Family Village 2, Governor Cuenco Ave., Banilad, Cebu City (beside the guardhouse).`,
      appointment: ap,
    };
  }

  return { handled: false };
}

async function listAppointments(limit = 50) {
  if (!isAppointmentCaptureConfigured()) {
    return { configured: false, appointments: [] };
  }

  const spreadsheetId = getSpreadsheetId();
  const sheets = await getSheetsClient();
  const tab = getAppointmentsTab();
  await ensureTabExists(sheets, spreadsheetId, tab);
  const rows = await readAllRows(sheets, spreadsheetId, tab);
  const appointments = rows
    .slice(1)
    .map(rowToAppointment)
    .filter(Boolean)
    .reverse()
    .slice(0, Math.min(limit, 200));

  return { configured: true, tab, count: appointments.length, appointments };
}

async function updateAppointmentStatus(appointmentId, status, notes = "") {
  if (!isAppointmentCaptureConfigured()) {
    return { skipped: true, reason: "Not configured" };
  }
  if (!VALID_STATUSES.includes(status)) {
    return { skipped: true, reason: `Invalid status: ${status}` };
  }

  const spreadsheetId = getSpreadsheetId();
  const sheets = await getSheetsClient();
  const tab = getAppointmentsTab();
  const rows = await readAllRows(sheets, spreadsheetId, tab);

  let rowIndex = -1;
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][COL.ID]) === String(appointmentId)) {
      rowIndex = i;
      break;
    }
  }
  if (rowIndex === -1) return { skipped: true, reason: "Not found" };

  const existing = rows[rowIndex];
  const now = new Date().toISOString();
  const merged = [...existing];
  merged[COL.UPDATED] = now;
  merged[COL.STATUS] = status;
  if (notes !== undefined) merged[COL.NOTES] = notes;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tab}!A${rowIndex + 1}:L${rowIndex + 1}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [merged] },
  });

  return { ok: true, appointment: rowToAppointment(merged) };
}

module.exports = {
  isAppointmentCaptureConfigured,
  isAppointmentIntent,
  processAppointmentFlow,
  recordAppointment,
  listAppointments,
  updateAppointmentStatus,
  getAppointmentsTab,
  APPOINTMENT_TYPES,
  VALID_STATUSES,
};
