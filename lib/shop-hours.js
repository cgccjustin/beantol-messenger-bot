const SHOP_TIMEZONE = process.env.SUPPORT_TIMEZONE || "Asia/Manila";

const SHOP_ADDRESS =
  process.env.SHOP_ADDRESS ||
  "Holy Family Village 2, Governor Cuenco Avenue, Banilad, Cebu City (beside the guardhouse).";
const SHOP_HOURS =
  process.env.SHOP_HOURS || "Monday–Friday, 9:00 AM–6:00 PM (shop closed on weekends).";

function getShopLocalParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SHOP_TIMEZONE,
    weekday: "short",
    hour: "numeric",
    hour12: false,
  }).formatToParts(date);
  const weekday = parts.find((p) => p.type === "weekday")?.value || "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  return { weekday, hour };
}

function isWeekend(date = new Date()) {
  const { weekday } = getShopLocalParts(date);
  return weekday === "Sat" || weekday === "Sun";
}

function getWeekendSystemNote(agentAvailable) {
  const agentLine = agentAvailable
    ? "If they want a sales rep, they may reply YES or ask for a real person during live chat hours (9 AM–9 PM Philippine time) — use [[HANDOFF]] only when rules allow."
    : "Live agents are outside chat hours (9 AM–9 PM) — do NOT use [[HANDOFF]]. They can leave a message and the team will follow up on Monday or during support hours.";

  return (
    "WEEKEND / SHOP CLOSED (Saturday & Sunday — strict):\n" +
    "- Beantol shop is CLOSED on weekends. Regular shop hours: Monday–Friday, 9:00 AM–6:00 PM.\n" +
    "- On your first reply, answer their question first — then add ONE brief weekend note if relevant (shop closed Mon–Fri hours only; no same-day dispatch).\n" +
    "- Do NOT promise same-day pickup, shop visit, or Maxim dispatch on Saturday or Sunday.\n" +
    "- PICKUP on weekends: say the shop is closed; order can be picked up first thing on Monday once order and payment are confirmed. Give shop address and hours. Do NOT mention Maxim.\n" +
    "- DELIVERY (Maxim, Cebu City / Mandaue / Talisay / Lapu-Lapu only) on weekends: say we can arrange Maxim first thing on Monday once order and payment are confirmed.\n" +
    "- REMOTE CEBU PROVINCE (Naga, Carcar, etc. — far from shop): no Maxim — offer pickup, own logistics, or J&T / preferred courier; fee shouldered by client.\n" +
    `- ${agentLine}\n` +
    "- Do not be pushy with sales on weekends — help first, soft close only if natural."
  );
}

function buildWeekendAgentOffer(agentAvailable) {
  if (!agentAvailable) return "";
  return "Reply YES anytime if you'd like to chat with a sales rep.";
}

function buildWeekendPickupReply(agentAvailable) {
  const lines = [
    "Our shop is closed on weekends (Mon–Fri, 9 AM–6 PM).",
    "",
    "We can prepare your order for pickup first thing on Monday once your order and payment are confirmed.",
    "",
    `📍 ${SHOP_ADDRESS}`,
    `🕐 ${SHOP_HOURS}`,
  ];
  const agentLine = buildWeekendAgentOffer(agentAvailable);
  if (agentLine) lines.push("", agentLine);
  return lines.join("\n");
}

function buildWeekendDeliveryReply(agentAvailable) {
  const lines = [
    "For Cebu City, Mandaue, Talisay, and Lapu-Lapu we arrange delivery via Maxim — delivery fee is paid by you to the rider, separate from your coffee order.",
    "",
    "For other towns in Cebu Province (e.g. Naga, Carcar), pickup at our shop, your own logistics, or J&T / a courier you prefer may work better.",
    "",
    "Our shop is closed on weekends (Mon–Fri, 9 AM–6 PM). We can process orders first thing on Monday once payment is confirmed.",
    "",
    "Tell us your location and we can suggest the best option — or send address, name, mobile, and order details.",
  ];
  const agentLine = buildWeekendAgentOffer(agentAvailable);
  if (agentLine) lines.push("", agentLine);
  return lines.join("\n");
}

function isWeekendPickupContext(userText) {
  const { detectFulfillment } = require("./lead-capture");
  return detectFulfillment(String(userText || "").trim()) === "pickup";
}

function isWeekendDeliveryContext(userText, options = {}) {
  const { looksLikeDeliveryDetails = false } = options;
  const t = String(userText || "").trim();
  if (!t) return false;

  if (isWeekendPickupContext(t)) return false;

  try {
    const { isOutsideCebuDeliveryInquiry } = require("./outside-cebu-delivery");
    if (isOutsideCebuDeliveryInquiry(t)) return false;
    const { isCebuAreaDeliveryInquiry } = require("./cebu-area-delivery");
    if (isCebuAreaDeliveryInquiry(t)) return false;
  } catch (_) {
    /* optional at load time */
  }

  if (looksLikeDeliveryDetails) return true;
  return (
    /\b(?:delivery|deliver|deliveries|padala|hatod|shipping|ship|maxim|dispatch)\b/i.test(
      t
    ) ||
    /\b(?:pwede|puede|gusto|can i|can you).*(?:deliver|hatod|padala|maxim)\b/i.test(t)
  );
}

module.exports = {
  isWeekend,
  getWeekendSystemNote,
  buildWeekendPickupReply,
  buildWeekendDeliveryReply,
  isWeekendPickupContext,
  isWeekendDeliveryContext,
};
