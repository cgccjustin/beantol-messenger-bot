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
/** Wholesale per-kg pricing: Beantol Prime, Brazil Santos, Brazil Cerrado only */
const WHOLESALE_PRODUCT_IDS = new Set([
  "beantol-prime",
  "brazil-santos",
  "brazil-cerrado",
]);
const SIZE_PATTERN = /\b(250g|500g|1kg|6\s*kg|\d+(?:\.\d+)?\s*(?:kg|kilograms?))\b/gi;
const BULK_KG_PATTERN = /\b(\d+(?:\.\d+)?)\s*(?:kg|kilograms?)\b/gi;

function isWholesaleEligibleProduct(productId) {
  return WHOLESALE_PRODUCT_IDS.has(productId);
}

function productById(productId) {
  return CATALOG_PRODUCTS.find((p) => p.id === productId) || null;
}

/** Whole-kg only for wholesale (6.5 → 6, 8.5 → 8). */
function normalizeWholesaleKg(kg) {
  if (!Number.isFinite(kg) || kg <= 0) return null;
  const hasFraction = Math.abs(kg - Math.floor(kg)) > 1e-6;
  const adjustedKg = hasFraction ? Math.floor(kg) : kg;
  return {
    requestedKg: kg,
    kg: adjustedKg,
    droppedFraction: hasFraction,
    fractionalPart: hasFraction ? kg - adjustedKg : 0,
  };
}

function parseKgDelta(text) {
  const t = String(text || "");
  let match = t.match(
    /\b(?:add|plus)\s+(?:another\s+|one\s+more\s+|an?\s+)?(\d+(?:\.\d+)?)\s*(?:more\s+)?(?:kg|kilograms?)\b/i
  );
  if (match) return parseFloat(match[1]);
  match = t.match(/\b(\d+(?:\.\d+)?)\s+more\s+(?:kg|kilograms?)\b/i);
  if (match) return parseFloat(match[1]);
  if (/\b(?:add|get)\s+(?:another|one more)\s+(?:kg|kilogram)\b/i.test(t)) return 1;
  match = t.match(/\b(?:add|plus)\s+(\d+(?:\.\d+)?)\s*(?:kg|kilograms?)\b/i);
  if (match) return parseFloat(match[1]);
  return null;
}

function getLineItemBulkKg(lineItem) {
  if (!lineItem) return null;
  if (lineItem.size === "wholesale") return lineItem.qty;
  if (lineItem.size === "1kg" && lineItem.qty >= 1) return lineItem.qty;
  return null;
}

function pickCustomerKgFromText(source) {
  const amounts = parseAllKgAmounts(source).filter((a) => !a.isMoq);
  if (!amounts.length) return null;
  const orderHits = amounts.filter((a) => a.isOrder);
  if (orderHits.length) return Math.max(...orderHits.map((a) => a.kg));
  return Math.max(...amounts.map((a) => a.kg));
}

function resolveCustomerOrderKg(text, recentTexts = []) {
  const fromCurrent = pickCustomerKgFromText(String(text || ""));
  if (fromCurrent != null) return fromCurrent;
  const combined = [text, ...(recentTexts || [])].filter(Boolean).join("\n");
  return pickCustomerKgFromText(combined);
}

function resolveEffectiveOrderKg(userText, recentTexts = [], sessionQuote = null) {
  const sessionLine = sessionQuote?.lineItems?.[0];
  const sessionKg = getLineItemBulkKg(sessionLine);

  const currentKg = pickCustomerKgFromText(userText);
  if (currentKg != null) return normalizeWholesaleKg(currentKg);

  const delta = parseKgDelta(userText);
  if (delta != null) {
    const baseKg =
      sessionKg ??
      resolveCustomerOrderKg("", recentTexts) ??
      resolveOrderKg(recentTexts.join("\n"));
    if (baseKg != null) return normalizeWholesaleKg(baseKg + delta);
  }

  if (sessionKg != null) return normalizeWholesaleKg(sessionKg);

  const fromRecent = resolveCustomerOrderKg(userText, recentTexts);
  if (fromRecent != null) return normalizeWholesaleKg(fromRecent);

  const wholesaleKg = resolveOrderKg(userText) || resolveOrderKg(recentTexts.join("\n"));
  if (wholesaleKg != null) return normalizeWholesaleKg(wholesaleKg);

  return null;
}

