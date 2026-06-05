const crypto = require("crypto");
const { google } = require("googleapis");
const { getGoogleAuth, hasGoogleCredentials } = require("./google-auth");
const { buildQuoteFromText, formatPeso } = require("./pricing");

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const QUOTE_VALID_DAYS = Number(process.env.QUOTE_VALID_DAYS || 7);

const HEADERS = [
  "Quote ID",
  "Created",
  "Updated",
  "Valid until",
  "Platform",
  "Sender ID",
  "Name",
  "Phone",
  "Line items",
  "Subtotal",
  "Status",
  "Notes",
  "Share token",
];

const COL = {
  QUOTE_ID: 0,
  CREATED: 1,
  UPDATED: 2,
  VALID_UNTIL: 3,
  PLATFORM: 4,
  SENDER_ID: 5,
  NAME: 6,
  PHONE: 7,
  LINE_ITEMS: 8,
  SUBTOTAL: 9,
  STATUS: 10,
  NOTES: 11,
  SHARE_TOKEN: 12,
};

function isQuoteCaptureConfigured() {
  if (process.env.QUOTE_CAPTURE_ENABLED === "false") return false;
  return Boolean(process.env.GOOGLE_LEADS_SHEET_ID?.trim() && hasGoogleCredentials());
}

function getQuotesTab() {
  return process.env.GOOGLE_QUOTES_SHEET_TAB?.trim() || "Quotes";
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
  if (titles.includes(tabName)) return false;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: tabName } } }],
    },
  });
  console.log(`Google Sheet tab created: ${tabName}`);
  return true;
}

async function ensureHeaders(sheets, spreadsheetId, tab) {
  await ensureTabExists(sheets, spreadsheetId, tab);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A1:M1`,
  });
  const first = res.data.values?.[0] || [];
  if (first.length >= HEADERS.length && first[0] === HEADERS[0]) return;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tab}!A1:M1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });
}

async function readAllRows(sheets, spreadsheetId, tab) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A:M`,
  });
  return res.data.values || [];
}

function rowToQuote(row) {
  if (!row || !row[COL.QUOTE_ID]) return null;
  return {
    quoteId: row[COL.QUOTE_ID] || "",
    created: row[COL.CREATED] || "",
    updated: row[COL.UPDATED] || "",
    validUntil: row[COL.VALID_UNTIL] || "",
    platform: row[COL.PLATFORM] || "",
    senderId: row[COL.SENDER_ID] || "",
    name: row[COL.NAME] || "",
    phone: row[COL.PHONE] || "",
    lineItems: row[COL.LINE_ITEMS] || "",
    subtotal: Number(row[COL.SUBTOTAL]) || 0,
    status: row[COL.STATUS] || "draft",
    notes: row[COL.NOTES] || "",
    shareToken: row[COL.SHARE_TOKEN] || "",
  };
}

function generateQuoteId(rows) {
  const d = new Date();
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, "");
  const todayPrefix = d.toISOString().slice(0, 10);
  let count = 0;
  for (let i = 1; i < rows.length; i++) {
    const created = rows[i][COL.CREATED] || "";
    if (String(created).startsWith(todayPrefix)) count += 1;
  }
  return `QT-${ymd}-${String(count + 1).padStart(4, "0")}`;
}

function makeShareToken() {
  return crypto.randomBytes(12).toString("hex");
}

