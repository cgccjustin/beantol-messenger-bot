/**
 * Faith-based encouragement mode.
 *
 * Roster mode (openToAll OFF): named profiles only — non-business → faith + Scripture.
 *   Beantol: Chin Siao | Offbeat Brew: Reyna, Honey, Justin
 *
 * Open-to-all mode (openToAll ON): any customer on Beantol, Offbeat Brew, or Kape Kristiano
 *   gets faith replies when the message is personal/faith (not shop orders, menu, hours, etc.).
 *
 * Toggle: FAITH_ENCOURAGEMENT_OPEN_TO_ALL=true|false (env) or features.faithEncouragement.openToAll per tenant.
 */

const FAITH_PROFILE_ROSTER = Object.freeze({
  beantol: [{ id: "chin", fullName: "Chin Siao" }],
  "offbeat-brew": [
    { id: "reyna", fullName: "Reyna Mae Epe" },
    { id: "honey", fullName: "Honey Pearl Reyes" },
    { id: "justin", fullName: "Justin Siao" },
  ],
});

const { requestChatCompletion } = require("./openai-chat");
const {
  isCafeOrderFlowEnabled,
  isCafeOrderFlowActive,
  isCafeOrderFlowRecentlyActive,
  tryHandleCafeMenuInquiry,
  parseCafeOrderFromText,
  asksPaymentMode,
} = require("./cafe-order-flow");
const { isHowToOrderInquiry, isCafeHowToOrderEnabled } = require("./how-to-order-inquiry");
const { isPostQuoteFlowActive, isPostQuoteFlowRecentlyActive } = require("./post-quote-flow");
const { isEquipmentSalesInquiry } = require("./equipment-inquiry");
const { isRecommendationIntent } = require("./recommendations");
const { isKnowledgeFaqInquiry } = require("./knowledge-faq-inquiry");

const BUSINESS_SIMPLE_GREETING =
  /^(?:hi|hello|hey|helo|good morning|good afternoon|good evening|kamusta|musta|hello po|hi po|good day|thanks|thank you|salamat)[!.?\s]*$/i;

/**
 * Personal / faith / life topics — clearly personal, no business keyword → faith mode.
 * NOTE: "need help" alone is intentionally excluded — it is too generic and ambiguous.
 * Generic help requests are probed first (isAmbiguousHelpRequest) before faith fires.
 */
const PERSONAL_FAITH_TOPIC_PATTERN =
  /\b(?:feel(?:ing)?\s+(?:sad|down|low|bad|empty|lost|hopeless|lonely|tired|weak|broken|hurt|heavy|depressed|anxious|worried|scared|afraid|stressed|overwhelmed|burned?\s*out|discouraged|miserable|bleh|meh)|i(?:'m|\s+am)\s+(?:so\s+|very\s+|really\s+|quite\s+|pretty\s+)?(?:sad|depressed|lonely|anxious|worried|scared|afraid|stressed|tired|overwhelmed|hopeless|lost|broken|hurt|not\s+ok|not\s+okay|down|low|empty|alone)|depress(?:ed|ion|ing)?|mental\s+health|what\s+(?:should|can|do)\s+i\s+do\s+when|how\s+(?:should|can|do)\s+i\s+(?:cope|deal|handle|overcome)|what\s+if\s+i|change\s+of\s+heart|have\s+a\s+change|new\s+heart|soft(?:en)?(?:ed)?\s+heart|hardened\s+heart|repent|repentance|redemption|salvation|doubting|struggling\s+with|lost\s+my\s+way|far\s+from\s+god|walk\s+with\s+god|need\s+(?:prayer|encouragement|comfort)|(?:can\s+you|please|pls)\s+(?:encourage|bless|inspire)|encourage\s+me|encouragement\s+(?:for|today|please)|pray\s+for\s+me|prayer\s+request|bible|scripture|verse|god|jesus|christ|faith|church|forgive|forgiveness|spiritual|grief|grieving|mourning|heartbreak|break\s*up|relationship\s+problem|life\s+advice|purpose\s+(?:in|of)\s+life|why\s+(?:am\s+i|do\s+i)\s+(?:sad|here|suffering)|board\s+exam|boards?\s+(?:exam|review|prep)|reviewing\s+for|study\s+stress|exam\s+stress|burnout|bored\s+studying|scared\s+to\s+fail|afraid\s+(?:to\s+)?fail|will\s+i\s+(?:pass|make\s+it|fail)|(?:pass|fail)\s+(?:the\s+)?(?:boards?|exam|PLE|NLE|BAR|CPA|LET|licensure)|PLE\b|NLE\b|don'?t\s+have\s+(?:much|enough)\s+time|running\s+out\s+of\s+time|not\s+(?:much|enough)\s+time\s+(?:left|to\s+study|to\s+review)|time\s+pressure|pressure\s+of|kaba|kabado|malungkot|lungkot|nalulungkot|gikapoy|naluya|u\s?ban|gikaguol|gikulbaan|stress\s+kaayo|way\s+la(?:ng)?\s+paglaom)\b/i;

const OFFBEAT_OPERATIONAL_PATTERN =
  /\b(?:order|buy|kuha|gusto ko|pickup|delivery|deliver|padala|hatod|gcash|payment|pay|price|how much|magkano|tagpila|quote|appointment|offbeat white|offbeat black|unplugged|cold brew|coffee|kape|bottle|bottles|best\s*seller|bestseller|what do you recommend|promo|deal|open today|closed today|hours|location|address|menu|drinks?)\b/i;

const BEANTOL_OPERATIONAL_PATTERN =
  /\b(?:order|buy|beans?|coffee|kape|roast|250g|500g|1kg|espresso|pour-over|pour over|french press|delivery|pickup|ship|gcash|payment|pay|price|how much|magkano|tagpila|quote|quotation|appointment|book|sample|wholesale|bulk|menu|catalog|inventory|stock|cebu|beantol|prime|santos|cerrado|guji|sidama|kenya|ellaga|recommend|bestseller|best seller|what do you recommend|help me choose|hours|location|address|shop|open today|closed|grind|handoff|agent|human|person|talk to|equipment|machine|grinder|brew method|cupping|training|wholesale)\b/i;

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 45000);

