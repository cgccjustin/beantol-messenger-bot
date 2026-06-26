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

/** Menu SKUs — longer / more specific keys first in array helps matching order. */
const KAPE_KRISTIANO_PRODUCTS = [
  { id: "kk-spanish-latte-hot", label: "Spanish Latte (hot)", keys: ["spanish latte hot", "hot spanish latte"] },
  {
    id: "kk-spanish-latte-cold",
    label: "Spanish Latte (cold)",
    keys: ["spanish latte cold", "cold spanish latte", "spanish latte"],
  },
  { id: "kk-latte-hot", label: "Latte (hot)", keys: ["latte hot", "hot latte"] },
  { id: "kk-latte-cold", label: "Latte (cold)", keys: ["latte cold", "cold latte", "latte"] },
  { id: "kk-cappuccino-hot", label: "Cappuccino (hot)", keys: ["cappuccino hot", "hot cappuccino"] },
  {
    id: "kk-cappuccino-cold",
    label: "Cappuccino (cold)",
    keys: ["cappuccino cold", "cold cappuccino", "cappuccino"],
  },
  { id: "kk-americano-hot", label: "Americano (hot)", keys: ["americano hot", "hot americano"] },
  {
    id: "kk-americano-cold",
    label: "Americano (cold)",
    keys: ["americano cold", "cold americano", "americano"],
  },
  { id: "kk-mocha-hot", label: "Mocha (hot)", keys: ["mocha hot", "hot mocha"] },
  { id: "kk-mocha-cold", label: "Mocha (cold)", keys: ["mocha cold", "cold mocha", "mocha"] },
  {
    id: "kk-cloud-cream-brew",
    label: "Cloud Cream Brew",
    keys: ["cloud cream brew", "cloud cream"],
  },
  { id: "kk-white-brew", label: "White Brew", keys: ["white brew"] },
  { id: "kk-himalayan-latte", label: "Himalayan Latte", keys: ["himalayan latte", "himalayan"] },
  { id: "kk-fizzy-berry", label: "Fizzy Berry", keys: ["fizzy berry"] },
  { id: "kk-fizzy-cucumber", label: "Fizzy Cucumber", keys: ["fizzy cucumber"] },
  { id: "kk-fizzy-lemon", label: "Fizzy Lemon", keys: ["fizzy lemon"] },
  { id: "kk-pour-over", label: "Pour Over", keys: ["pour over", "pour-over", "pourover"] },
  {
    id: "kk-ensaymada-filled",
    label: "I Love You Ensaymada (with filling)",
    keys: ["ensaymada with filling", "ensaymada with fill", "ensaymada filled"],
  },
  {
    id: "kk-ensaymada-plain",
    label: "I Love You Ensaymada (without filling)",
    keys: ["ensaymada without filling", "ensaymada plain", "ensaymada"],
  },
  { id: "kk-tablea-tsokolate", label: "Tablea Tsokolate (hot)", keys: ["tablea tsokolate", "tablea", "tsokolate"] },
  { id: "kk-passion-fruit", label: "Passion Fruit", keys: ["passion fruit"] },
  { id: "kk-chocolate", label: "Chocolate", keys: ["chocolate"] },
  { id: "kk-strawberry", label: "Strawberry", keys: ["strawberry"] },
  { id: "kk-oolong-tea", label: "Oolong Tea (hot)", keys: ["oolong tea", "oolong"] },
  { id: "kk-carbonara", label: "Creamy Carbonara", keys: ["creamy carbonara", "carbonara"] },
  { id: "kk-pork-chop", label: "Pork Chop with Egg", keys: ["pork chop with egg", "pork chop"] },
  { id: "kk-sisig", label: "Sisig with Egg", keys: ["sisig with egg", "sisig"] },
  { id: "kk-humba", label: "Humba with Egg", keys: ["humba with egg", "humba"] },
  { id: "kk-ramyun", label: "Ramyun with Egg", keys: ["ramyun with egg", "ramyun", "ramen"] },
  { id: "kk-empanada", label: "Empanada (3 pcs)", keys: ["empanada"] },
  { id: "kk-flavored-fries", label: "Flavored Fries", keys: ["flavored fries", "fries"] },
  { id: "kk-garlic-bread", label: "Creamcheese Garlic Bread", keys: ["creamcheese garlic bread", "garlic bread"] },
  { id: "kk-cheesecake", label: "Cheesecake Delight", keys: ["cheesecake delight", "cheesecake"] },
  { id: "kk-siomai", label: "Siomai (3 pcs)", keys: ["siomai"] },
  { id: "kk-suman", label: "Suman Lihiya (3 pcs)", keys: ["suman lihiya", "suman"] },
  { id: "kk-bottled-water", label: "Bottled Water", keys: ["bottled water", "water"] },
  { id: "kk-rice", label: "1 Cup Rice", keys: ["cup rice", "rice"] },
  { id: "kk-egg-addon", label: "Egg (add-on)", keys: ["egg add-on", "extra egg"] },
];

const TENANT_CATALOGS = {
  "offbeat-brew": OFFBEAT_BREW_PRODUCTS,
  "kape-kristiano": KAPE_KRISTIANO_PRODUCTS,
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
  KAPE_KRISTIANO_PRODUCTS,
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
