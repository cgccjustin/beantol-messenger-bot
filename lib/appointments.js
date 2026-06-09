const { google } = require("googleapis");
const { getGoogleAuth, hasGoogleCredentials } = require("./google-auth");
const { wantsToSkipAppointmentWizard } = require("./wizard-exit");
const { scopeKey } = require("./tenant-context");
const {
  getClosureForDate,
  buildClosureRejectionMessage,
} = require("./shop-closures");
const {
  getLeadsSheetId,
  getAppointmentsSheetTab,
  isAppointmentCaptureEnabledForTenant,
} = require("./tenant-google");
const { getShopAddress, getShopHours, businessName } = require("./tenant-messages");

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const SESSION_TTL_MS = Number(process.env.APPOINTMENT_SESSION_HOURS || 24) * 60 * 60 * 1000;
const SHOP_TIMEZONE = process.env.SUPPORT_TIMEZONE || "Asia/Manila";
const SHOP_OPEN_HOUR = Number(process.env.SHOP_OPEN_HOUR || 9);
const SHOP_CLOSE_HOUR = Number(process.env.SHOP_CLOSE_HOUR || 18);

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
  /\b(?:appointment|book(?:ing)?|schedule|visit(?: the)? shop|cupping|drop by|moadto sa shop|tan(-)?aw sa shop)\b/i;

const WEEKDAY_ALIASES = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

const DATETIME_QUESTION =
  "Happy to help you book a visit at {{BUSINESS_NAME}}. Can you tell me your preferred date and time?";

const DATE_ONLY_QUESTION = "What date would work for you?";

const TIME_ONLY_QUESTION = "What time would work for you?";

function appointmentDatetimeQuestion() {
  return DATETIME_QUESTION.replace(/\{\{BUSINESS_NAME\}\}/g, businessName());
}

function isAppointmentCaptureConfigured() {
  return isAppointmentCaptureEnabledForTenant() && hasGoogleCredentials();
}

function getAppointmentsTab() {
  return getAppointmentsSheetTab();
}

function getSpreadsheetId() {
  return getLeadsSheetId();
}

function sessionKey(senderId) {
  return scopeKey(senderId);
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
  const key = sessionKey(senderId);
  const s = bookingSessions.get(key);
  if (!s) return null;
  if (Date.now() - s.updatedAt > SESSION_TTL_MS) {
    bookingSessions.delete(key);
    return null;
  }
  return s;
}

function getManilaNowParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SHOP_TIMEZONE,
    weekday: "short",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    weekday: weekdayMap[get("weekday")] ?? 0,
  };
}

function toIsoDate(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addCalendarDays(year, month, day, offset) {
  const utc = new Date(Date.UTC(year, month - 1, day + offset));
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
  };
}

function manilaTodayIso() {
  const p = getManilaNowParts();
  return toIsoDate(p.year, p.month, p.day);
}

function manilaTomorrowIso() {
  const p = getManilaNowParts();
  const next = addCalendarDays(p.year, p.month, p.day, 1);
  return toIsoDate(next.year, next.month, next.day);
}

function resolveWeekdayDate(text) {
  const t = String(text || "").toLowerCase();
  const match = t.match(
    /\b(?:(?:this\s+(?:coming\s+)?|next\s+)(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)|(?:on\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun))\b/i
  );
  if (!match) return null;

  const token = (match[1] || match[2] || "").toLowerCase();
  const target = WEEKDAY_ALIASES[token];
  if (target == null) return null;

  const now = getManilaNowParts();
  let daysAhead = (target - now.weekday + 7) % 7;
  const forceNext =
    /\bnext\s+/i.test(t) || /\bthis\s+coming\s+/i.test(t) || /\bcoming\s+/i.test(t);
  if (daysAhead === 0 || forceNext) {
    daysAhead = daysAhead === 0 ? 7 : daysAhead;
  }
  if (daysAhead === 0) daysAhead = 7;

  const resolved = addCalendarDays(now.year, now.month, now.day, daysAhead);
  return toIsoDate(resolved.year, resolved.month, resolved.day);
}

