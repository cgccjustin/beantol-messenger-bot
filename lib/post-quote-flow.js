const { detectFulfillment, extractName, extractPhone } = require("./lead-capture");
const { wantsToSkipWizardForOrderOrProduct } = require("./wizard-exit");

const SESSION_TTL_MS =
  Number(process.env.POST_QUOTE_SESSION_HOURS || 4) * 60 * 60 * 1000;

const SHOP_ADDRESS =
  process.env.SHOP_ADDRESS ||
  "Holy Family Village 2, Governor Cuenco Avenue, Banilad, Cebu City (beside the guardhouse).";
const SHOP_HOURS =
  process.env.SHOP_HOURS || "Monday–Friday, 9:00 AM–6:00 PM (shop closed on weekends).";

/** @type {Map<string, object>} */
const sessions = new Map();

function getSession(senderId) {
  const session = sessions.get(senderId);
  if (!session) return null;
  if (Date.now() - session.updatedAt > SESSION_TTL_MS) {
    sessions.delete(senderId);
    return null;
  }
  return session;
}

function clearPostQuoteSession(senderId) {
  sessions.delete(senderId);
}

function isPostQuoteFlowActive(senderId) {
  const session = getSession(senderId);
  return Boolean(session && session.step !== "closed");
}

function isPostQuotePickupConfirmTurn(senderId, userText) {
  const session = getSession(senderId);
  if (!session || session.step !== "pickup_pending") return false;
  return isShortAffirmation(userText);
}

function isShortAffirmation(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 48) return false;
  return /^(?:ok(?:ay)?|yes|yep|oo|opo|confirm(?:ed)?|got it|noted|see you|sige|thanks|thank you|salamat)$/i.test(
    t
  );
}

function looksLikeDeliveryDetails(text) {
  const t = String(text || "").trim();
  if (t.length < 25) return false;
  const hasPhone =
    /\b(?:09\d{9}|\+?63[\s-]?9\d{9})\b/.test(t) ||
    /\b\d{3}[-.\s]?\d{3,4}[-.\s]?\d{4}\b/.test(t);
  const hasAddressHint =
    /\b(?:street|st\.|ave|avenue|road|rd\.|barangay|brgy|city|cebu|village|subdivision|unit|floor|blk|block|purok|banilad|mandaue|lapu|consolacion|address)\b/i.test(
      t
    ) || t.length > 80;
  return hasPhone && hasAddressHint;
}

function buildFulfillmentChoicePrompt() {
  return (
    "How would you like to proceed?\n\n" +
    "• **Pickup** at our shop\n" +
    "• **Delivery** — Maxim (Cebu City, Mandaue, Talisay, Lapu-Lapu); pickup or J&T/courier for other areas\n\n" +
    "Reply **pickup** or **delivery**."
  ).replace(/\*\*/g, "");
}

function buildPickupInstructions(options = {}) {
  const { isWeekend = false } = options;
  const lines = [
    "Great — pickup at our shop:",
    "",
    `📍 ${SHOP_ADDRESS}`,
    `🕐 ${SHOP_HOURS}`,
  ];
  if (isWeekend) {
    lines.push(
      "",
      "Our shop is closed on weekends. We can prepare your order for pickup first thing on Monday once payment is confirmed."
    );
  }
  lines.push(
    "",
    "Payment for your coffee must be settled before we prepare or release your order. Send your GCash or UnionBank proof in this chat when ready — our sales rep will verify it (no need to follow up here; our team handles confirmation).",
    "",
    "Reply **OK** when you've noted the pickup details, or ask if anything is unclear."
  );
  return lines.join("\n").replace(/\*\*/g, "");
}

function buildDeliveryCollectPrompt() {
  return (
    "Delivery via Maxim — please send all three in one message:\n\n" +
    "1) Complete delivery address\n" +
    "2) Contact name\n" +
    "3) Mobile / contact number\n\n" +
    "The Maxim delivery fee is paid by you to the rider (separate from your coffee order)."
  );
}

function buildDeliveryAckAndClosure(details, options = {}) {
  const { agentAvailable = false, isWeekend = false, name = "" } = options;
  const firstName = (name || details.name || "").split(/\s+/)[0];
  const lines = [
    firstName ? `Thanks for the details, ${firstName}!` : "Thanks for the details!",
    "",
    "Here's what we have:",
    `• Name: ${details.name || "(please confirm if missing)"}`,
    `• Address: ${details.address || details.raw || "(please confirm if missing)"}`,
    `• Contact: ${details.phone || "(please confirm if missing)"}`,
    "",
    "We'll arrange Maxim delivery once your order and payment are confirmed. The delivery fee is paid to the rider.",
  ];
  if (isWeekend) {
    lines.push("Our shop is closed on weekends — dispatch can be arranged first thing on Monday after payment is confirmed.");
  }
  lines.push(
    "",
    "Please settle payment for your coffee before we dispatch. Send proof of payment in this chat when ready — our sales rep will confirm (you don't need to chase us here)."
  );
  lines.push("", ...buildClosureLines({ agentAvailable, fulfillment: "delivery" }));
  return lines.join("\n");
}

