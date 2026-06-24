const { CATALOG_PRODUCTS, findCatalogProduct: findBeantolProduct } = require("./catalog");
const { getActiveTenant } = require("./tenant-context");
const { resolveProfile } = require("./tenant-system-rules");

/** Menu SKUs for inventory / admin — separate from Beantol roast catalog. */
const OFFBEAT_BREW_PRODUCTS = [
  { id: "offbeat-black", label: "Offbeat Black", keys: ["offbeat black", "black"] },
  { id: "offbeat-white", label: "Offbeat White", keys: ["offbeat white", "white"] },
  { id: "offbeat-mocha", label: "Offbeat Mocha", keys: ["offbeat mocha", "mocha"] },
  { id: "offbeat-dulce", label: "Offbeat Dulce", keys: ["offbeat dulce", "dulce"] },
  { id: "choco-unplugged", label: "Choco Unplugged", keys: ["choco unplugged", "choco"] },
  { id: "matcha-unplugged", label: "Matcha Unplugged", keys: ["matcha unplugged", "matcha"] },
  {
    id: "strawberry-unplugged",
    label: "Strawberry Unplugged",
    keys: ["strawberry unplugged", "strawberry"],
  },
];

const TENANT_CATALOGS = {
  "offbeat-brew": OFFBEAT_BREW_PRODUCTS,
};

function activeTenant(tenant) {
  return tenant || getActiveTenant();
}

function getCatalogProducts(tenant) {
  const t = activeTenant(tenant);
  const id = t?.id;
  if (id && TENANT_CATALOGS[id]) return TENANT_CATALOGS[id];
  if (resolveProfile(t) === "beantol") return CATALOG_PRODUCTS;
  return TENANT_CATALOGS[id] || [];
}

function findCatalogProduct(token, tenant) {
  const products = getCatalogProducts(tenant);
  const t = String(token || "").trim().toLowerCase();
  if (!t) return null;
  return (
    products.find(
      (p) => p.id === t || p.label.toLowerCase() === t || p.keys.some((k) => k === t)
    ) || null
  );
}

function getCatalogProductById(productId, tenant) {
  return getCatalogProducts(tenant).find((p) => p.id === productId) || null;
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** All menu/catalog products mentioned in customer text (tenant-aware). */
function matchAllCatalogProductsFromText(text, tenant) {
  const products = getCatalogProducts(tenant);
  const t = String(text || "").toLowerCase();
  if (!t || !products.length) return [];

  const found = new Set();
  const results = [];
  const candidates = [];
  for (const product of products) {
    for (const key of product.keys || []) {
      candidates.push({ product, key, len: key.length });
    }
    const labelKey = product.label.toLowerCase();
    candidates.push({ product, key: labelKey, len: labelKey.length });
  }
  candidates.sort((a, b) => b.len - a.len);

  for (const { product, key } of candidates) {
    if (found.has(product.id)) continue;
    if (!new RegExp(`\\b${escapeRegExp(key)}\\b`).test(t)) continue;
    found.add(product.id);
    results.push(product);
  }
  return results;
}

function matchCatalogFromText(text, tenant) {
  const products = getCatalogProducts(tenant);
  const t = String(text || "").toLowerCase();
  if (!t || !products.length) return null;

  let best = null;
  let bestLen = 0;
  for (const product of products) {
    const keys = [...(product.keys || []), product.label.toLowerCase()];
    for (const key of keys) {
      if (!new RegExp(`\\b${escapeRegExp(key)}\\b`).test(t)) continue;
      if (key.length > bestLen) {
        best = product;
        bestLen = key.length;
      }
    }
  }
  return best;
}

const ROASTERY_PRODUCT_IDS = new Set(CATALOG_PRODUCTS.map((p) => p.id));

/** Café sheet rows that look like Beantol roast SKUs (wrong seed or wrong tenant view). */
function inventoryHasWrongCatalogRows(items, tenant) {
  if (!items?.length) return false;
  const t = activeTenant(tenant);
  if (resolveProfile(t) === "beantol") return false;
  const catalogIds = new Set(getCatalogProducts(t).map((p) => p.id));
  if (!catalogIds.size) return false;
  return items.some((item) => ROASTERY_PRODUCT_IDS.has(item.productId) && !catalogIds.has(item.productId));
}

function refusesRoasterySeed(tenant) {
  const t = activeTenant(tenant);
  if (resolveProfile(t) === "beantol") return false;
  const products = getCatalogProducts(t);
  if (!products.length) return true;
  return products.some((p) => ROASTERY_PRODUCT_IDS.has(p.id));
}

/** Beantol roast SKUs — pricing, quotes, recommendations only. */
function getRoasteryCatalogProducts() {
  return CATALOG_PRODUCTS;
}

function findRoasteryProduct(token) {
  return findBeantolProduct(token);
}

module.exports = {
  OFFBEAT_BREW_PRODUCTS,
  getCatalogProducts,
  getCatalogProductById,
  findCatalogProduct,
  matchCatalogFromText,
  matchAllCatalogProductsFromText,
  inventoryHasWrongCatalogRows,
  refusesRoasterySeed,
  getRoasteryCatalogProducts,
  findRoasteryProduct,
};