function buildWholesaleBulkLineItem(product, effectiveKg) {
  if (!product || !isWholesaleEligibleProduct(product.id)) return null;
  const norm =
    typeof effectiveKg === "object" ? effectiveKg : normalizeWholesaleKg(effectiveKg);
  if (!norm || norm.kg < WHOLESALE_MOQ_KG) return null;

  const unitPrice = RETAIL_PRICES[product.id]?.wholesale;
  if (unitPrice == null) return null;

  const lineQty = norm.kg;
  const description = `${product.label} — wholesale ${lineQty} kg @ ${formatPeso(unitPrice)}/kg`;
  const lineTotal = unitPrice * lineQty;

  return {
    line: {
      productId: product.id,
      productLabel: product.label,
      size: "wholesale",
      qty: lineQty,
      unitPrice,
      lineTotal,
      description,
      display: `${description} = ${formatPeso(lineTotal)}`,
      wholesaleAdjustedFrom: norm.droppedFraction ? norm.requestedKg : undefined,
    },
    adjustment: norm.droppedFraction
      ? {
          type: "fraction_dropped",
          requestedKg: norm.requestedKg,
          kg: norm.kg,
          fractionalPart: norm.fractionalPart,
        }
      : null,
  };
}

function buildBulkLineItemForProduct(product, effectiveKg) {
  if (!product || !effectiveKg) return null;
  const norm =
    typeof effectiveKg === "object" ? effectiveKg : normalizeWholesaleKg(effectiveKg);
  if (!norm) return null;

  if (isWholesaleEligibleProduct(product.id) && norm.kg >= WHOLESALE_MOQ_KG) {
    return buildWholesaleBulkLineItem(product, norm);
  }

  const line = buildRetailBulkLineItem(product, norm.kg);
  if (!line) return null;
  return { line, adjustment: null };
}

function detectWholesaleUpgrade(sessionQuote, newQuote) {
  if (!sessionQuote?.lineItems?.length || !newQuote?.lineItems?.length) return null;
  const prev = sessionQuote.lineItems[0];
  const next =
    newQuote.lineItems.find((l) => l.productId === prev.productId) || newQuote.lineItems[0];
  const prevKg = getLineItemBulkKg(prev);
  const nextKg = getLineItemBulkKg(next);
  if (prevKg == null || nextKg == null) return null;
  if (
    prev.size !== "wholesale" &&
    next.size === "wholesale" &&
    prevKg < WHOLESALE_MOQ_KG &&
    nextKg >= WHOLESALE_MOQ_KG
  ) {
    return {
      prevKg,
      nextKg,
      productLabel: next.productLabel,
      unitPrice: next.unitPrice,
      lineTotal: next.lineTotal,
    };
  }
  return null;
}

function formatWholesaleUpgradePrefix() {
  return (
    `Good decision! At our ${WHOLESALE_MOQ_KG} kg minimum for wholesale pricing, you get a better per-kg rate.\n\n`
  );
}

function formatFractionAdjustmentPrefix(adjustment, productLabel) {
  return (
    `Note: Wholesale orders for ${productLabel} are in whole kg only (${WHOLESALE_MOQ_KG} kg minimum, then +1 kg steps). ` +
    `Your request for ${adjustment.requestedKg} kg is adjusted to ${adjustment.kg} kg.\n\n`
  );
}

function buildWholesalePricingSystemNote(userText, recentTexts = [], sessionQuote = null) {
  const parts = [];
  const effective = resolveEffectiveOrderKg(userText, recentTexts, sessionQuote);
  if (!effective) return "";

  const product =
    productById(sessionQuote?.lineItems?.[0]?.productId) ||
    matchCatalogFromText([userText, ...recentTexts].join(" "));
  if (!product || !isWholesaleEligibleProduct(product.id)) return "";

  const sessionLine = sessionQuote?.lineItems?.[0];
  const prevKg = getLineItemBulkKg(sessionLine);
  const newKg = effective.kg;
  const wholesalePrice = RETAIL_PRICES[product.id]?.wholesale;

  if (
    prevKg != null &&
    prevKg < WHOLESALE_MOQ_KG &&
    newKg >= WHOLESALE_MOQ_KG &&
    wholesalePrice
  ) {
    parts.push(
      `WHOLESALE UPGRADE: Customer increased from ${prevKg} kg (retail rate) to ${newKg} kg wholesale for ${product.label}. ` +
        `Congratulate them warmly (e.g. "Good decision — at 6 kg minimum you unlock wholesale pricing"). ` +
        `Quote wholesale ${formatPeso(wholesalePrice)}/kg × ${newKg} kg = ${formatPeso(wholesalePrice * newKg)}. Do NOT keep retail pricing.`
    );
  }

  if (effective.droppedFraction && newKg >= WHOLESALE_MOQ_KG && wholesalePrice) {
    parts.push(
      `WHOLESALE KG INCREMENT: Customer requested ${effective.requestedKg} kg but wholesale only allows whole kg (${WHOLESALE_MOQ_KG} kg minimum, then +1 kg steps). ` +
        `Use ${newKg} kg at wholesale ${formatPeso(wholesalePrice)}/kg. Explain the adjustment from ${effective.requestedKg} kg to ${newKg} kg — fractional kg is not available for wholesale.`
    );
  }

  return parts.join("\n");
}