function buildPickupClosure(options = {}) {
  const { agentAvailable = false, isWeekend = false, name = "" } = options;
  const firstName = (name || "").split(/\s+/)[0];
  const lines = [
    firstName ? `Thank you, ${firstName}!` : "Thank you!",
    "",
    "Your pickup order is noted. Our sales representative will confirm your order and payment with you shortly.",
  ];
  if (isWeekend) {
    lines.push("We'll have your order ready for pickup first thing on Monday once payment is confirmed.");
  }
  lines.push(
    "",
    "Please settle payment before pickup. Send your GCash or UnionBank proof in this chat when ready — our team will verify it."
  );
  lines.push("", ...buildClosureLines({ agentAvailable, fulfillment: "pickup" }));
  return lines.join("\n");
}

function buildClosureLines(options = {}) {
  const { agentAvailable = false } = options;
  const lines = [
    "Thank you for trusting Beantol! We're grateful for your order.",
    "",
    "If anything in our conversation is unclear, feel free to ask anytime.",
  ];
  if (agentAvailable) {
    lines.push(
      "",
      "Prefer to chat with a real person (not AI)? Reply **YES** or tell us you'd like an agent, representative, or live staff member."
    );
  } else {
    lines.push(
      "",
      "Live agents are available daily 9 AM–9 PM Philippine time if you need a person — message us again during those hours."
    );
  }
  lines.push("", "Have a blessed day! ☕");
  return lines.map((line) => line.replace(/\*\*/g, ""));
}

function parseDeliveryDetails(text) {
  const t = String(text || "").trim();
  const phone = extractPhone(t);
  const name = extractName(t);
  return {
    raw: t,
    phone,
    name,
    address: t,
  };
}

function startPostQuoteSession(senderId, meta = {}) {
  const session = {
    step: "choose_fulfillment",
    platform: meta.platform || "messenger",
    quoteSummary: meta.quoteSummary || "",
    quoteSubtotal: meta.quoteSubtotal ?? null,
    quoteUrl: meta.quoteUrl || "",
    fulfillment: "",
    updatedAt: Date.now(),
  };
  sessions.set(senderId, session);
  return session;
}

function appendPostQuoteFulfillmentPrompt(senderId, meta, baseReply) {
  startPostQuoteSession(senderId, meta);
  return `${baseReply}\n\n${buildFulfillmentChoicePrompt()}`;
}

function processPostQuoteFlowPreAi(senderId, userText, options = {}) {
  const session = getSession(senderId);
  if (!session || session.step === "closed") return { handled: false };

  const { agentAvailable = false, isWeekend = false } = options;
  const text = String(userText || "").trim();

  if (wantsToSkipWizardForOrderOrProduct(text)) {
    clearPostQuoteSession(senderId);
    return { handled: false };
  }

  if (session.step === "choose_fulfillment") {
    const choice = detectFulfillment(text);
    if (choice === "pickup") {
      session.step = "pickup_pending";
      session.fulfillment = "pickup";
      session.updatedAt = Date.now();
      sessions.set(senderId, session);
      return {
        handled: true,
        reply: buildPickupInstructions({ isWeekend }),
        captureOrder: { fulfillment: "pickup" },
      };
    }
    if (choice === "delivery") {
      session.step = "delivery_collect";
      session.fulfillment = "delivery";
      session.updatedAt = Date.now();
      sessions.set(senderId, session);
      return {
        handled: true,
        reply: buildDeliveryCollectPrompt(),
        captureOrder: { fulfillment: "delivery" },
      };
    }
    return {
      handled: true,
      reply:
        "Please let us know how you'd like to receive your order — reply **pickup** (at our shop) or **delivery** (via Maxim).".replace(
          /\*\*/g,
          ""
        ),
    };
  }

  if (session.step === "pickup_pending") {
    if (isShortAffirmation(text) || detectFulfillment(text) === "pickup") {
      session.step = "closed";
      session.updatedAt = Date.now();
      sessions.set(senderId, session);
      const name = extractName(text);
      return {
        handled: true,
        reply: buildPickupClosure({ agentAvailable, isWeekend, name }),
        captureOrder: { fulfillment: "pickup", orderStatus: "awaiting_payment" },
      };
    }
    return {
      handled: true,
      reply:
        "When you're ready, reply **OK** to confirm pickup — or ask if you need anything else about the shop location or hours.".replace(
          /\*\*/g,
          ""
        ),
    };
  }

  if (session.step === "delivery_collect") {
    if (looksLikeDeliveryDetails(text)) {
      const details = parseDeliveryDetails(text);
      session.step = "closed";
      session.deliveryDetails = details;
      session.updatedAt = Date.now();
      sessions.set(senderId, session);
      return {
        handled: true,
        reply: buildDeliveryAckAndClosure(details, {
          agentAvailable,
          isWeekend,
          name: details.name,
        }),
        captureOrder: {
          fulfillment: "delivery",
          orderStatus: "awaiting_payment",
          address: details.raw,
          phone: details.phone,
          name: details.name,
        },
        notifyDelivery: true,
      };
    }
    return {
      handled: true,
      reply:
        "To arrange Maxim delivery, please send your **complete address**, **contact name**, and **mobile number** in one message.".replace(
          /\*\*/g,
          ""
        ),
    };
  }

  return { handled: false };
}

module.exports = {
  appendPostQuoteFulfillmentPrompt,
  processPostQuoteFlowPreAi,
  clearPostQuoteSession,
  isPostQuoteFlowActive,
  isPostQuotePickupConfirmTurn,
  buildFulfillmentChoicePrompt,
  buildClosureLines,
};
