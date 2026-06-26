const { detectFulfillment, extractName, extractPhone } = require("./lead-capture");
const { wantsToSkipWizardForOrderOrProduct } = require("./wizard-exit");
const { scopeKey } = require("./tenant-context");
const { getShopAddress, getShopHours, businessName } = require("./tenant-messages");

const SESSION_TTL_MS =
  Number(process.env.POST_QUOTE_SESSION_HOURS || 4) * 60 * 60 * 1000;

/** @type {Map<string, object>} */
const sessions = new Map();

function getSession(senderId) {
  const session = sessions.get(scopeKey(senderId));
  if (!session) return null;
  if (Date.now() - session.updatedAt > SESSION_TTL_MS) {
    sessions.delete(scopeKey(senderId));
    return null;
  }
  return session;
}

function clearPostQuoteSession(senderId) {
  sessions.delete(scopeKey(senderId));
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

const OFF_TOPIC_POST_QUOTE =
  /\b(?:best\s*seller|what do you recommend|who is|what are your hours|fun fact|tell me about|promo|deal|sale|menu|price list|open today|closed today|how to order|beans?|recommend)\b/i;

function isPostQuoteCancellation(text) {
  return /\b(?:cancel(?:\s+my)?\s+order|never\s*mind|forget(?:\s+the|\s+my)?\s+order|stop(?:\s+the|\s+my)?\s+order)\b/i.test(
    String(text || "")
  );
}

function messageAnswersPostQuoteStep(text, session) {
  const t = String(text || "").trim();
  if (session.step === "choose_fulfillment") return Boolean(detectFulfillment(t));
  if (session.step === "pickup_pending") return isShortAffirmation(t);
  if (session.step === "delivery_collect") return looksLikeDeliveryDetails(t);
  return false;
}

function isPostQuoteDigression(text, session) {
  const t = String(text || "").trim();
  if (!t || isPostQuoteCancellation(t)) return false;
  if (messageAnswersPostQuoteStep(t, session)) return false;
  if (OFF_TOPIC_POST_QUOTE.test(t)) return true;
  if (/\?/.test(t)) return true;
  if (
    /\b(?:what|how|where|when|why|do you|can you|tell me|unsay|unsa|ano|paano)\b/i.test(t) &&
    !detectFulfillment(t)
  ) {
    return true;
  }
  return false;
}

function buildPostQuoteResumeNudge(session) {
  if (!session) return "";
  const prompts = {
    choose_fulfillment:
      "Would you still like to proceed with your order? Reply pickup or delivery.",
    pickup_pending: "Reply OK to confirm pickup when you're ready.",
    delivery_collect:
      "When ready, send your complete delivery address, contact name, and mobile number.",
  };
  const prompt =
    prompts[session.step] || "Would you like to continue with your order?";
  return `\n\n—\n${prompt}`;
}

function shouldAppendPostQuoteNudge(reply, session) {
  if (!session) return false;
  const r = String(reply || "").toLowerCase();
  if (
    /\b(?:would you still like|pickup or delivery|reply ok|delivery address|complete address|mobile number)\b/.test(
      r
    )
  ) {
    return false;
  }
  return true;
}

function appendPostQuoteResumeNudge(reply, senderId) {
  const session = getSession(senderId);
  if (!session || !shouldAppendPostQuoteNudge(reply, session)) {
    return String(reply || "").trim();
  }
  return `${String(reply || "").trim()}${buildPostQuoteResumeNudge(session)}`;
}

function buildPostQuoteDigressionSystemNote(senderId, userText) {
  const session = getSession(senderId);
  if (!session || session.step === "closed") return "";
  if (!isPostQuoteDigression(userText, session)) return "";
  return [
    "ACTIVE POST-QUOTE ORDER (strict): Customer is mid-order after receiving a quote.",
    `Step: ${session.step}. Fulfillment: ${session.fulfillment || "not chosen"}.`,
    session.quoteSummary ? `Quote: ${session.quoteSummary}.` : "",
    "DIGRESSION: Answer their new question first (use KNOWLEDGE CONTEXT). Do NOT restart the quote.",
    "Keep it concise. The bot will append a resume prompt.",
  ]
    .filter(Boolean)
    .join("\n");
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
  const shopAddress = getShopAddress();
  const shopHours = getShopHours();
  const lines = [
    "Great — pickup at our shop:",
    "",
    `📍 ${shopAddress}`,
    `🕐 ${shopHours}`,
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
  const brand = businessName();
  const lines = [
    `Thank you for trusting ${brand}! We're grateful for your order.`,
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

function looksLikeNameLine(line) {
  const t = String(line || "").trim();
  if (!t || t.length > 48) return false;
  if (extractPhone(t)) return false;
  if (/\d{3,}/.test(t)) return false;
  const words = t.split(/\s+/);
  if (words.length < 1 || words.length > 5) return false;
  return /^[A-Za-z][A-Za-z\s.'-]+$/.test(t);
}

function isPhoneOnlyLine(line) {
  const t = String(line || "").trim();
  const phone = extractPhone(t);
  if (!phone) return false;
  const remainder = t
    .replace(phone, "")
    .replace(/[\s,.\-()+]/g, "");
  return remainder.length === 0;
}

function parseDeliveryDetails(text) {
  const t = String(text || "").trim();
  const phone = extractPhone(t);
  let name = extractName(t);
  const lines = t.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const addressParts = [];

  if (lines.length >= 2) {
    for (const line of lines) {
      if (isPhoneOnlyLine(line)) continue;

      const linePhone = extractPhone(line);
      if (linePhone && isPhoneOnlyLine(line)) continue;

      if (!name && looksLikeNameLine(line)) {
        name = line;
        continue;
      }

      let addrLine = line;
      if (linePhone) {
        addrLine = line.replace(linePhone, "").trim().replace(/^[,.\s-]+|[,.\s-]+$/g, "");
      }
      if (addrLine && addrLine !== name) {
        addressParts.push(addrLine);
      }
    }
  }

  let address = addressParts.join(", ").trim();
  if (!address) {
    address = t;
    if (name) address = address.replace(name, "").trim();
    if (phone) address = address.replace(phone, "").trim();
    address = address
      .replace(/\r?\n+/g, ", ")
      .replace(/^[,.\s-]+|[,.\s-]+$/g, "")
      .trim();
  }

  return {
    raw: t,
    phone,
    name,
    address: address || t,
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
  sessions.set(scopeKey(senderId), session);
  return session;
}

/**
 * Restore post-quote wizard when customer swipes-replies to an older bot prompt.
 * @returns {{ resumed: boolean, step?: string }}
 */
function resumePostQuoteFromRepliedMessage(senderId, repliedContent, platform = "messenger") {
  const content = String(repliedContent || "");
  if (!content) return { resumed: false };

  if (/How would you like to proceed\?/i.test(content) || /reply pickup or delivery/i.test(content)) {
    startPostQuoteSession(senderId, { platform });
    return { resumed: true, step: "choose_fulfillment" };
  }

  if (/^Great — pickup at our shop:/i.test(content)) {
    const session = startPostQuoteSession(senderId, { platform });
    session.step = "pickup_pending";
    session.fulfillment = "pickup";
    session.updatedAt = Date.now();
    sessions.set(scopeKey(senderId), session);
    return { resumed: true, step: "pickup_pending" };
  }

  if (/^Delivery via Maxim — please send all three/i.test(content)) {
    const session = startPostQuoteSession(senderId, { platform });
    session.step = "delivery_collect";
    session.fulfillment = "delivery";
    session.updatedAt = Date.now();
    sessions.set(scopeKey(senderId), session);
    return { resumed: true, step: "delivery_collect" };
  }

  return { resumed: false };
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

  if (isPostQuoteCancellation(text)) {
    clearPostQuoteSession(senderId);
    return {
      handled: true,
      reply:
        "No problem — we can pick this up later. Message us anytime when you're ready to order.",
    };
  }

  if (isPostQuoteDigression(text, session)) {
    session.updatedAt = Date.now();
    sessions.set(scopeKey(senderId), session);
    return { handled: false, digression: true };
  }

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
      sessions.set(scopeKey(senderId), session);
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
      sessions.set(scopeKey(senderId), session);
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
      sessions.set(scopeKey(senderId), session);
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
      sessions.set(scopeKey(senderId), session);
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
          address: details.address || details.raw,
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
  resumePostQuoteFromRepliedMessage,
  buildFulfillmentChoicePrompt,
  buildClosureLines,
  appendPostQuoteResumeNudge,
  buildPostQuoteDigressionSystemNote,
};
