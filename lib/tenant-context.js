const { AsyncLocalStorage } = require("async_hooks");
const { getDefaultTenant } = require("./tenant-registry");

const storage = new AsyncLocalStorage();

function runWithTenant(tenant, fn) {
  return storage.run({ tenant }, fn);
}

function getActiveTenant() {
  const store = storage.getStore();
  if (store?.tenant) return store.tenant;
  return getDefaultTenant();
}

/** Unique session key per tenant + customer PSID (PSIDs can repeat across Pages). */
function scopeKey(senderId) {
  const tenant = getActiveTenant();
  const tid = tenant?.id || "default";
  return `${tid}:${String(senderId)}`;
}

function parseScopedKey(scopedKey) {
  const s = String(scopedKey);
  const idx = s.indexOf(":");
  if (idx <= 0) {
    return { tenantId: getDefaultTenant()?.id || "default", senderId: s };
  }
  return { tenantId: s.slice(0, idx), senderId: s.slice(idx + 1) };
}

module.exports = {
  runWithTenant,
  getActiveTenant,
  scopeKey,
  parseScopedKey,
};
