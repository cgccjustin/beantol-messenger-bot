const { google } = require("googleapis");
const { getGoogleAuth, hasGoogleCredentials } = require("./google-auth");
const { getLeadsSheetId, getClosuresSheetTab } = require("./tenant-google");
const { getActiveTenant } = require("./tenant-context");

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const CACHE_MS = Number(process.env.CLOSURES_CACHE_MINUTES || 30) * 60 * 1000;
const SHOP_TIMEZONE = process.env.SUPPORT_TIMEZONE || "Asia/Manila";

const HEADERS = ["Date", "Reason", "Notes"];
const COL = { DATE: 0, REASON: 1, NOTES: 2 };

/** @type {Map<string, { at: number, closures: Array<{date:string,reason:string,notes:string}> }>} */
const cacheByTenant = new Map();

function isClosuresConfigured() {
  return Boolean(getLeadsSheetId() && hasGoogleCredentials());
}

function getTenantCacheKey() {
  return getActiveTenant()?.id || "default";
}

function getTenantCache() {
  const key = getTenantCacheKey();
  if (!cacheByTenant.has(key)) {
    cacheByTenant.set(key, { at: 0, closures: [] });
  }
  return cacheByTenant.get(key);
}

function clearClosuresCache() {
  cacheByTenant.clear();
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
    requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tabName}!A1:C1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });
  console.log(`Google Sheet tab created: ${tabName}`);
}

const MONTH_NAMES = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

function currentManilaYear() {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: SHOP_TIMEZONE, year: "numeric" }).format(new Date())
  );
}

function currentManilaDateIso() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SHOP_TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

/**
 * If a year is omitted, assume the current year.
 * If that date has already passed (>= 1 day ago), roll to next year.
 */
function inferYear(month, day) {
  const thisYear = currentManilaYear();
  const candidate = `${thisYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (candidate >= currentManilaDateIso()) return thisYear;
  return thisYear + 1;
}

/**
 * Parse date from flexible admin-entered formats into YYYY-MM-DD.
 * Accepts:
 *   2026-06-12        → 2026-06-12
 *   06/12/2026        → 2026-06-12
 *   6/12              → June 12, inferred year
 *   June 12           → June 12, inferred year
 *   Jun 12, 2026      → 2026-06-12
 *   12 June           → same
 *   June 10,          → June 10, inferred year (trailing comma OK)
 */
function parseClosureDate(raw) {
  const s = String(raw || "").trim().replace(/,\s*$/, ""); // strip trailing comma
  if (!s) return null;

  // Already ISO YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // MM/DD/YYYY or M/D/YY
  const slashFull = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (slashFull) {
    const y = slashFull[3].length === 2 ? `20${slashFull[3]}` : slashFull[3];
    return `${y}-${slashFull[1].padStart(2, "0")}-${slashFull[2].padStart(2, "0")}`;
  }

  // MM/DD (no year) — e.g. 6/12
  const slashShort = s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (slashShort) {
    const m = Number(slashShort[1]);
    const d = Number(slashShort[2]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const y = inferYear(m, d);
      return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }

  // Month-name formats: "June 12", "June 12 2026", "12 June", "12 June 2026", "Jun 12,", etc.
  const monthNameFmt = s.match(
    /^([a-z]+)\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?$/i
  ) || s.match(
    /^(\d{1,2})\s+([a-z]+)(?:\s*,?\s*(\d{4}))?$/i
  );
  if (monthNameFmt) {
    let monthToken, dayToken, yearToken;
    if (/^[a-z]/i.test(monthNameFmt[1])) {
      // Month first: "June 12 2026"
      [, monthToken, dayToken, yearToken] = monthNameFmt;
    } else {
      // Day first: "12 June 2026"
      [, dayToken, monthToken, yearToken] = monthNameFmt;
    }
    const m = MONTH_NAMES[monthToken.toLowerCase()];
    const d = Number(dayToken);
    if (m && d >= 1 && d <= 31) {
      const y = yearToken ? Number(yearToken) : inferYear(m, d);
      return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }

  // Last resort: native Date parse (handles many formats with explicit years)
  const nd = new Date(s);
  if (!Number.isNaN(nd.getTime())) {
    const iso = nd.toISOString().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  }

  return null;
}

async function loadClosures(force = false) {
  if (!isClosuresConfigured()) return [];

  const cache = getTenantCache();
  if (!force && cache.at && Date.now() - cache.at < CACHE_MS) {
    return cache.closures;
  }

  try {
    const spreadsheetId = getLeadsSheetId();
    const tab = getClosuresSheetTab();
    const sheets = await getSheetsClient();
    await ensureTabExists(sheets, spreadsheetId, tab);

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tab}!A:C`,
    });
    const rows = res.data.values || [];

    const closures = rows
      .slice(1) // skip header
      .map((row) => {
        const date = parseClosureDate(row[COL.DATE]);
        const reason = String(row[COL.REASON] || "").trim();
        const notes = String(row[COL.NOTES] || "").trim();
        if (!date) return null;
        return { date, reason, notes };
      })
      .filter(Boolean);

    cache.closures = closures;
    cache.at = Date.now();
    return closures;
  } catch (err) {
    console.error("shop-closures: failed to load:", err.message);
    return cache.closures; // return stale on error
  }
}

/**
 * Returns the closure entry for a given YYYY-MM-DD date, or null if open.
 */
async function getClosureForDate(isoDate) {
  const closures = await loadClosures();
  return closures.find((c) => c.date === isoDate) || null;
}

function manilaDateNow() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SHOP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function addDays(isoDate, n) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

/**
 * Returns upcoming closures within the next `days` days (sorted ascending).
 */
async function getUpcomingClosures(days = 14) {
  const closures = await loadClosures();
  const today = manilaDateNow();
  const limit = addDays(today, days);
  return closures
    .filter((c) => c.date >= today && c.date <= limit)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function formatClosureDate(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return new Intl.DateTimeFormat("en-US", {
    timeZone: SHOP_TIMEZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(dt);
}

/**
 * Returns a system note for the AI listing upcoming special closures.
 * Returns "" if none upcoming.
 */
async function buildClosuresSystemNote() {
  const upcoming = await getUpcomingClosures(14);
  if (!upcoming.length) return "";

  const lines = [
    "SPECIAL CLOSURES (shop is closed on these additional days — not regular weekend closures):",
  ];
  for (const c of upcoming) {
    const label = formatClosureDate(c.date);
    const reason = c.reason || "Special closure";
    lines.push(`• ${label}: ${reason}${c.notes ? ` (${c.notes})` : ""}`);
  }
  lines.push(
    "When customers ask about visiting or booking on these dates, tell them the shop is closed with the reason above, and suggest another date."
  );
  return lines.join("\n");
}

/**
 * Build a user-facing rejection message for a closure date.
 */
function buildClosureRejectionMessage(closure, dateStr) {
  const label = formatClosureDate(dateStr);
  const reason = closure.reason || "a special closure";
  const lines = [
    `Sorry — the shop is closed on ${label} (${reason}).`,
    "",
    "Please choose a different date and I'll get your visit booked.",
  ];
  if (closure.notes) {
    lines.splice(1, 0, closure.notes);
  }
  return lines.join("\n");
}

module.exports = {
  isClosuresConfigured,
  loadClosures,
  getClosureForDate,
  getUpcomingClosures,
  buildClosuresSystemNote,
  buildClosureRejectionMessage,
  clearClosuresCache,
  formatClosureDate,
};
