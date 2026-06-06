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
const SIZE_PATTERN = /\b(250g|500g|1kg|6\s*kg|\d+(?:\.\d+)?\s*(?:kg|kilograms?))\b/gi;
const BULK_KG_PATTERN = /\b(\d+(?:\.\d+)?)\s*(?:kg|kilograms?)\b/gi;

function isMoqMention(source, matchIndex, matchLength) {
  const start = Math.max(0, matchIndex - 40);
  const end = Math.min(source.length, matchIndex + matchLength + 20);
  const snippet = source.slice(start, end).toLowerCase();
  return /\b(?:minimum|min\.?\s*order|moq|at least)\b/.test(snippet);
}

function isOrderMention(source, matchIndex, matchLength) {
  const start = Math.max(0, matchIndex - 45);
  const end = Math.min(source.length, matchIndex + matchLength + 25);
  const snippet = source.slice(start, end).toLowerCase();
  return /\b(?:your order|order of|for your order|you.?d like|quantity|quote for|total would be|size:)\b/.test(
    snippet
  );
}

function parseAllKgAmounts(text) {
  const source = String(text || "");
  const amounts = [];
  const re = /\b(\d+(?:\.\d+)?)\s*(?:kg|kilograms?)\b/gi;
  let match;
  while ((match = re.exec(source)) !== null) {
    const kg = parseFloat(match[1]);
    if (!Number.isFinite(kg) || kg <= 0) continue;
    amounts.push({
      kg,
      index: match.index,
      length: match[0].length,
      isMoq: isMoqMention(source, match.index, match[0].length),
      isOrder: isOrderMention(source, match.index, match[0].length),
    });
  }
  return amounts;
}

function parseKgAmount(text) {
  const preferred = resolveOrderKg(text);
  if (preferred != null) return preferred;
  const amounts = parseAllKgAmounts(text).filter((a) => a.kg >= WHOLESALE_MOQ_KG && !a.isMoq);
  if (amounts.length) return Math.max(...amounts.map((a) => a.kg));
  const any = parseAllKgAmounts(text);
  return any.length ? any[0].kg : null;
}

/** Pick the customer's order qty — not MOQ boilerplate (e.g. prefer 8 kg over "minimum 6 kg"). */
function resolveOrderKg(text, options = {}) {
  const source = String(text || "");
  if (!source.trim()) return null;

  const orderPattern =
    /(?:your order of|for your order of|size:\s*|\border of)\s*(\d+(?:\.\d+)?)\s*(?:kilograms?|kg)\b/gi;
  const orderMatches = [];
  let match;
  while ((match = orderPattern.exec(source)) !== null) {
    const kg = parseFloat(match[1]);
    if (!Number.isFinite(kg) || kg < WHOLESALE_MOQ_KG) continue;
    if (isMoqMention(source, match.index, match[0].length)) continue;
    orderMatches.push(kg);
  }
  if (orderMatches.length) return Math.max(...orderMatches);

  const amounts = parseAllKgAmounts(source).filter((a) => a.kg >= WHOLESALE_MOQ_KG);
  if (!amounts.length) return null;

  const orderHits = amounts.filter((a) => a.isOrder && !a.isMoq);
  if (orderHits.length) return Math.max(...orderHits.map((a) => a.kg));

  const nonMoq = amounts.filter((a) => !a.isMoq);
  if (nonMoq.length) return Math.max(...nonMoq.map((a) => a.kg));

  if (options.allowMoqFallback) return Math.max(...amounts.map((a) => a.kg));
  return null;
}

function resolveBulkKg(source, hit, options = {}) {
  const { quoteUserText = "" } = options;
  if (hit.product.roast === "filter") return null;
  if (!RETAIL_PRICES[hit.product.id]?.wholesale) return null;

  const userKg = resolveOrderKg(quoteUserText);
  if (userKg != null) return userKg;

  const windowStart = Math.max(0, hit.index - 80);
  const windowEnd = Math.min(source.length, hit.index + hit.length + 80);
  const window = source.slice(windowStart, windowEnd);
  const windowKg = resolveOrderKg(window, { allowMoqFallback: false });
  if (windowKg != null) return windowKg;

  return resolveOrderKg(source, { allowMoqFallback: true });
}

function normalizeSize(size) {
  const s = String(size || "").trim().toLowerCase().replace(/\s+/g, "");
  if (!s) return "";
  if (s === "wholesale") return "wholesale";
  if (s === "6kg") return "wholesale";
  const kgOnly = s.match(/^(\d+(?:\.\d+)?)kg$/);
  if (kgOnly) {
    const kg = parseFloat(kgOnly[1]);
    if (kg === 1) return "1kg";
    if (kg >= WHOLESALE_MOQ_KG) return "wholesale";
  }
  if (["250g", "500g", "1kg"].includes(s)) return s;
  return "";
}

