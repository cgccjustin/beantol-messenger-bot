const { CATALOG_PRODUCTS, matchCatalogFromText } = require("./catalog");

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

const SIZE_PATTERN = /\b(250g|500g|1kg|6\s*kg)\b/gi;

function nearestSizeForProduct(text, productIndex, productLength) {
  const windowStart = Math.max(0, productIndex - 30);
  const windowEnd = Math.min(text.length, productIndex + productLength + 40);
  const window = text.slice(windowStart, windowEnd);
  const relKey = productIndex - windowStart + Math.floor(productLength / 2);

  let bestSize = "";
  let bestDist = Infinity;
  let match;
  const re = new RegExp(SIZE_PATTERN.source, "gi");
  while ((match = re.exec(window)) !== null) {
    const dist = Math.abs(match.index - relKey);
    if (dist < bestDist) {
      bestDist = dist;
      bestSize = normalizeSize(match[0]);
    }
  }
  return bestSize;
}

function findProductHits(text) {
  const lower = String(text || "").toLowerCase();
  if (!lower) return [];

  const filterHint = /\b(?:filter|pour[- ]?over|v60|chemex|drip)\b/i.test(text);
  const espressoHint = /\b(?:espresso|latte|cappuccino|machine)\b/i.test(text);

  const hits = [];
  for (const product of CATALOG_PRODUCTS) {
    for (const key of product.keys) {
      if (product.roast === "espresso" && filterHint && !espressoHint && key === "guji") {
        continue;
      }
      if (product.roast === "filter" && espressoHint && !filterHint) {
        continue;
      }

      let start = 0;
      while (start < lower.length) {
        const idx = lower.indexOf(key, start);
        if (idx === -1) break;
        hits.push({ product, key, index: idx, length: key.length });
        start = idx + 1;
      }
    }
  }

  hits.sort((a, b) => a.index - b.index || b.length - a.length);
  const filtered = [];
  for (const hit of hits) {
    const overlaps = filtered.some(
      (existing) =>
        hit.index < existing.index + existing.length &&
        hit.index + hit.length > existing.index
    );
    if (!overlaps) filtered.push(hit);
  }
  return filtered;
}

function parseLineItemsFromText(text, options = {}) {
  const { wholesale = false } = options;
  const source = String(text || "");
  if (!source.trim()) return [];

  const hits = findProductHits(source);
  const lines = [];
  const seen = new Set();

  for (const hit of hits) {
    let resolvedSize = nearestSizeForProduct(source, hit.index, hit.length);
    const window = source.slice(
      Math.max(0, hit.index - 30),
      Math.min(source.length, hit.index + hit.length + 40)
    );

    if (!resolvedSize) {
      resolvedSize = "250g";
    }

    if (wholesale || /\b(?:wholesale|bulk|6\s*kg)\b/i.test(window)) {
      if (hit.product.roast === "filter") continue;
      resolvedSize = "wholesale";
    }

    const key = `${hit.product.id}:${resolvedSize}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const line = buildLineItem(hit.product, resolvedSize, 1, { wholesale: true });
    if (line) lines.push(line);
  }

  return lines;
}

function buildQuoteFromText(text, options = {}) {
  const {
    bean = "",
    size = "",
    qty = 1,
    wholesale = false,
    historyTexts = [],
    assistantReply = "",
  } = options;

  const combined = [text, ...historyTexts, assistantReply, bean, size]
    .filter(Boolean)
    .join("\n");

  let lines = parseLineItemsFromText(combined, { wholesale });

  if (!lines.length) {
    const product = matchCatalogFromText(combined);
    if (!product) return null;

    const sizeMatch = combined.match(/\b(250g|500g|1kg|6\s*kg)\b/i);
    let resolvedSize = normalizeSize(size) || (sizeMatch ? normalizeSize(sizeMatch[0]) : "");

    if (!resolvedSize) {
      resolvedSize = "250g";
    }

    if (wholesale || /\b(?:wholesale|bulk|6\s*kg)\b/i.test(combined)) {
      if (product.roast === "filter") return null;
      resolvedSize = "wholesale";
    }

    const line = buildLineItem(product, resolvedSize, qty, { wholesale: true });
    if (!line) return null;
    lines = [line];
  }

  const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  return {
    lineItems: lines,
    subtotal,
    summary: lines.map((line) => line.display).join(" · "),
  };
}

module.exports = {
  RETAIL_PRICES,
  WHOLESALE_MOQ_KG,
  normalizeSize,
  formatPeso,
  getUnitPrice,
  buildLineItem,
  parseLineItemsFromText,
  buildQuoteFromText,
};
