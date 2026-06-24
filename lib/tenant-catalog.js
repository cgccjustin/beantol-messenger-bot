const { CATALOG_PRODUCTS, findCatalogProduct: findBeantolProduct } = require("./catalog");
const { getActiveTenant } = require("./tenant-context");

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
  if (t?.rules?.profile === "cafe") return TENANT_CATALOGS[id] || [];
  return CATALOG_PRODUCTS;
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
  getRoasteryCatalogProducts,
  findRoasteryProduct,
};
