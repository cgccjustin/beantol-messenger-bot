const { getActiveTenant } = require("./tenant-context");
const { getShopHours, getShopAddress, businessName } = require("./tenant-messages");

/** Physical shop open/close — always Philippine time unless SHOP_TIMEZONE is set. */
const SHOP_TIMEZONE = process.env.SHOP_TIMEZONE || "Asia/Manila";

const SHOP_ADDRESS =
  process.env.SHOP_ADDRESS ||
  "Holy Family Village 2, Governor Cuenco Avenue, Banilad, Cebu City (beside the guardhouse).";
const SHOP_HOURS =
  process.env.SHOP_HOURS || "Monday–Friday, 9:00 AM–6:00 PM (shop closed on weekends).";

/** Mon=1 … Sun=0 (JS Date.getDay()). */
const DEFAULT_SCHEDULE = { openDays: [1, 2, 3, 4, 5], openHour: 9, closeHour: 18 };

const TENANT_SCHEDULES = {
  beantol: { openDays: [1, 2, 3, 4, 5], openHour: 9, closeHour: 18 },
  "kape-kristiano": { openDays: [1, 2, 3, 4, 5], openHour: 9, closeHour: 18 },
  "offbeat-brew": { openDays: [1, 2, 3, 4, 5, 6], openHour: 9, closeHour: 18 },
};

function weekdayToIndex(weekdayShort) {
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[weekdayShort] ?? 0;
}

function formatCloseHour(hour24) {
  if (hour24 === 12) return "12:00 PM";
  if (hour24 > 12) return `${hour24 - 12}:00 PM`;
  return `${hour24}:00 AM`;
}

function getShopLocalParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SHOP_TIMEZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const weekday = parts.find((p) => p.type === "weekday")?.value || "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return { weekday, hour, minute, dayIndex: weekdayToIndex(weekday) };
}

function getTenantSchedule(tenant) {
  const t = tenant || getActiveTenant();
  if (Array.isArray(t?.shop?.openDays) && t.shop.openDays.length) {
    return {
      openDays: t.shop.openDays.map(Number),
      openHour: Number(t.shop.openHour ?? 9),
      closeHour: Number(t.shop.closeHour ?? 18),
    };
  }
  if (t?.id && TENANT_SCHEDULES[t.id]) return TENANT_SCHEDULES[t.id];
  const hours = String(t?.shop?.hours || "").toLowerCase();
  if (/monday[–\-]\s*saturday|mon[–\-]\s*sat|monday to saturday/i.test(hours)) {
    return { openDays: [1, 2, 3, 4, 5, 6], openHour: 9, closeHour: 18 };
  }
  return DEFAULT_SCHEDULE;
}

function isShopOpenNow(tenant, date = new Date()) {
  const schedule = getTenantSchedule(tenant);
  const { dayIndex, hour, minute } = getShopLocalParts(date);
  if (!schedule.openDays.includes(dayIndex)) return false;
  const mins = hour * 60 + minute;
  return mins >= schedule.openHour * 60 && mins < schedule.closeHour * 60;
}

/** Shop is not open on this calendar day (e.g. Sunday for Offbeat, Sat/Sun for Beantol). */
function isShopClosedToday(tenant, date = new Date()) {
  const schedule = getTenantSchedule(tenant);
  const { dayIndex } = getShopLocalParts(date);
  return !schedule.openDays.includes(dayIndex);
}

