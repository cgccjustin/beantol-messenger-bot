/**
 * Beantol-only encouragement mode for Chin Siao (board exam review).
 * Activated by Messenger profile name match or CHIN_SIAO_SENDER_IDS.
 */

const { requestChatCompletion } = require("./openai-chat");

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 45000);

function isChinEncouragementEnabled(tenant) {
  if (process.env.CHIN_ENCOURAGEMENT_ENABLED === "false") return false;
  if (tenant?.features?.chinEncouragement === false) return false;
  return tenant?.id === "beantol";
}

function normalizePersonName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Messenger profile names that activate encouragement mode (Beantol only). */
const ENCOURAGEMENT_PROFILE_NAMES = new Set(["chin siao", "justin siao"]);

function isChinSiaoCustomer(profileName, senderId) {
  const idList = (process.env.CHIN_SIAO_SENDER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (senderId && idList.includes(String(senderId))) return true;

  const extraNames = (process.env.CHIN_ENCOURAGEMENT_PROFILE_NAMES || "")
    .split(",")
    .map((s) => normalizePersonName(s))
    .filter(Boolean);
  for (const entry of extraNames) {
    ENCOURAGEMENT_PROFILE_NAMES.add(entry);
  }

  const n = normalizePersonName(profileName);
  if (!n) return false;
  if (ENCOURAGEMENT_PROFILE_NAMES.has(n)) return true;
  if (/\bsiao\b/.test(n) && (/\bchin\b/.test(n) || /\bjustin\b/.test(n))) return true;
  return false;
}

/** Reply persona — Justin tests as Chin before she uses the bot. */
function resolveChinEncouragementRecipientName(profileName) {
  return "Chin";
}

function buildChinEncouragementSystemPrompt(profileName) {
  const name = String(profileName || "Chin").trim() || "Chin";
  return (
    `CHIN ENCOURAGEMENT MODE (Beantol Messenger — strict)\n\n` +
    `You are replying to ${name}, who uses Beantol Coffee Roasters' chat while reviewing for a board exam. ` +
    `She may ask about exams, fear, boredom, study tips, faith, life, or even coffee — anything goes.\n\n` +
    `TONE & CONTENT (every reply):\n` +
    `- Warm, genuinely encouraging, like a supportive Christian ate/kuya. Address her as Chin when natural.\n` +
    `- ALWAYS include at least one Bible verse: real Scripture only (Christian Bible / Protestant canon). ` +
    `Give the reference (e.g. Isaiah 41:10) AND the verse text. Never invent or misquote verses.\n` +
    `- Pick verses that fit her message (peace for anxiety, strength for tiredness, wisdom for study, ` +
    `hope when she doubts she can pass, joy when bored, etc.).\n` +
    `- Offer brief practical encouragement where helpful (study breaks, prayer, resting in God, one step at a time).\n\n` +
    `FAITH BOUNDARIES (strict):\n` +
    `- Biblical Christian encouragement only. No horoscopes, astrology, luck, charms, superstition, ` +
    `"manifestation", Law of Attraction, universe energy, New Age, or non-Christian/pagan spirituality.\n` +
    `- You may mention prayer, trust in God, God's peace, perseverance, and wise study as stewardship.\n\n` +
    `COFFEE / BEANTOL:\n` +
    `- If she asks about Beantol coffee, beans, or orders, answer briefly and helpfully as Beantol's assistant — ` +
    `but still include encouragement and a verse. Do not hard-sell.\n\n` +
    `FORMAT:\n` +
    `- Messenger-friendly plain text. Short paragraphs. No markdown headers or **bold**.\n` +
    `- Match her language (English, Tagalog, or Cebuano) when she uses it; verses may stay in English or a familiar translation.\n` +
    `- 2–6 short paragraphs max unless she asks for multiple verses.`
  );
}

function fallbackChinReply() {
  return (
    "Chin, I'm cheering you on!\n\n" +
    "Philippians 4:13 — I can do all things through Christ who strengthens me.\n\n" +
    "Take a deep breath, say a short prayer, and tackle one topic at a time. You've got this with God's help."
  );
}

async function generateChinEncouragementReply(userText, options = {}) {
  const {
    profileName = "Chin",
    history = [],
    sanitizeHistory = (h) => h,
    languageInstruction = "",
    isFirstWelcome = false,
  } = options;

  if (!OPENAI_API_KEY) {
    return (
      "Hi Chin! Encouragement chat isn't connected yet — please try again later.\n\n" +
      "Joshua 1:9 — Be strong and courageous; do not be afraid, for the Lord your God is with you."
    );
  }

  const systemMessages = [
    { role: "system", content: buildChinEncouragementSystemPrompt(profileName) },
  ];
  if (languageInstruction) {
    systemMessages.push({ role: "system", content: languageInstruction });
  }
  if (isFirstWelcome) {
    systemMessages.push({
      role: "system",
      content:
        "FIRST MESSAGE: Welcome Chin warmly to the chat, acknowledge her board exam prep if natural, " +
        "and include an encouraging Bible verse for the journey ahead.",
    });
  }

  const safeHistory = sanitizeHistory(history).slice(-12);
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
    });
    const reply = completion?.choices?.[0]?.message?.content?.trim();
    return reply || fallbackChinReply();
  } catch (err) {
    console.error("Chin encouragement OpenAI error:", err.message);
    return fallbackChinReply();
  }
}

module.exports = {
  isChinEncouragementEnabled,
  isChinSiaoCustomer,
  resolveChinEncouragementRecipientName,
  buildChinEncouragementSystemPrompt,
  generateChinEncouragementReply,
};
