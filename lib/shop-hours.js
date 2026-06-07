const SHOP_TIMEZONE = process.env.SUPPORT_TIMEZONE || "Asia/Manila";

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
    "- On your first reply this conversation (unless they only said hi), briefly mention we are closed weekends — you can still answer product, pricing, and general questions.\n" +
    "- Do NOT promise same-day pickup, shop visit, or Maxim dispatch on Saturday or Sunday.\n" +
    "- DELIVERY / PICKUP / DISPATCH on weekends: politely say we can arrange Maxim delivery or process their order first thing on Monday (once order and payment are confirmed). Offer to note their details now.\n" +
    `- ${agentLine}\n` +
    "- Do not be pushy with sales on weekends — help first, soft close only if natural."
  );
}

function buildWeekendDeliveryReply(agentAvailable) {
  const agentOffer = agentAvailable
    ? "If you'd like to chat with a sales rep now, reply YES — or tell me you'd like a real person. You can also leave your message here and we'll follow up."
    : "You can leave your message here and our team will follow up on Monday morning. Live chat with a sales rep is available daily 9 AM–9 PM Philippine time.";

  return (
    "Our shop is closed on weekends (we're open Monday–Friday, 9 AM–6 PM).\n\n" +
    "We can arrange your Maxim delivery first thing on Monday once your order and payment are confirmed.\n\n" +
    "I'm still happy to answer questions about coffee and pricing today.\n\n" +
    agentOffer
  );
}

function isWeekendDeliveryContext(userText, options = {}) {
  const { looksLikeDeliveryDetails = false } = options;
  const t = String(userText || "").trim();
  if (!t) return false;

  try {
    const { isOutsideCebuDeliveryInquiry } = require("./outside-cebu-delivery");
    if (isOutsideCebuDeliveryInquiry(t)) return false;
  } catch (_) {
    /* optional at load time */
  }

  if (looksLikeDeliveryDetails) return true;
  return (
    /\b(?:delivery|deliver|deliveries|padala|hatod|shipping|ship|maxim|dispatch|pickup|pick up|collect)\b/i.test(
      t
    ) ||
    /\b(?:pwede|puede|gusto|can i|can you).*(?:deliver|hatod|padala|maxim|pickup)\b/i.test(t)
  );
}

module.exports = {
  isWeekend,
  getWeekendSystemNote,
  buildWeekendDeliveryReply,
  isWeekendDeliveryContext,
};
