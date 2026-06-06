const DEBOUNCE_MS = Number(process.env.MESSAGE_DEBOUNCE_MS || 2500);
const PAYMENT_PROOF_WAIT_MS = Number(process.env.PAYMENT_PROOF_WAIT_MS || 10000);
const { messageHasImageAttachment, batchNeedsPaymentImageWait } = require("./payment-proof");

/** @type {Map<string, { pending: object[], timer: ReturnType<typeof setTimeout>|null, processing: boolean, paymentWaitStartedAt: number|null }>} */
const buckets = new Map();

function normalizeForDedupe(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function coalesceInboundTexts(texts) {
  const seen = new Set();
  const unique = [];
  for (const raw of texts) {
    const text = String(raw || "").trim();
    if (!text) continue;
    const key = normalizeForDedupe(text);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(text);
  }
  if (unique.length <= 1) return unique[0] || "";
  return unique.join("\n");
}

function scheduleFlush(senderId, handler) {
  const bucket = buckets.get(senderId);
  if (!bucket || bucket.processing) return;

  if (bucket.timer) clearTimeout(bucket.timer);

  let delay = DEBOUNCE_MS;
  if (batchNeedsPaymentImageWait(bucket.pending)) {
    if (!bucket.paymentWaitStartedAt) {
      bucket.paymentWaitStartedAt = Date.now();
    }
    const elapsed = Date.now() - bucket.paymentWaitStartedAt;
    if (elapsed < PAYMENT_PROOF_WAIT_MS) {
      delay = Math.max(DEBOUNCE_MS, PAYMENT_PROOF_WAIT_MS - elapsed);
    }
  } else {
    bucket.paymentWaitStartedAt = null;
  }

  bucket.timer = setTimeout(() => {
    flushBucket(senderId, handler).catch((err) => {
      console.error(`Inbound debounce flush failed for ${senderId}:`, err.message);
    });
  }, delay);
}

async function flushBucket(senderId, handler) {
  const bucket = buckets.get(senderId);
  if (!bucket || bucket.processing || !bucket.pending.length) return;

  if (batchNeedsPaymentImageWait(bucket.pending)) {
    if (!bucket.paymentWaitStartedAt) {
      bucket.paymentWaitStartedAt = Date.now();
    }
    const elapsed = Date.now() - bucket.paymentWaitStartedAt;
    if (elapsed < PAYMENT_PROOF_WAIT_MS) {
      scheduleFlush(senderId, handler);
      return;
    }
  }

  const waitedMs = bucket.paymentWaitStartedAt
    ? Date.now() - bucket.paymentWaitStartedAt
    : 0;
  const paymentWaitExpired =
    batchNeedsPaymentImageWait(bucket.pending) && waitedMs >= PAYMENT_PROOF_WAIT_MS - 250;

  bucket.processing = true;
  if (bucket.timer) {
    clearTimeout(bucket.timer);
    bucket.timer = null;
  }
  bucket.paymentWaitStartedAt = null;

  const batch = bucket.pending.splice(0);
  const last = batch[batch.length - 1];
  const imageItem = [...batch]
    .reverse()
    .find((item) => messageHasImageAttachment(item.messageContext?.event));

  const messageContext = {
    ...(imageItem?.messageContext || last.messageContext),
    paymentWaitExpired,
  };

  try {
    await handler(
      senderId,
      coalesceInboundTexts(batch.map((item) => item.text)),
      last.platform,
      messageContext
    );
  } finally {
    bucket.processing = false;
    if (bucket.pending.length) {
      scheduleFlush(senderId, handler);
    } else {
      buckets.delete(senderId);
    }
  }
}

/**
 * Queue an inbound DM so rapid follow-ups (hi / hello / are you there?) become one bot reply.
 */
function enqueueInboundMessage(senderId, text, platform, messageContext, handler) {
  let bucket = buckets.get(senderId);
  if (!bucket) {
    bucket = {
      pending: [],
      timer: null,
      processing: false,
      paymentWaitStartedAt: null,
    };
    buckets.set(senderId, bucket);
  }

  bucket.pending.push({ text, platform, messageContext });

  if (bucket.processing) return;

  scheduleFlush(senderId, handler);
}

module.exports = {
  enqueueInboundMessage,
  coalesceInboundTexts,
  DEBOUNCE_MS,
  PAYMENT_PROOF_WAIT_MS,
};
