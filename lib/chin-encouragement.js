/**
 * Faith-based encouragement mode for selected Messenger profiles.
 * Beantol: Chin Siao (board exam encouragement).
 * Offbeat Brew: Reyna Mae Epe, Honey Pearl Reyes, Justin Siao (as themselves).
 *
 * Named profiles only get faith replies for personal / faith / life topics.
 * Business messages (orders, menu, beans, quotes, etc.) use the normal bot.
 */

const { requestChatCompletion } = require("./openai-chat");
const {
  isCafeOrderFlowEnabled,
  isCafeOrderFlowActive,
  tryHandleCafeMenuInquiry,
  parseCafeOrderFromText,
  asksPaymentMode,
} = require("./cafe-order-flow");
const { isHowToOrderInquiry, isCafeHowToOrderEnabled } = require("./how-to-order-inquiry");
const { isPostQuoteFlowActive } = require("./post-quote-flow");
const { isEquipmentSalesInquiry } = require("./equipment-inquiry");
const { isRecommendationIntent } = require("./recommendations");
const { isKnowledgeFaqInquiry } = require("./knowledge-faq-inquiry");

const BUSINESS_SIMPLE_GREETING =
  /^(?:hi|hello|hey|helo|good morning|good afternoon|good evening|kamusta|musta|hello po|hi po|good day|thanks|thank you|salamat)[!.?\s]*$/i;

const OFFBEAT_OPERATIONAL_PATTERN =
  /\b(?:order|buy|kuha|gusto ko|pickup|delivery|deliver|padala|hatod|gcash|payment|pay|price|how much|tagpila|quote|appointment|offbeat white|offbeat black|unplugged|cold brew|bottle|bottles|best\s*seller|bestseller|what do you recommend|promo|deal|open today|closed today|hours|location|address)\b/i;

const BEANTOL_OPERATIONAL_PATTERN =
  /\b(?:order|buy|beans?|roast|250g|500g|1kg|espresso|pour-over|pour over|french press|delivery|pickup|ship|gcash|payment|pay|price|how much|tagpila|quote|quotation|appointment|book|sample|wholesale|bulk|menu|catalog|inventory|stock|cebu|beantol|prime|santos|cerrado|guji|sidama|kenya|ellaga|recommend|bestseller|best seller|what do you recommend|help me choose|hours|location|address|shop|open today|closed|grind|handoff|agent|human|person|talk to|equipment|machine|grinder|brew method|cupping|training|wholesale)\b/i;

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 45000);

const FAITH_ENCOURAGEMENT_TENANTS = new Set(["beantol", "offbeat-brew"]);

const RECIPIENT_RULES = {
  beantol: [
    {
      id: "chin",
      recipientName: "Chin",
      persona: "board_exam",
      brand: "Beantol Coffee Roasters",
      matchName: (n) => n === "chin siao" || (/\bchin\b/.test(n) && /\bsiao\b/.test(n)),
    },
  ],
  "offbeat-brew": [
    {
      id: "reyna",
      recipientName: "Reyna",
      persona: "general",
      brand: "Offbeat Brew",
      matchName: (n) =>
        n === "reyna mae epe" ||
        n === "reyna epe" ||
        (/\breyna\b/.test(n) && /\bepe\b/.test(n)),
    },
    {
      id: "honey",
      recipientName: "Honey",
      persona: "general",
      brand: "Offbeat Brew",
      matchName: (n) =>
        n === "honey pearl reyes" ||
        n === "honey reyes" ||
        (/\bhoney\b/.test(n) && /\breyes\b/.test(n)),
    },
    {
      id: "justin",
      recipientName: "Justin",
      persona: "general",
      brand: "Offbeat Brew",
      matchName: (n) => n === "justin siao" || (/\bjustin\b/.test(n) && /\bsiao\b/.test(n)),
    },
  ],
};

function isFaithEncouragementEnabled(tenant) {
  if (process.env.CHIN_ENCOURAGEMENT_ENABLED === "false") return false;
  if (process.env.FAITH_ENCOURAGEMENT_ENABLED === "false") return false;
  if (tenant?.features?.chinEncouragement === false) return false;
  if (tenant?.features?.faithEncouragement === false) return false;
  return FAITH_ENCOURAGEMENT_TENANTS.has(tenant?.id);
}

