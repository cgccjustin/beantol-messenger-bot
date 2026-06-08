const { getActiveTenant } = require("./tenant-context");
const { businessName } = require("./tenant-messages");

function activeTenant(tenant) {
  return tenant || getActiveTenant();
}

function isTenantFeatureEnabled(name, tenant) {
  const t = activeTenant(tenant);
  if (!t?.features || t.features[name] === undefined) return true;
  return t.features[name] !== false;
}

function isCebuDeliveryZonesEnabled(tenant) {
  return isTenantFeatureEnabled("cebuDeliveryZones", tenant);
}

function isRecommendationsEnabled(tenant) {
  return isTenantFeatureEnabled("recommendations", tenant);
}

function buildTenantBehaviorSystemNote(tenant) {
  const t = activeTenant(tenant);
  const name = businessName(t);
  const lines = [
    `SHOP IDENTITY: You are the assistant for ${name} only. Do not call the shop Beantol unless this is Beantol Coffee Roasters.`,
    "For menu, reservations, hours, and delivery policy, prefer the KNOWLEDGE BASE context below over generic coffee-roastery assumptions.",
  ];
  if (!isCebuDeliveryZonesEnabled(t)) {
    lines.push(
      "DELIVERY: Do NOT use Beantol Maxim/J&T/Cebu Province delivery scripts. Answer delivery and pickup only as written in this shop's knowledge base (e.g. pickup only, no delivery to Naga — follow KB exactly)."
    );
  }
  if (!isRecommendationsEnabled(t)) {
    lines.push(
      "PRODUCTS: Do NOT run the Beantol bean recommender or mention Beantol catalog SKUs (Prime, Brazil Cerrado, etc.) unless they appear in the knowledge base."
    );
  }
  if (!isTenantFeatureEnabled("quotes", t)) {
    lines.push("QUOTES: Do not offer formal printable quote links for this shop.");
  }
  return lines.join("\n");
}

module.exports = {
  isTenantFeatureEnabled,
  isCebuDeliveryZonesEnabled,
  isRecommendationsEnabled,
  buildTenantBehaviorSystemNote,
};
