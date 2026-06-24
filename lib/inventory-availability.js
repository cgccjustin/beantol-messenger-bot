const { CATALOG_PRODUCTS, findCatalogProduct, matchCatalogFromText } = require("./catalog");

const { getLeadsSheetId } = require("./tenant-google");

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

function getUnavailableLabels() {
  if (isInventorySheetConfiguredLight()) {
    const { getCachedUnavailableLabels } = require("./inventory-sheet");
    return getCachedUnavailableLabels();
  }
  return parseEnvUnavailableLabels();
}

function getUnavailableLabelSet() {
  return new Set(getUnavailableLabels());
}

function isProductIdOutOfStock(productId) {
  const product = CATALOG_PRODUCTS.find((p) => p.id === productId);
  if (!product) return false;
  return getUnavailableLabelSet().has(product.label);
}

function isProductLabelOutOfStock(label) {
  return getUnavailableLabelSet().has(label);
}

function filterInStockLineItems(lineItems = []) {
  return lineItems.filter((line) => !isProductIdOutOfStock(line.productId));
}

function userTextRequestsOutOfStockProduct(userText) {
  const product = matchCatalogFromText(String(userText || ""));
  if (!product) return false;
  return isProductIdOutOfStock(product.id);
}

function assistantReplyIndicatesRequestedProductUnavailable(assistantReply, userText) {
  const reply = String(assistantReply || "");
  if (!/\b(?:out of stock|currently out of stock|currently unavailable|not available|unavailable)\b/i.test(reply)) {
    return false;
  }

  const product = matchCatalogFromText(String(userText || ""));
  if (!product) return false;

  const replyLower = reply.toLowerCase();
  const tokens = [product.label.toLowerCase(), ...product.keys];
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

  const product = CATALOG_PRODUCTS.find((p) => p.id === lineItem.productId);
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
  for (const part of parts) {
    const product = findCatalogProduct(part);
    if (product && !outSet.has(product.label)) {
      if (!inStock.includes(product.label)) inStock.push(product.label);
      continue;
    }
    if (!product) {
      const fuzzy = CATALOG_PRODUCTS.find(
        (p) => part.toLowerCase().includes(p.keys[0]) && !outSet.has(p.label)
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
  return /\b(250g|500g|1kg|\d+(?:\.\d+)?\s*kg)\b/i.test(t);
}

function shouldBlockOutOfStockOrder(userText) {
  return userTextRequestsOutOfStockProduct(userText) && hasOrderOrSizeIntent(userText);
}

function buildOutOfStockOrderBlock(userText) {
  if (!shouldBlockOutOfStockOrder(userText)) return null;
  const product = matchCatalogFromText(String(userText || ""));
  if (!product) return null;

  const outSet = getUnavailableLabelSet();
  const alt = filterAlternativesToInStock(product.alternative, outSet);
  let msg = `${product.label} is currently out of stock per our latest inventory — sorry about that.`;
  if (alt) {
    msg += ` May I suggest ${alt} instead?`;
  } else {
    const inStock = CATALOG_PRODUCTS.filter(
      (p) => !outSet.has(p.label) && p.roast === product.roast
    ).map((p) => p.label);
    if (inStock.length) {
      msg += ` We do have ${inStock.slice(0, 2).join(" or ")} available.`;
    }
  }
  msg += " Which would you prefer?";
  return msg;
}

function assistantReplyRefusesOutOfStockOrder(assistantReply, userText) {
  if (assistantReplyIndicatesRequestedProductUnavailable(assistantReply, userText)) {
    return true;
  }
  const reply = String(assistantReply || "");
  if (!/\b(?:out of stock|currently out of stock|currently unavailable|not available|unavailable)\b/i.test(reply)) {
    return false;
  }
  const product = matchCatalogFromText(String(userText || ""));
  if (!product) return false;
  const replyLower = reply.toLowerCase();
  return [product.label.toLowerCase(), ...product.keys].some((token) =>
    replyLower.includes(token)
  );
}

function enforceOutOfStockOrderPolicy(userText, assistantReply) {
  if (!shouldBlockOutOfStockOrder(userText)) return assistantReply;
  if (assistantReplyRefusesOutOfStockOrder(assistantReply, userText)) return assistantReply;
  return buildOutOfStockOrderBlock(userText) || assistantReply;
}

function buildTasteRecommendationInventoryHint(userText) {
  const t = String(userText || "").toLowerCase();
  if (hasOrderOrSizeIntent(userText)) return "";
  if (
    !/\b(?:chocolate|nutty|nut\b|fruity|bright|recommend|suggest|help me choose|what should i|which bean|unsay|unsa ang|maayo)\b/i.test(
      t
    )
  ) {
    return "";
  }

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
  buildOutOfStockOrderBlock,
  enforceOutOfStockOrderPolicy,
  buildTasteRecommendationInventoryHint,
  needsSizeBeforeQuote,
  gateQuoteProposal,
};
