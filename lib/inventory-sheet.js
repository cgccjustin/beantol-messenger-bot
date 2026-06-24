const { google } = require("googleapis");
const { getGoogleAuth, hasGoogleCredentials } = require("./google-auth");
const { CATALOG_PRODUCTS, findCatalogProduct } = require("./catalog");
const { getLeadsSheetId, getInventorySheetTab } = require("./tenant-google");
const { getActiveTenant } = require("./tenant-context");

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

let cacheByTenant = new Map();
const CACHE_MS = Number(process.env.INVENTORY_CACHE_MINUTES || 5) * 60 * 1000;

function isInventorySheetConfigured() {
  if (process.env.INVENTORY_SHEET_ENABLED === "false") return false;
  return Boolean(getLeadsSheetId() && hasGoogleCredentials());
}

function getInventoryTab() {
  return getInventorySheetTab();
}

function getSpreadsheetId() {
  return getLeadsSheetId();
}

function getTenantCache() {
  const tenantId = getActiveTenant()?.id || "default";
  if (!cacheByTenant.has(tenantId)) {
    cacheByTenant.set(tenantId, {
      at: 0,
      unavailable: [],
      unavailableIds: [],
      lowStock: [],
      rows: [],
    });
  }
  return cacheByTenant.get(tenantId);
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

function normalizeInventoryStatus(raw) {
  const s = String(raw || "in_stock")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (s === "out_of_stock" || s === "outofstock" || s === "oos") return "out_of_stock";
  if (s === "low" || s === "low_stock") return "low";
  return VALID_STATUSES.has(s) ? s : "in_stock";
}

function itemIsOutOfStock(item) {
  if (!item) return false;
  if (normalizeInventoryStatus(item.status) === "out_of_stock") return true;
  const qty = parseQty(item.qty);
  return qty === 0;
}

function resolveProductId(productIdCell, nameCell) {
  const idRaw = String(productIdCell || "").trim();
  if (idRaw) {
    const byId = CATALOG_PRODUCTS.find((p) => p.id === idRaw);
    if (byId) return byId.id;
    const byKey = findCatalogProduct(idRaw);
    if (byKey) return byKey.id;
  }
  const nameRaw = String(nameCell || productIdCell || "").trim();
  if (nameRaw) {
    const byName = findCatalogProduct(nameRaw);
    if (byName) return byName.id;
  }
  return idRaw || "";
}

function rowToItem(row) {
  if (!row || !row.length) return null;
  const productId = resolveProductId(row[COL.PRODUCT_ID], row[COL.NAME]);
  if (!productId) return null;
  const status = normalizeInventoryStatus(row[COL.STATUS]);
  const catalog = CATALOG_PRODUCTS.find((p) => p.id === productId);
  return {
    productId,
    name: row[COL.NAME] || catalog?.label || productId,
    status,
    qty: row[COL.QTY] ?? "",
    updated: row[COL.UPDATED] || "",
    notes: row[COL.NOTES] || "",
  };
}

function resolveCatalogLabel(item) {
  const product = CATALOG_PRODUCTS.find((p) => p.id === item.productId);
  return product?.label || item.name;
}

function buildCacheFromItems(items) {
  const unavailableItems = items.filter(itemIsOutOfStock);
  const unavailable = unavailableItems.map((i) => resolveCatalogLabel(i)).filter(Boolean);
  const unavailableIds = unavailableItems.map((i) => i.productId).filter(Boolean);
  const lowStock = items.filter((i) => isLowStockItem(i)).map((i) => resolveCatalogLabel(i));
  return { unavailable, unavailableIds, lowStock, rows: items };
}

async function loadInventory(force = false) {
  if (!isInventorySheetConfigured()) {
    return { configured: false, items: [], unavailable: [], lowStock: [] };
  }

  const cache = getTenantCache();
  const cacheFresh =
    !force && cache.at && Date.now() - cache.at < CACHE_MS && (cache.rows?.length || 0) > 0;
  if (cacheFresh) {
    return {
      configured: true,
      items: cache.rows,
      unavailable: cache.unavailable,
      lowStock: cache.lowStock,
      tab: getInventoryTab(),
      sheetId: getSpreadsheetId(),
      tenantId: getActiveTenant()?.id || null,
    };
  }

  const spreadsheetId = getSpreadsheetId();
  const sheets = await getSheetsClient();
  const tab = getInventoryTab();
  await ensureHeadersAndSeed(sheets, spreadsheetId, tab);

  const rows = await readAllRows(sheets, spreadsheetId, tab);
  const rawRowCount = rows.length;
  const items = rows.slice(1).map(rowToItem).filter(Boolean);
  const dataRowCount = Math.max(0, rawRowCount - 1);

  if (dataRowCount > 0 && items.length === 0) {
    const msg =
      `Inventory tab "${tab}" has ${dataRowCount} data row(s) but none parsed — ` +
      "check column A is Product ID (or product name matching catalog).";
    console.warn(msg, { spreadsheetId, tab, tenantId: getActiveTenant()?.id });
    return {
      configured: true,
      items: [],
      unavailable: [],
      lowStock: [],
      tab,
      sheetId: spreadsheetId,
      tenantId: getActiveTenant()?.id || null,
      rawRowCount,
      dataRowCount,
      parseError: msg,
    };
  }

  const built = buildCacheFromItems(items);

  cache.at = Date.now();
  Object.assign(cache, built);
  return {
    configured: true,
    items,
    unavailable: built.unavailable,
    lowStock: built.lowStock,
    tab,
    sheetId: spreadsheetId,
    tenantId: getActiveTenant()?.id || null,
    rawRowCount,
    dataRowCount,
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

  getTenantCache().at = 0;
  const item = rowToItem(merged);
  console.log(`Inventory updated: ${productId} → ${finalStatus} qty=${qtyValue || "—"}`);
  return { ok: true, item };
}

/** @deprecated use updateProductFields */
async function updateProductStatus(productId, status, notes = "") {
  return updateProductFields(productId, { status, notes });
}

function getCachedUnavailableLabels() {
  return getTenantCache().unavailable || [];
}

function getCachedUnavailableProductIds() {
  return getTenantCache().unavailableIds || [];
}

function getCachedLowStockLabels() {
  return getTenantCache().lowStock || [];
}

function getCachedInventoryItems() {
  return getTenantCache().rows || [];
}

/** Ensure sheet inventory is loaded before sync reads (cold start / stale cache). */
async function ensureInventoryLoaded() {
  if (!isInventorySheetConfigured()) return;
  const cache = getTenantCache();
  const stale = !cache.at || Date.now() - cache.at >= CACHE_MS;
  const empty = !cache.rows?.length;
  if (!stale && !empty) return;

  try {
    await loadInventory(empty || stale);
  } catch (err) {
    console.warn("ensureInventoryLoaded:", err.message, { tenantId: getActiveTenant()?.id });
  }
}

module.exports = {
  isInventorySheetConfigured,
  getInventoryTab,
  getLowStockThreshold,
  listInventory,
  refreshInventoryCache,
  ensureInventoryLoaded,
  updateProductFields,
  updateProductStatus,
  itemIsOutOfStock,
  normalizeInventoryStatus,
  getCachedUnavailableLabels,
  getCachedUnavailableProductIds,
  getCachedLowStockLabels,
  getCachedInventoryItems,
  parseQty,
  isLowStockItem,
  VALID_STATUSES,
};
