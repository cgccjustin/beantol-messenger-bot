const {
  buildQuoteFromText,
  buildQuoteFromConfirmSummary,
  formatPeso,
  parseLineItemsFromText,
  parseKgAmount,
  parseKgDelta,
  resolveOrderKg,
  resolveEffectiveOrderKg,
  requestedBelowMoqBulkKg,
  buildBulkLineItemForProduct,
  detectWholesaleUpgrade,
  formatWholesaleUpgradePrefix,
  formatFractionAdjustmentPrefix,
  productById,
  resolveProductForPricingNote,
  isWholesaleEligibleProduct,
  WHOLESALE_MOQ_KG,
} = require("./pricing");
const {
  isQuoteCaptureConfigured,
  shouldCreateQuote,
  mergeQuoteLineItems,
  recordQuote,
} = require("./quotes");
const { ADD_TO_ORDER_PATTERN } = require("./lead-capture");

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

  const lines = t.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (CONFIRM_NO_PATTERN.test(line)) return false;
    if (CONFIRM_YES_PATTERN.test(line)) return true;
    if (/^yes\b/i.test(line)) return true;
  }

  if (CONFIRM_NO_PATTERN.test(t)) return false;
  if (CONFIRM_YES_PATTERN.test(t) || /^yes\b/i.test(t)) return true;
  if (t.length <= 48 && /\b(?:proceed|confirm)(?: with (?:this|the) order)?\b/i.test(t)) {
    return true;
  }
  return false;
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

function isConfirmationOnly(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (parseLineItemsFromText(t).length) return false;
  if (matchCatalogFromTextSafe(t)) return false;
  return isConfirmYes(t);
}

function matchCatalogFromTextSafe(text) {
  try {
    const { matchCatalogFromText } = require("./catalog");
    return matchCatalogFromText(text);
  } catch (_) {
    return null;
  }
}

function getQuoteConfirmSession(senderId) {
  return getSession(senderId);
}

function isStandaloneOrderTurn(userText) {
  const t = String(userText || "").trim();
  if (!t || isConfirmationOnly(t) || isAddToQuote(t) || parseKgDelta(t)) return false;
  const product = matchCatalogFromTextSafe(t);
  if (!product) return false;
  return parseKgAmount(t) != null || parseLineItemsFromText(t, { quoteUserText: t }).length > 0;
}

function historyTextsForQuoteTurn(userText, recentTexts) {
  if (isStandaloneOrderTurn(userText)) return [];
  return recentTexts.slice(-3);
}

function detectWholesale(userText, assistantReply = "", recentTexts = [], sessionQuote = null) {
  const product = resolveProductForPricingNote(userText, recentTexts, sessionQuote);
  if (product && !isWholesaleEligibleProduct(product.id)) return false;

  const effective = resolveEffectiveOrderKg(userText, recentTexts, sessionQuote);
  if (effective && effective.kg >= WHOLESALE_MOQ_KG) return true;
  if (requestedBelowMoqBulkKg(userText, recentTexts, sessionQuote)) return false;
  const combined = [userText, assistantReply, ...recentTexts].filter(Boolean).join(" ");
  if (/\b(?:wholesale|bulk)\b/i.test(combined)) return true;
  const kg = resolveOrderKg(combined) || parseKgAmount(combined);
  return kg != null && kg >= WHOLESALE_MOQ_KG;
}

