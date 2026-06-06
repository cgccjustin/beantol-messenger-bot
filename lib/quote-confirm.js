const {
  buildQuoteFromText,
  formatPeso,
  parseLineItemsFromText,
} = require("./pricing");
const {
  isQuoteCaptureConfigured,
  shouldCreateQuote,
  mergeQuoteLineItems,
  recordQuote,
} = require("./quotes");
const { analyzeLeadSignal, ADD_TO_ORDER_PATTERN } = require("./lead-capture");

const SESSION_TTL_MS =
  Number(process.env.QUOTE_CONFIRM_SESSION_HOURS || 4) * 60 * 60 * 1000;

/** @type {Map<string, { step: string, quote: object, meta: object, updatedAt: number }>} */
const sessions = new Map();

const CONFIRM_YES_PATTERN =
  /^(?:yes|yep|yeah|yup|oo|opo|ok(?:ay)?|correct|confirm(?:ed)?|proceed|go ahead|send(?: it)?|looks good|good|sige|go|👍|✅)$/i;

const CONFIRM_NO_PATTERN =
  /\b(?:no|nope|cancel|wrong|start over|forget it|never mind|nevermind|not that|change it|different|reset)\b/i;

const EXPLICIT_QUOTE_PATTERN =
  /\b(?:formal quote|send (?:me )?(?:a )?quote|quotation|price quote|printable quote|quote link)\b/i;

function getSession(senderId) {
  const session = sessions.get(senderId);
  if (!session) return null;
  if (Date.now() - session.updatedAt > SESSION_TTL_MS) {
    sessions.delete(senderId);
    return null;
  }
  return session;
}

function clearQuoteConfirmSession(senderId) {
  sessions.delete(senderId);
}

function startConfirmSession(senderId, quote, meta) {
  const session = {
    step: "confirm",
    quote,
    meta,
    updatedAt: Date.now(),
  };
  sessions.set(senderId, session);
  return session;
}

function isConfirmYes(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (CONFIRM_NO_PATTERN.test(t)) return false;
  return CONFIRM_YES_PATTERN.test(t) || /^yes\b/i.test(t);
}

function isConfirmNo(text) {
  return CONFIRM_NO_PATTERN.test(String(text || "").trim());
}

function isAddToQuote(text) {
  return ADD_TO_ORDER_PATTERN.test(String(text || ""));
}

function isExplicitQuoteRequest(text) {
  return EXPLICIT_QUOTE_PATTERN.test(String(text || ""));
}

/** Build quote from this turn only — no chat history or prior sheet rows. */
function buildProposal(userText, assistantReply = "", options = {}) {
  const fromUser = buildQuoteFromText(userText, {
    ...options,
    historyTexts: [],
    assistantReply: "",
  });
  if (fromUser?.lineItems?.length) return fromUser;

  if (assistantReply) {
    return buildQuoteFromText("", {
      ...options,
      historyTexts: [],
      assistantReply,
    });
  }
  return null;
}

function formatConfirmMessage(quote) {
  const lines = (quote.lineItems || [])
    .map((line) => `• ${line.display}`)
    .join("\n");
  const summary = lines || String(quote.summary || "").replace(/\s·\s/g, "\n• ");

  return (
    `Quote summary — please confirm:\n\n${summary}\n\n` +
    `Total: ${formatPeso(quote.subtotal)}\n\n` +
    `Reply YES to get your printable formal quote link.\n` +
    `To add items, say e.g. "also add Prime 250g". To start over, reply NO.`
  );
}

function shouldOfferQuoteConfirm(userText, assistantReply, signal, options = {}) {
  const explicit = isExplicitQuoteRequest(userText);
  if (
    !shouldCreateQuote({
      stage: signal?.stage,
      interest: signal?.interest,
      userText,
      explicit,
    })
  ) {
    return false;
  }

  const proposal = buildProposal(userText, assistantReply, options);
  if (!proposal?.lineItems?.length) return false;

  if (explicit) return true;
  if (/\b(?:₱|peso|total|price|magkano|tagpila)\b/i.test(assistantReply || "")) {
    return true;
  }
  if (/\b(?:price|prices|how much|magkano|tagpila|quote|quotation)\b/i.test(userText)) {
    return true;
  }
  return Boolean(signal?.interest);
}