function normalizePersonName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function parseSenderIdMap(envValue) {
  const map = new Map();
  for (const entry of String(envValue || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [id, recipientId] = entry.split(":").map((s) => s.trim());
    if (id && recipientId) map.set(id, recipientId);
    else if (id) map.set(id, id);
  }
  return map;
}

function matchFaithEncouragementRecipient(tenant, profileName, senderId) {
  const tenantId = tenant?.id;
  const rules = RECIPIENT_RULES[tenantId];
  if (!rules?.length) return null;

  const legacyIds = (process.env.CHIN_SIAO_SENDER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (tenantId === "beantol" && senderId && legacyIds.includes(String(senderId))) {
    return rules.find((r) => r.id === "chin") || rules[0];
  }

  const senderMap = parseSenderIdMap(process.env.FAITH_ENCOURAGEMENT_SENDER_IDS);
  if (senderId && senderMap.has(String(senderId))) {
    const targetId = senderMap.get(String(senderId));
    const byId = rules.find((r) => r.id === targetId);
    if (byId) return byId;
  }

  const extraNames = (process.env.CHIN_ENCOURAGEMENT_PROFILE_NAMES || "")
    .split(",")
    .concat((process.env.FAITH_ENCOURAGEMENT_PROFILE_NAMES || "").split(","))
    .map((s) => normalizePersonName(s))
    .filter(Boolean);

  const n = normalizePersonName(profileName);
  if (!n && !extraNames.length) return null;

  for (const rule of rules) {
    if (n && rule.matchName(n)) return rule;
  }

  for (const extra of extraNames) {
    for (const rule of rules) {
      if (rule.matchName(extra)) return rule;
    }
  }

  return null;
}

function buildBoardExamSystemPrompt(recipient, profileName) {
  const name = recipient.recipientName;
  return (
    `FAITH ENCOURAGEMENT MODE — ${recipient.brand} (strict)\n\n` +
    `You are replying to ${name}, who uses ${recipient.brand}'s chat while reviewing for a board exam. ` +
    `She may ask about exams, fear, boredom, study tips, faith, life, or feelings — personal encouragement, not shop orders.\n\n` +
    buildSharedFaithRules(name, recipient.brand, { endWithVerse: false, includeVerseInBody: true }) +
    `\n\nBOARD EXAM CONTEXT:\n` +
    `- Be especially supportive for review stress, fear of failing, boredom while studying, and "can I pass?" questions.\n` +
    `- Offer brief practical study encouragement where helpful (breaks, prayer, one topic at a time).\n\n` +
    buildVariationRules(name)
  );
}

function buildGeneralFaithSystemPrompt(recipient) {
  const name = recipient.recipientName;
  return (
    `FAITH ENCOURAGEMENT MODE — ${recipient.brand} (strict)\n\n` +
    `You are replying to ${name} on ${recipient.brand}'s Messenger chat. ` +
    `They may ask about life, work, feelings, relationships, faith questions, or random personal thoughts. ` +
    `Their concerns are their own (not assumed to be board exam or study unless they say so). ` +
    `Shop orders and menu questions are handled by the normal bot, not here.\n\n` +
    buildSharedFaithRules(name, recipient.brand, { endWithVerse: true, includeVerseInBody: false }) +
    `\n\n` +
    buildVariationRules(name)
  );
}

function buildSharedFaithRules(name, brand, options = {}) {
  const { endWithVerse = false, includeVerseInBody = true } = options;
  let rules =
    `TONE & CONTENT:\n` +
    `- Warm, genuinely encouraging, like a supportive Christian ate/kuya. Address ${name} by name when natural.\n` +
    `- Ground every reply in biblical Christian faith — hope, peace, wisdom, strength, gratitude, trust in God.\n` +
    `- Answer their actual question or feeling first; do not ignore what they asked.\n`;

  if (endWithVerse) {
    rules +=
      `- STRUCTURE (strict): Respond to their message with faith-based encouragement and practical warmth, ` +
      `then END the reply with a closing Bible verse block: reference + verse text as the final encouragement.\n`;
  }
  if (includeVerseInBody) {
    rules +=
      `- ALWAYS include at least one Bible verse in the reply: real Scripture only (Christian Bible / Protestant canon). ` +
      `Give the reference (e.g. Isaiah 41:10) AND the verse text. Never invent or misquote verses.\n`;
  }

  rules +=
    `\nFAITH BOUNDARIES (strict):\n` +
    `- Biblical Christian encouragement only. No horoscopes, astrology, luck, charms, superstition, ` +
    `"manifestation", Law of Attraction, universe energy, New Age, or non-Christian/pagan spirituality.\n` +
    `- You may mention prayer, trust in God, God's peace, and perseverance.\n\n` +
    `FORMAT:\n` +
    `- Messenger-friendly plain text. Short paragraphs. No markdown headers or **bold**.\n` +
    `- Match their language (English, Tagalog, or Cebuano) when they use it.\n` +
    `- 2–6 short paragraphs max unless they ask for multiple verses.`;

  return rules;
}

function buildVariationRules(name) {
  return (
    `VARIATION (strict — read chat history):\n` +
    `- Every reply must feel fresh. If ${name} asks the same or similar thing again, still answer fully with faith — ` +
    `but use a NEW verse, a NEW angle, and NEW encouragement.\n` +
    `- Never repeat a verse reference you already used in this conversation. Never copy-paste or lightly reword a prior reply.\n` +
    `- You may briefly acknowledge they asked before ("Still on your mind?") then offer something different.\n` +
    `- Rotate tone: gentle, energizing, or reflective — stay varied over time.`
  );
}

function buildEncouragementSystemPrompt(recipient) {
  if (recipient.persona === "board_exam") {
    return buildBoardExamSystemPrompt(recipient);
  }
  return buildGeneralFaithSystemPrompt(recipient);
}

const VERSE_REF_PATTERN =
  /\b((?:[1-3]\s+)?[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+\d{1,3}:\d{1,3}(?:-\d{1,3})?)\b/g;

function extractUsedVerseReferences(history = []) {
  const refs = new Set();
  for (const msg of history) {
    if (msg?.role !== "assistant") continue;
    const text = String(msg.content || "");
    for (const match of text.matchAll(VERSE_REF_PATTERN)) {
      refs.add(match[1].replace(/\s+/g, " ").trim());
    }
  }
  return [...refs];
}

function buildVariationSystemNote(history = [], userText = "", recipient) {
  const name = recipient?.recipientName || "them";
  const usedVerses = extractUsedVerseReferences(history);
  const lines = [
    "THIS TURN — VARIATION (strict):",
    `${name} may repeat themselves or ask something similar to an earlier message. Still give a fresh faith-based reply.`,
    "Use a DIFFERENT verse and a DIFFERENT approach than your previous replies in this chat.",
    "Do not reuse wording from your earlier messages.",
  ];
  if (usedVerses.length) {
    lines.push(
      `Verses already quoted in this conversation — choose a NEW reference (do not repeat): ${usedVerses.join(", ")}.`
    );
  }
  const t = String(userText || "").toLowerCase();
  if (recipient?.persona === "board_exam") {
    if (/\b(?:bored|boring|burnout|what should i do)\b/.test(t) && history.length >= 2) {
      lines.push("Topic hint: boredom — fresh idea + new verse.");
    }
    if (/\b(?:pass|passing|board|exam)\b/.test(t) && history.length >= 2) {
      lines.push("Topic hint: board exam — fresh angle + new verse.");
    }
  }
  if (/\b(?:fear|afraid|anxious|anxiety|worried|kaba|panic|stress)\b/.test(t) && history.length >= 2) {
    lines.push("Topic hint: fear / anxiety — new comfort + verse not used before.");
  }
  if (/\b(?:sad|lonely|tired|overwhelmed|discouraged|hopeless)\b/.test(t) && history.length >= 2) {
    lines.push("Topic hint: heavy feelings — new gentle truth + fresh verse.");
  }
  if (recipient?.persona === "general" && recipient.brand?.includes("Offbeat")) {
    lines.push(
      "Remember: end the reply with a Bible verse (reference + text) as the closing encouragement."
    );
  }
  return lines.join("\n");
}

function fallbackEncouragementReply(recipient) {
  const name = recipient?.recipientName || "friend";
  if (recipient?.persona === "board_exam") {
    return (
      `${name}, I'm cheering you on!\n\n` +
      "Philippians 4:13 — I can do all things through Christ who strengthens me.\n\n" +
      "Take a deep breath, say a short prayer, and tackle one topic at a time."
    );
  }
  return (
    `Hi ${name}! I'm glad you reached out.\n\n` +
    "Whatever you're carrying today, you don't face it alone — God sees you and cares for you.\n\n" +
    "Isaiah 41:10 — So do not fear, for I am with you; do not be dismayed, for I am your God. " +
    "I will strengthen you and help you; I will uphold you with my righteous right hand."
  );
}

async function generateFaithEncouragementReply(userText, options = {}) {
  const {
    recipient,
    history = [],
    sanitizeHistory = (h) => h,
    languageInstruction = "",
    isFirstWelcome = false,
  } = options;

  if (!recipient) {
    return fallbackEncouragementReply({ recipientName: "friend", persona: "general" });
  }

  const name = recipient.recipientName;

  if (!OPENAI_API_KEY) {
    return (
      `Hi ${name}! Encouragement chat isn't connected yet — please try again later.\n\n` +
      "Joshua 1:9 — Be strong and courageous; do not be afraid, for the Lord your God is with you."
    );
  }

  const systemMessages = [{ role: "system", content: buildEncouragementSystemPrompt(recipient) }];
  if (languageInstruction) {
    systemMessages.push({ role: "system", content: languageInstruction });
  }
  if (isFirstWelcome) {
    const welcomeNote =
      recipient.persona === "board_exam"
        ? `FIRST MESSAGE: Welcome ${name} warmly, acknowledge board exam prep if natural, and include an encouraging Bible verse.`
        : `FIRST MESSAGE: Welcome ${name} warmly to ${recipient.brand}. Be faith-filled and end with an encouraging Bible verse.`;
    systemMessages.push({ role: "system", content: welcomeNote });
  }

  const safeHistory = sanitizeHistory(history).slice(-12);
  const variationNote = buildVariationSystemNote(safeHistory, userText, recipient);
  if (variationNote) {
    systemMessages.push({ role: "system", content: variationNote });
  }

  const messages = [
    ...systemMessages,
    ...safeHistory,
    { role: "user", content: String(userText || "").trim() || "(empty message)" },
  ];

  try {
    const { completion } = await requestChatCompletion(OPENAI_API_KEY, {
      model: OPENAI_MODEL,
      messages,
      maxTokens: 450,
      timeoutMs: OPENAI_TIMEOUT_MS,
      temperature: 0.85,
    });
    const reply = completion?.choices?.[0]?.message?.content?.trim();
    return reply || fallbackEncouragementReply(recipient);
  } catch (err) {
    console.error("Faith encouragement OpenAI error:", err.message);
    return fallbackEncouragementReply(recipient);
  }
}

/**
 * Named faith profiles: defer to the normal bot for business / shop messages.
 * Faith mode runs for personal, faith, life, and board-exam encouragement topics.
 */
function shouldSkipFaithEncouragementForMessage(userText, tenant, recipient, options = {}) {
  if (!recipient) return false;

  const { senderId = "" } = options;
  const text = String(userText || "").trim();
  if (!text) return false;

  if (isCafeOrderFlowActive(senderId) || isPostQuoteFlowActive(senderId)) return true;
  if (BUSINESS_SIMPLE_GREETING.test(text)) return true;

  const tenantId = tenant?.id || "";

  if (tenantId === "beantol") {
    if (BEANTOL_OPERATIONAL_PATTERN.test(text)) return true;
    if (isEquipmentSalesInquiry(text)) return true;
    if (isRecommendationIntent(text)) return true;
    if (isKnowledgeFaqInquiry(text)) return true;
  }

  if (tenantId === "offbeat-brew" && isCafeOrderFlowEnabled(tenant)) {
    if (tryHandleCafeMenuInquiry(text, tenant).handled) return true;
    if (isCafeHowToOrderEnabled(tenant) && isHowToOrderInquiry(text, tenant)) return true;
    if (parseCafeOrderFromText(text, tenant)?.length) return true;
    if (asksPaymentMode(text)) return true;
    if (OFFBEAT_OPERATIONAL_PATTERN.test(text)) return true;
  }

  return false;
}

function isChinEncouragementEnabled(tenant) {
  return isFaithEncouragementEnabled(tenant);
}

function isChinSiaoCustomer(profileName, senderId) {
  return Boolean(matchFaithEncouragementRecipient({ id: "beantol" }, profileName, senderId));
}

function resolveChinEncouragementRecipientName(profileName) {
  const recipient = matchFaithEncouragementRecipient({ id: "beantol" }, profileName, "");
  return recipient?.recipientName || "Chin";
}

async function generateChinEncouragementReply(userText, options = {}) {
  const recipient =
    options.recipient ||
    matchFaithEncouragementRecipient({ id: "beantol" }, options.profileName, "") ||
    RECIPIENT_RULES.beantol[0];
  return generateFaithEncouragementReply(userText, { ...options, recipient });
}

module.exports = {
  isFaithEncouragementEnabled,
  matchFaithEncouragementRecipient,
  shouldSkipFaithEncouragementForMessage,
  generateFaithEncouragementReply,
  buildEncouragementSystemPrompt,
  isChinEncouragementEnabled,
  isChinSiaoCustomer,
  resolveChinEncouragementRecipientName,
  buildChinEncouragementSystemPrompt: buildEncouragementSystemPrompt,
  generateChinEncouragementReply,
};
