const { isOutsideCebuDeliveryInquiry } = require("./outside-cebu-delivery");

/** Maxim local delivery — Cebu City metro + nearby cities. */
const MAXIM_DELIVERY_PLACES =
  /\b(?:cebu city|mandaue|talisay|lapu-?lapu|banilad|lahug|it park|itpark|guadalupe|mabolo|capitol|ayala center cebu)\b/i;

/** Cebu Province towns where Maxim is impractical — J&T / own logistics / pickup. */
const REMOTE_CEBU_PROVINCE_PLACES =
  /\b(?:naga|carcar|consolacion|liloan|minglanilla|toledo|danao|compostela|cordova|balamban|moalboal|oslob|bogo|tabogon|dalaguete|samboan|barili|pinamungajan|argao|dumanjug|guindulman|santander|sibonga|sogod|tuburan|tudela|catmon|ginatilan|badian|asturias|san fernando|poblacion)\b/i;

const SHOP_ADDRESS =
  process.env.SHOP_ADDRESS ||
  "Holy Family Village 2, Governor Cuenco Avenue, Banilad, Cebu City (beside the guardhouse).";
const SHOP_HOURS =
  process.env.SHOP_HOURS || "Monday–Friday, 9:00 AM–6:00 PM (shop closed on weekends).";

function hasDeliveryIntent(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  return (
    /\b(?:deliver|delivery|padala|hatod|shipping|ship|maxim|send|courier|logistics)\b/i.test(t) ||
    /\b(?:can you|could you|pwede|puede|gusto).*(?:deliver|padala|hatod|send|ship)\b/i.test(t) ||
    /\b(?:deliver|padala|hatod|send|ship).*(?:to|sa)\b/i.test(t)
  );
}

function capitalizePlace(raw) {
  return String(raw || "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function extractPlaceName(text) {
  const t = String(text || "");
  const maximMatch = t.match(MAXIM_DELIVERY_PLACES);
  if (maximMatch) return capitalizePlace(maximMatch[0]);
  const remoteMatch = t.match(REMOTE_CEBU_PROVINCE_PLACES);
  if (remoteMatch) return capitalizePlace(remoteMatch[0]);
  return "";
}

function getDeliveryZone(text) {
  const t = String(text || "").trim();
  if (!t) return "";
  if (MAXIM_DELIVERY_PLACES.test(t)) return "maxim";
  if (REMOTE_CEBU_PROVINCE_PLACES.test(t)) return "remote_cebu";
  if (/\b(?:within|around|in)\s+(?:metro\s+)?cebu\b/i.test(t) && !/\bprovince\b/i.test(t)) {
    return "maxim";
  }
  return "";
}

function isCebuAreaDeliveryInquiry(text) {
  const t = String(text || "").trim();
  if (!hasDeliveryIntent(t)) return false;
  if (isOutsideCebuDeliveryInquiry(t)) return false;
  return getDeliveryZone(t) !== "";
}

function buildWeekendFulfillmentNote() {
  return (
    "Our shop is closed on weekends (Mon–Fri, 9 AM–6 PM). " +
    "We can process your order first thing on Monday once payment is confirmed."
  );
}

function buildAgentLine(agentAvailable) {
  if (!agentAvailable) return "";
  return "Reply YES anytime if you'd like to chat with a sales rep.";
}

function buildMaximDeliveryReply(options = {}) {
  const { place = "", isWeekend = false, agentAvailable = false } = options;
  const destination = place ? ` to ${place}` : " to Cebu City, Mandaue, Talisay, or Lapu-Lapu";
  const lines = [
    `Yes — we can arrange Maxim delivery${destination}. The delivery fee is paid by you to the rider, separate from your coffee order.`,
  ];
  if (isWeekend) {
    lines.push("", buildWeekendFulfillmentNote());
  }
  lines.push(
    "",
    "To arrange delivery, please send in one message: (1) complete address, (2) contact name, and (3) mobile number."
  );
  const agentLine = buildAgentLine(agentAvailable);
  if (agentLine) lines.push("", agentLine);
  return lines.join("\n");
}

function buildRemoteCebuProvinceDeliveryReply(options = {}) {
  const { place = "", isWeekend = false, agentAvailable = false } = options;
  const area = place ? `${place} (Cebu Province)` : "your area in Cebu Province";
  const lines = [
    `Yes — we can get your order to ${area}. It's a bit far from our shop for our usual Maxim rider, so here are your options:`,
    "",
    `• **Pickup** at our shop — ${SHOP_ADDRESS} (${SHOP_HOURS})`,
    "• **Your own logistics** — you arrange a courier to pick up from us",
    "• **J&T or a courier you prefer** — we can help arrange shipping; delivery fee is shouldered by you, separate from your coffee order",
  ].map((line) => line.replace(/\*\*/g, ""));
  if (isWeekend) {
    lines.push("", buildWeekendFulfillmentNote());
  }
  lines.push(
    "",
    "Tell us which option works for you, and send your name, mobile, full address, and order details if you'd like us to help arrange shipping."
  );
  const agentLine = buildAgentLine(agentAvailable);
  if (agentLine) lines.push("", agentLine);
  return lines.join("\n");
}

function buildCebuAreaDeliveryReply(options = {}) {
  const { zone = "maxim", place = "", isWeekend = false, agentAvailable = false } = options;
  if (zone === "remote_cebu") {
    return buildRemoteCebuProvinceDeliveryReply({ place, isWeekend, agentAvailable });
  }
  return buildMaximDeliveryReply({ place, isWeekend, agentAvailable });
}

function getCebuDeliverySystemNote() {
  return (
    "CEBU DELIVERY ZONES (strict):\n" +
    "- MAXIM (local rider): Cebu City, Mandaue, Talisay, Lapu-Lapu only. Delivery fee paid by customer to rider, separate from coffee.\n" +
    "- REMOTE CEBU PROVINCE (e.g. Naga, Carcar, Toledo — far from shop): Do NOT promise Maxim. Offer: (1) pickup at shop, (2) customer arranges own logistics/courier pickup, or (3) J&T or courier they prefer — shipping fee shouldered by client.\n" +
    "- OUTSIDE CEBU / other provinces: J&T or preferred courier only — never Maxim.\n" +
    "- Always answer their location question first; one brief weekend note if relevant."
  );
}

/**
 * @returns {{ handled: boolean, reply?: string, zone?: string }}
 */
function resolveCebuAreaDeliveryTurn(userText, options = {}) {
  const zone = getDeliveryZone(userText);
  if (!isCebuAreaDeliveryInquiry(userText) || !zone) return { handled: false };
  const { isWeekend = false, agentAvailable = false } = options;
  return {
    handled: true,
    zone,
    reply: buildCebuAreaDeliveryReply({
      zone,
      place: extractPlaceName(userText),
      isWeekend,
      agentAvailable,
    }),
  };
}

module.exports = {
  MAXIM_DELIVERY_PLACES,
  REMOTE_CEBU_PROVINCE_PLACES,
  isCebuAreaDeliveryInquiry,
  getDeliveryZone,
  extractPlaceName,
  buildMaximDeliveryReply,
  buildRemoteCebuProvinceDeliveryReply,
  buildCebuAreaDeliveryReply,
  getCebuDeliverySystemNote,
  resolveCebuAreaDeliveryTurn,
};
