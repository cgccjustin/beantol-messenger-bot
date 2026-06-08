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
  userTextRequestsOutOfStockProduct,
  assistantReplyIndicatesRequestedProductUnavailable,
  needsSizeBeforeQuote,
  gateQuoteProposal,
};