function parseTypeChoice(text) {
  const t = String(text || "").toLowerCase();
  if (/cupping/i.test(t)) return "cupping";
  if (/^[2b]|cupping/i.test(t)) return "cupping";
  if (/^[1a]|shop|visit|store/i.test(t)) return "shop";
  if (/\b(?:shop|visit|store)\b/i.test(t)) return "shop";
  return null;
}

function inferAppointmentType(text) {
  return parseTypeChoice(text) || "shop";
}

function parseTimeFromText(text) {
  const t = String(text || "").trim();
  if (!t) return null;

  const atTime = t.match(
    /\b(?:at|around|by|@)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/i
  );
  if (atTime) {
    let h = Number(atTime[1]);
    const m = atTime[2] || "00";
    const ap = atTime[3].replace(/\./g, "").toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:${m}`;
  }

  const twentyFour = t.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (twentyFour) {
    return `${String(Number(twentyFour[1])).padStart(2, "0")}:${twentyFour[2]}`;
  }

  if (/\b(?:this\s+)?morning\b/i.test(t)) return "09:00";
  if (/\b(?:this\s+)?noon\b/i.test(t)) return "12:00";
  if (/\b(?:this\s+)?afternoon\b/i.test(t)) return "14:00";
  if (/\b(?:this\s+)?evening\b/i.test(t)) return "17:00";

  return null;
}

function parseDateFromText(text) {
  const t = String(text || "").trim();
  if (!t) return null;

  const iso = t.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];

  const slash = t.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
  if (slash) {
    const y = slash[3]
      ? slash[3].length === 2
        ? `20${slash[3]}`
        : slash[3]
      : String(getManilaNowParts().year);
    const m = slash[1].padStart(2, "0");
    const d = slash[2].padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  if (/\btoday\b/i.test(t)) return manilaTodayIso();
  if (/\btomorrow\b/i.test(t)) return manilaTomorrowIso();

  const weekday = resolveWeekdayDate(t);
  if (weekday) return weekday;

  return null;
}

function parseDateTime(text) {
  const raw = String(text || "").trim();
  let date = parseDateFromText(raw);
  let time = parseTimeFromText(raw);

  if (!date && /\b(?:this\s+)?(?:morning|afternoon|evening|noon)\b/i.test(raw)) {
    date = manilaTodayIso();
  }

  return { date, time };
}

function formatFriendlyDate(isoDate) {
  const s = String(isoDate || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return new Intl.DateTimeFormat("en-US", {
    timeZone: SHOP_TIMEZONE,
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(dt);
}

function formatFriendlyTime(timeStr) {
  const s = String(timeStr || "").trim();
  const match = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return s;
  let h = Number(match[1]);
  const m = Number(match[2]);
  const ap = h >= 12 ? "pm" : "am";
  const h12 = h % 12 || 12;
  if (m === 0) return `${h12}${ap}`;
  return `${h12}:${String(m).padStart(2, "0")}${ap}`;
}

function formatPreferredWhen(preferredDate, preferredTime) {
  const datePart = formatFriendlyDate(preferredDate);
  const timePart = formatFriendlyTime(preferredTime);
  return `${datePart} around ${timePart}`;
}

function timeToMinutes(timeStr) {
  const match = String(timeStr || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function isWeekendDate(isoDate) {
  const s = String(isoDate || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const dt = new Date(`${s}T12:00:00+08:00`);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: SHOP_TIMEZONE,
    weekday: "short",
  }).format(dt);
  return weekday === "Sat" || weekday === "Sun";
}

function isTimeWithinShopHours(timeStr) {
  const mins = timeToMinutes(timeStr);
  if (mins == null) return false;
  const open = SHOP_OPEN_HOUR * 60;
  const close = SHOP_CLOSE_HOUR * 60;
  return mins >= open && mins <= close;
}

/**
 * Validate preferred visit slot against shop days/hours. Does not log anything.
 */
function validateAppointmentSlot(date, time) {
  if (!date) return { valid: false, reason: "missing_date" };
  if (isWeekendDate(date)) return { valid: false, reason: "weekend" };
  if (!time) return { valid: true };
  if (!isTimeWithinShopHours(time)) {
    const mins = timeToMinutes(time);
    const open = SHOP_OPEN_HOUR * 60;
    if (mins != null && mins < open) return { valid: false, reason: "before_hours" };
    return { valid: false, reason: "after_hours" };
  }
  return { valid: true };
}

function buildSlotRejectionReply(validation, { date = "", time = "" } = {}) {
  const hours = getShopHours();
  const lines = [];

  if (validation.reason === "weekend") {
    lines.push(
      "That date falls on a weekend — our shop is closed then.",
      "",
      `Please choose a weekday visit during shop hours: ${hours}`,
      "",
      appointmentDatetimeQuestion()
    );
    return lines.join("\n");
  }

  if (validation.reason === "before_hours" || validation.reason === "after_hours") {
    const timeLabel = time ? formatFriendlyTime(time) : "that time";
    lines.push(
      `${timeLabel} is outside our shop hours.`,
      "",
      `We're open ${hours}`,
      ""
    );
    if (date && !isWeekendDate(date)) {
      lines.push(
        `What time on ${formatFriendlyDate(date)} would work for you?`,
        "",
        "(Or send a different date and time if you prefer.)"
      );
    } else {
      lines.push(appointmentDatetimeQuestion());
    }
    return lines.join("\n");
  }

  lines.push(`Please choose a time during shop hours: ${hours}`, "", appointmentDatetimeQuestion());
  return lines.join("\n");
}

