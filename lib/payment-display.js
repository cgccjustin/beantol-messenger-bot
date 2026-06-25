const { scopeKey, getActiveTenant } = require("./tenant-context");

/** @type {Map<string, number>} sender scope -> qr sent at */
const gcashQrSentAt = new Map();
const GCASH_QR_COOLDOWN_MS = Number(process.env.GCASH_QR_COOLDOWN_MINUTES || 45) * 60 * 1000;

/**
 * Strip mistaken peso sign (₱ or "P") before GCash / phone numbers — not currency.
 */
function fixMisplacedPesoOnPhoneNumbers(text) {
  let out = String(text || "");
  out = out.replace(/₱\s*(?=(?:\+?63|0)?9[\d\s\-()]{8,14}\d)/gi, "");
  out = out.replace(/\bP(?=(?:0?9\d{9}|63[\d\s-]{10,12}))/g, "");
  return out;
}

function resolvePublicAssetUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (base && raw.startsWith("/")) return `${base}${raw}`;
  return raw;
}

function getGcashQrUrl(tenant) {
  const t = tenant || getActiveTenant();
  const fromTenant = t?.branding?.gcashQrUrl?.trim();
  if (fromTenant) return resolvePublicAssetUrl(fromTenant);
  const envKey = t?.id ? `GCASH_QR_URL_${t.id.replace(/-/g, "_").toUpperCase()}` : "";
  if (envKey && process.env[envKey]?.trim()) {
    return resolvePublicAssetUrl(process.env[envKey].trim());
  }
  return "";
}

function shouldSendGcashQrImage(userText, botReply, tenant) {
  const qrUrl = getGcashQrUrl(tenant);
  if (!qrUrl) return false;

  const user = String(userText || "").toLowerCase();
  const reply = String(botReply || "").toLowerCase();
  const combined = `${user}\n${reply}`;

  const userWantsPayment =
    /\b(?:gcash|g-cash|how (?:to|do i) pay|payment details|pay (?:via|through|now)|send payment|qr code|qr|magbayad|paano magbayad|bayad)\b/i.test(
      user
    );
  const replySharesGcash =
    /\bgcash\b/i.test(reply) &&
    (/\b0?9[\d\s-]{9,12}\b/.test(reply) || /\bregistered name\b/i.test(reply));

  return userWantsPayment || replySharesGcash;
}

function markGcashQrSent(senderId) {
  gcashQrSentAt.set(scopeKey(senderId), Date.now());
}

function shouldSkipGcashQrDuplicate(senderId) {
  const at = gcashQrSentAt.get(scopeKey(senderId));
  if (!at) return false;
  if (Date.now() - at > GCASH_QR_COOLDOWN_MS) {
    gcashQrSentAt.delete(scopeKey(senderId));
    return false;
  }
  return true;
}

module.exports = {
  fixMisplacedPesoOnPhoneNumbers,
  getGcashQrUrl,
  shouldSendGcashQrImage,
  markGcashQrSent,
  shouldSkipGcashQrDuplicate,
  resolvePublicAssetUrl,
};
