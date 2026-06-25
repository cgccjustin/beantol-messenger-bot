const {
  isShopOpenNow,
  isShopClosedToday,
  getTenantSchedule,
  formatCloseHour,
  formatShopLocalTime,
  getShopLocalParts,
  SHOP_TIMEZONE,
} = require("./shop-hours");
const { getShopHours, getShopAddress, businessName } = require("./tenant-messages");

const SUPPORT_TIMEZONE = process.env.SUPPORT_TIMEZONE || "Asia/Manila";
const SUPPORT_HOURS_START = Number(process.env.SUPPORT_HOURS_START || 9);
const SUPPORT_HOURS_END = Number(process.env.SUPPORT_HOURS_END || 21);

function isLiveSupportOpen(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SUPPORT_TIMEZONE,
    hour: "numeric",
    hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  return hour >= SUPPORT_HOURS_START && hour < SUPPORT_HOURS_END;
}

function supportHoursLabel() {
  const end =
    SUPPORT_HOURS_END === 21
      ? "9:00 PM"
      : SUPPORT_HOURS_END === 24
        ? "midnight"
        : formatCloseHour(SUPPORT_HOURS_END);
  return `${formatCloseHour(SUPPORT_HOURS_START)}–${end} Philippine time`;
}

/** Customer asking if the physical shop is open or what the shop hours are. */
function isShopHoursInquiry(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 240) return false;

  if (
    /\b(?:deliver|delivery|padala|hatod|maxim|grab)\b/i.test(t) &&
    !/\b(?:open|hours|bukas|oras|close|closed|tindahan|shop)\b/i.test(t)
  ) {
    return false;
  }

  if (
    /\b(?:gcash|maya|qr|payment|bayad)\b/i.test(t) &&
    !/\b(?:open|hours|bukas|oras|close|closed)\b/i.test(t)
  ) {
    return false;
  }

  if (/^(?:open|bukas)\s*\??$/i.test(t)) return true;

  if (/\b(?:shop\s+)?hours\b/i.test(t)) return true;
  if (/\b(?:opening|closing)\s+(?:hours|time)\b/i.test(t)) return true;
  if (/\bwhat\s+time\s+(?:do\s+you|are\s+you)\s+(?:open|close)/i.test(t)) return true;
  if (/\b(?:when|anong)\s+(?:oras|time).*(?:open|close|bukas|sarado)/i.test(t)) return true;
  if (/\buntil\s+what\s+time\b/i.test(t)) return true;
  if (/\b(?:are|is)\s+(?:you|the\s+shop)\s+open\b/i.test(t)) return true;
  if (/\bopen\s+(?:now|today|pa|ba|ka|po|kaha|kah)\b/i.test(t)) return true;
  if (/\b(?:bukas|open)\s+(?:mo|ba|pa|kah|kaha)\b/i.test(t)) return true;
  if (/\bopen\s+on\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.test(t)) {
    return true;
  }
  if (/\b(?:closed|close|sarado)\s+(?:today|ba|kah|na|karon)\b/i.test(t)) return true;
  if (/\boras\s+(?:mo|ninyo|sa)\b/i.test(t)) return true;

  return false;
}

function addCalendarDaysInShopTz(fromDate, days) {
  const iso = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHOP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(fromDate);
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days, 12, 0, 0));
}

function getNextShopOpenHint(tenant, now = new Date()) {
  const schedule = getTenantSchedule(tenant);
  const openLabel = formatCloseHour(schedule.openHour);
  const { dayIndex: todayIdx, hour, minute } = getShopLocalParts(now);
  const mins = hour * 60 + minute;
  const beforeOpenToday =
    schedule.openDays.includes(todayIdx) && mins < schedule.openHour * 60;

  for (let offset = beforeOpenToday ? 0 : 1; offset <= 7; offset++) {
    const probe = addCalendarDaysInShopTz(now, offset);
    const { dayIndex, weekday } = getShopLocalParts(probe);
    if (!schedule.openDays.includes(dayIndex)) continue;
    if (offset === 0) return `today at ${openLabel}`;
    if (offset === 1) return `tomorrow at ${openLabel}`;
    return `${weekday} at ${openLabel}`;
  }
  return openLabel;
}

function formatHoursLine(hours) {
  const h = String(hours || "").trim().replace(/[.!?]+$/, "");
  return h ? `Regular shop hours: ${h}.` : "";
}

function buildShopHoursReply(tenant, options = {}) {
  const now = options.now || new Date();
  const liveChat = options.liveChatAvailable ?? isLiveSupportOpen(now);
  const name = businessName(tenant);
  const hours = getShopHours(tenant);
  const address = getShopAddress(tenant);
  const schedule = getTenantSchedule(tenant);
  const openLabel = formatCloseHour(schedule.openHour);
  const closeLabel = formatCloseHour(schedule.closeHour);
  const localTime = formatShopLocalTime(now);
  const open = isShopOpenNow(tenant, now);
  const closedAllDay = isShopClosedToday(tenant, now);
  const nextOpen = getNextShopOpenHint(tenant, now);

  const lines = [];

  if (open) {
    lines.push(
      `Yes — ${name} is open right now (as of ${localTime}, Philippine time).`,
      "",
      `We're open until ${closeLabel} today. ${formatHoursLine(hours)}`
    );
  } else if (closedAllDay) {
    lines.push(
      `The shop is closed today (${localTime}, Philippine time).`,
      "",
      formatHoursLine(hours),
      `We open next on ${nextOpen}.`
    );
  } else {
    lines.push(
      `The shop is closed right now (${localTime}, Philippine time) — today's hours are ${openLabel}–${closeLabel}.`,
      "",
      formatHoursLine(hours),
      `We open again ${nextOpen}.`
    );
  }

  lines.push("");
  if (liveChat) {
    lines.push(
      `You can still message us here until ${formatCloseHour(SUPPORT_HOURS_END)} for orders and questions. Live chat support is ${supportHoursLabel()} — separate from shop walk-in hours.`
    );
  } else {
    lines.push(
      `Live chat support is ${supportHoursLabel()}. Message us again during those hours if you'd like a team member, or I can still help with menu and order questions when support is open.`
    );
  }

  if (address) {
    lines.push("", `📍 ${address}`);
  }

  if (open) {
    lines.push("", "Would you like to order for pickup or delivery?");
  }
  return lines.join("\n");
}