function mergeSessionCart(existingQuote, addition, options = {}) {
  if (!addition) return existingQuote;
  if (!existingQuote) return addition;
  return mergeQuoteLineItems(existingQuote.summary, addition, [], options);
}

function buildQuoteShareUrl(quote, publicBaseUrl) {
  if (!quote?.quoteId || !quote?.shareToken || !publicBaseUrl) return "";
  const base = publicBaseUrl.replace(/\/$/, "");
  return `${base}/quote/${encodeURIComponent(quote.quoteId)}?t=${encodeURIComponent(quote.shareToken)}`;
}

/**
 * Pre-AI: handle YES/NO while a quote confirmation is pending.
 */
async function processQuoteConfirmPreAi(senderId, userText, platform, publicBaseUrl) {
  if (!isQuoteCaptureConfigured()) return { handled: false };

  const session = getSession(senderId);
  if (!session || session.step !== "confirm") return { handled: false };

  if (isConfirmYes(userText)) {
    const result = await recordQuote({
      ...session.meta,
      senderId,
      platform,
      userText,
      quoteSnapshot: session.quote,
      freshQuote: true,
    });
    clearQuoteConfirmSession(senderId);
    if (!result?.ok) {
      return {
        handled: true,
        reply:
          "Sorry — I couldn't generate that quote just now. Please tell me the bean and size again.",
      };
    }
    const url = buildQuoteShareUrl(result.quote, publicBaseUrl);
    const reply = url
      ? `Here's your formal quote (save or print):\n${url}`
      : "Your quote is saved. Message us if you need the link resent.";
    return { handled: true, reply, quoteUrl: url || null };
  }

  if (isConfirmNo(userText)) {
    clearQuoteConfirmSession(senderId);
    return {
      handled: true,
      reply:
        "No problem — what would you like a quote for? Tell me the bean and size (e.g. Cerrado 6 kg wholesale, or Prime 250g).",
    };
  }

  return { handled: false };
}

/**
 * Post-AI: start or update quote confirmation (never attach link until YES).
 */
function processQuoteConfirmPostAi(senderId, userText, platform, assistantReply, context = {}) {
  if (!isQuoteCaptureConfigured()) return { handled: false };

  const {
    signal,
    name = "",
    phone = "",
    interest = "",
    bean = "",
    size = "",
    wholesale = false,
    publicBaseUrl = "",
  } = context;

  const options = { bean, size, wholesale };
  let session = getSession(senderId);

  if (session?.step === "confirm") {
    if (isAddToQuote(userText) || parseLineItemsFromText(userText, options).length) {
      const addition = buildProposal(userText, assistantReply, options);
      if (addition) {
        session.quote = mergeSessionCart(session.quote, addition, options);
        session.updatedAt = Date.now();
        sessions.set(senderId, session);
        return {
          handled: true,
          appendConfirm: true,
          reply: formatConfirmMessage(session.quote),
        };
      }
    }
    return { handled: false };
  }

  if (!shouldOfferQuoteConfirm(userText, assistantReply, signal, options)) {
    return { handled: false };
  }

  const proposal = buildProposal(userText, assistantReply, options);
  if (!proposal) return { handled: false };

  startConfirmSession(senderId, proposal, {
    platform,
    name,
    phone,
    interest: interest || signal?.interest || "",
    bean,
    size,
    wholesale,
    stage: signal?.stage || "quoted",
  });

  return {
    handled: true,
    appendConfirm: true,
    reply: formatConfirmMessage(proposal),
  };
}

module.exports = {
  processQuoteConfirmPreAi,
  processQuoteConfirmPostAi,
  clearQuoteConfirmSession,
  buildProposal,
  formatConfirmMessage,
  isConfirmYes,
  isExplicitQuoteRequest,
};
