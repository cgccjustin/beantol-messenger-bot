const { getActiveTenant } = require("./tenant-context");
const {
  getCatalogProducts,
  getCatalogProductById,
  findCatalogProduct,
  matchCatalogFromText,
  matchAllCatalogProductsFromText,
} = require("./tenant-catalog");

const { getLeadsSheetId } = require("./tenant-google");
const { isRecommendationsEnabled } = require("./tenant-features");
const { resolveProfile } = require("./tenant-system-rules");

function isInventorySheetConfiguredLight() {
  if (process.env.INVENTORY_SHEET_ENABLED === "false") return false;
  return Boolean(getLeadsSheetId());
}

function parseEnvUnavailableLabels() {
  const raw = process.env.UNAVAILABLE_PRODUCTS || process.env.OUT_OF_STOCK || "";
  if (!raw.trim()) return [];

  const labels = [];
  for (const token of raw.split(/[,;\n]+/).map((t) => t.trim()).filter(Boolean)) {
    const hit = findCatalogProduct(token);
    if (hit && !labels.includes(hit.label)) labels.push(hit.label);
  }
  return labels;
}

function getUnavailableProductIds() {
  const tenant = getActiveTenant();
  const catalog = getCatalogProducts(tenant);
  if (isInventorySheetConfiguredLight()) {
    const sheet = require("./inventory-sheet");
    const items = sheet.getCachedInventoryItems() || [];
    if (items.length) {
      const ids = sheet.getCachedUnavailableProductIds();
      if (ids.length) return ids;
      return items.filter((i) => sheet.itemIsOutOfStock(i)).map((i) => i.productId).filter(Boolean);
    }
    return catalog
      .filter((p) => parseEnvUnavailableLabels().includes(p.label))
      .map((p) => p.id);
  }
  return catalog.filter((p) => parseEnvUnavailableLabels().includes(p.label)).map((p) => p.id);
}

function getUnavailableLabels() {
  if (isInventorySheetConfiguredLight()) {
    const sheet = require("./inventory-sheet");
    const items = sheet.getCachedInventoryItems() || [];
    if (items.length) {
      const labels = sheet.getCachedUnavailableLabels();
      if (labels.length) return labels;
      return getUnavailableProductIds()
        .map((id) => getCatalogProductById(id, getActiveTenant())?.label)
        .filter(Boolean);
    }
    return parseEnvUnavailableLabels();
  }
  return parseEnvUnavailableLabels();
}

function getUnavailableLabelSet() {
  return new Set(getUnavailableLabels());
}

function isProductIdOutOfStock(productId) {
  if (!productId) return false;
  if (isInventorySheetConfiguredLight()) {
    const sheet = require("./inventory-sheet");
    const items = sheet.getCachedInventoryItems() || [];
    if (items.length) {
      const row = items.find((i) => i.productId === productId);
      if (row && sheet.itemIsOutOfStock(row)) return true;
    }
    const ids = sheet.getCachedUnavailableProductIds();
    if (ids.includes(productId)) return true;
  } else {
    const ids = getUnavailableProductIds();
    if (ids.includes(productId)) return true;
  }
  const product = getCatalogProductById(productId, getActiveTenant());
  if (!product) return false;
  return getUnavailableLabelSet().has(product.label);
}

function isProductLabelOutOfStock(label) {
  return getUnavailableLabelSet().has(label);
}

function filterInStockLineItems(lineItems = []) {
  return lineItems.filter((line) => !isProductIdOutOfStock(line.productId));
}

function findOutOfStockProductsInText(userText) {
  return matchAllCatalogProductsFromText(String(userText || "")).filter((p) =>
    isProductIdOutOfStock(p.id)
  );
}

function userTextRequestsOutOfStockProduct(userText) {
  return findOutOfStockProductsInText(userText).length > 0;
}

function assistantReplyIndicatesRequestedProductUnavailable(assistantReply, userText) {
  const reply = String(assistantReply || "");
  if (!/\b(?:out of stock|currently out of stock|currently unavailable|not available|unavailable)\b/i.test(reply)) {
    return false;
  }

  const product = matchCatalogFromText(String(userText || ""));
  if (!product) return false;

  const replyLower = reply.toLowerCase();
  const tokens = [product.label.toLowerCase(), ...(product.keys || [])];
  return tokens.some((token) => replyLower.includes(token));
}

