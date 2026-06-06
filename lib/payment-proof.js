/** Client must explicitly say they are sending payment proof — not inferred from order context alone. */
const EXPLICIT_PAYMENT_PROOF_INTENT =
  /\b(?:(?:here'?s|here is|this is|sending|sent|attached|sharing|please find).{0,45}(?:payment|proof|screenshot|screen ?shot|receipt|gcash|transfer|bayad)|(?:payment|proof|screenshot|receipt).{0,30}(?:attached|sent|sending|here|below)|proof of payment|payment proof|screenshot of (?:my )?payment|payment screenshot|sent (?:my )?(?:payment|proof|gcash)|(?:my )?gcash (?:payment|proof|receipt|screenshot)|already paid|paid already|bayad na|nagbayad na|nag transfer na|it'?s paid|payment done)\b/i;

function messageHasImageAttachment(event) {
  const attachments = event?.message?.attachments;
  return Array.isArray(attachments) && attachments.some((a) => a.type === "image");
}

function hasExplicitPaymentProofIntent(text) {
  return EXPLICIT_PAYMENT_PROOF_INTENT.test(String(text || ""));
}

/** Image + explicit caption/text that they are sending payment proof — never image alone. */
function isPaymentProofImageSubmission(userText, options = {}) {
  if (!options.hasImageAttachment) return false;
  return hasExplicitPaymentProofIntent(userText);
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
  const { agentAvailable = false, isWeekend = false } = options;

  const lines = [
    "Thank you for sending that.",
    "I can't view images directly in this chat, but I've noted that you've shared your payment proof.",
    "Our sales rep will review it and confirm your payment shortly.",
  ];

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
  isPaymentProofImageSubmission,
  inboundTextForImageMessage,
  buildPaymentProofAckReply,
  EXPLICIT_PAYMENT_PROOF_INTENT,
};
