const { detectFulfillment, extractName, extractPhone } = require("./lead-capture");
const { wantsToSkipWizardForOrderOrProduct } = require("./wizard-exit");
const { scopeKey } = require("./tenant-context");
const { getShopAddress, getShopHours, businessName } = require("./tenant-messages");
const {
  resolveDeliveryDetails,
  looksLikeCafeDeliveryDetails,
  looksLikePartialCafeDeliveryDetails,
  extractLatestDeliveryBlock,
  lineHasPhone,
} = require("./cafe-order-flow");

const SESSION_TTL_MS =
  Number(process.env.POST_QUOTE_SESSION_HOURS || 4) * 60 * 60 * 1000;

const POST_QUOTE_IDLE_MS =
  Number(process.env.CAFE_ORDER_IDLE_MINUTES || 30) * 60 * 1000;

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

/**
 * Returns true when a post-quote session exists AND is recently active (not idle).
 * Idle sessions let faith replies through (with a nudge), fresh sessions block faith.
 */
function isPostQuoteFlowRecentlyActive(senderId) {
  const session = getSession(senderId);
  if (!session || session.step === "closed") return false;
  const ref = session.lastCustomerAt || session.updatedAt;
  return Date.now() - ref <= POST_QUOTE_IDLE_MS;
}

function isPostQuotePickupConfirmTurn(senderId, userText) {
  const session = getSession(senderId);
  if (!session || session.step !== "pickup_pending") return false;
  return messageIncludesPickupConfirm(userText);
}

const OFF_TOPIC_POST_QUOTE =
  /\b(?:best\s*seller|what do you recommend|who is|what are your hours|fun fact|tell me about|promo|deal|sale|menu|price list|open today|closed today|how to order|recommend)\b/i;

function isPostQuoteCancellation(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (/^(?:cancel(?:led)?|cancelled)(?:[\s!.?]*|$)/i.test(t)) return true;
  if (/^no[\s,]*(cancel|thanks|thank you|never\s*mind|nevermind)/i.test(t)) return true;
  return /\b(?:cancel(?:\s+(?:my|the|that|this|it))?\s*(?:order)?|never\s*mind(?:\s+(?:the|that|this))?\s*(?:order)?|forget(?:\s+(?:the|my|that|this))?\s*(?:order)?|stop(?:\s+(?:the|that|this|my))?\s*(?:order)?|don't want(?:\s+(?:it|that|this))?|dont want(?:\s+(?:it|that|this))?|wag na|ayaw na|dili na)\b/i.test(
    t
  );
}

function hasCompleteDeliveryDetails(details) {
  return Boolean(details?.phone && (details.address || details.name));
}

function hasUsableDeliveryDetails(details) {
  return Boolean(
    details &&
      (details.phone || details.address || details.name) &&
      (details.phone || (details.address && details.name))
  );
}

function looksLikeDeliveryDetails(text, recentUserTexts = [], tenant = null) {
  const block = extractLatestDeliveryBlock(recentUserTexts, text, tenant);
  return (
    looksLikeCafeDeliveryDetails(block) ||
    looksLikeCafeDeliveryDetails(text) ||
    looksLikePartialCafeDeliveryDetails(block) ||
    looksLikePartialCafeDeliveryDetails(text)
  );
}

function messageIncludesPickupConfirm(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (isShortAffirmation(t)) return true;
  if (t.length > 120) return false;
  return /\b(?:ok(?:ay)?|yes|yep|oo|opo|confirm(?:ed)?|got it|noted|sige|proceed|go ahead)\b/i.test(t);
}

function messageContainsPostQuoteProgress(text, session, recentUserTexts = [], tenant = null) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (isPostQuoteCancellation(t)) return true;
  if (detectFulfillment(t)) return true;
  if (looksLikeDeliveryDetails(t, recentUserTexts, tenant)) return true;
  if (lineHasPhone(t)) return true;
  if (session?.step === "pickup_pending" && messageIncludesPickupConfirm(t)) return true;
  return false;
}

function hasEmbeddedPostQuoteSideQuestion(text, session, recentUserTexts = [], tenant = null) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (OFF_TOPIC_POST_QUOTE.test(t)) return true;
  if (!messageContainsPostQuoteProgress(t, session, recentUserTexts, tenant)) return false;
  if (/\?/.test(t)) return true;
  if (
    /\b(?:what|how|where|when|why|do you|can you|tell me|unsay|unsa|ano|paano|beans?)\b/i.test(t) &&
    !detectFulfillment(t)
  ) {
    return true;
  }
  return false;
}

function messageAnswersPostQuoteStep(text, session, recentUserTexts = [], tenant = null) {
  const t = String(text || "").trim();
  if (session.step === "choose_fulfillment") {
    return Boolean(detectFulfillment(t) || looksLikeDeliveryDetails(t, recentUserTexts, tenant));
  }
  if (session.step === "pickup_pending") return messageIncludesPickupConfirm(t);
  if (session.step === "delivery_collect") {
    return looksLikeDeliveryDetails(t, recentUserTexts, tenant) || lineHasPhone(t);
  }
  return false;
}

