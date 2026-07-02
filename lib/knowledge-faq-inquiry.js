const fs = require("fs");
const rag = require("./rag");

const WHO_IS_PREFIX =
  "(?:who\\s+is|who'?s|who\\s+are|sino\\s+si|sino\\s+ang|kinsa\\s+si|kinsa\\s+ang|kinsa\\s+na\\s+si|tell\\s+me\\s+about)";

const WHO_IS_INQUIRY = new RegExp(`\\b${WHO_IS_PREFIX}\\s+[a-z0-9]`, "i");
const WHO_IS_NAME = new RegExp(`\\b${WHO_IS_PREFIX}\\s+(.+?)\\??\\s*$`, "i");
const NAME_LIST_SPLIT = /\s*,\s*|\s+(?:and|og|ug)\s+/i;

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "can", "could", "will", "would", "should", "may", "might",
  "you", "your", "yours", "we", "our", "they", "their", "it", "its", "this", "that",
  "what", "how", "where", "when", "why", "who", "which", "whom",
  "in", "on", "at", "to", "for", "of", "with", "from", "by", "about", "as",
  "and", "or", "but", "if", "then", "so", "not", "no", "yes", "please",
  "si", "ang", "sa", "ng", "na", "ba", "po", "ko", "mo", "nimo", "nako", "ka",
  "ni", "kay", "ug", "og", "lang", "ra", "pa", "man", "kaha", "kah", "ba",
  "ano", "uns", "unsa", "kinsa", "sino", "asa", "saan", "kanus", "kanus-a",
  "pila", "magkano", "paano", "pwede", "puede", "kaila", "kilala", "gusto",
  "tell", "me", "know", "have", "there", "any", "available",
]);

const QUERY_REWRITES = [
  [/\bkinsa\s+si\s+/gi, "who is "],
  [/\bsino\s+si\s+/gi, "who is "],
  [/\bkaila\s+ka\s+ni\s+/gi, "who is "],
  [/\bkaila\s+nimo\s+si\s+/gi, "who is "],
  [/\bkilala\s+mo\s+si\s+/gi, "who is "],
  [/\bkilala\s+mo\s+ba\s+si\s+/gi, "who is "],
  [/\bdo\s+you\s+know\s+/gi, "who is "],
  [/\buns(?:a|\s+man)\s+/gi, "what "],
  [/\bunsa\s+/gi, "what "],
  [/\bano(?:\s+ang|\s+ba)?\s+/gi, "what "],
  [/\bpaano\s+/gi, "how "],
  [/\bhow\s+do\s+i\s+/gi, "how "],
  [/\bhow\s+can\s+i\s+/gi, "how "],
  [/\bpwede\s+ba\s+/gi, "can "],
  [/\bpuede\s+ba\s+/gi, "can "],
  [/\basa\s+/gi, "where "],
  [/\bsaan\s+/gi, "where "],
  [/\bpila\s+/gi, "how much "],
  [/\bmagkano\s+/gi, "how much "],
];

const MIN_MATCH_SCORE = 3;

const BEAN_FAQ_HINT =
  /\b(?:beans?|roasted|take-home|retail bag|beantol roastery|sell coffee beans|order roasted)\b/i;

const HOW_TO_ORDER_QUERY =
  /\b(?:how\s+(?:can\s+)?i\s+order|how\s+(?:do|to)\s+order|how\s+to\s+place|like\s+to\s+order|want\s+to\s+order|gusto\s+(?:ko\s+)?mag\s*order|paano\s+(?:mag)?order)\b/i;