/** Build quote from the current quote turn — not old sheet rows or full chat history. */
function buildProposal(userText, assistantReply = "", options = {}) {
  const { recentTexts = [], sessionQuote = null } = options;
  const historyTexts = historyTextsForQuoteTurn(userText, recentTexts);
  const effectiveKg = resolveEffectiveOrderKg(userText, historyTexts, sessionQuote);
  const wholesale = detectWholesale(userText, assistantReply, historyTexts, sessionQuote);
  const quoteUserText = isStandaloneOrderTurn(userText)
    ? userText
    : [userText, ...historyTexts].filter(Boolean).join("\n");
  const opts = {
    ...options,
    wholesale: wholesale || options.wholesale,
    quoteUserText,
    sessionQuote,
    effectiveKg,
  };

  if (isConfirmationOnly(userText)) {
    if (assistantReply) {
      const fromSummary = buildQuoteFromConfirmSummary(assistantReply, opts);
      if (fromSummary?.lineItems?.length) return fromSummary;
      return buildQuoteFromText("", {
        ...opts,
        historyTexts: [],
        assistantReply,
      });
    }
    return null;
  }

  const fromUser = buildQuoteFromText(userText, {
    ...opts,
    historyTexts,
    assistantReply: "",
  });
  if (fromUser?.lineItems?.length) return fromUser;

  if (assistantReply) {
    const fromSummary = buildQuoteFromConfirmSummary(assistantReply, opts);
    if (fromSummary?.lineItems?.length) return fromSummary;
    return buildQuoteFromText("", {
      ...opts,
      historyTexts: [],
      assistantReply,
    });
  }

  return buildQuoteFromText(userText, {
    ...opts,
    historyTexts: isStandaloneOrderTurn(userText) ? [] : recentTexts.slice(-2),
    assistantReply: "",
  });
}

function formatConfirmMessage(quote, prefix = "") {
  const lines = (quote.lineItems || [])
    .map((line) => `• ${line.display}`)
    .join("\n");
  const summary = lines || String(quote.summary || "").replace(/\s·\s/g, "\n• ");

  return (
    `${prefix}` +
    `Quote summary — please confirm:\n\n${summary}\n\n` +
    `Total: ${formatPeso(quote.subtotal)}\n\n` +
    `Reply YES to get your printable formal quote link.\n` +
    `To add items, say e.g. "also add Prime 250g". To start over, reply NO.`
  );
}

function buildConfirmReply(previousQuote, newQuote, adjustment = null) {
  let prefix = "";
  const upgrade = detectWholesaleUpgrade(previousQuote, newQuote);
  if (upgrade) {
    prefix = formatWholesaleUpgradePrefix(upgrade);
  }
  if (adjustment?.type === "fraction_dropped") {
    const label = newQuote.lineItems?.[0]?.productLabel || "this bean";
    prefix += formatFractionAdjustmentPrefix(adjustment, label);
  }
  return formatConfirmMessage(newQuote, prefix);
}

function tryMergeSessionKg(session, userText, assistantReply, options) {
  const delta = parseKgDelta(userText);
  const effective = resolveEffectiveOrderKg(
    userText,
    options.recentTexts || [],
    session.quote
  );
  if (!effective && delta == null) return null;

  const line = session.quote?.lineItems?.[0];
  const product = productById(line?.productId) || matchCatalogFromTextSafe(userText);
  if (!product) return null;

  const resolved = effective || resolveEffectiveOrderKg("", options.recentTexts || [], session.quote);
  if (!resolved) return null;

  const built = buildBulkLineItemForProduct(product, resolved);
  if (!built?.line) return null;

  const quote = {
    lineItems: [built.line],
    subtotal: built.line.lineTotal,
    summary: built.line.display,
  };

  return {
    quote,
    reply: buildConfirmReply(session.quote, quote, built.adjustment),
    upgrade: detectWholesaleUpgrade(session.quote, quote),
  };
}

function assistantAlreadyAskedConfirm(assistantReply) {
  return /\b(?:reply yes|type yes|would you like to proceed|proceed with this order|confirm this order)\b/i.test(
    String(assistantReply || "")
  );
}