function formatShopLocalTime(date = new Date()) {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: SHOP_TIMEZONE,
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

function getShopStatusSystemNote(tenant) {
  const t = tenant || getActiveTenant();
  const hours = getShopHours(t) || SHOP_HOURS;
  const schedule = getTenantSchedule(t);
  const now = new Date();
  const open = isShopOpenNow(t, now);
  const closedAllDay = isShopClosedToday(t, now);
  const localTime = formatShopLocalTime(now);
  const closeLabel = formatCloseHour(schedule.closeHour);

  let guidance;
  if (open) {
    guidance =
      `- If the customer asks "are you open?", "open now?", or similar: say YES — the shop is open until ${closeLabel} today.\n` +
      "- Same-day pickup is OK only if they can arrive before closing.\n";
  } else if (closedAllDay) {
    guidance =
      `- If the customer asks "are you open?", "open now?", or similar: say NO — the shop is closed today.\n` +
      `- Regular hours: ${hours}\n` +
      "- Do NOT say the shop is open or invite same-day pickup/visit today.\n";
  } else {
    guidance =
      `- If the customer asks "are you open?", "open now?", or similar: say NO — the shop is closed right now (outside today's opening hours).\n` +
      `- Regular hours: ${hours}\n` +
      "- Do NOT say the shop is open or invite same-day pickup/visit now.\n";
  }

  return (
    `SHOP STATUS NOW (authoritative — ${SHOP_TIMEZONE}; overrides guesses from KNOWLEDGE CONTEXT):\n` +
    `- Local time now: ${localTime}\n` +
    `- Physical shop: ${open ? "OPEN right now" : "CLOSED right now"}\n` +
    `- Regular hours: ${hours}\n` +
    guidance +
    "- Live chat agent handoff (9 AM–9 PM) is separate from shop hours — follow the live support note for [[HANDOFF]]."
  );
}

/** Beantol-style Sat/Sun — kept for legacy callers; prefer isShopClosedToday(tenant). */
function isWeekend(date = new Date()) {
  const { weekday } = getShopLocalParts(date);
  return weekday === "Sat" || weekday === "Sun";
}

function getWeekendSystemNote(agentAvailable, tenant) {
  const t = tenant || getActiveTenant();
  const hours = getShopHours(t) || SHOP_HOURS;
  const agentLine = agentAvailable
    ? "If they want a sales rep, they may reply YES or ask for a real person during live chat hours (9 AM–9 PM Philippine time) — use [[HANDOFF]] only when rules allow."
    : "Live agents are outside chat hours (9 AM–9 PM) — do NOT use [[HANDOFF]]. They can leave a message and the team will follow up on Monday or during support hours.";

  return (
    "WEEKEND / SHOP CLOSED (Saturday & Sunday — strict):\n" +
    `- ${businessName(t)} shop is CLOSED on weekends. Regular shop hours: ${hours}.\n` +
    "- On your first reply, answer their question first — then add ONE brief weekend note if relevant (shop closed; no same-day dispatch).\n" +
    "- Do NOT promise same-day pickup, shop visit, or Maxim dispatch on Saturday or Sunday.\n" +
    "- PICKUP on weekends: say the shop is closed; order can be picked up first thing on the next open shop day once order and payment are confirmed. Give shop address and hours. Do NOT mention Maxim.\n" +
    "- DELIVERY (Maxim, Cebu City / Mandaue / Talisay / Lapu-Lapu only) on weekends: say we can arrange Maxim first thing on the next open shop day once order and payment are confirmed.\n" +
    "- REMOTE CEBU PROVINCE (Naga, Carcar, etc. — far from shop): no Maxim — offer pickup, own logistics, or J&T / preferred courier; fee shouldered by client.\n" +
    `- ${agentLine}\n` +
    "- Do not be pushy with sales on weekends — help first, soft close only if natural."
  );
}

function buildWeekendAgentOffer(agentAvailable) {
  if (!agentAvailable) return "";
  return "Reply YES anytime if you'd like to chat with a sales rep.";
}

function buildWeekendPickupReply(agentAvailable, tenant) {
  const t = tenant || getActiveTenant();
  const address = getShopAddress(t) || SHOP_ADDRESS;
  const hours = getShopHours(t) || SHOP_HOURS;
  const lines = [
    `Our shop is closed on weekends (${hours}).`,
    "",
    "We can prepare your order for pickup on the next open shop day once your order and payment are confirmed.",
    "",
    `📍 ${address}`,
    `🕐 ${hours}`,
  ];
  const agentLine = buildWeekendAgentOffer(agentAvailable);
  if (agentLine) lines.push("", agentLine);
  return lines.join("\n");
}

function buildWeekendDeliveryReply(agentAvailable, tenant) {
  const t = tenant || getActiveTenant();
  const hours = getShopHours(t) || SHOP_HOURS;
  const lines = [
    "For Cebu City, Mandaue, Talisay, and Lapu-Lapu we arrange delivery via Maxim — delivery fee is paid by you to the rider, separate from your coffee order.",
    "",
    "For other towns in Cebu Province (e.g. Naga, Carcar), pickup at our shop, your own logistics, or J&T / a courier you prefer may work better.",
    "",
    `Our shop is closed on weekends (${hours}). We can process orders on the next open shop day once payment is confirmed.`,
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
  isShopOpenNow,
  isShopClosedToday,
  getShopStatusSystemNote,
  getTenantSchedule,
  formatCloseHour,
  formatShopLocalTime,
  getShopLocalParts,
  SHOP_TIMEZONE,
  getWeekendSystemNote,
  buildWeekendPickupReply,
  buildWeekendDeliveryReply,
  isWeekendPickupContext,
  isWeekendDeliveryContext,
};