const PRODUCT_IDENTITY_QUESTION =
  /\bwhat(?:'s|\s+is)\s+(?:this|that|it)\b/i;

const MENU_PRODUCT_HINT =
  /\b(?:offbeat|unplugged|latte|cappuccino|americano|mocha|dulce|choco|matcha|strawberry|spanish|himalayan|tablea|pour-over|empanada|ensaymada|carbonara|siomai|sisig|humba|ramyun|fries|fizzy|cloud|brew)\b/i;

function normalizeForMatch(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[''']/g, "'")
    .replace(/[^\p{L}\p{N}\s'?-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function significantTokens(text) {
  const tokens = new Set();
  for (const word of normalizeForMatch(text).split(/\s+/)) {
    const w = word.replace(/^['"]|['"]$/g, "");
    if (!w || w.length < 2) continue;
    if (STOP_WORDS.has(w)) continue;
    tokens.add(w);
  }
  return tokens;
}

function rewriteQueryForMatch(raw) {
  let text = normalizeForMatch(raw);

  const crushMatch = text.match(
    /(?:kinsa ang|who is|sino ang)\s+(?:gusto|crush|type|likes|like)\s+(?:ni|sa|of)\s+(.+)/i
  ) || text.match(/(?:gusto|crush|likes)\s+(?:ni|of)\s+(.+)/i);
  if (crushMatch) {
    const subject = crushMatch[1].trim().replace(/[?.!]+$/, "");
    return { mode: "terms", terms: ["crush", subject] };
  }

  for (const [pattern, replacement] of QUERY_REWRITES) {
    text = text.replace(pattern, replacement);
  }
  text = text.replace(/[?.!]+$/, "").trim();
  return { mode: "text", text };
}

function looksLikeSectionHeaderLine(line) {
  const t = String(line || "").trim();
  if (!t || t.length < 3 || t.length > 55) return false;
  if (/[.,;:!?]/.test(t)) return false;
  if (t.split(/\s+/).length > 5) return false;
  if (/^[•\-*\d]/.test(t)) return false;
  return /^[A-Z][A-Za-z0-9 &,/-]*$/.test(t);
}

function extractAnswerBody(rawAnswer) {
  let answer = String(rawAnswer || "").trim();
  const nextQ = answer.search(/\sQ:\s/i);
  if (nextQ >= 0) answer = answer.slice(0, nextQ).trim();

  const lines = answer.split("\n");
  const kept = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) break;
    if (/^[•\-*]/.test(t)) break;
    if (/^Q:\s/i.test(t)) break;
    if (looksLikeSectionHeaderLine(t)) break;
    kept.push(t);
  }
  return kept.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Parse all Q: / A: pairs from synced Google Doc plain text.
 */
function parseAllFaqs(text) {
  const faqs = [];
  const body = String(text || "");
  if (!body) return faqs;

  const parts = body.split(/\s(?=Q:\s)/i);
  for (const part of parts) {
    const m =
      part.match(/^Q:\s*(.+?)\?\s*A:\s*(.+)/is) ||
      part.match(/^Q:\s*(.+?)\n\s*A:\s*(.+)/is);
    if (!m) continue;

    const questionBlock = m[1].trim();
    const answer = extractAnswerBody(m[2]);
    if (!questionBlock || !answer) continue;

    const questions = questionBlock
      .split(/\s*\/\s*|\s*\|\s*/)
      .map((q) => q.trim().replace(/\?$/, ""))
      .filter(Boolean);

    for (const question of questions) {
      faqs.push({
        question,
        answer,
        tokens: significantTokens(question),
        normalized: normalizeForMatch(question),
      });
    }
  }
  return faqs;
}

function loadAllFaqs(tenant) {
  const faqs = [];
  for (const filePath of rag.listSourceFiles(tenant)) {
    faqs.push(...parseAllFaqs(fs.readFileSync(filePath, "utf8")));
  }
  return faqs;
}

function scoreFaqMatch(userText, faq) {
  const rewritten = rewriteQueryForMatch(userText);
  const qNorm = faq.normalized;

  if (rewritten.mode === "terms") {
    let score = 0;
    for (const term of rewritten.terms) {
      const t = normalizeForMatch(term);
      if (!t) continue;
      if (qNorm.includes(t)) score += 4;
      for (const token of significantTokens(t)) {
        if (faq.tokens.has(token)) score += 2;
      }
    }
    return score;
  }

  const userTokens = significantTokens(rewritten.text);
  let score = 0;
  for (const token of userTokens) {
    if (faq.tokens.has(token)) score += 3;
  }

  const uText = rewritten.text;
  if (uText.length >= 4 && (qNorm.includes(uText) || uText.includes(qNorm))) {
    score += 5;
  }

  if (userTokens.size >= 2) {
    let overlap = 0;
    for (const token of userTokens) {
      if (faq.tokens.has(token)) overlap += 1;
    }
    if (overlap >= Math.min(2, userTokens.size)) score += 1;
  }

  return score;
}

// Detects availability-type queries ("what beans do you have / what's available?")
// in any language. Used to penalise irrelevant FAQs (cupping, origins) that share
// the token "beans" with the query but are answering a completely different question.
const AVAILABILITY_QUERY =
  /\b(?:naa|available|availability|in\s+stock|stock|meron|mayroon|unsay\s+naa|what(?:'s|\s+is|\s+are)?\s+(?:there|available|in\s+stock)|what\s+(?:beans?|coffee)?\s*(?:do\s+you|have|have\s+you)|wala\s+(?:nga\s+)?beans?|what(?:'s|\s+is|\s+are)?\s+not\s+(?:there|available))\b/i;

// Detects cupping-session FAQs so we can penalise them for non-cupping queries.
const CUPPING_FAQ_HINT = /\bcupping\b/i;

// Detects bean-origin FAQs ("where do beans come from / origin / gikan")
// so we can penalise them for availability queries.
const ORIGIN_FAQ_HINT =
  /\b(?:come\s+from|origin|source\s+country|gikan|where.*bean|sourced\s+from|import(?:ed)?\s+from)\b/i;

function adjustFaqScore(userText, faq, baseScore) {
  if (baseScore < MIN_MATCH_SCORE) return baseScore;
  let score = baseScore;
  const uNorm = normalizeForMatch(userText);
  const qNorm = faq.normalized;
  const userMentionsBeans = BEAN_FAQ_HINT.test(uNorm);

  if (HOW_TO_ORDER_QUERY.test(uNorm)) {
    if (/\bhow\s+(?:can\s+)?i\s+order\b/.test(qNorm) || /\bhow to order\b/.test(qNorm)) {
      score += 10;
    }
    if (BEAN_FAQ_HINT.test(qNorm) && !userMentionsBeans) {
      score -= 12;
    }
    if (MENU_PRODUCT_HINT.test(uNorm)) {
      score -= 8;
    }
  }

  if (BEAN_FAQ_HINT.test(qNorm) && !userMentionsBeans) {
    score -= 6;
  }

  if (PRODUCT_IDENTITY_QUESTION.test(uNorm) && /\bdifference between\b/.test(qNorm)) {
    score -= 15;
  }

  // Heavy penalties: cupping and origin FAQs should never match availability queries.
  // A customer asking "what beans do you have?" / "Unsay Naa nga beans?" shares only
  // the token "beans" with these FAQs — just enough to hit MIN_MATCH_SCORE. Without
  // penalties they are returned verbatim instead of the AI answering from inventory.
  if (AVAILABILITY_QUERY.test(uNorm)) {
    if (CUPPING_FAQ_HINT.test(qNorm)) score -= 10; // cupping ≠ availability
    if (ORIGIN_FAQ_HINT.test(qNorm)) score -= 10;  // origin ≠ availability
  }
  if (CUPPING_FAQ_HINT.test(qNorm) && !CUPPING_FAQ_HINT.test(uNorm)) {
    score -= 10; // don't surface cupping unless user asked about cupping
  }
  if (ORIGIN_FAQ_HINT.test(qNorm) && !ORIGIN_FAQ_HINT.test(uNorm) && AVAILABILITY_QUERY.test(uNorm)) {
    score -= 10; // don't surface origin info for availability queries
  }

  return score;
}

function preferFaqOnTie(userText, candidate, incumbent) {
  const uNorm = normalizeForMatch(userText);
  const userMentionsBeans = BEAN_FAQ_HINT.test(uNorm);
  const candHow = /^how\b/.test(candidate.normalized);
  const incHow = /^how\b/.test(incumbent.normalized);
  if (candHow && !incHow) return true;
  if (incHow && !candHow) return false;

  const candBeans = BEAN_FAQ_HINT.test(candidate.normalized);
  const incBeans = BEAN_FAQ_HINT.test(incumbent.normalized);
  if (!userMentionsBeans) {
    if (!candBeans && incBeans) return true;
    if (candBeans && !incBeans) return false;
  }

  if (candidate.tokens.size > incumbent.tokens.size) return true;
  return false;
}

function findBestFaqMatch(faqs, userText) {
  let best = null;
  let bestScore = 0;
  for (const faq of faqs) {
    const score = adjustFaqScore(userText, faq, scoreFaqMatch(userText, faq));
    if (score > bestScore) {
      bestScore = score;
      best = faq;
    } else if (score === bestScore && score >= MIN_MATCH_SCORE && best && preferFaqOnTie(userText, faq, best)) {
      best = faq;
    }
  }
  if (!best || bestScore < MIN_MATCH_SCORE) return null;
  return { faq: best, score: bestScore };
}

function extractPersonNameFromQuery(text) {
  const m = String(text || "")
    .trim()
    .match(WHO_IS_NAME);
  if (!m) return null;
  return m[1].trim().replace(/[?.!]+$/, "");
}

function extractPersonNamesFromQuery(text) {
  const phrase = extractPersonNameFromQuery(text);
  if (!phrase) return [];

  const names = [];
  for (const part of phrase.split(NAME_LIST_SPLIT)) {
    const trimmed = part.trim().replace(/[?.!]+$/, "");
    if (!trimmed) continue;

    if (/\bcrush\b|\bgusto\b/i.test(trimmed)) {
      names.push(trimmed);
      continue;
    }

    const words = trimmed.split(/\s+/).filter(Boolean);
    if (
      words.length === 2 &&
      /^[A-Za-z]/.test(words[0]) &&
      /^[A-Za-z]/.test(words[1]) &&
      words[0].length >= 2 &&
      words[1].length >= 2
    ) {
      names.push(words[0], words[1]);
    } else {
      names.push(trimmed);
    }
  }
  return names;
}

function lookupWhoIsAnswers(faqs, personName) {
  const raw = String(personName || "").trim().toLowerCase();
  if (!raw) return null;

  const first = raw.split(/\s+/)[0];
  let best = null;
  let bestScore = 0;

  for (const faq of faqs) {
    const q = faq.normalized;
    if (!/\bwho is\b/.test(q) && !q.startsWith("who is ")) continue;

    let score = 0;
    if (q.includes(`who is ${raw}`)) score += 10;
    else if (q.includes(`who is ${first}`)) score += 8;
    else if (q.includes(raw) || q.includes(first)) score += 4;

    for (const token of significantTokens(raw)) {
      if (faq.tokens.has(token)) score += 2;
    }

    if (score > bestScore) {
      bestScore = score;
      best = faq;
    }
  }

  return bestScore >= MIN_MATCH_SCORE ? best?.answer || null : null;
}

function tryMultiWhoIsReply(faqs, userText) {
  if (/\b(?:crush|gusto)\b/i.test(userText)) return null;

  const names = extractPersonNamesFromQuery(userText);
  if (!names.length) return null;

  const lines = [];
  for (const personName of names) {
    const answer = lookupWhoIsAnswers(faqs, personName);
    if (!answer) continue;
    const displayName = personName
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
    lines.push(`${displayName}? ${answer}`);
  }
  return lines.length ? lines.join("\n\n") : null;
}

/** Customer asking a FAQ-style question answerable from Q: / A: in the knowledge doc. */
function isKnowledgeFaqInquiry(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 280) return false;

  if (/^(?:hi|hello|hey|thanks|thank you|salamat|ok|okay|sige|good morning|good evening)\s*[!?.]*$/i.test(t)) {
    return false;
  }

  if (
    /\b(?:order|deliver|padala|hatod)\b/i.test(t) &&
    /\b\d+\s*(?:pcs|pc|bottles|bottle|kg|g|gram)\b/i.test(t)
  ) {
    return false;
  }

  if (WHO_IS_INQUIRY.test(t)) return true;
  if (/\?/.test(t)) return true;

  return /\b(what|how|where|when|why|which|can you|do you|are you|is there|tell me|uns|unsa|pila|asa|kanus|kinsa|sino|ano|paano|pwede|puede|kaila|kilala|gusto|crush)\b/i.test(
    t
  );
}

function buildKnowledgeFaqReply(tenant, userText) {
  const faqs = loadAllFaqs(tenant);
  if (!faqs.length) return null;

  const multiWho = tryMultiWhoIsReply(faqs, userText);
  if (multiWho) return multiWho;

  const match = findBestFaqMatch(faqs, userText);
  if (!match) return null;

  return match.faq.answer;
}

/** @deprecated use isKnowledgeFaqInquiry */
function isWhoIsFaqInquiry(text) {
  return isKnowledgeFaqInquiry(text) && WHO_IS_INQUIRY.test(String(text || "").trim());
}

/** @deprecated use buildKnowledgeFaqReply */
function buildWhoIsFaqReply(tenant, userText) {
  return buildKnowledgeFaqReply(tenant, userText);
}

/** @deprecated use parseAllFaqs */
function parseWhoIsFaqs(text) {
  const map = new Map();
  for (const faq of parseAllFaqs(text)) {
    if (!/\bwho is\b/i.test(faq.question)) continue;
    const name = faq.question.replace(/^who is\s+/i, "").trim().toLowerCase();
    if (name && !map.has(name)) map.set(name, faq.answer);
  }
  return map;
}

module.exports = {
  isKnowledgeFaqInquiry,
  buildKnowledgeFaqReply,
  parseAllFaqs,
  rewriteQueryForMatch,
  scoreFaqMatch,
  isWhoIsFaqInquiry,
  buildWhoIsFaqReply,
  parseWhoIsFaqs,
  extractPersonNameFromQuery,
  extractPersonNamesFromQuery,
};
