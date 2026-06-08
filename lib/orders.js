const { google } = require("googleapis");
const { getGoogleAuth, hasGoogleCredentials } = require("./google-auth");
const { buildQuoteFromText, formatPeso } = require("./pricing");
const { mergeQuoteLineItems } = require("./quotes");
const {
  getLeadsSheetId,
  getOrdersSheetTab,
  isOrderCaptureEnabledForTenant,
} = require("./tenant-google");

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

const HEADERS = [
  "Order ID",
  "Created",
  "Updated",
  "Platform",
  "Sender ID",
  "Name",
  "Phone",
  "Bean",
  "Size",
  "Fulfillment",
  "Address",
  "Payment status",
  "Order status",
  "Last message",
  "Notes",
  "Line items",
  "Subtotal",
];

const COL = {
  ORDER_ID: 0,
  CREATED: 1,
  UPDATED: 2,
  PLATFORM: 3,
  SENDER_ID: 4,
  NAME: 5,
  PHONE: 6,
  BEAN: 7,
  SIZE: 8,
  FULFILLMENT: 9,
  ADDRESS: 10,
  PAYMENT_STATUS: 11,
  ORDER_STATUS: 12,
  LAST_MESSAGE: 13,
  NOTES: 14,
  LINE_ITEMS: 15,
  SUBTOTAL: 16,
};

const TERMINAL_ORDER_STATUSES = new Set(["completed", "cancelled"]);

const ORDER_STATUS_RANK = {
  inquiry: 1,
  pending: 2,
  awaiting_payment: 3,
  confirmed: 4,
  dispatched: 5,
  completed: 6,
  cancelled: 0,
};

function isOrderCaptureConfigured() {
  return isOrderCaptureEnabledForTenant() && hasGoogleCredentials();
}

function getOrdersTab() {
  return getOrdersSheetTab();
}

function getSpreadsheetId() {
  return getLeadsSheetId();
}

async function getSheetsClient() {
  const auth = getGoogleAuth([SHEETS_SCOPE]);
  return google.sheets({ version: "v4", auth });
}

function truncate(text, max = 500) {
  const s = String(text || "").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

async function ensureHeaders(sheets, spreadsheetId, tab) {
  const range = `${tab}!A1:Q1`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const first = res.data.values?.[0] || [];
  if (
    first[0] === HEADERS[0] &&
    first.length >= HEADERS.length &&
    first[COL.LINE_ITEMS] === HEADERS[COL.LINE_ITEMS]
  ) {
    return;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tab}!A1:Q1`,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });
}

async function readAllRows(sheets, spreadsheetId, tab) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A:Q`,
  });
  return res.data.values || [];
}

function rowToOrder(row) {
  if (!row || !row[COL.ORDER_ID]) return null;
  return {
    orderId: row[COL.ORDER_ID] || "",
    created: row[COL.CREATED] || "",
    updated: row[COL.UPDATED] || "",
    platform: row[COL.PLATFORM] || "",
    senderId: row[COL.SENDER_ID] || "",
    name: row[COL.NAME] || "",
    phone: row[COL.PHONE] || "",
    bean: row[COL.BEAN] || "",
    size: row[COL.SIZE] || "",
    fulfillment: row[COL.FULFILLMENT] || "",
    address: row[COL.ADDRESS] || "",
    paymentStatus: row[COL.PAYMENT_STATUS] || "",
    orderStatus: row[COL.ORDER_STATUS] || "",
    lastMessage: row[COL.LAST_MESSAGE] || "",
    notes: row[COL.NOTES] || "",
    lineItems: row[COL.LINE_ITEMS] || "",
    subtotal: Number(row[COL.SUBTOTAL]) || 0,
  };
}

function formatOrderProductFields(lineData, signal = {}) {
  const items = lineData?.lineItems || [];
  if (items.length === 0) {
    return { bean: signal.bean || "", size: signal.size || "" };
  }
  if (items.length === 1) {
    return { bean: items[0].productLabel, size: items[0].size };
  }
  return {
    bean: items.map((item) => `${item.productLabel} ${item.size}`).join(", "),
    size: "",
  };
}

function buildOrderLineData(userText, options = {}) {
  const { historyTexts = [], assistantReply = "" } = options;
  return buildQuoteFromText(userText, { historyTexts, assistantReply });
}

