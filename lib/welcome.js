const WELCOMED_TTL_MS =
  Number(process.env.WELCOME_SENT_TTL_HOURS || 168) * 60 * 60 * 1000;

/** @type {Map<string, number>} senderId -> welcomedAt */
const { scopeKey } = require("./tenant-context");

const welcomedAt = new Map();

const GET_STARTED_PATTERN = /^GET_STARTED(?:_PAYLOAD)?$/i;

function isGetStartedPostback(event, userText = "") {
  const payload = String(event?.postback?.payload || "").trim();
  if (payload && GET_STARTED_PATTERN.test(payload)) return true;
  const title = String(event?.postback?.title || "").trim();
  if (/^get started$/i.test(title)) return true;
  return GET_STARTED_PATTERN.test(String(userText || "").trim());
}

function hasBeenWelcomed(senderId) {
  const at = welcomedAt.get(scopeKey(senderId));
  if (!at) return false;
  if (Date.now() - at > WELCOMED_TTL_MS) {
    welcomedAt.delete(senderId);
    return false;
  }
  return true;
}

function markWelcomed(senderId) {
  welcomedAt.set(scopeKey(senderId), Date.now());
}

function buildWelcomeMessage(options = {}) {
  const {
    name = "",
    businessName = "our shop",
    isWeekend: shopClosedToday = false,
    shopOpenNow = false,
    shopHours = "",
    agentAvailable = false,
    platform = "messenger",
    mode = "full",
    recommendations = true,
    quotes = true,
    cebuDeliveryZones = true,
    appointments = true,
  } = options;

  if (mode === "short") {
    return buildShortWelcomeMessage({ name, businessName });
  }

  const shop = String(businessName || "our shop").trim();
  const firstName = String(name || "").trim().split(/\s+/)[0];
  const greeting = firstName ? `Welcome to ${shop}, ${firstName}!` : `Welcome to ${shop}!`;

  const bullets = ["• Shop hours, payment, and general questions"];
  if (recommendations !== false) bullets.unshift("• Coffee recommendations");
  if (quotes !== false) bullets.push("• Prices, quotes, and orders");
  else bullets.push("• Menu and prices");
  if (cebuDeliveryZones !== false) {
    bullets.push("• Pickup at our shop or delivery (Cebu / outside Cebu)");
  } else if (appointments !== false) {
    bullets.push("• Pickup, reservations, and orders");
  } else {
    bullets.push("• Pickup and orders");
  }

  const examples =
    recommendations !== false && quotes !== false
      ? "Tell me what you're looking for — e.g. \"recommend an espresso bean\", \"price for Prime 250g\", or \"I'd like to order\"."
      : "Tell me what you're looking for — e.g. your menu, hours, reservations, or how to order.";

  const lines = [
    `${greeting} ☕`,
    "",
    `I'm ${shop}'s assistant — happy to help you with:`,
    ...bullets,
    "",
    examples,
  ];

  if (shopClosedToday && !shopOpenNow && mode === "full") {
    lines.push(
      "",
      shopHours
        ? `Our shop is closed right now (${shopHours}), but I can still help you here in chat.`
        : "Our shop is closed right now, but I can still help you here in chat."
    );
  }

  if (agentAvailable && mode === "full") {
    lines.push(
      "",
      "Prefer a live person during chat hours (9 AM–9 PM)? Reply YES or ask for an agent anytime."
    );
  } else if (platform && mode === "full") {
    lines.push(
      "",
      "Live agents are available daily 9 AM–9 PM Philippine time if you need a person later."
    );
  }

  return lines.join("\n");
}

function buildShortWelcomeMessage(options = {}) {
  const shop = String(options.businessName || "").trim();
  const first = String(options.name || "").trim().split(/\s+/)[0];
  if (first && shop) return `Hi ${first}! Welcome to ${shop}. ☕`;
  if (first) return `Hi ${first}! ☕`;
  return shop ? `Hi! Welcome to ${shop}. ☕` : "Hi there! ☕";
}

function isGreetingOnly(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  return /^(?:hi|hello|hey|helo|good morning|good afternoon|good evening|kamusta|musta|hello po|hi po|good day)[!.?\s]*$/i.test(
    t
  );
}

function isSubstantiveFirstMessage(userText, event = null) {
  const t = String(userText || "").trim();
  if (!t || isGreetingOnly(t)) return false;
  if (isGetStartedPostback(event, t)) return false;
  return true;
}

/**
 * @returns {{ isGetStarted: boolean, prependWelcome: boolean, welcomeOpts: object }}
 */
function createWelcomeState(senderId, userText, event, welcomeOpts = {}) {
  const isGetStarted = isGetStartedPostback(event, userText);
  const firstContact = !hasBeenWelcomed(senderId);
  const substantive = isSubstantiveFirstMessage(userText, event);
  return {
    isGetStarted,
    prependWelcome: firstContact && !isGetStarted,
    shortWelcome: substantive,
    welcomeOpts,
    done: false,
  };
}

function applyWelcomeToReply(reply, senderId, welcomeState) {
  const message = String(reply || "").trim();
  if (!message || !welcomeState || welcomeState.done) return message;

  if (welcomeState.prependWelcome) {
    markWelcomed(senderId);
    welcomeState.done = true;
    const welcome = welcomeState.shortWelcome
      ? buildShortWelcomeMessage(welcomeState.welcomeOpts)
      : buildWelcomeMessage({ ...welcomeState.welcomeOpts, mode: "full" });
    return `${welcome}\n\n${message}`;
  }

  return message;
}

function welcomeOnlyReply(senderId, welcomeState) {
  markWelcomed(senderId);
  if (welcomeState) welcomeState.done = true;
  return buildWelcomeMessage(welcomeState?.welcomeOpts || {});
}

module.exports = {
  isGetStartedPostback,
  hasBeenWelcomed,
  markWelcomed,
  buildWelcomeMessage,
  buildShortWelcomeMessage,
  isGreetingOnly,
  isSubstantiveFirstMessage,
  createWelcomeState,
  applyWelcomeToReply,
  welcomeOnlyReply,
};