const FAITH_ROSTER_TENANTS = new Set(["beantol", "offbeat-brew"]);
const FAITH_OPEN_TO_ALL_TENANTS = new Set(["beantol", "offbeat-brew", "kape-kristiano", "destiny"]);
/** Tenants where every message is answered with faith encouragement (no business mode). */
const FAITH_ONLY_TENANTS = new Set(["destiny"]);

/** @deprecated use FAITH_ROSTER_TENANTS */
const FAITH_ENCOURAGEMENT_TENANTS = FAITH_ROSTER_TENANTS;

const RECIPIENT_RULES = {
  beantol: [
    {
      id: "chin",
      recipientName: "Chin",
      fullName: "Chin Siao",
      persona: "board_exam",
      brand: "Beantol Coffee Roasters",
      matchName: (n) =>
        n === "chin siao" ||
        n === "chin" ||
        (/\bchin\b/.test(n) && /\bsiao\b/.test(n)),
    },
  ],
  "offbeat-brew": [
    {
      id: "reyna",
      recipientName: "Reyna",
      fullName: "Reyna Mae Epe",
      persona: "general",
      brand: "Offbeat Brew",
      matchName: (n) =>
        n === "reyna mae epe" ||
        n === "reyna epe" ||
        n === "reyna mae" ||
        n === "reyna" ||
        (/\breyna\b/.test(n) && /\bepe\b/.test(n)) ||
        /\breyna\b/.test(n),
    },
    {
      id: "honey",
      recipientName: "Honey",
      fullName: "Honey Pearl Reyes",
      persona: "general",
      brand: "Offbeat Brew",
      matchName: (n) =>
        n === "honey pearl reyes" ||
        n === "honey reyes" ||
        n === "honey pearl" ||
        n === "honey" ||
        (/\bhoney\b/.test(n) && /\breyes\b/.test(n)) ||
        /\bhoney\b/.test(n),
    },
    {
      id: "justin",
      recipientName: "Justin",
      fullName: "Justin Siao",
      persona: "general",
      brand: "Offbeat Brew",
      matchName: (n) =>
        n === "justin siao" ||
        n === "justin" ||
        (/\bjustin\b/.test(n) && /\bsiao\b/.test(n)),
    },
  ],
};

function isFaithEncouragementOpenToAll(tenant) {
  if (isFaithOnlyTenant(tenant)) return true;

  const env = String(process.env.FAITH_ENCOURAGEMENT_OPEN_TO_ALL || "")
    .trim()
    .toLowerCase();
  if (env === "true") return FAITH_OPEN_TO_ALL_TENANTS.has(tenant?.id);
  if (env === "false") return false;

  const faith = tenant?.features?.faithEncouragement;
  if (faith?.openToAll === true) return FAITH_OPEN_TO_ALL_TENANTS.has(tenant?.id);
  if (faith?.openToAll === false) return false;
  return false;
}

function isFaithOnlyTenant(tenant) {
  const tenantFaith = tenant?.features?.faithEncouragement;
  if (typeof tenantFaith === "object" && tenantFaith.faithOnly === true) return true;
  return FAITH_ONLY_TENANTS.has(tenant?.id);
}

function isFaithEncouragementEnabled(tenant) {
  if (process.env.CHIN_ENCOURAGEMENT_ENABLED === "false") return false;
  if (process.env.FAITH_ENCOURAGEMENT_ENABLED === "false") return false;
  if (tenant?.features?.chinEncouragement === false) return false;
  const tenantFaith = tenant?.features?.faithEncouragement;
  if (tenantFaith === false) return false;
  if (typeof tenantFaith === "object" && tenantFaith.enabled === false) return false;

  if (isFaithOnlyTenant(tenant)) return true;

  if (isFaithEncouragementOpenToAll(tenant)) {
    return FAITH_OPEN_TO_ALL_TENANTS.has(tenant?.id);
  }

  return FAITH_ROSTER_TENANTS.has(tenant?.id);
}

