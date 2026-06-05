const { matchCatalogFromText } = require("./catalog");

/** Canonical retail prices (₱) — matches knowledge base template */

const RETAIL_PRICES = {
  "beantol-prime": { "250g": 420, "500g": 780, "1kg": 1450, wholesale: 1350 },
  "brazil-santos": { "250g": 450, "500g": 800, "1kg": 1500, wholesale: 1400 },
  "brazil-cerrado": { "250g": 500, "500g": 900, "1kg": 1550, wholesale: 1450 },
  "ethiopia-guji-espresso": { "250g": 850, "500g": 1350, "1kg": 1850 },
  "ethiopia-sidama": { "250g": 800, "500g": 1300, "1kg": 1700 },
  "mt-apo": { "250g": 700 },
  "mt-apo-ellaga": { "250g": 900 },
  "guji-filter": { "250g": 800 },
  "kenya-filter": { "250g": 900 },
};

const WHOLESALE_MOQ_KG = 6;

function normalizeSize(size) {
  const s = String(size || "").trim().toLowerCase().replace(/\s+/g, "");
  if (!s) return "";
  if (s === "6kg") return "wholesale";
  if (["250g", "500g", "1kg"].includes(s)) return s;
  return "";
}

function formatPeso(amount) {
  return `₱${Number(amount).toLocaleString("en-PH")}`;
}

function getUnitPrice(productId, size, options = {}) {
  const prices = RETAIL_PRICES[productId];
  if (!prices) return null;

  const normalized = normalizeSize(size);
  if (!normalized) return null;

  if (normalized === "wholesale") {
    if (!prices.wholesale || options.wholesale === false) return null;
    return prices.wholesale;
  }

  return prices[normalized] ?? null;
}

function buildLineItem(product, size, qty = 1, options = {}) {
  const normalized = normalizeSize(size);
  const isWholesale = normalized === "wholesale";
  const unitPrice = getUnitPrice(product.id, normalized, options);
  if (unitPrice == null) return null;

  const quantity = Math.max(1, Number(qty) || 1);
  let lineQty;
  let description;

  if (isWholesale) {
    lineQty = WHOLESALE_MOQ_KG * quantity;
    description = `${product.label} — wholesale ${lineQty} kg @ ${formatPeso(unitPrice)}/kg`;
  } else {
    lineQty = quantity;
    description = `${product.label} — ${normalized} × ${lineQty}`;
  }

  const lineTotal = isWholesale ? unitPrice * lineQty : unitPrice * lineQty;

  return {
    productId: product.id,
    productLabel: product.label,
    size: normalized,
    qty: lineQty,
    unitPrice,
    lineTotal,
    description,
    display: `${description} = ${formatPeso(lineTotal)}`,
  };
}

function buildQuoteFromText(text, options = {}) {
  const { bean = "", size = "", qty = 1, wholesale = false } = options;
  const combined = [bean, size, text].filter(Boolean).join(" ");

  const product = matchCatalogFromText(combined);
  if (!product) return null;

  const sizeMatch = combined.match(/\b(250g|500g|1kg|6\s*kg)\b/i);
  let resolvedSize = normalizeSize(size) || (sizeMatch ? normalizeSize(sizeMatch[0]) : "");

  if (!resolvedSize) {
    resolvedSize = product.roast === "filter" ? "250g" : "250g";
  }

  if (wholesale || /\b(?:wholesale|bulk|6\s*kg)\b/i.test(combined)) {
    if (product.roast === "filter") return null;
    resolvedSize = "wholesale";
  }

  const line = buildLineItem(product, resolvedSize, qty, { wholesale: true });
  if (!line) return null;

  return {
    lineItems: [line],
    subtotal: line.lineTotal,
    summary: line.display,
  };
}

module.exports = {
  RETAIL_PRICES,
  WHOLESALE_MOQ_KG,
  normalizeSize,
  formatPeso,
  getUnitPrice,
  buildLineItem,
  buildQuoteFromText,
};