function isPostQuoteDigression(text, session, recentUserTexts = [], tenant = null) {
  const t = String(text || "").trim();
  if (!t || isPostQuoteCancellation(t)) return false;
  if (messageContainsPostQuoteProgress(t, session, recentUserTexts, tenant)) {
    return hasEmbeddedPostQuoteSideQuestion(t, session, recentUserTexts, tenant);
  }
  if (messageAnswersPostQuoteStep(t, session, recentUserTexts, tenant)) return false;
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
      "Still working on your order — reply pickup or delivery (you can include other questions in the same message).",
    pickup_pending: "Reply OK when you're ready to confirm pickup, or ask anything else in the same message.",
    delivery_collect:
      "For delivery, send address, contact name, and mobile number in one message — or ask another question alongside it.",
  };
  const prompt =
    prompts[session.step] || "Would you like to continue with your order?";
  return `\n\n—\n${prompt}`;
}

function shouldAppendPostQuoteNudge(reply, session) {
  if (!session) return false;
  const r = String(reply || "").toLowerCase();
  if (
    /\b(?:would you still like|pickup or delivery|reply ok|delivery address|complete address|mobile number|still working on your order|for delivery, send)\b/.test(
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

function buildPostQuoteDigressionSystemNote(senderId, userText, tenant = null) {
  const session = getSession(senderId);
  if (!session || session.step === "closed") return "";
  if (!isPostQuoteDigression(userText, session, [], tenant)) return "";
  const fulfillmentNote = session.fulfillment ? ` Fulfillment: ${session.fulfillment}.` : "";
  return [
    "ACTIVE POST-QUOTE ORDER (strict): Customer is mid-order after receiving a quote.",
    `Step: ${session.step}.${fulfillmentNote}`,
    session.quoteSummary ? `Quote: ${session.quoteSummary}.` : "",
    "If their message also included pickup/delivery or delivery details, those are ALREADY saved — do not re-ask.",
    "DIGRESSION: Answer their question first (use KNOWLEDGE CONTEXT). Do NOT restart the quote.",
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

function buildFulfillmentChoicePrompt() {
  return (
    "How would you like to proceed?\n\n" +
    "• **Pickup** at our shop\n" +
    "• **Delivery** — Maxim (Cebu City, Mandaue, Talisay, Lapu-Lapu); pickup or J&T/courier for other areas\n\n" +
    "Reply **pickup** or **delivery** — you can also send delivery details in the same message."
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

function buildDeliveryCollectPrompt(partialDetails = null) {
  const lines = [
    "Delivery via Maxim — please send all three in one message:",
    "",
    "1) Complete delivery address",
    "2) Contact name",
    "3) Mobile / contact number",
    "",
    "The Maxim delivery fee is paid by you to the rider (separate from your coffee order).",
  ];
  if (partialDetails && (partialDetails.name || partialDetails.address || partialDetails.phone)) {
    lines.push(
      "",
      "I already have some details — send anything missing, or confirm if this is complete:",
      `• Name: ${partialDetails.name || "(missing)"}`,
      `• Address: ${partialDetails.address || partialDetails.raw || "(missing)"}`,
      `• Contact: ${partialDetails.phone || "(missing)"}`
    );
  }
  return lines.join("\n");
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

function parseDeliveryDetails(text, recentUserTexts = [], tenant = null, existing = null) {
  return (
    resolveDeliveryDetails(existing, recentUserTexts, text, tenant) ||
    resolveDeliveryDetails(null, recentUserTexts, text, tenant)
  );
}

function closeDeliverySession(senderId, session, details, options = {}) {
  session.step = "closed";
  session.deliveryDetails = details;
  session.updatedAt = Date.now();
  sessions.set(scopeKey(senderId), session);
  return {
    handled: true,
    reply: buildDeliveryAckAndClosure(details, {
      agentAvailable: options.agentAvailable,
      isWeekend: options.isWeekend,
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

function tryHolisticPostQuoteAdvance(senderId, session, text, tenant, options = {}) {
  const { recentUserTexts = [], agentAvailable = false, isWeekend = false } = options;
  const sideQuestion = hasEmbeddedPostQuoteSideQuestion(text, session, recentUserTexts, tenant);
  const fulfillment =
    detectFulfillment(text) ||
    detectFulfillment(recentUserTexts.join("\n")) ||
    session.fulfillment ||
    "";
  const details = parseDeliveryDetails(text, recentUserTexts, tenant, session.deliveryDetails || null);
  const deliveryProgress =
    Boolean(details && (details.phone || details.address || details.name)) ||
    looksLikeDeliveryDetails(text, recentUserTexts, tenant);

  if (session.step === "choose_fulfillment") {
    if (fulfillment === "pickup") {
      session.step = "pickup_pending";
      session.fulfillment = "pickup";
      session.updatedAt = Date.now();
      sessions.set(scopeKey(senderId), session);
      if (sideQuestion) return { handled: false, digression: true };
      return {
        handled: true,
        reply: buildPickupInstructions({ isWeekend }),
        captureOrder: { fulfillment: "pickup" },
      };
    }
    if (fulfillment === "delivery") {
      session.fulfillment = "delivery";
      if (hasCompleteDeliveryDetails(details)) {
        return closeDeliverySession(senderId, session, details, { agentAvailable, isWeekend });
      }
      session.deliveryDetails = details?.phone || details?.address || details?.name ? details : null;
      session.step = "delivery_collect";
      session.updatedAt = Date.now();
      sessions.set(scopeKey(senderId), session);
      if (sideQuestion) return { handled: false, digression: true };
      return {
        handled: true,
        reply: buildDeliveryCollectPrompt(session.deliveryDetails),
        captureOrder: { fulfillment: "delivery" },
      };
    }
  }

  if (session.step === "delivery_collect" && deliveryProgress) {
    session.fulfillment = "delivery";
    session.deliveryDetails = details;
    if (hasCompleteDeliveryDetails(details)) {
      return closeDeliverySession(senderId, session, details, { agentAvailable, isWeekend });
    }
    session.updatedAt = Date.now();
    sessions.set(scopeKey(senderId), session);
    if (sideQuestion) return { handled: false, digression: true };
    return {
      handled: true,
      reply: buildDeliveryCollectPrompt(details),
      captureOrder: { fulfillment: "delivery" },
    };
  }

  if (session.step === "pickup_pending" && messageIncludesPickupConfirm(text)) {
    session.step = "closed";
    session.updatedAt = Date.now();
    sessions.set(scopeKey(senderId), session);
    const name = extractName(text) || details?.name || "";
    if (sideQuestion) return { handled: false, digression: true };
    return {
      handled: true,
      reply: buildPickupClosure({ agentAvailable, isWeekend, name }),
      captureOrder: { fulfillment: "pickup", orderStatus: "awaiting_payment" },
    };
  }

  if (sideQuestion) return { handled: false, digression: true };
  return { handled: false };
}

function startPostQuoteSession(senderId, meta = {}) {
  const session = {
    step: "choose_fulfillment",
    platform: meta.platform || "messenger",
    quoteSummary: meta.quoteSummary || "",
    quoteSubtotal: meta.quoteSubtotal ?? null,
    quoteUrl: meta.quoteUrl || "",
    fulfillment: "",
    deliveryDetails: null,
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

  const { agentAvailable = false, isWeekend = false, recentUserTexts = [], tenant = null } = options;
  const text = String(userText || "").trim();

  if (isPostQuoteCancellation(text)) {
    clearPostQuoteSession(senderId);
    return {
      handled: true,
      reply:
        "No problem — we can pick this up later. Message us anytime when you're ready to order.",
    };
  }

  const holistic = tryHolisticPostQuoteAdvance(senderId, session, text, tenant, {
    recentUserTexts,
    agentAvailable,
    isWeekend,
  });
  if (holistic.handled) return holistic;
  if (holistic.digression) {
    session.updatedAt = Date.now();
    sessions.set(scopeKey(senderId), session);
    return { handled: false, digression: true };
  }

  if (isPostQuoteDigression(text, session, recentUserTexts, tenant)) {
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
        "Please let us know how you'd like to receive your order — reply **pickup** (at our shop) or **delivery** (via Maxim). You can include delivery details in the same message.".replace(
          /\*\*/g,
          ""
        ),
    };
  }

  if (session.step === "pickup_pending") {
    if (messageIncludesPickupConfirm(text) || detectFulfillment(text) === "pickup") {
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
    if (looksLikeDeliveryDetails(text, recentUserTexts, tenant)) {
      const details = parseDeliveryDetails(text, recentUserTexts, tenant, session.deliveryDetails);
      if (hasCompleteDeliveryDetails(details)) {
        return closeDeliverySession(senderId, session, details, { agentAvailable, isWeekend });
      }
      session.deliveryDetails = details;
      session.updatedAt = Date.now();
      sessions.set(scopeKey(senderId), session);
      return {
        handled: true,
        reply: buildDeliveryCollectPrompt(details),
        captureOrder: { fulfillment: "delivery" },
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

/**
 * Returns a gentle postscript nudge to append to a faith reply when the customer
 * has a stalled post-quote (Beantol bean order) session. Returns "" if nothing pending.
 */
function buildFaithPostQuoteNudge(senderId) {
  const session = getSession(senderId);
  if (!session || session.step === "closed") return "";
  // Only nudge on idle sessions — recently-active sessions block faith entirely.
  const ref = session.lastCustomerAt || session.updatedAt;
  if (Date.now() - ref <= POST_QUOTE_IDLE_MS) return "";
  return "\n\nP.S. Whenever you're ready — no rush at all — your quote is still here and I can help you finalize your order. Just say the word! 😊";
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
  buildFaithPostQuoteNudge,
  isPostQuoteFlowRecentlyActive,
};