function buildGenericFaithRecipient(tenant, profileName = "") {
  const trimmed = String(profileName || "").trim();
  const firstName = trimmed.split(/\s+/)[0] || "friend";
  const brand =
    tenant?.branding?.businessName || tenant?.name || "our shop";
  return {
    id: "guest",
    recipientName: firstName,
    fullName: trimmed || firstName,
    persona: "general",
    brand,
  };
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

/** Remember matched faith recipients by sender so profile lookup failures still work. */
/** @type {Map<string, string>} tenantId:senderId -> recipient rule id */
const faithSenderRecipientCache = new Map();

function faithSenderCacheKey(tenantId, senderId) {
  return `${tenantId}:${String(senderId || "")}`;
}

function rememberFaithSenderRecipient(tenantId, senderId, recipient) {
  if (!tenantId || !senderId || !recipient?.id) return;
  faithSenderRecipientCache.set(faithSenderCacheKey(tenantId, senderId), recipient.id);
}

function getCachedFaithRecipient(tenantId, senderId) {
  const rules = RECIPIENT_RULES[tenantId];
  if (!rules?.length || !senderId) return null;
  const id = faithSenderRecipientCache.get(faithSenderCacheKey(tenantId, senderId));
  if (!id) return null;
  return rules.find((r) => r.id === id) || null;
}

function normalizeFaithSenderId(senderId) {
  return String(senderId ?? "").trim();
}

function getTenantFaithSenderMap(tenant) {
  const map = new Map();
  const recipients = tenant?.features?.faithEncouragement?.recipients;
  if (!Array.isArray(recipients)) return map;
  for (const entry of recipients) {
    const id = String(entry?.id || "").trim();
    if (!id) continue;
    for (const sid of entry.senderIds || []) {
      const psid = normalizeFaithSenderId(sid);
      if (psid) map.set(psid, id);
    }
  }
  return map;
}

function matchRecipientByName(profileName, rules) {
  const n = normalizePersonName(profileName);
  if (!n) return null;
  for (const rule of rules) {
    if (rule.matchName(n)) return rule;
  }
  return null;
}

function matchTenantConfiguredFaithName(profileName, tenant, rules) {
  const n = normalizePersonName(profileName);
  if (!n) return null;
  const configured = tenant?.features?.faithEncouragement?.recipients;
  if (!Array.isArray(configured)) return null;

  for (const entry of configured) {
    const id = String(entry?.id || "").trim();
    if (!id) continue;
    const rule = rules.find((r) => r.id === id);
    if (!rule) continue;

    const aliases = new Set(
      [entry.fullName, rule.fullName, ...(entry.names || [])]
        .map((name) => normalizePersonName(name))
        .filter(Boolean)
    );

    if (aliases.has(n)) return rule;

    for (const alias of aliases) {
      if (n.includes(alias) || alias.includes(n)) return rule;
    }
  }

  return null;
}

function matchFaithEncouragementRecipient(tenant, profileName, senderId) {
  const tenantId = tenant?.id;
  const rules = RECIPIENT_RULES[tenantId];
  if (!rules?.length) return null;

  if (senderId) {
    const cached = getCachedFaithRecipient(tenantId, senderId);
    if (cached) return cached;
  }

  const legacyIds = (process.env.CHIN_SIAO_SENDER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (tenantId === "beantol" && senderId && legacyIds.includes(normalizeFaithSenderId(senderId))) {
    const matched = rules.find((r) => r.id === "chin") || rules[0];
    rememberFaithSenderRecipient(tenantId, senderId, matched);
    return matched;
  }

  const senderMap = parseSenderIdMap(process.env.FAITH_ENCOURAGEMENT_SENDER_IDS);
  for (const [psid, recipientId] of getTenantFaithSenderMap(tenant)) {
    senderMap.set(psid, recipientId);
  }
  if (senderId && senderMap.has(normalizeFaithSenderId(senderId))) {
    const targetId = senderMap.get(normalizeFaithSenderId(senderId));
    const byId = rules.find((r) => r.id === targetId);
    if (byId) {
      rememberFaithSenderRecipient(tenantId, senderId, byId);
      return byId;
    }
  }

  const extraNames = (process.env.CHIN_ENCOURAGEMENT_PROFILE_NAMES || "")
    .split(",")
    .concat((process.env.FAITH_ENCOURAGEMENT_PROFILE_NAMES || "").split(","))
    .map((s) => normalizePersonName(s))
    .filter(Boolean);

  const byProfile = matchRecipientByName(profileName, rules);
  if (byProfile) {
    rememberFaithSenderRecipient(tenantId, senderId, byProfile);
    return byProfile;
  }

  const byTenantName = matchTenantConfiguredFaithName(profileName, tenant, rules);
  if (byTenantName) {
    rememberFaithSenderRecipient(tenantId, senderId, byTenantName);
    return byTenantName;
  }

  const n = normalizePersonName(profileName);
  if (n) {
    for (const extra of extraNames) {
      if (n === extra || n.includes(extra) || extra.includes(n)) {
        const byExtra = matchRecipientByName(extra, rules);
        if (byExtra) {
          rememberFaithSenderRecipient(tenantId, senderId, byExtra);
          return byExtra;
        }
      }
    }
  }

  return null;
}

/** @type {Set<string>} */
const faithLeadCacheWarmedTenants = new Set();

function matchFaithRecipientFromLeadInterest(tenant, lead = {}) {
  const rules = RECIPIENT_RULES[tenant?.id];
  if (!rules?.length) return null;
  const interest = String(lead.interest || "").toLowerCase();
  if (!/faith encouragement|board exam encouragement/.test(interest)) return null;

  const name = normalizePersonName(lead.name);
  if (!name) return null;

  return (
    matchRecipientByName(lead.name, rules) ||
    rules.find(
      (r) =>
        name === normalizePersonName(r.recipientName) ||
        name === normalizePersonName(r.fullName) ||
        name.includes(normalizePersonName(r.recipientName))
    ) ||
    null
  );
}

async function ensureFaithSenderCacheFromLeads(tenant) {
  const tenantId = tenant?.id;
  if (!tenantId || faithLeadCacheWarmedTenants.has(tenantId)) return;

  faithLeadCacheWarmedTenants.add(tenantId);

  try {
    const { listLeads, isLeadCaptureConfigured } = require("./leads");
    if (!isLeadCaptureConfigured()) return;

    const { leads } = await listLeads(1000);
    const rules = RECIPIENT_RULES[tenantId];
    if (!rules?.length) return;

    let warmed = 0;
    for (const lead of leads || []) {
      const senderId = String(lead.senderId || "").trim();
      if (!senderId) continue;

      const name = String(lead.name || "").trim();
      if (name) {
        const matched = matchFaithEncouragementRecipient(tenant, name, senderId);
        if (matched) {
          warmed += 1;
          continue;
        }
      }

      const fromInterest = matchFaithRecipientFromLeadInterest(tenant, lead);
      if (fromInterest) {
        rememberFaithSenderRecipient(tenantId, senderId, fromInterest);
        warmed += 1;
      }
    }

    if (warmed) {
      console.log(`Faith sender cache warmed from Leads for ${tenantId}: ${warmed} profile(s)`);
    }
  } catch (err) {
    faithLeadCacheWarmedTenants.delete(tenantId);
    console.warn(`Faith sender cache warm failed (${tenantId}):`, err.message);
  }
}

function rememberFaithProfileFromLead(tenant, senderId, name, interest = "") {
  if (!tenant?.id || !senderId) return null;
  const matched =
    matchFaithEncouragementRecipient(tenant, name, senderId) ||
    matchFaithRecipientFromLeadInterest(tenant, { name, interest });
  if (matched) rememberFaithSenderRecipient(tenant.id, senderId, matched);
  return matched;
}

async function matchFaithEncouragementRecipientAsync(tenant, profileName, senderId, options = {}) {
  await ensureFaithSenderCacheFromLeads(tenant);

  const direct = matchFaithEncouragementRecipient(tenant, profileName, senderId);
  if (direct) return direct;

  const { leadName = "" } = options;
  if (leadName) {
    const fromLead = matchFaithEncouragementRecipient(tenant, leadName, senderId);
    if (fromLead) return fromLead;
  }

  if (!senderId || !options.findLeadRow) return null;

  try {
    const found = await options.findLeadRow(senderId);
    const sheetName = String(found?.lead?.name || found?.row?.[4] || "").trim();
    if (sheetName) {
      const fromSheet = matchFaithEncouragementRecipient(tenant, sheetName, senderId);
      if (fromSheet) {
        console.log(
          `Faith profile matched via Leads sheet for ${senderId}: ${sheetName} → ${fromSheet.recipientName}`
        );
        return fromSheet;
      }
    }

    const fromInterest = matchFaithRecipientFromLeadInterest(tenant, found?.lead || {});
    if (fromInterest) {
      rememberFaithSenderRecipient(tenant.id, senderId, fromInterest);
      console.log(
        `Faith profile matched via Leads interest for ${senderId} → ${fromInterest.recipientName}`
      );
      return fromInterest;
    }
  } catch (err) {
    console.warn(`Faith profile lead lookup failed for ${senderId}:`, err.message);
  }

  return null;
}

function buildBoardExamSystemPrompt(recipient, profileName) {
  const name = recipient.recipientName;
  return (
    `FAITH ENCOURAGEMENT MODE — ${recipient.brand} (strict)\n\n` +
    `You are replying to ${name}, who uses ${recipient.brand}'s chat while reviewing for a board exam. ` +
    `She may ask about exams, fear, boredom, study tips, faith, life, or feelings — personal encouragement, not shop orders.\n\n` +
    buildSharedFaithRules(name, recipient.brand) +
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
    buildSharedFaithRules(name, recipient.brand) +
    `\n\n` +
    buildVariationRules(name)
  );
}

function buildSharedFaithRules(name, brand) {
  return (
    `TONE & CONTENT:\n` +
    `- Warm, genuinely encouraging, like a supportive Christian ate/kuya. Address ${name} by name when natural.\n` +
    `- Ground every reply in biblical Christian faith — hope, peace, wisdom, strength, gratitude, trust in God.\n` +
    `- Answer their actual question or feeling first; do not ignore what they asked.\n\n` +
    `REPLY STRUCTURE (mandatory — every single reply):\n` +
    `1. Faith-based encouragement that speaks directly to what they said (2–4 short paragraphs).\n` +
    `2. One blank line.\n` +
    `3. A closing block that starts with the word "Scripture:" on its own line.\n` +
    `4. On the next line: Bible reference + em dash + full verse text (real Scripture only; Protestant canon).\n` +
    `   Example:\n` +
    `   Scripture:\n` +
    `   Isaiah 41:10 — So do not fear, for I am with you; do not be dismayed, for I am your God. I will strengthen you and help you; I will uphold you with my righteous right hand.\n` +
    `- NEVER send a reply without the Scripture block. Never invent or misquote verses.\n` +
    `- NEVER suggest menu items, drinks, orders, or café sales. Do not recommend coffee or upsell the shop.\n\n` +
    `FAITH BOUNDARIES (strict):\n` +
    `- Biblical Christian encouragement only. No horoscopes, astrology, luck, charms, superstition, ` +
    `"manifestation", Law of Attraction, universe energy, New Age, or non-Christian/pagan spirituality.\n` +
    `- You may mention prayer, trust in God, God's peace, and perseverance.\n\n` +
    `FORMAT:\n` +
    `- Messenger-friendly plain text. Short paragraphs. No markdown headers or **bold**.\n` +
    `- Match their language (English, Tagalog, or Cebuano) when they use it — but keep the "Scripture:" label in English.\n` +
    `- 2–6 short paragraphs max before the Scripture block unless they ask for multiple verses.`
  );
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

const SCRIPTURE_BLOCK_PATTERN = /Scripture:\s*\n/i;

const TOPIC_VERSE_FALLBACKS = [
  {
    topics: /\b(?:change\s+of\s+heart|new\s+heart|repent|redemption|what\s+if)\b/i,
    ref: "Ezekiel 36:26",
    text: "I will give you a new heart and put a new spirit in you; I will remove from you your heart of stone and give you a heart of flesh.",
  },
  {
    topics: /\b(?:depress(?:ed|ion|ing)?|sad|lonely|broken|grief|hopeless|hurt|malungkot|lungkot)\b/i,
    ref: "Psalm 34:18",
    text: "The Lord is close to the brokenhearted and saves those who are crushed in spirit.",
  },
  {
    topics: /\b(?:anxious|anxiety|worried|worry|stress|kaba|kabado|gikulbaan|overwhelm)\b/i,
    ref: "Philippians 4:6-7",
    text: "Do not be anxious about anything, but in every situation, by prayer and petition, with thanksgiving, present your requests to God. And the peace of God, which transcends all understanding, will guard your hearts and your minds in Christ Jesus.",
  },
  {
    topics: /\b(?:tired|weary|burnout|burned?\s*out|gikapoy|naluya)\b/i,
    ref: "Matthew 11:28",
    text: "Come to me, all you who are weary and burdened, and I will give you rest.",
  },
  {
    topics: /\b(?:afraid|fear|scared|fail|board|exam|review)\b/i,
    ref: "Joshua 1:9",
    text: "Be strong and courageous. Do not be afraid; do not be discouraged, for the Lord your God will be with you wherever you go.",
  },
  {
    topics: /.*/i,
    ref: "Isaiah 41:10",
    text: "So do not fear, for I am with you; do not be dismayed, for I am your God. I will strengthen you and help you; I will uphold you with my righteous right hand.",
  },
];

function isFaithEncouragementRequest(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  return (
    /\b(?:encourage|encouragement|bless|inspire)\b/i.test(t) &&
    /\b(?:me|us|today|please|po|lang|naman)\b/i.test(t)
  );
}

function isPersonalOrFaithTopic(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (isFaithEncouragementRequest(t)) return true;
  if (PERSONAL_FAITH_TOPIC_PATTERN.test(t)) return true;
  if (
    /\bwhat if\b/i.test(t) &&
    !OFFBEAT_OPERATIONAL_PATTERN.test(t) &&
    !BEANTOL_OPERATIONAL_PATTERN.test(t) &&
    !/\b(?:order|menu|price|delivery|pickup|offbeat|coffee|drink|bottle|promo)\b/i.test(t)
  ) {
    return true;
  }
  if (/\?\s*$/.test(t) && /\b(?:why|what|how|should|can)\b/i.test(t) && !OFFBEAT_OPERATIONAL_PATTERN.test(t) && !BEANTOL_OPERATIONAL_PATTERN.test(t)) {
    return /\b(?:feel|life|god|faith|pray|sad|depress|anxious|lonely|hope|peace|forgive|relationship|heart|mind|soul|change)\b/i.test(t);
  }
  return false;
}

function formatScriptureBlock(reference, verseText) {
  return `Scripture:\n${reference} — ${verseText}`;
}

function replyIncludesScriptureVerse(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (SCRIPTURE_BLOCK_PATTERN.test(t)) return true;
  return /\b(?:[1-3]\s+)?[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+\d{1,3}:\d{1,3}(?:-\d{1,3})?\s*[—–-]\s*\S/.test(t);
}

function pickFallbackVerse(userText, usedRefs = []) {
  const used = new Set(usedRefs.map((r) => r.replace(/\s+/g, " ").trim()));
  const t = String(userText || "");
  for (const entry of TOPIC_VERSE_FALLBACKS) {
    if (!entry.topics.test(t)) continue;
    if (!used.has(entry.ref)) return entry;
  }
  for (const entry of TOPIC_VERSE_FALLBACKS) {
    if (!used.has(entry.ref)) return entry;
  }
  return TOPIC_VERSE_FALLBACKS[TOPIC_VERSE_FALLBACKS.length - 1];
}

function ensureFaithReplyHasVerse(reply, userText, recipient, history = []) {
  const body = String(reply || "").trim();
  if (replyIncludesScriptureVerse(body)) return body;

  const usedRefs = extractUsedVerseReferences(history);
  const verse = pickFallbackVerse(userText, usedRefs);
  const name = recipient?.recipientName || "friend";
  const lead =
    body ||
    `${name}, I'm glad you reached out. Whatever you're carrying today, you don't face it alone — God sees you and cares for you.`;

  return `${lead.replace(/\s+$/, "")}\n\n${formatScriptureBlock(verse.ref, verse.text)}`;
}

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
  if (/\b(?:sad|lonely|tired|overwhelmed|discouraged|hopeless|depress|malungkot|lungkot)\b/.test(t) && history.length >= 2) {
    lines.push("Topic hint: heavy feelings — new gentle truth + fresh verse.");
  }
  lines.push(
    'MANDATORY: End with a "Scripture:" line, then reference + em dash + full verse text. Never omit the Scripture block.'
  );
  return lines.join("\n");
}

function fallbackEncouragementReply(recipient, userText = "") {
  const name = recipient?.recipientName || "friend";
  const verse = pickFallbackVerse(userText, []);
  if (recipient?.persona === "board_exam") {
    return (
      `${name}, I'm cheering you on!\n\n` +
      "Take a deep breath, say a short prayer, and tackle one topic at a time.\n\n" +
      formatScriptureBlock("Philippians 4:13", "I can do all things through Christ who strengthens me.")
    );
  }
  return (
    `Hi ${name}! I'm glad you reached out.\n\n` +
    "Whatever you're carrying today, you don't face it alone — God sees you and cares for you.\n\n" +
    formatScriptureBlock(verse.ref, verse.text)
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
      formatScriptureBlock(
        "Joshua 1:9",
        "Be strong and courageous; do not be afraid, for the Lord your God is with you."
      )
    );
  }

  const systemMessages = [{ role: "system", content: buildEncouragementSystemPrompt(recipient) }];
  if (languageInstruction) {
    systemMessages.push({ role: "system", content: languageInstruction });
  }
  if (isFirstWelcome) {
    const welcomeNote =
      recipient.persona === "board_exam"
        ? `FIRST MESSAGE: Welcome ${name} warmly, acknowledge board exam prep if natural, encourage with faith, and END with the mandatory Scripture block.`
        : `FIRST MESSAGE: Welcome ${name} warmly to ${recipient.brand}. Be faith-filled and END with the mandatory Scripture block.`;
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
    const rawReply = completion?.choices?.[0]?.message?.content?.trim();
    const reply = rawReply || fallbackEncouragementReply(recipient, userText);
    return ensureFaithReplyHasVerse(reply, userText, recipient, safeHistory);
  } catch (err) {
    console.error("Faith encouragement OpenAI error:", err.message);
    return ensureFaithReplyHasVerse(
      fallbackEncouragementReply(recipient, userText),
      userText,
      recipient,
      safeHistory
    );
  }
}

/**
 * Named faith profiles: default to faith mode for any non-business message.
 * Only explicit shop / order / menu / quote traffic uses the normal bot.
 */
function isFaithProfileBusinessMessage(userText, tenant, recipient, options = {}) {
  return shouldSkipFaithEncouragementForMessage(userText, tenant, recipient, options);
}

function shouldSkipCafeBusinessMessage(userText, tenant) {
  const tenantId = tenant?.id || "";
  if (tenantId !== "offbeat-brew" && tenantId !== "kape-kristiano") return false;
  if (!isCafeOrderFlowEnabled(tenant)) return false;
  const text = String(userText || "");
  if (tryHandleCafeMenuInquiry(text, tenant).handled) return true;
  if (isCafeHowToOrderEnabled(tenant) && isHowToOrderInquiry(text, tenant)) return true;
  if (parseCafeOrderFromText(text, tenant)?.length) return true;
  if (asksPaymentMode(text)) return true;
  if (OFFBEAT_OPERATIONAL_PATTERN.test(text)) return true;
  return false;
}

function shouldUseFaithEncouragement(tenant, recipient, userText, options = {}) {
  if (!isFaithEncouragementEnabled(tenant)) return false;

  // options.rosterRecipient is the actual named profile match (Chin, Reyna, etc.)
  // recipient may be a generic built recipient — do NOT use it as a roster signal.
  const rosterRecipient = options.rosterRecipient || null;

  // Faith-only tenants (e.g. Destiny): every message is a faith reply — no topic filter.
  if (isFaithOnlyTenant(tenant)) {
    const replyAs =
      rosterRecipient || recipient || buildGenericFaithRecipient(tenant, options.profileName);
    if (!replyAs) return false;
    return true;
  }

  // Named roster member (known profile, e.g. Chin): faith for any non-business message —
  // their persona is established and faith is their expected mode of interaction.
  if (rosterRecipient) {
    return !shouldSkipFaithEncouragementForMessage(userText, tenant, rosterRecipient, options);
  }

  // Open-to-all (general customers on business-primary tenants):
  // These bots are business-first. Faith only activates when the customer
  // clearly and explicitly steps into personal / faith territory.
  // Ambiguous messages, greetings, and vague requests go to the probe gate
  // (first-contact) or fall through to the normal business bot.
  if (isFaithEncouragementOpenToAll(tenant)) {
    if (!isPersonalOrFaithTopic(userText)) return false;
    const replyAs = recipient || buildGenericFaithRecipient(tenant, options.profileName);
    return !shouldSkipFaithEncouragementForMessage(userText, tenant, replyAs, options);
  }

  return false;
}

function shouldSkipFaithEncouragementForMessage(userText, tenant, recipient, options = {}) {
  if (!recipient) return false;

  const { senderId = "", allowDespiteActiveOrder = false } = options;
  const text = String(userText || "").trim();
  if (!text) return false;

  // Mid-order session — keep the order flow uninterrupted.
  // Idle sessions (customer stepped away 30+ min) let faith through; the reply
  // will append a gentle nudge to resume the pending order.
  // allowDespiteActiveOrder is set by server.js when the message is pure
  // personal/faith with no business keywords — faith fires + nudge appended.
  if (!allowDespiteActiveOrder) {
    if (isCafeOrderFlowRecentlyActive(senderId) || isPostQuoteFlowRecentlyActive(senderId)) return true;
  }

  const tenantId = tenant?.id || "";

  // Business keyword check runs BEFORE the personal-topic check.
  // If a message contains business intent (even mixed with personal content),
  // the business bot handles it — it has full history and can respond with empathy
  // while also answering the business question. Faith mode would ignore business Qs.
  if (tenantId === "beantol") {
    if (BEANTOL_OPERATIONAL_PATTERN.test(text)) return true;
    if (isEquipmentSalesInquiry(text)) return true;
    if (isRecommendationIntent(text)) return true;
  }
  if (shouldSkipCafeBusinessMessage(text, tenant)) return true;

  // No business keyword — pure personal / faith / neutral message → don't skip faith.
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

// ─── First-contact faith classification ──────────────────────────────────────

/**
 * Vague help/question requests that could be business OR personal — needs a probe.
 * Used for both first-contact and ongoing conversation.
 */
const AMBIGUOUS_HELP_PATTERN =
  /\b(?:i\s+need\s+(?:some\s+)?help(?:\s+(?:with\s+something|please|lang|po))?$|can\s+(?:you\s+)?help(?:\s+me(?:\s+(?:out|with\s+something))?)?|help\s+me(?:\s+(?:with\s+)?(?:something|a\s+(?:problem|question|concern)))?|need\s+(?:some\s+)?(?:advice|guidance|someone\s+to\s+(?:talk\s+to?|listen))|have\s+(?:a\s+)?(?:question|concern|something\s+to\s+(?:ask|share))|want\s+to\s+(?:ask|talk)(?:\s+(?:about\s+)?(?:something|anything|personal|life))?|may\s+(?:i\s+)?(?:ask\s+(?:something|you\s+something|a\s+question)?)|may\s+(?:tanong|itatanong|gusto|problema)\s*(?:ako|lang)?|meron\s+(?:akong\s+)?(?:tanong|gusto|problema)|pwede\s+(?:ba\s+)?(?:kita|kitang)\s+(?:tanungin|habulin)|need\s+to\s+talk|i\s+have\s+something\s+(?:to\s+(?:ask|say|share))|something\s+(?:personal|to\s+ask|on\s+my\s+mind)|ask\s+(?:you\s+)?(?:something|about\s+(?:life|something\s+personal)))\b/i;

/** @deprecated use AMBIGUOUS_HELP_PATTERN */
const FIRST_MSG_AMBIGUOUS_PATTERN = AMBIGUOUS_HELP_PATTERN;

/**
 * Returns true when a message is a vague help/question request that needs a probe
 * before committing to faith or business mode.
 */
function isAmbiguousHelpRequest(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  return AMBIGUOUS_HELP_PATTERN.test(t);
}

/**
 * Classify a customer's very first message to decide how to handle faith routing.
 * Business-primary tenants (Beantol, Offbeat, KK) should never assume faith intent —
 * always validate before committing to faith mode.
 *
 * Returns:
 *   "business" — let the normal business bot handle it (greeting, operational keyword,
 *                or anything ambiguous that doesn't clearly need faith)
 *   "probe"    — send a gentle "business or personal?" nudge before committing
 *   "faith"    — proceed with faith encouragement + brand intro (only when clearly personal)
 */
function classifyFirstFaithMessage(text, tenant) {
  const t = String(text || "").trim();
  if (!t) return "business";

  // Pure standalone greeting → normal business welcome flow
  if (BUSINESS_SIMPLE_GREETING.test(t)) return "business";

  // Clear business keyword → business bot
  if (tenant?.id === "beantol" && BEANTOL_OPERATIONAL_PATTERN.test(t)) return "business";
  if (shouldSkipCafeBusinessMessage(t, tenant)) return "business";

  // Vague help request → probe first ("business or personal?")
  if (FIRST_MSG_AMBIGUOUS_PATTERN.test(t)) return "probe";

  // Only commit to faith when the topic is clearly and explicitly personal/faith.
  // Anything else → normal business bot (business-primary tenants should never
  // assume faith intent for ambiguous or neutral messages).
  if (isPersonalOrFaithTopic(t)) return "faith";

  return "business";
}

/**
 * Short probe for ambiguous messages mid-conversation (not the first message).
 * No brand intro — just a quick clarifying question.
 */
function buildOngoingProbeReply(tenant, recipientName = "") {
  const name = String(recipientName || "").trim();
  const hi = name ? `${name}, ` : "";
  const productLabel =
    tenant?.id === "beantol"
      ? "something about our coffee or shop"
      : tenant?.id === "offbeat-brew"
        ? "something about our drinks or menu"
        : tenant?.id === "kape-kristiano"
          ? "something about our café"
          : "something about our products";
  return (
    `${hi}happy to help! Are you asking about ${productLabel}, ` +
    `or is there something personal on your mind?`
  );
}

/**
 * Probe reply for ambiguous first messages — gently asks whether the customer
 * needs business info or something personal, before committing to either mode.
 */
function buildFirstContactProbeReply(tenant, recipientName = "") {
  const brand = tenant?.branding?.businessName || tenant?.name || "this chat";
  const name = String(recipientName || "").trim();
  const hi = name ? `Hi ${name}!` : "Hi!";
  const productLabel =
    tenant?.id === "beantol"
      ? "coffee, beans, or anything about our shop"
      : tenant?.id === "offbeat-brew"
        ? "our drinks, menu, or anything about Offbeat"
        : tenant?.id === "kape-kristiano"
          ? "our menu or café"
          : "our products or services";
  return (
    `${hi} I'm ${brand}'s chat assistant.\n\n` +
    `What can I help you with today? Are you looking for info about ${productLabel}, ` +
    `or is there something else on your mind?`
  );
}

module.exports = {
  FAITH_PROFILE_ROSTER,
  FAITH_OPEN_TO_ALL_TENANTS,
  FAITH_ROSTER_TENANTS,
  isFaithOnlyTenant,
  isFaithEncouragementEnabled,
  isFaithEncouragementOpenToAll,
  buildGenericFaithRecipient,
  matchFaithEncouragementRecipient,
  matchFaithEncouragementRecipientAsync,
  rememberFaithProfileFromLead,
  isPersonalOrFaithTopic,
  isFaithEncouragementRequest,
  isFaithProfileBusinessMessage,
  shouldUseFaithEncouragement,
  shouldSkipFaithEncouragementForMessage,
  generateFaithEncouragementReply,
  buildEncouragementSystemPrompt,
  ensureFaithReplyHasVerse,
  replyIncludesScriptureVerse,
  isAmbiguousHelpRequest,
  classifyFirstFaithMessage,
  buildFirstContactProbeReply,
  buildOngoingProbeReply,
  isChinEncouragementEnabled,
  isChinSiaoCustomer,
  resolveChinEncouragementRecipientName,
  buildChinEncouragementSystemPrompt: buildEncouragementSystemPrompt,
  generateChinEncouragementReply,
};