function generateOrderId(rows) {
  const d = new Date();
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, "");
  const todayPrefix = d.toISOString().slice(0, 10);
  let count = 0;
  for (let i = 1; i < rows.length; i++) {
    const created = rows[i][COL.CREATED] || "";
    if (String(created).startsWith(todayPrefix)) count += 1;
  }
  return `BT-${ymd}-${String(count + 1).padStart(4, "0")}`;
}

function mergeOrderStatus(existing, incoming) {
  if (!existing) return incoming || "inquiry";
  if (!incoming) return existing;
  const existingRank = ORDER_STATUS_RANK[String(existing).toLowerCase()] || 0;
  const incomingRank = ORDER_STATUS_RANK[String(incoming).toLowerCase()] || 0;
  if (TERMINAL_ORDER_STATUSES.has(String(existing).toLowerCase())) return existing;
  return incomingRank >= existingRank ? incoming : existing;
}

function findActiveOrder(rows, senderId) {
  for (let i = rows.length - 1; i >= 1; i--) {
    if (String(rows[i][COL.SENDER_ID]) !== String(senderId)) continue;
    const status = String(rows[i][COL.ORDER_STATUS] || "").toLowerCase();
    if (!TERMINAL_ORDER_STATUSES.has(status)) {
      return { rowIndex: i, row: rows[i] };
    }
  }
  return null;
}