function rejectInvalidSlot(senderId, session, validation, snapshot = {}) {
  session.updatedAt = Date.now();

  if (validation.reason === "weekend") {
    delete session.date;
    delete session.time;
    session.step = "datetime";
  } else if (validation.reason === "before_hours" || validation.reason === "after_hours") {
    delete session.time;
    session.step = session.date ? "time_only" : "datetime";
  } else {
    session.step = "datetime";
  }

  bookingSessions.set(sessionKey(senderId), session);
  return {
    handled: true,
    reply: buildSlotRejectionReply(validation, snapshot),
  };
}

async function tryValidateAndFinalize(senderId, session, options = {}) {
  const validation = validateAppointmentSlot(session.date, session.time);
  if (!validation.valid) {
    return rejectInvalidSlot(senderId, session, validation, {
      date: session.date,
      time: session.time,
    });
  }

  const closure = await getClosureForDate(session.date).catch(() => null);
  if (closure) {
    const rejectedDate = session.date;
    session.updatedAt = Date.now();
    delete session.date;
    delete session.time;
    session.step = "datetime";
    bookingSessions.set(sessionKey(senderId), session);
    return {
      handled: true,
      reply: buildClosureRejectionMessage(closure, rejectedDate),
    };
  }

  return finalizeBooking(senderId, session, options);
}

function buildConfirmationReply(appointment) {
  const when = formatPreferredWhen(appointment.preferredDate, appointment.preferredTime);
  const lines = [
    `Thanks — your request is logged (${appointment.appointmentId}).`,
    "",
    `Preferred visit: ${when}`,
    "",
    "Our team will confirm by chat.",
    "",
    `Shop: ${getShopHours()}`,
    getShopAddress(),
  ];
  if (appointment.type === "Cupping session") {
    lines.splice(3, 0, "Cupping session requested.");
  }
  return lines.join("\n");
}

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

async function finalizeBooking(senderId, session, options = {}) {
  bookingSessions.delete(sessionKey(senderId));
  const result = await recordAppointment({
    senderId,
    platform: options.platform,
    name: options.name || "",
    phone: options.phone || "",
    type: session.type || "shop",
    preferredDate: session.date,
    preferredTime: session.time,
    notes: options.notes || "",
  });

  if (!result?.ok) {
    return {
      handled: true,
      reply:
        `I noted your preferred visit time. Our team will confirm shortly.\n\nShop: ${getShopHours()} · ${getShopAddress()}.\n\nLive agents on chat daily 9 AM–9 PM if you need someone now.`,
    };
  }

  return {
    handled: true,
    reply: buildConfirmationReply(result.appointment),
    appointment: result.appointment,
  };
}