function isDeliveryInquiryText(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  return (
    /\b(?:delivery|deliver|deliveries|padala|hatod|shipping|ship|maxim|grab)\b/i.test(t) ||
    /\b(?:pwede|puede|gusto|can i|can you).*(?:deliver|hatod|padala|maxim|grab)\b/i.test(t) ||
    /\border.*(?:deliver|hatod|padala|maxim|grab)\b/i.test(t) ||
    /\b(?:deliver|hatod|padala|maxim|grab).*(?:order|coffee|drink|beans)\b/i.test(t)
  );
}

function isPickupInquiryText(text) {
  const t = String(text || "").trim();
  return /\b(?:pickup|pick-up|pick up|pick it up|will pick up|for pick up|self-?collect|kuha sa shop|moadto|mangadto)\b/i.test(
    t
  );
}

/** Delivery, pickup, or order intent while the physical shop is closed. */
function isShopClosedFulfillmentIntent(text, options = {}) {
  const t = String(text || "").trim();
  if (!t || t.length > 400) return false;
  if (isShopHoursInquiry(t)) return false;
  if (options.looksLikeDeliveryDetails) return true;

  const { ORDER_INTENT_PATTERN, detectFulfillment, analyzeOrderSignal } = require("./lead-capture");

  if (isDeliveryInquiryText(t)) return true;
  if (isPickupInquiryText(t)) return true;
  if (ORDER_INTENT_PATTERN.test(t)) return true;

  const fulfillment = detectFulfillment(t);
  if (fulfillment === "delivery" || fulfillment === "pickup") return true;

  const signal = analyzeOrderSignal(t, {
    historyTexts: options.historyTexts || [],
    isDeliveryDetails: Boolean(options.looksLikeDeliveryDetails),
  });
  if (!signal) return false;
  return (
    signal.trigger === "order intent" ||
    signal.trigger === "add to order" ||
    signal.trigger === "delivery details" ||
    signal.orderStatus === "pending"
  );
}

function buildShopClosedFulfillmentReply(tenant, userText, options = {}) {
  const now = options.now || new Date();
  const looksLikeDeliveryDetails = Boolean(options.looksLikeDeliveryDetails);
  const { detectFulfillment } = require("./lead-capture");
  const hours = getShopHours(tenant);
  const schedule = getTenantSchedule(tenant);
  const closeLabel = formatCloseHour(schedule.closeHour);
  const localTime = formatShopLocalTime(now);
  const closedAllDay = isShopClosedToday(tenant, now);
  const nextOpen = getNextShopOpenHint(tenant, now);
  const fulfillment = detectFulfillment(userText);
  const delivery =
    looksLikeDeliveryDetails || fulfillment === "delivery" || isDeliveryInquiryText(userText);
  const pickup = fulfillment === "pickup" || isPickupInquiryText(userText);

  const closedLine = closedAllDay
    ? `We're closed today (${localTime}, Philippine time).`
    : `We're already closed for today (${localTime}, Philippine time — the shop closed at ${closeLabel}).`;

  const lines = [closedLine, "", formatHoursLine(hours)];

  if (looksLikeDeliveryDetails) {
    lines.push(
      "",
      "Thanks — we've noted your message.",
      `We'll arrange your order first thing when we resume operations (${nextOpen}).`
    );
  } else if (delivery) {
    lines.push(
      "",
      "Yes — we can take your delivery order here.",
      `We're closed for walk-in and dispatch right now, but we'll arrange delivery first thing when we resume operations (${nextOpen}).`
    );
  } else if (pickup) {
    lines.push(
      "",
      `We can take your order now for pickup when we open again (${nextOpen}). Same-day pickup isn't available while we're closed.`
    );
  } else {
    lines.push(
      "",
      `We can take your order now and prepare it first thing when we resume operations (${nextOpen}).`
    );
  }

  if (!looksLikeDeliveryDetails) {
    lines.push("", "To get started, please send:");
    lines.push("• What you'd like (item and quantity)");
    if (delivery) {
      lines.push("• Complete delivery address, contact name, and mobile number");
    } else {
      lines.push("• Pickup or delivery preference");
    }
    lines.push(
      "",
      "When you're ready to pay, send your GCash payment screenshot here (or pay cash on pickup when we're open)."
    );
  } else {
    lines.push(
      "",
      "If you haven't paid yet, send your GCash payment screenshot here when ready — we'll process everything when the shop opens."
    );
  }

  return lines.join("\n");
}

module.exports = {
  isShopHoursInquiry,
  buildShopHoursReply,
  isLiveSupportOpen,
  isShopClosedFulfillmentIntent,
  buildShopClosedFulfillmentReply,
};
