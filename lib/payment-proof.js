/** Client must explicitly say they are sending payment proof — not inferred from order context alone. */
const EXPLICIT_PAYMENT_PROOF_INTENT =
  /\b(?:(?:here'?s|here is|this is|sending|sent|attached|sharing|please find).{0,45}(?:payment|proof|screenshot|screen ?shot|receipt|gcash|transfer|bayad)|(?:payment|proof|screenshot|receipt).{0,30}(?:attached|sent|sending|here|below)|proof of payment|payment proof|screenshot of (?:my )?payment|payment screenshot|sent (?:my )?(?:payment|proof|gcash)|(?:my )?gcash (?:payment|proof|receipt|screenshot)|already paid|paid already|bayad na|nagbayad na|nag transfer na|it'?s paid|payment done)\b/i;

const PAYMENT_PROOF_RECENT_MS = 5 * 60 * 1000;
const PAYMENT_HANDLED_SUPPRESS_MS = 90 * 1000;

/** @type {Map<string, { at: number, text: string }>} */
const pendingPaymentProof = new Map();
/** @type {Map<string, number>} */
const paymentProofHandledAt = new Map();

function messageHasImageAttachment(event) {
  const attachments = event?.message?.attachments;
  return Array.isArray(attachments) && attachments.some((a) => a.type === "image");
}

function hasExplicitPaymentProofIntent(text) {
  return EXPLICIT_PAYMENT_PROOF_INTENT.test(String(text || ""));
}

function markPendingPaymentProof(senderId, text) {
  pendingPaymentProof.set(senderId, { at: Date.now(), text: String(text || "") });
}

function clearPendingPaymentProof(senderId) {
  pendingPaymentProof.delete(senderId);
}

function hasPendingPaymentProof(senderId) {
  const entry = pendingPaymentProof.get(senderId);
  if (!entry) return false;
  if (Date.now() - entry.at > PAYMENT_PROOF_RECENT_MS) {
    pendingPaymentProof.delete(senderId);
    return false;
  }
  return true;
}

function markPaymentProofHandled(senderId) {
  paymentProofHandledAt.set(senderId, Date.now());
  clearPendingPaymentProof(senderId);
}

function shouldSuppressAfterPaymentProof(senderId) {
  const at = paymentProofHandledAt.get(senderId);
  if (!at) return false;
  if (Date.now() - at > PAYMENT_HANDLED_SUPPRESS_MS) {
    paymentProofHandledAt.delete(senderId);
    return false;
  }
  return true;
}

function recentUserPaymentIntent(recentUserTexts = [], chatHistory = []) {
  if (hasExplicitPaymentProofIntent((recentUserTexts || []).join("\n"))) return true;

  let userCount = 0;
  for (let i = (chatHistory || []).length - 1; i >= 0; i--) {
    if (chatHistory[i].role !== "user") continue;
    userCount += 1;
    if (hasExplicitPaymentProofIntent(chatHistory[i].content || "")) return true;
    if (userCount >= 4) break;
  }
  return false;
}

/**
 * Decide how to handle payment proof for this inbound turn.
 * @returns {{ action: 'none'|'ack'|'wait_for_image'|'suppress' }}
 */
function resolvePaymentProofSubmission(userText, options = {}) {
  const {
    hasImageAttachment = false,
    senderId = "",
    recentUserTexts = [],
    chatHistory = [],
  } = options;

  if (senderId && shouldSuppressAfterPaymentProof(senderId)) {
    return { action: "suppress" };
  }

  const explicitHere = hasExplicitPaymentProofIntent(userText);
  const recentExplicit = recentUserPaymentIntent(recentUserTexts, chatHistory);
  const pending = senderId && hasPendingPaymentProof(senderId);

  if (hasImageAttachment && (explicitHere || recentExplicit || pending)) {
    return { action: "ack", hasImage: true };
  }

  if (!hasImageAttachment && (explicitHere || pending)) {
    const entry = senderId ? pendingPaymentProof.get(senderId) : null;
    const waitedLong =
      entry && Date.now() - entry.at >= Number(process.env.PAYMENT_PROOF_WAIT_MS || 10000) - 250;

    if (explicitHere && !entry) {
      if (senderId) markPendingPaymentProof(senderId, userText);
    }

    if (waitedLong || (explicitHere && options.paymentWaitExpired)) {
      return { action: "ack", hasImage: false };
    }

    if (explicitHere || pending) {
      return { action: "wait_for_image" };
    }
  }

  return { action: "none" };
}

function batchNeedsPaymentImageWait(batch) {
  const merged = batch.map((item) => item.text).join("\n");
  const hasImage = batch.some((item) => messageHasImageAttachment(item.messageContext?.event));
  return hasExplicitPaymentProofIntent(merged) && !hasImage;
}

function inboundTextForImageMessage(event) {
  const msg = event?.message;
  if (!msg) return "";
  const caption = msg.text ? String(msg.text).trim() : "";
  if (!messageHasImageAttachment(event)) return caption;
  if (caption) {
    return `${caption} [Customer sent an image]`;
  }
  return "[Customer sent an image]";
}

function buildPaymentProofAckReply(options = {}) {
  const {
    agentAvailable = false,
    isWeekend = false,
    quoteSummary = "",
    quoteSubtotal = null,
    hasImage = true,
    formatPeso = (n) => `₱${Number(n).toLocaleString("en-PH")}`,
  } = options;

  const lines = hasImage
    ? [
        "Thank you for your payment.",
        "I can't view images directly in this chat, but I've noted your payment proof.",
        "Our sales rep will review it and confirm your payment shortly.",
      ]
    : [
        "Thank you — I've noted your payment message.",
        "Please send your GCash or bank transfer screenshot in this chat when ready.",
        "Our sales rep will review it and confirm your payment shortly.",
      ];

  if (quoteSummary) {
    lines.push("", "Order noted:", quoteSummary.replace(/\s·\s/g, "\n• "));
    if (quoteSubtotal != null) {
      lines.push(`Total: ${formatPeso(quoteSubtotal)}`);
    }
  }

  if (isWeekend) {
    lines.push(
      "Our shop is closed on weekends; confirmation may be completed first thing on Monday."
    );
  }

  lines.push(
    "",
    "If there's anything else you need, just let me know. Otherwise, thank you — we'll take it from here!"
  );

  if (agentAvailable) {
    lines.push(
      "",
      "Prefer to speak with a sales rep? Reply YES or ask for a real person."
    );
  }

  return lines.join("\n");
}

module.exports = {
  messageHasImageAttachment,
  hasExplicitPaymentProofIntent,
  batchNeedsPaymentImageWait,
  resolvePaymentProofSubmission,
  markPaymentProofHandled,
  shouldSuppressAfterPaymentProof,
  inboundTextForImageMessage,
  buildPaymentProofAckReply,
  EXPLICIT_PAYMENT_PROOF_INTENT,
};
