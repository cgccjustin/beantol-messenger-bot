const { google } = require("googleapis");
const { getGoogleAuth, hasGoogleCredentials } = require("./google-auth");
const { CATALOG_PRODUCTS } = require("./catalog");

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

const HEADERS = ["Product ID", "Product name", "Status", "Qty", "Updated", "Notes"];

const COL = {
  PRODUCT_ID: 0,
  NAME: 1,
  STATUS: 2,
  QTY: 3,
  UPDATED: 4,
  NOTES: 5,
};

const VALID_STATUSES = new Set(["in_stock", "out_of_stock", "low"]);

function getLowStockThreshold() {
  return Math.max(0, Number(process.env.INVENTORY_LOW_STOCK_THRESHOLD || 3));
}

let cache = { at: 0, unavailable: [], lowStock: [], rows: [] };
const CACHE_MS = Number(process.env.INVENTORY_CACHE_MINUTES || 5) * 60 * 1000;

function isInventorySheetConfigured() {
  if (process.env.INVENTORY_SHEET_ENABLED === "false") return false;
  return Boolean(process.env.GOOGLE_LEADS_SHEET_ID?.trim() && hasGoogleCredentials());
}

function getInventoryTab() {
  return process.env.GOOGLE_INVENTORY_SHEET_TAB?.trim() || "Inventory";
}

function getSpreadsheetId() {
  return process.env.GOOGLE_LEADS_SHEET_ID?.trim();
}

function parseQty(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(String(value).trim());
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function resolveStatusFromQty(qty, requestedStatus) {
  const status = String(requestedStatus || "in_stock").toLowerCase();
  if (status === "out_of_stock") return "out_of_stock";
  if (qty === null) return VALID_STATUSES.has(status) ? status : "in_stock";
  if (qty === 0) return "out_of_stock";
  if (qty <= getLowStockThreshold()) return "low";
  return status === "low" ? "low" : "in_stock";
}

function isLowStockItem(item) {
  if (!item) return false;
  if (item.status === "low") return true;
  const qty = parseQty(item.qty);
  return qty !== null && qty > 0 && qty <= getLowStockThreshold();
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

async function readAllRows(sheets, spreadsheetId, tab) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A:F`,
  });
  return res.data.values || [];
}

async function ensureHeadersAndSeed(sheets, spreadsheetId, tab) {
  await ensureTabExists(sheets, spreadsheetId, tab);
  const rows = await readAllRows(sheets, spreadsheetId, tab);
  const first = rows[0] || [];

  if (!first.length || first[0] !== HEADERS[0]) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tab}!A1:F1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADERS] },
    });
  }

  if (rows.length <= 1) {
    const now = new Date().toISOString();
    const seed = CATALOG_PRODUCTS.map((p) => [
      p.id,
      p.label,
      "in_stock",
      "",
      now,
      "Seeded from bot catalog",
    ]);
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${tab}!A:F`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: seed },
    });
  }
}

function rowToItem(row) {
  if (!row || !row[COL.PRODUCT_ID]) return null;
  return {
    productId: row[COL.PRODUCT_ID] || "",
    name: row[COL.NAME] || "",
    status: String(row[COL.STATUS] || "in_stock").toLowerCase(),
    qty: row[COL.QTY] ?? "",
    updated: row[COL.UPDATED] || "",
    notes: row[COL.NOTES] || "",
  };
}

function buildCacheFromItems(items) {
  const unavailable = items
    .filter((i) => i.status === "out_of_stock")
    .map((i) => i.name);
  const lowStock = items.filter((i) => isLowStockItem(i)).map((i) => i.name);
  return { unavailable, lowStock, rows: items };
}

async function loadInventory(force = false) {
  if (!isInventorySheetConfigured()) {
    return { configured: false, items: [], unavailable: [], lowStock: [] };
  }

  if (!force && cache.at && Date.now() - cache.at < CACHE_MS) {
    return {
      configured: true,
      items: cache.rows,
      unavailable: cache.unavailable,
      lowStock: cache.lowStock,
    };
  }

  const spreadsheetId = getSpreadsheetId();
  const sheets = await getSheetsClient();
  const tab = getInventoryTab();
  await ensureHeadersAndSeed(sheets, spreadsheetId, tab);

  const rows = await readAllRows(sheets, spreadsheetId, tab);
  const items = rows.slice(1).map(rowToItem).filter(Boolean);
  const built = buildCacheFromItems(items);

  cache = { at: Date.now(), ...built };
  return {
    configured: true,
    items,
    unavailable: built.unavailable,
    lowStock: built.lowStock,
    tab,
    sheetId: spreadsheetId,
  };
}

async function listInventory() {
  return loadInventory(false);
}

async function refreshInventoryCache() {
  return loadInventory(true);
}

async function updateProductFields(productId, fields = {}) {
  if (!isInventorySheetConfigured()) {
    return { skipped: true, reason: "Inventory sheet not configured" };
  }

  const { status, qty, notes } = fields;

  const spreadsheetId = getSpreadsheetId();
  const sheets = await getSheetsClient();
  const tab = getInventoryTab();
  await ensureHeadersAndSeed(sheets, spreadsheetId, tab);

  const rows = await readAllRows(sheets, spreadsheetId, tab);
  let rowIndex = -1;
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][COL.PRODUCT_ID]) === String(productId)) {
      rowIndex = i;
      break;
    }
  }

  if (rowIndex === -1) {
    return { skipped: true, reason: "Product not found" };
  }

  const existing = rows[rowIndex];
  const existingQty = parseQty(existing[COL.QTY]);
  const parsedQty = qty !== undefined ? parseQty(qty) : null;
  const qtyForResolve = parsedQty !== null ? parsedQty : existingQty;
  const requestedStatus = status !== undefined ? status : existing[COL.STATUS];
  const finalStatus = resolveStatusFromQty(qtyForResolve, requestedStatus);

  const now = new Date().toISOString();
  const qtyValue =
    parsedQty !== null ? String(parsedQty) : existing[COL.QTY] ?? "";

  const merged = [
    existing[COL.PRODUCT_ID],
    existing[COL.NAME],
    finalStatus,
    qtyValue,
    now,
    notes !== undefined ? notes : existing[COL.NOTES] || "",
  ];

  const sheetRow = rowIndex + 1;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tab}!A${sheetRow}:F${sheetRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [merged] },
  });

  cache.at = 0;
  const item = rowToItem(merged);
  console.log(`Inventory updated: ${productId} → ${finalStatus} qty=${qtyValue || "—"}`);
  return { ok: true, item };
}

/** @deprecated use updateProductFields */
async function updateProductStatus(productId, status, notes = "") {
  return updateProductFields(productId, { status, notes });
}

function getCachedUnavailableLabels() {
  return cache.unavailable || [];
}

function getCachedLowStockLabels() {
  return cache.lowStock || [];
}

function getCachedInventoryItems() {
  return cache.rows || [];
}

module.exports = {
  isInventorySheetConfigured,
  getInventoryTab,
  getLowStockThreshold,
  listInventory,
  refreshInventoryCache,
  updateProductFields,
  updateProductStatus,
  getCachedUnavailableLabels,
  getCachedLowStockLabels,
  getCachedInventoryItems,
  parseQty,
  isLowStockItem,
  VALID_STATUSES,
};