function formatPeso(amount) {
  return `₱${Number(amount).toLocaleString("en-PH")}`;
}

function retailSizesForProduct(product) {
  const prices = RETAIL_PRICES[product.id];
  if (!prices) return ["250g"];
  return Object.keys(prices).filter((size) => size !== "wholesale" && prices[size] != null);
}

function clampSizeForProduct(product, size) {
  const normalized = normalizeSize(size);
  const available = retailSizesForProduct(product);
  if (normalized && available.includes(normalized)) return normalized;
  if (product.roast === "filter") return "250g";
  return available.includes("250g") ? "250g" : available[0] || "250g";
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

function bulkKgNearHit(source, hit, options = {}) {
  return resolveBulkKg(source, hit, options);
}

function buildLineItem(product, size, qty = 1, options = {}) {
  const bulkKg = options.bulkKg;
  const normalized = bulkKg >= WHOLESALE_MOQ_KG ? "wholesale" : clampSizeForProduct(product, size);
  const isWholesale = normalized === "wholesale";
  const unitPrice = getUnitPrice(product.id, normalized, { ...options, wholesale: true });
  if (unitPrice == null) return null;

  const quantity = Math.max(1, Number(qty) || 1);
  let lineQty;
  let description;

  if (isWholesale) {
    lineQty =
      bulkKg >= WHOLESALE_MOQ_KG ? bulkKg : WHOLESALE_MOQ_KG * quantity;
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

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSizePatterns(productKey) {
  const key = escapeRegex(productKey);
  return [
    new RegExp(`\\b(250g|500g|1kg|6\\s*kg)\\s*(?:of\\s+)?(?:brazil\\s+)?${key}\\b`, "i"),
    new RegExp(`(?:brazil\\s+)?${key}\\s*(?:\\(filter\\))?\\s*[:\\-]?\\s*(250g|500g|1kg|6\\s*kg)\\b`, "i"),
    new RegExp(`\\b(250g|500g|1kg|6\\s*kg)\\s+(?:of\\s+)?(?:the\\s+)?(?:brazil\\s+)?${key}\\b`, "i"),
  ];
}

function explicitSizeForProduct(source, hit) {
  const windowStart = Math.max(0, hit.index - 45);
  const windowEnd = Math.min(source.length, hit.index + hit.length + 55);
  const window = source.slice(windowStart, windowEnd);

  for (const pattern of buildSizePatterns(hit.key)) {
    const match = window.match(pattern);
    if (match) {
      return clampSizeForProduct(hit.product, match[1]);
    }
  }
  return "";
}

function isSizeCloserToOtherProduct(window, sizePos, hit, windowStart) {
  const lower = window.toLowerCase();
  const relCenter = hit.index - windowStart + hit.length / 2;

  for (const product of CATALOG_PRODUCTS) {
    if (product.id === hit.product.id) continue;
    for (const key of product.keys) {
      let searchFrom = 0;
      while (searchFrom < lower.length) {
        const keyIdx = lower.indexOf(key, searchFrom);
        if (keyIdx === -1) break;
        const keyCenter = keyIdx + key.length / 2;
        const sizeDist = Math.abs(sizePos - keyCenter);
        const ourDist = Math.abs(sizePos - relCenter);
        if (sizeDist < ourDist && sizeDist < 28) return true;
        searchFrom = keyIdx + 1;
      }
    }
  }
  return false;
}

function sizeForProductHit(source, hit, options = {}) {
  const bulkKg = resolveBulkKg(source, hit, options);
  if (bulkKg) return "wholesale";

  const explicit = explicitSizeForProduct(source, hit);
  if (explicit) return explicit;

  if (hit.product.roast === "filter") {
    return "250g";
  }

  const windowStart = Math.max(0, hit.index - 45);
  const windowEnd = Math.min(source.length, hit.index + hit.length + 55);
  const window = source.slice(windowStart, windowEnd);
  const relCenter = hit.index - windowStart + hit.length / 2;

  let bestSize = "";
  let bestDist = Infinity;
  const re = new RegExp(SIZE_PATTERN.source, "gi");
  let match;
  while ((match = re.exec(window)) !== null) {
    if (isSizeCloserToOtherProduct(window, match.index, hit, windowStart)) continue;
    const size = normalizeSize(match[0]);
    if (!getUnitPrice(hit.product.id, size)) continue;
    const dist = Math.abs(match.index - relCenter);
    if (dist < bestDist) {
      bestDist = dist;
      bestSize = size;
    }
  }

  return bestSize ? clampSizeForProduct(hit.product, bestSize) : "250g";
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
  const { wholesale = false, quoteUserText = "" } = options;
  const source = String(text || "");
  if (!source.trim()) return [];

  const hits = findProductHits(source);
  const byProduct = new Map();
  const parseOpts = { wholesale: true, quoteUserText: quoteUserText || source };

  for (const hit of hits) {
    const window = source.slice(
      Math.max(0, hit.index - 45),
      Math.min(source.length, hit.index + hit.length + 55)
    );
    let bulkKg = resolveBulkKg(source, hit, parseOpts);
    let resolvedSize = bulkKg ? "wholesale" : sizeForProductHit(source, hit, parseOpts);

    if (
      !bulkKg &&
      (wholesale || /\b(?:wholesale|bulk)\b/i.test(window)) &&
      hit.product.roast !== "filter"
    ) {
      resolvedSize = "wholesale";
      bulkKg = WHOLESALE_MOQ_KG;
    }

    const line = buildLineItem(hit.product, resolvedSize, 1, {
      wholesale: true,
      bulkKg: resolvedSize === "wholesale" ? bulkKg : undefined,
    });
    if (line) byProduct.set(hit.product.id, line);
  }

  return Array.from(byProduct.values());
}

function mergeLineItemsFromSources(sources, options = {}) {
  const byProduct = new Map();
  for (const source of sources) {
    if (!String(source || "").trim()) continue;
    for (const line of parseLineItemsFromText(source, options)) {
      byProduct.set(line.productId, line);
    }
  }
  return Array.from(byProduct.values());
}

function mergeQuoteLineItemsFromConversation(userSources, assistantReply, options = {}) {
  const byProduct = new Map();

  for (const source of userSources) {
    if (!String(source || "").trim()) continue;
    for (const line of parseLineItemsFromText(source, options)) {
      byProduct.set(line.productId, line);
    }
  }

  if (assistantReply) {
    for (const line of parseLineItemsFromText(assistantReply, options)) {
      if (!byProduct.has(line.productId)) {
        byProduct.set(line.productId, line);
      }
    }
  }

  return Array.from(byProduct.values());
}

function buildQuoteFromText(text, options = {}) {
  const {
    bean = "",
    size = "",
    qty = 1,
    wholesale = false,
    historyTexts = [],
    assistantReply = "",
    quoteUserText = "",
  } = options;

  const userSources = [...historyTexts, text, bean, size].filter(Boolean);
  const parseOpts = {
    wholesale: wholesale || undefined,
    quoteUserText: quoteUserText || text || userSources.join(" "),
  };
  let lines = mergeQuoteLineItemsFromConversation(userSources, assistantReply, parseOpts);

  if (!lines.length) {
    lines = mergeLineItemsFromSources(userSources, parseOpts);
  }

  if (!lines.length && assistantReply) {
    lines = parseLineItemsFromText(assistantReply, parseOpts);
  }

  if (!lines.length) {
    const combined = [...userSources, assistantReply].filter(Boolean).join("\n");
    const product = matchCatalogFromText(combined);
    if (!product) return null;

    const sizeMatch = combined.match(/\b(250g|500g|1kg|\d+(?:\.\d+)?\s*(?:kg|kilograms?))\b/i);
    let resolvedSize = normalizeSize(size) || (sizeMatch ? normalizeSize(sizeMatch[0]) : "");
    let bulkKg = resolveOrderKg(combined) || parseKgAmount(combined);

    if (!resolvedSize) {
      resolvedSize = product.roast === "filter" ? "250g" : "250g";
    }

    if (
      wholesale ||
      bulkKg >= WHOLESALE_MOQ_KG ||
      /\b(?:wholesale|bulk|6\s*kg)\b/i.test(combined)
    ) {
      if (product.roast === "filter") return null;
      resolvedSize = "wholesale";
      bulkKg = bulkKg >= WHOLESALE_MOQ_KG ? bulkKg : WHOLESALE_MOQ_KG;
    }

    const line = buildLineItem(product, resolvedSize, qty, {
      wholesale: true,
      bulkKg: resolvedSize === "wholesale" ? bulkKg : undefined,
    });
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
  parseKgAmount,
  parseAllKgAmounts,
  resolveOrderKg,
  normalizeSize,
  formatPeso,
  getUnitPrice,
  buildLineItem,
  parseLineItemsFromText,
  mergeLineItemsFromSources,
  mergeQuoteLineItemsFromConversation,
  buildQuoteFromText,
  clampSizeForProduct,
};