function resolveProductForPricingNote(userText, recentTexts = [], sessionQuote = null) {
  return (
    productById(sessionQuote?.lineItems?.[0]?.productId) ||
    matchCatalogFromText([userText, ...(recentTexts || [])].filter(Boolean).join(" "))
  );
}

function customerMentionedWholesale(text) {
  return /\b(?:wholesale|bulk)\b/i.test(String(text || ""));
}

/** System note when customer asks bulk kg or wholesale on beans that have no wholesale tier. */
function buildNonWholesaleBulkSystemNote(userText, recentTexts = [], sessionQuote = null) {
  const combined = [userText, ...(recentTexts || [])].filter(Boolean).join("\n");
  const product = resolveProductForPricingNote(userText, recentTexts, sessionQuote);
  if (!product || isWholesaleEligibleProduct(product.id)) return "";

  const effective = resolveEffectiveOrderKg(userText, recentTexts, sessionQuote);
  const kg = effective?.kg ?? resolveCustomerOrderKg(userText, recentTexts);
  const mentionsWholesale = customerMentionedWholesale(combined);
  const bulkKgRequest = kg != null && kg >= 2;

  if (!mentionsWholesale && !bulkKgRequest) return "";

  const eligibleList = "Beantol Prime, Brazil Santos, and Brazil Cerrado";
  let note =
    `NON-WHOLESALE BEAN (${product.label}): This product has NO wholesale pricing. Wholesale is ONLY for ${eligibleList}. ` +
    `Do NOT mention 6 kg minimum, MOQ, wholesale per-kg rate, or upgrading to 6 kg for ${product.label}. ` +
    `Do NOT ask whether they want to upgrade to 6 kg wholesale.`;

  const retail1kg = RETAIL_PRICES[product.id]?.["1kg"];
  if (bulkKgRequest && retail1kg) {
    note += ` Quote their ${kg} kg at retail: ${formatPeso(retail1kg)}/kg × ${kg} kg = ${formatPeso(retail1kg * kg)}. You may also mention 250g, 500g, and 1kg packs.`;
  }

  if (mentionsWholesale) {
    note += ` Customer mentioned wholesale — say ${product.label} is retail-only; wholesale applies to ${eligibleList} (6 kg+).`;
  }

  return note;
}

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
  return /\b(?:your order|order of|for your order|you.?d like|like to order|quantity|quote for|total would be|size:)\b/.test(
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
  if (orderMatches.length) {
    const norm = normalizeWholesaleKg(Math.max(...orderMatches));
    return norm ? norm.kg : null;
  }

  const amounts = parseAllKgAmounts(source).filter((a) => a.kg >= WHOLESALE_MOQ_KG);
  if (!amounts.length) return null;

  const orderHits = amounts.filter((a) => a.isOrder && !a.isMoq);
  if (orderHits.length) {
    const norm = normalizeWholesaleKg(Math.max(...orderHits.map((a) => a.kg)));
    return norm ? norm.kg : null;
  }

  const nonMoq = amounts.filter((a) => !a.isMoq);
  if (nonMoq.length) {
    const norm = normalizeWholesaleKg(Math.max(...nonMoq.map((a) => a.kg)));
    return norm ? norm.kg : null;
  }

  if (options.allowMoqFallback) {
    const norm = normalizeWholesaleKg(Math.max(...amounts.map((a) => a.kg)));
    return norm ? norm.kg : null;
  }
  return null;
}

