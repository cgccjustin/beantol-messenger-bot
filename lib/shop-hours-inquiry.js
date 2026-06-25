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

  lines.push("", "Would you like to order for pickup or delivery?");
  return lines.join("\n");
}

module.exports = {
  isShopHoursInquiry,
  buildShopHoursReply,
  isLiveSupportOpen,
};
