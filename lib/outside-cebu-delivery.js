const SESSION_TTL_MS = 48 * 60 * 60 * 1000;

/** @type {Map<string, { at: number, inquiryCount: number, agentOffered: boolean }>} */
const sessions = new Map();
/** @type {Map<string, number>} */
const agentOfferPending = new Map();
const AGENT_OFFER_TTL_MS = 48 * 60 * 60 * 1000;

const OUTSIDE_CEBU_MARKERS =
  /\b(?:outside|out of|beyond|other provinces?|other areas?|not in|not from|different province|nationwide|anywhere in the philippines)\b/i;

const REMOTE_PLACE_MARKERS =
  /\b(?:manila|metro manila|quezon city|makati|luzon|visayas|mindanao|davao|iloilo|bacolod|baguio|pampanga|laguna|cavite|bulacan|bohol|palawan|general santos|zamboanga|tacloban|cdo|cagayan de oro)\b/i;

function isOutsideCebuDeliveryInquiry(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (!/\b(?:deliver|delivery|ship|padala|hatod|send|courier|padala|logistics)\b/i.test(t)) {
    return false;
  }

  if (/\b(?:outside|out of)\s+(?:cebu|the city)\b/i.test(t)) return true;
  if (OUTSIDE_CEBU_MARKERS.test(t) && /\bcebu\b/i.test(t)) return true;
  if (/\b(?:deliver|delivery|ship|padala|send)\b/i.test(t) && REMOTE_PLACE_MARKERS.test(t)) {
    return true;
  }
  if (/\b(?:deliver|delivery|ship)\b/i.test(t) && OUTSIDE_CEBU_MARKERS.test(t)) return true;

  return false;
}

function isOutsideCebuConfirmationFollowUp(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (!/\b(?:confirm|confirmation|possible|pwede|ok ba|is it ok|is that ok|talaga|really|sure|push through)\b/i.test(t)) {
    return false;
  }
  return (
    isOutsideCebuDeliveryInquiry(t) ||
    /\b(?:outside|out of)\s*cebu\b/i.test(t) ||
    /\b(?:jn?t|j and t|courier|nationwide|province|manila|luzon|visayas|mindanao)\b/i.test(t)
  );
}

function getSession(senderId) {
  const session = sessions.get(senderId);
  if (!session) return null;
  if (Date.now() - session.at > SESSION_TTL_MS) {
    sessions.delete(senderId);
    return null;
  }
  return session;
}

function recordOutsideCebuInquiry(senderId) {
  const existing = getSession(senderId);
  const session = {
    at: Date.now(),
    inquiryCount: (existing?.inquiryCount || 0) + 1,
    agentOffered: existing?.agentOffered || false,
  };
  sessions.set(senderId, session);
  return session;
}

function markOutsideCebuAgentOffered(senderId) {
  const session = getSession(senderId) || { at: Date.now(), inquiryCount: 1, agentOffered: false };
  session.agentOffered = true;
  session.at = Date.now();
  sessions.set(senderId, session);
  agentOfferPending.set(senderId, Date.now());
}

function isOutsideCebuAgentOfferPending(senderId) {
  const at = agentOfferPending.get(senderId);
  if (!at) return false;
  if (Date.now() - at > AGENT_OFFER_TTL_MS) {
    agentOfferPending.delete(senderId);
    return false;
  }
  return true;
}

function clearOutsideCebuAgentOfferPending(senderId) {
  agentOfferPending.delete(senderId);
}

function buildOutsideCebuDeliveryReply() {
  return (
    "Yes — we can ship outside Cebu.\n\n" +
    "For addresses outside Cebu, we use J&T or a courier you prefer. " +
    "Delivery time and shipping cost depend on your location — our team will confirm those with you.\n\n" +
    "Please leave your name, mobile number, full address (city/province), and what you'd like to order. " +
    "A Beantol representative will follow up on your inquiry.\n\n" +
    "You can keep asking questions here anytime — no need to wait for an agent to reply first."
  );
}

function buildOutsideCebuAgentOfferReply(agentAvailable) {
  const base =
    "Happy to clarify again — yes, we ship outside Cebu via J&T or your preferred courier.\n\n";
  if (agentAvailable) {
    return (
      base +
      "If you'd like to speak with a live person to confirm shipping for your area, reply YES — " +
      "or tell me you'd like an agent, representative, or real live person."
    );
  }
  return (
    base +
    "Live chat with a sales rep is available daily 9 AM–9 PM Philippine time. " +
    "You can leave your details here now and our team will follow up — or message again during support hours to chat with a person."
  );
}

function getOutsideCebuSystemNote() {
  return (
    "OUTSIDE CEBU DELIVERY (strict — overrides Maxim wording for this topic):\n" +
    "- Maxim is for Cebu City, Mandaue, Talisay, and Lapu-Lapu ONLY — not outside Cebu and not remote Cebu Province towns like Naga.\n" +
    "- For outside Cebu: we ship via J&T or the customer's preferred courier. Delivery time and cost depend on destination — team confirms after inquiry.\n" +
    "- Ask them to leave name, mobile, full address (city/province), and order details; a human representative will follow up.\n" +
    "- Do NOT use [[HANDOFF]] on the first answer — keep helping in chat.\n" +
    "- If they ask again to confirm outside-Cebu delivery is OK/possible, offer a live agent (YES during 9 AM–9 PM support hours) per handoff rules — still no [[HANDOFF]] until they clearly want a person."
  );
}

/**
 * @returns {{ handled: boolean, reply?: string, offerAgent?: boolean, isRepeat?: boolean }}
 */
function resolveOutsideCebuDeliveryTurn(senderId, userText, options = {}) {
  const { agentAvailable = false } = options;
  const text = String(userText || "").trim();
  const isInquiry = isOutsideCebuDeliveryInquiry(text);
  const isFollowUp = isOutsideCebuConfirmationFollowUp(text);
  if (!isInquiry && !isFollowUp) return { handled: false };

  const session = getSession(senderId);
  const isRepeat =
    Boolean(session) &&
    (isFollowUp || (isInquiry && session.inquiryCount >= 1));

  if (isRepeat && !session?.agentOffered) {
    recordOutsideCebuInquiry(senderId);
    markOutsideCebuAgentOffered(senderId);
    return {
      handled: true,
      reply: buildOutsideCebuAgentOfferReply(agentAvailable),
      offerAgent: true,
      isRepeat: true,
    };
  }

  if (isRepeat && session?.agentOffered) {
    return {
      handled: true,
      reply:
        "We're still here to help. For outside-Cebu shipping we use J&T or your preferred courier — " +
        "leave your details anytime, or reply YES during live chat hours (9 AM–9 PM) if you'd like a real person.",
      isRepeat: true,
    };
  }

  recordOutsideCebuInquiry(senderId);
  return {
    handled: true,
    reply: buildOutsideCebuDeliveryReply(),
    isRepeat: false,
  };
}

module.exports = {
  isOutsideCebuDeliveryInquiry,
  isOutsideCebuConfirmationFollowUp,
  isOutsideCebuAgentOfferPending,
  clearOutsideCebuAgentOfferPending,
  buildOutsideCebuDeliveryReply,
  buildOutsideCebuAgentOfferReply,
  getOutsideCebuSystemNote,
  resolveOutsideCebuDeliveryTurn,
};
