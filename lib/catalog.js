/** Sellable SKUs — shared by inventory, pricing, and chat stock rules */

const CATALOG_PRODUCTS = [
  {
    id: "beantol-prime",
    label: "Beantol Prime",
    keys: ["beantol prime", "prime"],
    alternative: "Brazil Cerrado or Brazil Santos",
    roast: "espresso",
  },
  {
    id: "brazil-santos",
    label: "Brazil Santos",
    keys: ["brazil santos", "santos"],
    alternative: "Brazil Cerrado or Beantol Prime",
    roast: "espresso",
  },
  {
    id: "brazil-cerrado",
    label: "Brazil Cerrado",
    keys: ["brazil cerrado", "cerrado"],
    alternative: "Brazil Santos or Beantol Prime",
    roast: "espresso",
  },
  {
    id: "ethiopia-guji-espresso",
    label: "Ethiopia Guji (espresso)",
    keys: ["ethiopia guji", "guji espresso", "guji"],
    alternative: "Ethiopia Sidama or Beantol Prime",
    roast: "espresso",
  },
  {
    id: "ethiopia-sidama",
    label: "Ethiopia Sidama",
    keys: ["ethiopia sidama", "sidama"],
    alternative: "Ethiopia Guji or Brazil Cerrado",
    roast: "espresso",
  },
  {
    id: "mt-apo",
    label: "Mt. Apo (filter)",
    keys: ["mt apo", "mt. apo", "mount apo"],
    alternative: "Mt. Apo (Ellaga) or filter Guji",
    roast: "filter",
  },
  {
    id: "mt-apo-ellaga",
    label: "Mt. Apo (Ellaga)",
    keys: ["mt apo ellaga", "ellaga", "dione ellaga"],
    alternative: "Mt. Apo (filter) or filter Guji",
    roast: "filter",
  },
  {
    id: "guji-filter",
    label: "Guji (filter)",
    keys: ["guji filter", "filter guji"],
    alternative: "Kenya (filter) or Mt. Apo",
    roast: "filter",
  },
  {
    id: "kenya-filter",
    label: "Kenya (filter)",
    keys: ["kenya", "kenya filter", "filter kenya"],
    alternative: "Guji (filter) or Mt. Apo",
    roast: "filter",
  },
];

function findCatalogProduct(token) {
  const t = String(token || "").trim().toLowerCase();
  if (!t) return null;
  return (
    CATALOG_PRODUCTS.find(
      (p) =>
        p.id === t ||
        p.label.toLowerCase() === t ||
        p.keys.some((k) => k === t)
    ) || null
  );
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchCatalogFromText(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return null;

  const filterHint = /\b(?:filter|pour[- ]?over|v60|chemex|drip)\b/i.test(t);
  const espressoHint = /\b(?:espresso|latte|cappuccino|machine)\b/i.test(t);

  let best = null;
  let bestLen = 0;
  for (const product of CATALOG_PRODUCTS) {
    for (const key of product.keys) {
      if (!t.includes(key)) continue;
      if (product.roast === "espresso" && filterHint && !espressoHint && key === "guji") {
        continue;
      }
      if (product.roast === "filter" && espressoHint && !filterHint) {
        continue;
      }
      if (key.length > bestLen) {
        best = product;
        bestLen = key.length;
      }
    }
  }
  return best;
}

/** All catalog products mentioned in text (e.g. "Santos and Prime" → both). */
function matchAllCatalogProductsFromText(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return [];

  const filterHint = /\b(?:filter|pour[- ]?over|v60|chemex|drip)\b/i.test(t);
  const espressoHint = /\b(?:espresso|latte|cappuccino|machine)\b/i.test(t);
  const found = new Set();
  const results = [];

  for (const product of CATALOG_PRODUCTS) {
    if (found.has(product.id)) continue;
    for (const key of product.keys) {
      if (!new RegExp(`\\b${escapeRegExp(key)}\\b`).test(t)) continue;
      if (product.roast === "espresso" && filterHint && !espressoHint && key === "guji") {
        continue;
      }
      if (product.roast === "filter" && espressoHint && !filterHint) {
        continue;
      }
      found.add(product.id);
      results.push(product);
      break;
    }
  }
  return results;
}

module.exports = {
  CATALOG_PRODUCTS,
  findCatalogProduct,
  matchCatalogFromText,
  matchAllCatalogProductsFromText,
};
