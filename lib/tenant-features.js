const { getActiveTenant } = require("./tenant-context");

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

module.exports = {
  isTenantFeatureEnabled,
  isCebuDeliveryZonesEnabled,
  isRecommendationsEnabled,
};
