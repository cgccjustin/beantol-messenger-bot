const { scopeKey, getActiveTenant } = require("./tenant-context");
const { businessName } = require("./tenant-messages");

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

function usesGcashQrOnly(tenant) {
  return Boolean(getGcashQrUrl(tenant));
}

function isGcashOrPaymentInquiry(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return false;
  return (
    /\b(?:gcash|g-cash)\??\b/i.test(t) ||
    /\bhow (?:to|do i|can i) pay\b/i.test(t) ||
    /\bpayment(?: method| details| info)?\b/i.test(t) ||
    /\bpay (?:via|through|now|how|using)\b/i.test(t) ||
    /\b(?:magbayad|paano magbayad|bayad|send payment|qr code|scan to pay)\b/i.test(t)
  );
}

function buildGcashQrPaymentReply(tenant) {
  const shop = businessName(tenant);
  return [
    `You can pay via GCash or cash on pickup at ${shop}.`,
    "",
    "I'll send our GCash QR code now — open GCash, tap Scan, and scan the code to pay.",
    "After paying, please send your payment screenshot here in chat.",
    "",
    "Need help with your order first?",
  ].join("\n");
}

function buildGcashQrPaymentSystemNote(tenant) {
  if (!usesGcashQrOnly(tenant)) return "";
  return (
    "GCASH PAYMENT (strict — QR only in chat):\n" +
    "- Do NOT type, quote, or mention the GCash mobile number or any phone digits for payment.\n" +
    "- Say the bot will send the GCash QR code to scan in the GCash app.\n" +
    "- Cash on pickup is also OK.\n" +
    "- After paying, ask them to send payment proof (screenshot) in this chat."
  );
}

/** Remove GCash mobile numbers from bot text when QR-only mode is on. */
function applyGcashQrOnlyReplyPolicy(text, tenant) {
  if (!usesGcashQrOnly(tenant)) return text;
  let out = String(text || "");
  out = out.replace(/\b(?:gcash|g-cash)\s*(?:number|no\.?|#|mobile(?:\s*number)?)?\s*:?\s*0?9[\d\s-]{9,12}\b/gi, "GCash QR code");
  out = out.replace(/\b0?9[\d\s-]{9,12}\b/g, "");
  out = out.replace(/\(registered name:[^)]+\)/gi, "");
  out = out.replace(/registered name:\s*[^\n.,]+/gi, "");
  out = out.replace(/\(\s*\)/g, "");
  out = out.replace(/(?:,\s*)?(?:or\s+)?(?:via\s+)?GCash\s*(?:number|no\.?)?\s*(?:\(\s*\))?/gi, (m) =>
    /via/i.test(m) ? "via GCash QR code" : m
  );
  return out.replace(/\n{3,}/g, "\n\n").replace(/  +/g, " ").trim();
}

function shouldSendGcashQrImage(userText, botReply, tenant) {
  const qrUrl = getGcashQrUrl(tenant);
  if (!qrUrl) return false;
  if (isGcashOrPaymentInquiry(userText)) return true;

  const reply = String(botReply || "").toLowerCase();
  return (
    /\bgcash\b/i.test(reply) &&
    (/\b0?9[\d\s-]{9,12}\b/.test(reply) ||
      /\bregistered name\b/i.test(reply) ||
      /\bqr\b/i.test(reply) ||
      /\bscan\b/i.test(reply))
  );
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
  usesGcashQrOnly,
  isGcashOrPaymentInquiry,
  buildGcashQrPaymentReply,
  buildGcashQrPaymentSystemNote,
  applyGcashQrOnlyReplyPolicy,
  shouldSendGcashQrImage,
  markGcashQrSent,
  shouldSkipGcashQrDuplicate,
  resolvePublicAssetUrl,
};