function addDaysIso(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function shouldCreateQuote(payload) {
  const { stage, interest, userText = "", explicit = false } = payload;
  if (explicit) return true;
  if (!interest && !/\b(?:price|quote|quotation|magkano|tagpila)\b/i.test(userText)) {
    return false;
  }
  return stage === "quoted" || stage === "wholesale" || stage === "ordering";
}

async function recordQuote(payload) {
  const spreadsheetId = getSpreadsheetId();
  if (!isQuoteCaptureConfigured()) {
    return { skipped: true, reason: "Quote capture not configured" };
  }

  const {
    senderId,
    platform = "messenger",
    name = "",
    phone = "",
    interest = "",
    bean = "",
    size = "",
    userText = "",
    historyTexts = [],
    assistantReply = "",
    stage = "quoted",
    wholesale = false,
  } = payload;

  if (!senderId) return { skipped: true, reason: "Missing senderId" };

  const quoteData = buildQuoteFromText(userText, {
    bean,
    size,
    wholesale,
    historyTexts,
    assistantReply,
  });
  if (!quoteData) {
    return { skipped: true, reason: "Could not resolve product/size for quote" };
  }

  const sheets = await getSheetsClient();
  const tab = getQuotesTab();
  await ensureHeaders(sheets, spreadsheetId, tab);

  const rows = await readAllRows(sheets, spreadsheetId, tab);
  const now = new Date().toISOString();
  const validUntil = addDaysIso(QUOTE_VALID_DAYS);

  let existingIndex = -1;
  let existing = null;
  for (let i = rows.length - 1; i >= 1; i--) {
    if (String(rows[i][COL.SENDER_ID]) !== String(senderId)) continue;
    const status = String(rows[i][COL.STATUS] || "").toLowerCase();
    if (status === "accepted" || status === "expired") continue;
    const valid = rows[i][COL.VALID_UNTIL] || "";
    if (valid && valid < now.slice(0, 10)) continue;
    existingIndex = i;
    existing = rows[i];
    break;
  }

  const isNew = existingIndex === -1;
  const quoteId = existing?.[COL.QUOTE_ID] || generateQuoteId(rows);
  const shareToken = existing?.[COL.SHARE_TOKEN] || makeShareToken();

  const existingSubtotal = Number(existing?.[COL.SUBTOTAL]) || 0;
  const existingItems = String(existing?.[COL.LINE_ITEMS] || "");
  const newItemCount = (quoteData.summary.match(/=/g) || []).length;
  const existingItemCount = (existingItems.match(/=/g) || []).length;
  const useExistingLines =
    !isNew &&
    existingItems &&
    (quoteData.subtotal < existingSubtotal ||
      (existingItemCount > newItemCount && quoteData.subtotal <= existingSubtotal));

  const lineItems = useExistingLines ? existingItems : quoteData.summary;
  const subtotal = useExistingLines ? existingSubtotal : quoteData.subtotal;

  const mergedRow = [
    quoteId,
    existing?.[COL.CREATED] || now,
    now,
    validUntil,
    platform || existing?.[COL.PLATFORM] || "",
    String(senderId),
    name || existing?.[COL.NAME] || "",
    phone || existing?.[COL.PHONE] || "",
    lineItems,
    subtotal,
    isNew ? "sent" : existing?.[COL.STATUS] || "sent",
    interest || existing?.[COL.NOTES] || "",
    shareToken,
  ];

  if (isNew) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${tab}!A:M`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [mergedRow] },
    });
  } else {
    const sheetRow = existingIndex + 1;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tab}!A${sheetRow}:M${sheetRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [mergedRow] },
    });
  }

  const quote = rowToQuote(mergedRow);
  console.log(`Quote ${isNew ? "created" : "updated"}: ${quoteId} sender=${senderId}`);
  return { ok: true, isNew, quote };
}

async function getQuoteById(quoteId, shareToken) {
  if (!isQuoteCaptureConfigured()) return null;

  const spreadsheetId = getSpreadsheetId();
  const sheets = await getSheetsClient();
  const tab = getQuotesTab();
  const rows = await readAllRows(sheets, spreadsheetId, tab);

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][COL.QUOTE_ID]) !== String(quoteId)) continue;
    const quote = rowToQuote(rows[i]);
    if (!quote) return null;
    if (shareToken && quote.shareToken !== shareToken) return null;
    return quote;
  }
  return null;
}

async function listQuotes(limit = 50) {
  const spreadsheetId = getSpreadsheetId();
  if (!isQuoteCaptureConfigured()) {
    return { configured: false, quotes: [] };
  }

  const sheets = await getSheetsClient();
  const tab = getQuotesTab();
  const rows = await readAllRows(sheets, spreadsheetId, tab);
  const quotes = rows
    .slice(1)
    .map(rowToQuote)
    .filter(Boolean)
    .reverse()
    .slice(0, Math.max(1, Math.min(limit, 200)));

  return {
    configured: true,
    sheetId: spreadsheetId,
    tab,
    count: quotes.length,
    quotes,
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderQuoteLineRows(lineItems) {
  const parts = String(lineItems || "")
    .split(/\s·\s|\n|;/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (!parts.length) {
    return `<tr><td colspan="2">${escapeHtml(lineItems || "—")}</td></tr>`;
  }

  return parts
    .map((part) => {
      const amountMatch = part.match(/=\s*(₱[\d,]+)\s*$/);
      const amount = amountMatch ? amountMatch[1] : "";
      const label = amountMatch
        ? part.slice(0, amountMatch.index).replace(/=\s*$/, "").trim()
        : part;
      return `<tr><td>${escapeHtml(label)}</td><td style="text-align:right">${escapeHtml(amount)}</td></tr>`;
    })
    .join("");
}

function renderQuoteHtml(quote, baseUrl) {
  const validLine = quote.validUntil
    ? `Valid until ${quote.validUntil}`
    : "Valid for 7 days from issue date";

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Beantol Quote ${quote.quoteId}</title>
<style>
body{font-family:Georgia,serif;max-width:640px;margin:32px auto;padding:0 20px;color:#1a1a1a}
header{border-bottom:3px solid #2d6a4f;padding-bottom:16px;margin-bottom:24px}
h1{font-size:1.5rem;margin:0 0 4px;color:#2d6a4f}
.meta{color:#555;font-size:14px;margin:4px 0}
table{width:100%;border-collapse:collapse;margin:20px 0}
th,td{border:1px solid #ddd;padding:10px;text-align:left}
th{background:#f5f5f5}
.total{font-size:1.25rem;font-weight:bold;text-align:right;margin-top:16px}
.foot{margin-top:32px;font-size:13px;color:#666;border-top:1px solid #eee;padding-top:16px}
@media print{body{margin:0}}
</style></head><body>
<header>
<h1>Beantol Specialty Coffee</h1>
<p class="meta">Formal quotation · ${quote.quoteId}</p>
<p class="meta">Issued ${(quote.created || "").slice(0, 10)} · ${validLine}</p>
</header>
<p><strong>Prepared for:</strong> ${quote.name || "Customer"}${quote.phone ? ` · ${quote.phone}` : ""}</p>
<table>
<tr><th>Item</th><th style="text-align:right">Amount</th></tr>
${renderQuoteLineRows(quote.lineItems)}
</table>
<p class="total">Total: ${formatPeso(quote.subtotal)}</p>
<div class="foot">
<p>Prices in Philippine Pesos (₱). Espresso and filter roasts are different products.</p>
<p>Wholesale: 6 kg minimum on eligible espresso beans. Delivery via Maxim — customer pays rider fee.</p>
<p>Questions? Message us on Facebook or Instagram @beantol, or visit the shop Mon–Fri.</p>
${baseUrl ? `<p style="font-size:11px;color:#999">View online: ${baseUrl}</p>` : ""}
</div>
</body></html>`;
}

module.exports = {
  isQuoteCaptureConfigured,
  getQuotesTab,
  shouldCreateQuote,
  recordQuote,
  getQuoteById,
  listQuotes,
  renderQuoteHtml,
  QUOTE_VALID_DAYS,
};