function shouldOfferQuoteConfirm(userText, assistantReply, signal, options = {}) {
  const { recentTexts = [], sessionQuote = null } = options;

  const effective = resolveEffectiveOrderKg(userText, recentTexts, sessionQuote);
  if (effective?.kg >= WHOLESALE_MOQ_KG) {
    return Boolean(buildProposal(userText, assistantReply, options));
  }

  if (requestedBelowMoqBulkKg(userText, recentTexts, sessionQuote)) {
    return Boolean(buildProposal(userText, assistantReply, options));
  }

  if (parseKgDelta(userText)) {
    return Boolean(buildProposal(userText, assistantReply, options));
  }

  if (isConfirmationOnly(userText)) {
    return Boolean(buildProposal(userText, assistantReply, options));
  }

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
  return Boolean(parseLineItemsFromText(userText, options).length || parseKgAmount(userText));
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

function clearSessionIfBelowMoqRequest(senderId, userText, recentTexts = [], sessionQuote = null) {
  const effective = resolveEffectiveOrderKg(userText, recentTexts, sessionQuote);
  if (effective && effective.kg >= WHOLESALE_MOQ_KG) {
    return null;
  }
  const belowMoq = requestedBelowMoqBulkKg(userText, recentTexts, sessionQuote);
  if (belowMoq != null) {
    clearQuoteConfirmSession(senderId);
  }
  return belowMoq;
}

async function finalizeQuoteFromYes(senderId, userText, platform, publicBaseUrl, quoteSnapshot, meta = {}) {
  const result = await recordQuote({
    ...meta,
    senderId,
    platform,
    userText,
    quoteSnapshot,
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

/**
 * Pre-AI: handle YES/NO while a quote confirmation is pending.
 */
async function processQuoteConfirmPreAi(
  senderId,
  userText,
  platform,
  publicBaseUrl,
  recentTexts = [],
  options = {}
) {
  if (!isQuoteCaptureConfigured()) return { handled: false };

  const { lastAssistantReply = "" } = options;

  clearSessionIfBelowMoqRequest(senderId, userText, recentTexts, getSession(senderId)?.quote);

  let session = getSession(senderId);

  if (!session && isConfirmYes(userText) && assistantAlreadyAskedConfirm(lastAssistantReply)) {
    const proposal = buildProposal(userText, lastAssistantReply, { recentTexts: [] });
    if (proposal?.lineItems?.length) {
      return finalizeQuoteFromYes(senderId, userText, platform, publicBaseUrl, proposal, {
        platform,
        interest: "",
        stage: "quoted",
      });
    }
  }

  if (!session || session.step !== "confirm") return { handled: false };

  if (isConfirmYes(userText)) {
    return finalizeQuoteFromYes(
      senderId,
      userText,
      platform,
      publicBaseUrl,
      session.quote,
      session.meta
    );
  }

  if (isConfirmNo(userText)) {
    clearQuoteConfirmSession(senderId);
    return {
      handled: true,
      reply:
        "No problem — what would you like a quote for? Tell me the bean and size (e.g. Cerrado 7 kg wholesale, or Prime 250g).",
    };
  }

  return { handled: false };
}

/**
 * Post-AI: start or update quote confirmation (never attach link until YES).
 */
function processQuoteConfirmPostAi(senderId, userText, platform, assistantReply, context = {}) {
  if (!isQuoteCaptureConfigured()) return { handled: false };

  if (isConfirmYes(userText)) {
    return { handled: false };
  }

  const {
    signal,
    name = "",
    phone = "",
    interest = "",
    bean = "",
    size = "",
    wholesale = false,
    publicBaseUrl = "",
    recentTexts = [],
  } = context;

  const existingSession = getSession(senderId);
  const options = {
    bean,
    size,
    wholesale,
    recentTexts,
    sessionQuote: existingSession?.quote,
  };

  clearSessionIfBelowMoqRequest(
    senderId,
    userText,
    recentTexts,
    existingSession?.quote
  );

  const effectiveKg = resolveEffectiveOrderKg(userText, recentTexts, existingSession?.quote);
  if (effectiveKg?.kg >= WHOLESALE_MOQ_KG) {
    const wholesaleProposal = buildProposal(userText, assistantReply, options);
    if (wholesaleProposal?.lineItems?.length) {
      const hasWholesale = wholesaleProposal.lineItems.some((line) => line.size === "wholesale");
      if (hasWholesale) {
        const upgrade = detectWholesaleUpgrade(existingSession?.quote, wholesaleProposal);
        startConfirmSession(senderId, wholesaleProposal, {
          platform,
          name,
          phone,
          interest: interest || signal?.interest || "",
          bean,
          size,
          wholesale: true,
          stage: signal?.stage || "quoted",
        });
        const skipDuplicate =
          assistantAlreadyAskedConfirm(assistantReply) && !isExplicitQuoteRequest(userText);
        let prefix = upgrade ? formatWholesaleUpgradePrefix(upgrade) : "";
        if (effectiveKg.droppedFraction) {
          const label = wholesaleProposal.lineItems[0]?.productLabel || "this bean";
          prefix += formatFractionAdjustmentPrefix(
            {
              requestedKg: effectiveKg.requestedKg,
              kg: effectiveKg.kg,
            },
            label
          );
        }
        return {
          handled: true,
          appendConfirm: !skipDuplicate,
          reply: formatConfirmMessage(wholesaleProposal, prefix),
        };
      }
    }
  }

  if (requestedBelowMoqBulkKg(userText, recentTexts, existingSession?.quote)) {
    const retailProposal = buildProposal(userText, assistantReply, options);
    if (retailProposal?.lineItems?.length) {
      const allWholesale = retailProposal.lineItems.every((line) => line.size === "wholesale");
      if (!allWholesale) {
        startConfirmSession(senderId, retailProposal, {
          platform,
          name,
          phone,
          interest: interest || signal?.interest || "",
          bean,
          size,
          wholesale: false,
          stage: signal?.stage || "quoted",
        });
        const skipDuplicate =
          assistantAlreadyAskedConfirm(assistantReply) && !isExplicitQuoteRequest(userText);
        return {
          handled: true,
          appendConfirm: !skipDuplicate,
          reply: formatConfirmMessage(retailProposal),
        };
      }
    }
    return { handled: false };
  }

  const session = getSession(senderId);

  if (session?.step === "confirm") {
    if (isConfirmationOnly(userText)) {
      if (!isConfirmYes(userText)) {
        const refreshed = buildProposal(userText, assistantReply, {
          ...options,
          sessionQuote: session.quote,
        });
        if (refreshed?.lineItems?.length) {
          session.quote = refreshed;
          session.updatedAt = Date.now();
          sessions.set(senderId, session);
        }
      }
      return { handled: false };
    }

    const kgMerged = tryMergeSessionKg(session, userText, assistantReply, options);
    if (kgMerged) {
      session.quote = kgMerged.quote;
      session.meta.wholesale = kgMerged.quote.lineItems.some((l) => l.size === "wholesale");
      session.updatedAt = Date.now();
      sessions.set(senderId, session);
      return {
        handled: true,
        appendConfirm: true,
        reply: kgMerged.reply,
      };
    }

    if (isAddToQuote(userText)) {
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

    const replacement = buildProposal(userText, assistantReply, options);
    if (replacement?.lineItems?.length && parseLineItemsFromText(userText, options).length) {
      startConfirmSession(senderId, replacement, {
        ...session.meta,
        platform,
        name: name || session.meta.name,
        phone: phone || session.meta.phone,
        interest: interest || session.meta.interest,
        bean,
        size,
        wholesale: wholesale || options.wholesale,
      });
      return {
        handled: true,
        appendConfirm: true,
        reply: formatConfirmMessage(replacement),
      };
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
    wholesale: wholesale || options.wholesale,
    stage: signal?.stage || "quoted",
  });

  const skipDuplicate =
    assistantAlreadyAskedConfirm(assistantReply) && !isExplicitQuoteRequest(userText);

  return {
    handled: true,
    appendConfirm: !skipDuplicate,
    reply: formatConfirmMessage(proposal),
  };
}

module.exports = {
  processQuoteConfirmPreAi,
  processQuoteConfirmPostAi,
  clearQuoteConfirmSession,
  getQuoteConfirmSession,
  buildProposal,
  formatConfirmMessage,
  isConfirmYes,
  isExplicitQuoteRequest,
};