function resolveBulkKg(source, hit, options = {}) {
  const { quoteUserText = "", effectiveKg = null, sessionQuote = null } = options;
  if (hit.product.roast === "filter") return null;
  if (!isWholesaleEligibleProduct(hit.product.id)) return null;

  if (effectiveKg?.kg >= WHOLESALE_MOQ_KG) return effectiveKg.kg;

  const effective = resolveEffectiveOrderKg(quoteUserText, [], sessionQuote);
  if (effective?.kg >= WHOLESALE_MOQ_KG) return effective.kg;

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

function buildRetailBulkLineItem(product, kg) {
  const norm = normalizeWholesaleKg(kg);
  if (!norm || norm.kg <= 0 || norm.kg >= WHOLESALE_MOQ_KG) return null;
  const prices = RETAIL_PRICES[product.id];
  const unitPrice = prices?.["1kg"];
  if (unitPrice == null) return null;

  const qty = norm.kg;
  const lineTotal = unitPrice * qty;
  const description = `${product.label} — ${qty} kg (retail, at 1 kg price)`;

  return {
    productId: product.id,
    productLabel: product.label,
    size: "1kg",
    qty,
    unitPrice,
    lineTotal,
    description,
    display: `${description} = ${formatPeso(lineTotal)}`,
  };
}

function requestedBelowMoqBulkKg(text, recentTexts = [], sessionQuote = null) {
  const effective = resolveEffectiveOrderKg(text, recentTexts, sessionQuote);
  if (effective) {
    return effective.kg < WHOLESALE_MOQ_KG ? effective.kg : null;
  }

  const pickBelowMoq = (source) => {
    const amounts = parseAllKgAmounts(source).filter(
      (a) => a.kg > 0 && a.kg < WHOLESALE_MOQ_KG && !a.isMoq
    );
    if (!amounts.length) return null;
    const orderHits = amounts.filter((a) => a.isOrder);
    if (orderHits.length) return Math.max(...orderHits.map((a) => a.kg));
    return Math.max(...amounts.map((a) => a.kg));
  };

  const fromCurrent = pickBelowMoq(String(text || ""));
  if (fromCurrent != null) return fromCurrent;

  const combined = [text, ...(recentTexts || [])].filter(Boolean).join("\n");
  return pickBelowMoq(combined);
}

function subMoqKgForSource(source, quoteUserText = "") {
  const combined = [quoteUserText, source].filter(Boolean).join("\n");
  const amounts = parseAllKgAmounts(combined).filter(
    (a) => a.kg > 0 && a.kg < WHOLESALE_MOQ_KG && !a.isMoq
  );
  if (!amounts.length) return null;
  const orderHits = amounts.filter((a) => a.isOrder);
  if (orderHits.length) return Math.max(...orderHits.map((a) => a.kg));
  return Math.max(...amounts.map((a) => a.kg));
}

function buildLineItem(product, size, qty = 1, options = {}) {
  let bulkKg = options.bulkKg;
  if (bulkKg != null) {
    const norm = normalizeWholesaleKg(bulkKg);
    bulkKg = norm ? norm.kg : bulkKg;
  }
  const normalized = bulkKg >= WHOLESALE_MOQ_KG ? "wholesale" : clampSizeForProduct(product, size);
  const isWholesale = normalized === "wholesale";
  if (isWholesale && !isWholesaleEligibleProduct(product.id)) {
    return buildRetailBulkLineItem(product, bulkKg);
  }
  const unitPrice = getUnitPrice(product.id, normalized, { ...options, wholesale: true });
  if (unitPrice == null) return null;

  const quantity = Math.max(1, Number(qty) || 1);
  let lineQty;
  let description;

  if (isWholesale) {
    lineQty = bulkKg >= WHOLESALE_MOQ_KG ? bulkKg : WHOLESALE_MOQ_KG * quantity;
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
  const {
    wholesale = false,
    quoteUserText = "",
    effectiveKg = null,
    sessionQuote = null,
  } = options;
  const source = String(text || "");
  if (!source.trim()) return [];

  const hits = findProductHits(source);
  const byProduct = new Map();
  const resolvedEffective =
    effectiveKg || resolveEffectiveOrderKg(quoteUserText || source, [], sessionQuote);
  const parseOpts = {
    wholesale: true,
    quoteUserText: quoteUserText || source,
    effectiveKg: resolvedEffective,
    sessionQuote,
  };

  for (const hit of hits) {
    const window = source.slice(
      Math.max(0, hit.index - 45),
      Math.min(source.length, hit.index + hit.length + 55)
    );

    if (
      resolvedEffective &&
      isWholesaleEligibleProduct(hit.product.id) &&
      resolvedEffective.kg >= WHOLESALE_MOQ_KG
    ) {
      const wholesaleBulk = buildWholesaleBulkLineItem(hit.product, resolvedEffective);
      if (wholesaleBulk?.line) {
        byProduct.set(hit.product.id, wholesaleBulk.line);
        continue;
      }
    }

    const subMoqKg = subMoqKgForSource(source, quoteUserText);
    if (
      subMoqKg != null &&
      (!resolvedEffective || resolvedEffective.kg < WHOLESALE_MOQ_KG)
    ) {
      const retailBulk = buildRetailBulkLineItem(hit.product, subMoqKg);
      if (retailBulk) {
        byProduct.set(hit.product.id, retailBulk);
        continue;
      }
    }

    let bulkKg = resolveBulkKg(source, hit, parseOpts);
    let resolvedSize = bulkKg ? "wholesale" : sizeForProductHit(source, hit, parseOpts);

    if (
      !bulkKg &&
      (wholesale || /\b(?:wholesale|bulk)\b/i.test(window)) &&
      hit.product.roast !== "filter" &&
      isWholesaleEligibleProduct(hit.product.id) &&
      !requestedBelowMoqBulkKg(quoteUserText || source, [], sessionQuote)
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
    const blockAssistantWholesale = requestedBelowMoqBulkKg(
      options.quoteUserText || "",
      [],
      options.sessionQuote
    );
    for (const line of parseLineItemsFromText(assistantReply, options)) {
      if (blockAssistantWholesale && line.size === "wholesale") continue;
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
    sessionQuote = null,
    effectiveKg = null,
  } = options;

  const userSources = [...historyTexts, text, bean, size].filter(Boolean);
  const resolvedEffective =
    effectiveKg ||
    resolveEffectiveOrderKg(
      quoteUserText || text || userSources.join(" "),
      historyTexts,
      sessionQuote
    );
  const parseOpts = {
    wholesale: wholesale || undefined,
    quoteUserText: quoteUserText || text || userSources.join(" "),
    sessionQuote,
    effectiveKg: resolvedEffective,
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

    const belowMoqKg = requestedBelowMoqBulkKg(combined, [], sessionQuote);
    if (belowMoqKg) {
      const retailLine = buildRetailBulkLineItem(product, belowMoqKg);
      if (retailLine) {
        lines = [retailLine];
      }
    }

    if (
      !lines.length &&
      resolvedEffective?.kg >= WHOLESALE_MOQ_KG &&
      isWholesaleEligibleProduct(product.id)
    ) {
      const wholesaleBulk = buildWholesaleBulkLineItem(product, resolvedEffective);
      if (wholesaleBulk?.line) {
        lines = [wholesaleBulk.line];
      }
    }

    if (lines.length) {
      const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
      return {
        lineItems: lines,
        subtotal,
        summary: lines.map((line) => line.display).join(" · "),
      };
    }

    const sizeMatch = combined.match(/\b(250g|500g|1kg|\d+(?:\.\d+)?\s*(?:kg|kilograms?))\b/i);
    let resolvedSize = normalizeSize(size) || (sizeMatch ? normalizeSize(sizeMatch[0]) : "");
    let bulkKg = resolveOrderKg(combined) || parseKgAmount(combined);

    if (!resolvedSize) {
      resolvedSize = product.roast === "filter" ? "250g" : "250g";
    }

    if (
      wholesale ||
      bulkKg >= WHOLESALE_MOQ_KG ||
      (/\b(?:wholesale|bulk)\b/i.test(combined) &&
        !requestedBelowMoqBulkKg(combined, [], sessionQuote))
    ) {
      if (product.roast === "filter" || !isWholesaleEligibleProduct(product.id)) {
        if (bulkKg >= WHOLESALE_MOQ_KG) {
          const retailLine = buildRetailBulkLineItem(product, bulkKg);
          if (retailLine) lines = [retailLine];
        }
      } else {
        resolvedSize = "wholesale";
        bulkKg =
          resolvedEffective?.kg >= WHOLESALE_MOQ_KG
            ? resolvedEffective.kg
            : bulkKg >= WHOLESALE_MOQ_KG
              ? bulkKg
              : WHOLESALE_MOQ_KG;
      }
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
  WHOLESALE_PRODUCT_IDS,
  parseKgAmount,
  parseAllKgAmounts,
  parseKgDelta,
  resolveOrderKg,
  resolveEffectiveOrderKg,
  resolveCustomerOrderKg,
  requestedBelowMoqBulkKg,
  buildRetailBulkLineItem,
  buildWholesalePricingSystemNote,
  buildNonWholesaleBulkSystemNote,
  resolveProductForPricingNote,
  isWholesaleEligibleProduct,
  normalizeWholesaleKg,
  productById,
  normalizeSize,
  formatPeso,
  getUnitPrice,
  buildLineItem,
  parseLineItemsFromText,
  mergeLineItemsFromSources,
  mergeQuoteLineItemsFromConversation,
  buildQuoteFromText,
  clampSizeForProduct,
  getLineItemBulkKg,
};
