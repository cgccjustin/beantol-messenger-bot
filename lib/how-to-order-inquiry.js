const { resolveProfile } = require("./tenant-system-rules");
const { getShopAddress, getShopHours, businessName } = require("./tenant-messages");
const { parseCafeOrderFromText } = require("./cafe-order-flow");

const MENU_PRODUCT_HINT =
  /\b(?:offbeat|unplugged|latte|cappuccino|americano|mocha|dulce|choco|matcha|strawberry|spanish|himalayan|tablea|pour-over|empanada|ensaymada|carbonara|siomai|sisig|humba|ramyun|fries|fizzy|cloud|brew)\b/i;

const BUY_BEANS_INQUIRY =
  /\b(?:buy\s+beans?|order\s+beans?|roasted\s+beans?|take-home\s+beans?|sell\s+beans?|coffee\s+beans?\s+(?:to\s+)?buy|benta.*beans?|retail\s+bags?\s+of)\b/i;

const HOW_TO_ORDER_INQUIRY =
  /\b(?:how\s+(?:can\s+)?i\s+order|how\s+(?:do|to)\s+order|how\s+to\s+place\s+an?\s+order|order\s+process|paano\s+(?:mag)?order|unsaon\s+(?:pag)?order|like\s+to\s+order|want\s+to\s+order|gusto\s+(?:ko\s+)?mag\s*order|order\s+lang)\b/i;

function isBuyBeansInquiry(text) {
  return BUY_BEANS_INQUIRY.test(String(text || ""));
}

/** Generic menu-order question — not wholesale beans or a specific product order line. */
function isHowToOrderInquiry(text, tenant = null) {
  const t = String(text || "").trim();
  if (!t || t.length > 280) return false;
  if (isBuyBeansInquiry(t)) return false;
  if (tenant && parseCafeOrderFromText(t, tenant)?.length) return false;
  if (MENU_PRODUCT_HINT.test(t) && /\border\b/i.test(t)) return false;
  if (/\b(?:beans?|roasted|take-home|retail bag)\b/i.test(t) && /\border\b/i.test(t)) {
    return false;
  }
  if (/\b\d+\s*(?:x|pcs?|bottles?|btl|kg|g)\b/i.test(t)) return false;
  if (/^(?:i(?:'d| would)?\s+like\s+to\s+order|gusto\s+ko\s+mag\s*order)[\s.!?]*$/i.test(t)) {
    return true;
  }
  return HOW_TO_ORDER_INQUIRY.test(t);
}

function buildHowToOrderReply(tenant) {
  const brand = businessName(tenant);
  const address = getShopAddress(tenant);
  const hours = getShopHours(tenant);

  if (tenant?.id === "offbeat-brew") {
    return [
      `Here's how to order at ${brand}:`,
      "",
      "• Messenger / Instagram: Tell us what you'd like (e.g. 1× Offbeat White), whether pickup or delivery, and we'll guide you through payment.",
      `• Pickup: Visit us during shop hours — ${hours} — at ${address}.`,
      "• Delivery: Iligan City via Maxim or Grab. The rider fee is paid by you separately. We'll ask for your complete address, contact name, and mobile number.",
      "",
      "What would you like to order today?",
    ].join("\n");
  }

  if (tenant?.id === "kape-kristiano") {
    return [
      `Here's how to order at ${brand}:`,
      "",
      "• Messenger / Instagram: Tell us what you'd like from the menu, pickup or delivery, and we'll guide you through payment.",
      `• Pickup: Visit us during shop hours — ${hours} — at ${address}.`,
      "• Delivery: Cebu City, Mandaue, Talisay, and Lapu-Lapu via Maxim (rider fee paid separately). Send your complete address, name, and mobile number.",
      "",
      "What would you like to order today?",
    ].join("\n");
  }

  if (resolveProfile(tenant) === "cafe") {
    return [
      `Here's how to order at ${brand}:`,
      "",
      "• Message us here with what you'd like from the menu and whether you prefer pickup or delivery.",
      address ? `• Pickup: ${address}` : "",
      hours ? `• Shop hours: ${hours}` : "",
      "",
      "What would you like to order today?",
    ]
      .filter(Boolean)
      .join("\n");
  }

  return null;
}

function isCafeHowToOrderEnabled(tenant) {
  return resolveProfile(tenant) === "cafe";
}

module.exports = {
  isHowToOrderInquiry,
  isBuyBeansInquiry,
  buildHowToOrderReply,
  isCafeHowToOrderEnabled,
};