async function recordOrder(payload) {
  const spreadsheetId = getSpreadsheetId();
  if (!isOrderCaptureConfigured()) {
    return { skipped: true, reason: "Order capture not configured" };
  }

  const {
    senderId,
    platform = "messenger",
    name = "",
    phone = "",
    bean = "",
    size = "",
    fulfillment = "",
    address = "",
    paymentStatus = "unpaid",
    orderStatus = "inquiry",
    lastMessage = "",
    trigger = "",
    userText = "",
    historyTexts = [],
    assistantReply = "",
    lineItems = "",
    subtotal = 0,
  } = payload;

  if (!senderId) {
    return { skipped: true, reason: "Missing senderId" };
  }

  const sheets = await getSheetsClient();
  const tab = getOrdersTab();
  await ensureHeaders(sheets, spreadsheetId, tab);

  const rows = await readAllRows(sheets, spreadsheetId, tab);
  const now = new Date().toISOString();
  const active = findActiveOrder(rows, senderId);
  const isNew = !active;
  const existing = active?.row || null;
  const rowIndex = active?.rowIndex ?? -1;

  const lineData = buildOrderLineData(userText || lastMessage, {
    historyTexts,
    assistantReply,
  });
  const parsedQuote = lineData || {
    lineItems: [],
    summary: lineItems || "",
    subtotal: Number(subtotal) || 0,
  };
  const mergedQuote = mergeQuoteLineItems(
    String(existing?.[COL.LINE_ITEMS] || ""),
    parsedQuote,
    [userText, lastMessage, ...historyTexts, assistantReply].filter(Boolean),
    {}
  );
  const productFields = formatOrderProductFields(mergedQuote, { bean, size });

  const mergedStatus = mergeOrderStatus(existing?.[COL.ORDER_STATUS], orderStatus);
  const mergedPayment =
    paymentStatus === "paid" || existing?.[COL.PAYMENT_STATUS] === "paid"
      ? "paid"
      : paymentStatus || existing?.[COL.PAYMENT_STATUS] || "unpaid";

  const orderId = existing?.[COL.ORDER_ID] || generateOrderId(rows);
  const mergedRow = [
    orderId,
    existing?.[COL.CREATED] || now,
    now,
    platform || existing?.[COL.PLATFORM] || "",
    String(senderId),
    name || existing?.[COL.NAME] || "",
    phone || existing?.[COL.PHONE] || "",
    productFields.bean || bean || existing?.[COL.BEAN] || "",
    productFields.size || size || existing?.[COL.SIZE] || "",
    fulfillment || existing?.[COL.FULFILLMENT] || "",
    address || existing?.[COL.ADDRESS] || "",
    mergedPayment,
    mergedStatus,
    truncate(lastMessage) || existing?.[COL.LAST_MESSAGE] || "",
    existing?.[COL.NOTES] || "",
    mergedQuote.summary || "",
    mergedQuote.subtotal || 0,
  ];

  const statusChanged = !isNew && existing?.[COL.ORDER_STATUS] !== mergedStatus;
  const paymentChanged =
    !isNew && existing?.[COL.PAYMENT_STATUS] !== mergedPayment && mergedPayment === "paid";
  const itemsChanged =
    !isNew && String(existing?.[COL.LINE_ITEMS] || "") !== String(mergedQuote.summary || "");

  if (isNew) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${tab}!A:Q`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [mergedRow] },
    });
  } else {
    const sheetRow = rowIndex + 1;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tab}!A${sheetRow}:Q${sheetRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [mergedRow] },
    });
  }

  const order = rowToOrder(mergedRow);
  console.log(
    `Order ${isNew ? "created" : "updated"}: ${orderId} sender=${senderId} status=${mergedStatus} (${trigger || "—"})`
  );

  return {
    ok: true,
    isNew,
    statusChanged,
    paymentChanged,
    order,
    notify: isNew || statusChanged || paymentChanged || itemsChanged,
  };
}

const ADMIN_ORDER_STATUSES = [
  "inquiry",
  "pending",
  "awaiting_payment",
  "confirmed",
  "dispatched",
  "completed",
  "cancelled",
];

async function findOrderRow(orderId) {
  const spreadsheetId = getSpreadsheetId();
  if (!isOrderCaptureConfigured() || !orderId) return null;

  const sheets = await getSheetsClient();
  const tab = getOrdersTab();
  const rows = await readAllRows(sheets, spreadsheetId, tab);

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][COL.ORDER_ID]) === String(orderId)) {
      return { rowIndex: i, row: rows[i], order: rowToOrder(rows[i]) };
    }
  }
  return null;
}

async function updateOrderFields(orderId, fields = {}) {
  const spreadsheetId = getSpreadsheetId();
  if (!isOrderCaptureConfigured()) {
    return { skipped: true, reason: "Order capture not configured" };
  }

  const found = await findOrderRow(orderId);
  if (!found) return { skipped: true, reason: "Order not found" };

  const { orderStatus, paymentStatus, notes } = fields;
  const existing = found.row;
  const now = new Date().toISOString();

  if (orderStatus && !ADMIN_ORDER_STATUSES.includes(String(orderStatus).toLowerCase())) {
    return { skipped: true, reason: `Invalid order status: ${orderStatus}` };
  }
  if (paymentStatus && !["unpaid", "paid"].includes(String(paymentStatus).toLowerCase())) {
    return { skipped: true, reason: `Invalid payment status: ${paymentStatus}` };
  }

  const merged = [...existing];
  merged[COL.UPDATED] = now;
  if (orderStatus !== undefined) merged[COL.ORDER_STATUS] = String(orderStatus).toLowerCase();
  if (paymentStatus !== undefined) merged[COL.PAYMENT_STATUS] = String(paymentStatus).toLowerCase();
  if (notes !== undefined) merged[COL.NOTES] = notes;

  const sheetRow = found.rowIndex + 1;
  const sheets = await getSheetsClient();
  const tab = getOrdersTab();
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tab}!A${sheetRow}:O${sheetRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [merged] },
  });

  const order = rowToOrder(merged);
  console.log(`Order fields updated: ${orderId} status=${order.orderStatus}`);
  return { ok: true, order };
}

async function listOrders(limit = 50) {
  const spreadsheetId = getSpreadsheetId();
  if (!isOrderCaptureConfigured()) {
    return { configured: false, orders: [] };
  }

  const sheets = await getSheetsClient();
  const tab = getOrdersTab();
  const rows = await readAllRows(sheets, spreadsheetId, tab);
  const orders = rows
    .slice(1)
    .map(rowToOrder)
    .filter(Boolean)
    .reverse()
    .slice(0, Math.max(1, Math.min(limit, 200)));

  return {
    configured: true,
    sheetId: spreadsheetId,
    tab,
    count: orders.length,
    orders,
  };
}

module.exports = {
  isOrderCaptureConfigured,
  recordOrder,
  listOrders,
  findOrderRow,
  updateOrderFields,
  getOrdersTab,
  ADMIN_ORDER_STATUSES,
  buildOrderLineData,
  formatOrderProductFields,
};