async function processAppointmentFlow(senderId, userText, options = {}) {
  const text = String(userText || "").trim();
  let session = getBookingSession(senderId);
  const { name = "", phone = "" } = options;

  if (!session && isAppointmentIntent(text)) {
    session = {
      step: "datetime",
      type: inferAppointmentType(text),
      updatedAt: Date.now(),
    };
    bookingSessions.set(sessionKey(senderId), session);

    // If the intent message already contains date and/or time, use them immediately.
    const { date: intentDate, time: intentTime } = parseDateTime(text);
    if (intentDate && intentTime) {
      session.date = intentDate;
      session.time = intentTime;
      return tryValidateAndFinalize(senderId, session, { ...options, name, phone, notes: text });
    }
    if (intentDate) {
      const dateCheck = validateAppointmentSlot(intentDate, null);
      if (!dateCheck.valid) {
        return rejectInvalidSlot(senderId, session, dateCheck, { date: intentDate });
      }
      const closureEarly = await getClosureForDate(intentDate).catch(() => null);
      if (closureEarly) {
        return { handled: true, reply: buildClosureRejectionMessage(closureEarly, intentDate) };
      }
      session.date = intentDate;
      session.step = "time_only";
      bookingSessions.set(sessionKey(senderId), session);
      return { handled: true, reply: TIME_ONLY_QUESTION };
    }
    if (intentTime) {
      session.time = intentTime;
      session.step = "date_only";
      bookingSessions.set(sessionKey(senderId), session);
      return { handled: true, reply: DATE_ONLY_QUESTION };
    }

    return { handled: true, reply: appointmentDatetimeQuestion() };
  }

  if (!session) return { handled: false };

  if (wantsToSkipAppointmentWizard(text)) {
    bookingSessions.delete(sessionKey(senderId));
    return { handled: false };
  }

  session.updatedAt = Date.now();

  if (session.step === "datetime") {
    const { date, time } = parseDateTime(text);
    if (!date && !time) {
      return {
        handled: true,
        reply: `I didn't catch a date or time yet.\n\n${appointmentDatetimeQuestion()}`,
      };
    }
    if (date && !time) {
      const dateCheck = validateAppointmentSlot(date, null);
      if (!dateCheck.valid) {
        return rejectInvalidSlot(senderId, session, dateCheck, { date });
      }
      const closureEarly = await getClosureForDate(date).catch(() => null);
      if (closureEarly) {
        return {
          handled: true,
          reply: buildClosureRejectionMessage(closureEarly, date),
        };
      }
      session.date = date;
      session.step = "time_only";
      bookingSessions.set(sessionKey(senderId), session);
      return { handled: true, reply: TIME_ONLY_QUESTION };
    }
    if (!date && time) {
      session.time = time;
      session.step = "date_only";
      bookingSessions.set(sessionKey(senderId), session);
      return { handled: true, reply: DATE_ONLY_QUESTION };
    }
    session.date = date;
    session.time = time;
    return tryValidateAndFinalize(senderId, session, { ...options, name, phone, notes: text });
  }

  if (session.step === "time_only") {
    const time = parseTimeFromText(text);
    if (!time) {
      return { handled: true, reply: TIME_ONLY_QUESTION };
    }
    session.time = time;
    return tryValidateAndFinalize(senderId, session, { ...options, name, phone, notes: text });
  }

  if (session.step === "date_only") {
    const date = parseDateFromText(text);
    if (!date) {
      return { handled: true, reply: DATE_ONLY_QUESTION };
    }
    session.date = date;
    return tryValidateAndFinalize(senderId, session, { ...options, name, phone, notes: text });
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
  parseDateTime,
  formatPreferredWhen,
  validateAppointmentSlot,
  isTimeWithinShopHours,
  isWeekendDate,
};