function assistantReplyAsksForRetailSize(assistantReply) {
  const reply = String(assistantReply || "");
  return (
    /\b(?:which size|what size)\b/i.test(reply) &&
    /\b(?:250g|500g|1kg)\b/i.test(reply)
  );
}

function userTextHasExplicitSize(text) {
  return /\b(250g|500g|1kg|\d+(?:\.\d+)?\s*kg)\b/i.test(String(text || ""));
}

function lineUsesAssumedDefaultRetailSize(userText, lineItem) {
  if (!lineItem || lineItem.size !== "250g" || lineItem.qty !== 1) return false;
  if (/\b250g\b/i.test(String(userText || ""))) return false;

  const product = getCatalogProductById(lineItem.productId, getActiveTenant());
  if (!product || product.roast === "filter") return false;

  return !userTextHasExplicitSize(userText);
}

function needsSizeBeforeQuote(userText, assistantReply) {
  const text = String(userText || "");
  if (userTextHasExplicitSize(text)) return false;

  const product = matchCatalogFromText(text);
  if (!product || product.roast === "filter") return false;

  if (assistantReplyAsksForRetailSize(assistantReply)) return true;

  if (
    /\b(?:order|buy|purchase|i(?:'d| would) like to order|mag order|gusto ko order)\b/i.test(text)
  ) {
    return true;
  }

  return false;
}

function filterAlternativesToInStock(alternativeStr, outSet) {
  if (!alternativeStr || !outSet?.size) return String(alternativeStr || "").trim();
  const parts = String(alternativeStr)
    .split(/\s+or\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
  const inStock = [];
  const catalog = getCatalogProducts(getActiveTenant());
  for (const part of parts) {
    const product = findCatalogProduct(part);
    if (product && !outSet.has(product.label)) {
      if (!inStock.includes(product.label)) inStock.push(product.label);
      continue;
    }
    if (!product) {
      const fuzzy = catalog.find(
        (p) => part.toLowerCase().includes((p.keys || [])[0]) && !outSet.has(p.label)
      );
      if (fuzzy && !inStock.includes(fuzzy.label)) inStock.push(fuzzy.label);
    }
  }
  return inStock.join(" or ");
}

function hasOrderOrSizeIntent(userText) {
  const t = String(userText || "");
  if (
    /\b(?:order|buy|purchase|mag[- ]?order|gusto ko|i want|i'd like|i would like|get me|paorder|checkout|add to|i(?:'ll|\s)take|get the|yung|ang)\b/i.test(
      t
    )
  ) {
    return true;
  }
  if (/\bplease\b/i.test(t) && matchAllCatalogProductsFromText(t).length) return true;
  return /\b(250g|500g|1kg|\d+(?:\.\d+)?\s*kg)\b/i.test(t);
}

function shouldBlockOutOfStockOrder(userText) {
  return userTextRequestsOutOfStockProduct(userText) && hasOrderOrSizeIntent(userText);
}

function isProductNameOnlyInquiry(userText) {
  const t = String(userText || "").trim();
  if (!t || t.length > 56) return false;
  if (hasOrderOrSizeIntent(userText)) return false;
  const product = matchCatalogFromText(t);
  if (!product) return false;
  const stripped = t.replace(/[?!.,]/g, "").trim().toLowerCase();
  return [product.label.toLowerCase(), ...(product.keys || [])].some(
    (key) => stripped === key || new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(stripped)
  );
}

function shouldBlockOutOfStockProductInquiry(userText) {
  return userTextRequestsOutOfStockProduct(userText);
}

function formatOutOfStockNames(products) {
  const labels = products.map((p) => p.label);
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

function suggestInStockAlternatives(oosProducts) {
  const outSet = getUnavailableLabelSet();
  for (const product of oosProducts) {
    const alt = filterAlternativesToInStock(product.alternative, outSet);
    if (alt) return alt;
  }
  const catalog = getCatalogProducts(getActiveTenant());
  const inStock = catalog
    .filter(
      (p) =>
        !outSet.has(p.label) && !oosProducts.some((o) => o.id === p.id)
    )
    .map((p) => p.label);
  return inStock.slice(0, 2).join(" or ");
}

function buildOutOfStockProductReply(userText) {
  if (!shouldBlockOutOfStockProductInquiry(userText)) return null;
  const oosProducts = findOutOfStockProductsInText(userText);
  if (!oosProducts.length) return null;

  const names = formatOutOfStockNames(oosProducts);
  const alt = suggestInStockAlternatives(oosProducts);
  let msg =
    oosProducts.length === 1
      ? `${names} is currently out of stock per our latest inventory — sorry about that.`
      : `${names} are currently out of stock per our latest inventory — sorry about that.`;
  if (alt) {
    msg += ` May I suggest ${alt} instead?`;
  }
  msg += " Would you like to know more about what's available?";
  return msg;
}

/** @deprecated use buildOutOfStockProductReply */
function buildOutOfStockOrderBlock(userText) {
  return buildOutOfStockProductReply(userText);
}

function replyMentionsProduct(reply, product) {
  const replyLower = String(reply || "").toLowerCase();
  return [product.label.toLowerCase(), ...(product.keys || [])].some((token) =>
    replyLower.includes(token)
  );
}

function assistantReplyRefusesOutOfStockOrder(assistantReply, userText) {
  const oosProducts = findOutOfStockProductsInText(userText);
  if (!oosProducts.length) {
    return assistantReplyIndicatesRequestedProductUnavailable(assistantReply, userText);
  }
  const reply = String(assistantReply || "");
  if (!/\b(?:out of stock|currently out of stock|currently unavailable|not available|unavailable)\b/i.test(reply)) {
    return false;
  }
  return oosProducts.some((product) => replyMentionsProduct(reply, product));
}

function assistantReplyTreatsProductAsBuyable(assistantReply, product) {
  if (!product) return false;
  const reply = String(assistantReply || "");
  if (!replyMentionsProduct(reply, product)) return false;
  if (
    /\b(?:out of stock|currently out of stock|currently unavailable|not available|unavailable)\b/i.test(
      reply
    )
  ) {
    return false;
  }
  return (
    /\b(?:yes|yeah|yep|we have|available|in stock|meron|naa|sure|carry|absolutely|definitely)\b/i.test(
      reply
    ) ||
    /\b(?:great|good|excellent|nice|perfect|wonderful|solid|lovely)\s+(?:choice|pick|option|one|options)\b/i.test(
      reply
    ) ||
    /\b(?:great|good|excellent|nice|perfect|wonderful|solid|lovely)\b/i.test(reply) ||
    /\b(?:which|what)\s+size\b/i.test(reply) ||
    /\b(?:would you like|like to order|ready to order)\b/i.test(reply) ||
    /₱|\b(?:250g|500g|1kg)\b/i.test(reply)
  );
}

function assistantReplyTreatsOutOfStockProductAsBuyable(assistantReply, userText) {
  return findOutOfStockProductsInText(userText).some((product) =>
    assistantReplyTreatsProductAsBuyable(assistantReply, product)
  );
}

function findOutOfStockProductsPromotedInReply(assistantReply) {
  const reply = String(assistantReply || "");
  const soundsLikeSale =
    /₱|\b(?:250g|500g|1kg)\b/i.test(reply) ||
    /\b(?:great|good|excellent|nice|perfect|wonderful|yes)\b/i.test(reply) ||
    /\b(?:which|what)\s+size\b/i.test(reply);
  const soundsLikeAvailabilityList =
    /\b(?:available|in stock|we have|also|aside|other|options?|alternatives?|beans?|espresso)\b/i.test(
      reply
    );

  if (!soundsLikeSale && !soundsLikeAvailabilityList) return [];

  return getCatalogProducts(getActiveTenant()).filter((p) => {
    if (!isProductIdOutOfStock(p.id)) return false;
    if (!replyMentionsProduct(reply, p)) return false;
    const idx = reply.toLowerCase().indexOf(p.label.toLowerCase());
    const window = reply.slice(Math.max(0, idx - 40), idx + p.label.length + 60).toLowerCase();
    if (/\b(?:out of stock|currently out of stock|unavailable|not available)\b/i.test(window)) {
      return false;
    }
    return true;
  });
}

function assistantReplyClaimsOutOfStockProductAvailable(assistantReply, userText) {
  return assistantReplyTreatsOutOfStockProductAsBuyable(assistantReply, userText);
}

function enforceOutOfStockProductPolicy(userText, assistantReply) {
  if (shouldBlockOutOfStockProductInquiry(userText)) {
    if (assistantReplyRefusesOutOfStockOrder(assistantReply, userText)) return assistantReply;
    return buildOutOfStockProductReply(userText) || assistantReply;
  }
  if (assistantReplyTreatsOutOfStockProductAsBuyable(assistantReply, userText)) {
    return buildOutOfStockProductReply(userText) || assistantReply;
  }
  const promoted = findOutOfStockProductsPromotedInReply(assistantReply);
  if (promoted.length) {
    const synthetic = promoted.map((p) => (p.keys && p.keys[0]) || p.label).join(" and ");
    return buildOutOfStockProductReply(synthetic) || assistantReply;
  }
  return assistantReply;
}

/** @deprecated use enforceOutOfStockProductPolicy */
function enforceOutOfStockOrderPolicy(userText, assistantReply) {
  return enforceOutOfStockProductPolicy(userText, assistantReply);
}

function buildOutOfStockProductSystemHint(userText) {
  const oosProducts = findOutOfStockProductsInText(userText);
  if (!oosProducts.length) return "";
  const outSet = getUnavailableLabelSet();
  const names = formatOutOfStockNames(oosProducts);
  const alt = suggestInStockAlternatives(oosProducts);
  return (
    `OUT OF STOCK INQUIRY (strict): Customer asked about ${names} — OUT OF STOCK. ` +
    `Say they are not available. Do NOT confirm yes, do NOT quote prices or sizes for ${names}. ` +
    (alt ? `Suggest in-stock alternatives only: ${alt}.` : "Suggest other in-stock items from INVENTORY.")
  );
}

function isTasteOrListRecommendationInquiry(text) {
  const t = String(text || "").toLowerCase();
  if (!t || hasOrderOrSizeIntent(text)) return false;
  const tenant = getActiveTenant();
  if (resolveProfile(tenant) !== "beantol" || !isRecommendationsEnabled(tenant)) return false;
  return (
    /\b(?:chocolate|nutty|nut\b|fruity|bright)\b/i.test(t) ||
    /\b(?:do you have|you have|have something|got anything|meron)\b/i.test(t) ||
    /\b(?:what(?:'s|s| is) available|available ba|may (?:ba|pa))\b/i.test(t) ||
    /\b(?:recommend|suggest|list|which bean|what bean|beans?\b.*(?:have|offer|carry|available)|your beans)\b/i.test(
      t
    ) ||
    /\b(?:help me choose|what should i|help me pick)\b/i.test(t)
  );
}

function isCafeMenuOrAvailabilityInquiry(text) {
  const t = String(text || "").toLowerCase().trim();
  if (!t || hasOrderOrSizeIntent(text)) return false;
  if (resolveProfile(getActiveTenant()) !== "cafe") return false;
  return (
    /\b(?:what(?:'s|s| is) (?:your )?(?:menu|available|on the menu))\b/i.test(t) ||
    /\b(?:what do you have|what can i (?:get|order)|show (?:me )?(?:the )?menu|full menu|menu please)\b/i.test(
      t
    ) ||
    /\b(?:what(?:'s|s| is) available|available ba|may (?:ba|pa)|meron kayo|unsay (?:naa|available))\b/i.test(
      t
    ) ||
    /\b(?:list (?:your )?(?:menu|drinks|items)|what drinks)\b/i.test(t)
  );
}

function isInStockAvailabilityInquiry(userText) {
  const t = String(userText || "").trim();
  if (!t || hasOrderOrSizeIntent(userText)) return false;
  if (resolveProfile(getActiveTenant()) !== "beantol") return false;

  const asksAvailability =
    /\b(?:available|meron|naa|have|stock|offer|carry|unsay|unsa)\b/i.test(t) ||
    /\b(?:what(?:'s|s| is)?\s*(?:else|other|uban|laing))\b/i.test(t);

  const asksAside =
    /\b(?:aside|besides|other than|except|liban|b(?: gawas| gawas sa)|wala(?:y|)?\s*(?:laing|uban)|dili(?:\s+lang)?\s+(?:sa|ang))\b/i.test(
      t
    ) ||
    /\buns(?:a|ay)\s*(?:ra|pa|laing|uban)\b/i.test(t) ||
    /\bwhat\s+else\b/i.test(t);

  if (asksAside && asksAvailability) return true;
  if (asksAside && matchAllCatalogProductsFromText(t).length) return true;
  return false;
}

function buildInStockAvailabilityReply(userText) {
  if (!isInStockAvailabilityInquiry(userText)) return null;

  const outSet = getUnavailableLabelSet();
  const excludeIds = new Set(matchAllCatalogProductsFromText(userText).map((p) => p.id));
  const catalog = getCatalogProducts(getActiveTenant());
  const inStock = catalog.filter((p) => !outSet.has(p.label) && !excludeIds.has(p.id));

  if (!inStock.length) {
    return (
      "Right now I don't have other espresso beans in stock aside from what you mentioned — sorry about that. " +
      "Would you like help with delivery or payment for Cerrado?"
    );
  }

  const lines = [
    "Aside from what you mentioned, here's what we have in stock right now:",
    "",
  ];
  for (const product of inStock) {
    if (product.roast === "filter") {
      lines.push(`• ${product.label} — filter roast (250g)`);
    } else {
      lines.push(`• ${product.label} — espresso`);
    }
  }
  lines.push("");
  lines.push("Which one would you like? I can share sizes and pricing.");
  return lines.join("\n");
}

function buildCafeMenuListSystemHint(userText) {
  if (!isCafeMenuOrAvailabilityInquiry(userText)) return "";
  const tenant = getActiveTenant();
  const outSet = getUnavailableLabelSet();
  const inStock = getCatalogProducts(tenant)
    .filter((p) => !outSet.has(p.label))
    .map((p) => p.label);
  let hint =
    "MENU / AVAILABILITY (strict): Customer asks what is on the menu or what is available. " +
    "Answer ONLY from KNOWLEDGE CONTEXT for this café — list menu drinks/items with prices from the doc. " +
    "Do NOT mention Beantol roast beans (Prime, Brazil Cerrado, Santos, Sidama, Guji, etc.).";
  if (tenant?.id === "offbeat-brew") {
    hint +=
      " OFFBEAT Coffee Series (Black, White, Mocha, Dulce) is COLD ONLY — ready-to-drink bottled cold brew. " +
      "NEVER ask hot or cold or offer a hot version for these drinks. " +
      "Do NOT mention snacks, food, or pastries — Offbeat serves drinks only.";
  }
  if (tenant?.id === "kape-kristiano") {
    hint +=
      " Kape Kristiano serves coffee (hot/cold classics), KK Favorites (cold), non-coffee drinks, sweet treats, and meals. " +
      "List ONLY from KNOWLEDGE CONTEXT and catalog — include hot/cold prices for classics where applicable.";
  }
  if (inStock.length) {
    hint += ` In-stock per admin inventory: ${inStock.join(", ")}.`;
  }
  if (outSet.size) {
    hint += ` Out of stock per admin: ${[...outSet].join(", ")} — do not offer these.`;
  }
  return hint;
}

const TASTE_PICKS = {
  chocolateNutty: [
    {
      id: "brazil-cerrado",
      why: "Single-origin espresso — deeper chocolate and hazelnut notes.",
    },
    {
      id: "beantol-prime",
      why: "Balanced chocolate and fruit — our flagship blend.",
    },
    {
      id: "brazil-santos",
      why: "Sweet chocolate, nutty, creamy body.",
    },
  ],
};

function buildInStockTasteRecommendationReply(userText) {
  if (!isRecommendationsEnabled()) return null;
  if (!isTasteOrListRecommendationInquiry(userText)) return null;

  const { CATALOG_PRODUCTS } = require("./catalog");
  const outSet = getUnavailableLabelSet();
  const ids = getUnavailableProductIds();
  if (!outSet.size && !ids.length) return null;

  const wantsChocolateNutty =
    /\b(?:chocolate|nutty|nut\b)\b/i.test(userText) &&
    !/\b(?:fruity|bright|floral)\b/i.test(userText);

  let picks = [];
  if (wantsChocolateNutty) {
    picks = TASTE_PICKS.chocolateNutty.filter((pick) => !isProductIdOutOfStock(pick.id));
  } else {
    picks = CATALOG_PRODUCTS.filter(
      (p) => p.roast === "espresso" && !isProductIdOutOfStock(p.id)
    )
      .slice(0, 3)
      .map((p) => ({ id: p.id, why: "Available now — ask for flavor notes or sizes." }));
  }

  if (!picks.length) return null;

  const intro = wantsChocolateNutty
    ? "For nutty, chocolatey espresso — here's what we have in stock right now:"
    : "Here are espresso beans we have in stock right now:";

  const lines = [intro, ""];
  for (const pick of picks) {
    const product = CATALOG_PRODUCTS.find((p) => p.id === pick.id);
    if (!product) continue;
    lines.push(`• ${product.label} — ${pick.why}`);
  }
  lines.push("");
  lines.push("Which one would you like to know more about? I can share sizes and prices when you pick.");
  return lines.join("\n");
}

function buildTasteRecommendationInventoryHint(userText) {
  if (!isRecommendationsEnabled()) return "";
  const { CATALOG_PRODUCTS } = require("./catalog");
  const t = String(userText || "").toLowerCase();
  if (hasOrderOrSizeIntent(userText)) return "";
  if (!isTasteOrListRecommendationInquiry(userText)) return "";

  const outSet = getUnavailableLabelSet();
  const inStockEspresso = CATALOG_PRODUCTS.filter(
    (p) => p.roast === "espresso" && !outSet.has(p.label)
  ).map((p) => p.label);
  if (!inStockEspresso.length) return "";

  let note = `TASTE / RECOMMENDATION (strict): Recommend ONLY beans from this in-stock list: ${inStockEspresso.join(", ")}.`;
  if (outSet.size) {
    note += ` Do NOT mention these out-of-stock beans even as a second option: ${[...outSet].join(", ")}.`;
  }
  return note;
}

function gateQuoteProposal(userText, assistantReply, proposal) {
  if (!proposal?.lineItems?.length) return null;

  if (needsSizeBeforeQuote(userText, assistantReply)) return null;

  if (userTextRequestsOutOfStockProduct(userText)) return null;

  if (assistantReplyIndicatesRequestedProductUnavailable(assistantReply, userText)) {
    return null;
  }

  const inStockLines = filterInStockLineItems(proposal.lineItems);
  if (!inStockLines.length) return null;

  const text = String(userText || "");
  if (
    !userTextHasExplicitSize(text) &&
    inStockLines.some((line) => lineUsesAssumedDefaultRetailSize(text, line)) &&
    (assistantReplyAsksForRetailSize(assistantReply) ||
      /\b(?:order|buy|purchase|i(?:'d| would) like to order|mag order|gusto ko order)\b/i.test(
        text
      ))
  ) {
    return null;
  }

  if (inStockLines.length === proposal.lineItems.length) return proposal;

  const subtotal = inStockLines.reduce((sum, line) => sum + line.lineTotal, 0);
  return {
    lineItems: inStockLines,
    subtotal,
    summary: inStockLines.map((line) => line.display).join(" · "),
  };
}

module.exports = {
  getUnavailableLabels,
  isProductIdOutOfStock,
  isProductLabelOutOfStock,
  filterInStockLineItems,
  filterAlternativesToInStock,
  userTextRequestsOutOfStockProduct,
  assistantReplyIndicatesRequestedProductUnavailable,
  shouldBlockOutOfStockOrder,
  shouldBlockOutOfStockProductInquiry,
  buildOutOfStockProductReply,
  buildOutOfStockOrderBlock,
  enforceOutOfStockProductPolicy,
  enforceOutOfStockOrderPolicy,
  buildOutOfStockProductSystemHint,
  buildInStockTasteRecommendationReply,
  buildInStockAvailabilityReply,
  isInStockAvailabilityInquiry,
  buildTasteRecommendationInventoryHint,
  buildCafeMenuListSystemHint,
  isCafeMenuOrAvailabilityInquiry,
  needsSizeBeforeQuote,
  gateQuoteProposal,
};
