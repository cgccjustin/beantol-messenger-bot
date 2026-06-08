const { CATALOG_PRODUCTS } = require("./catalog");
const { buildLineItem, formatPeso } = require("./pricing");
const { wantsToSkipWizardForOrderOrProduct } = require("./wizard-exit");
const { scopeKey } = require("./tenant-context");

const SESSION_TTL_MS = Number(process.env.RECOMMEND_SESSION_HOURS || 24) * 60 * 60 * 1000;

/** @type {Map<string, { step: string, brew?: string, taste?: string, updatedAt: number }>} */
const sessions = new Map();

const RECOMMEND_INTENT =
  /\b(?:recommend|suggest|help me choose|what should i (?:get|buy)|best for|which (?:bean|coffee)|unsay maayo|unsa ang maayo|help me pick)\b/i;

function isRecommendationIntent(text) {
  return RECOMMEND_INTENT.test(String(text || "").trim());
}

function getSession(senderId) {
  const s = sessions.get(scopeKey(senderId));
  if (!s) return null;
  if (Date.now() - s.updatedAt > SESSION_TTL_MS) {
    sessions.delete(scopeKey(senderId));
    return null;
  }
  return s;
}

function startSession(senderId) {
  const session = { step: "brew", updatedAt: Date.now() };
  sessions.set(scopeKey(senderId), session);
  return session;
}

function clearSession(senderId) {
  sessions.delete(scopeKey(senderId));
}

function parseBrewChoice(text) {
  const t = String(text || "").toLowerCase();
  if (/^[1a]|espresso|machine|latte|cappuccino/i.test(t)) return "espresso";
  if (/^[2b]|pour|filter|v60|chemex|drip|manual/i.test(t)) return "filter";
  if (/^[3c]|not sure|unsure|idk|both/i.test(t)) return "unsure";
  return null;
}

function parseTasteChoice(text) {
  const t = String(text || "").toLowerCase();
  if (/^[1a]|balanced|both|prime|chocolate.*fruit|fruit.*chocolate/i.test(t)) return "balanced";
  if (/^[2b]|chocolate|nutty|cerrado|santos|deep/i.test(t)) return "chocolate";
  if (/^[3c]|fruity|floral|bright|sidama|ethiopia/i.test(t)) return "fruity";
  return null;
}

function formatPriceLine(productId, size = "250g") {
  const product = CATALOG_PRODUCTS.find((p) => p.id === productId);
  if (!product) return "";
  const line = buildLineItem(product, size, 1);
  return line ? `• ${line.display}` : "";
}

function buildPicks(session) {
  const picks = [];
  const brew = session.brew || "unsure";
  const taste = session.taste || "balanced";

  if (brew === "filter" || brew === "unsure") {
    picks.push({
      id: "mt-apo",
      why: "Local Philippine coffee — smooth and approachable for pour-over.",
    });
    picks.push({
      id: "guji-filter",
      why: "Ethiopian filter roast — bright and fruity for V60 or Chemex.",
    });
  }

  if (brew === "espresso" || brew === "unsure") {
    if (taste === "chocolate") {
      picks.push({
        id: "brazil-cerrado",
        why: "Single-origin espresso — deeper chocolate and hazelnut notes.",
      });
    } else if (taste === "fruity") {
      picks.push({
        id: "ethiopia-sidama",
        why: "Bright, fruity espresso — great for milk drinks with character.",
      });
    } else {
      picks.push({
        id: "beantol-prime",
        why: "Flagship blend — balanced chocolate and fruit; many clients' daily espresso.",
      });
      if (brew === "espresso") {
        picks.push({
          id: "brazil-cerrado",
          why: "Alternative — deeper chocolate single origin if you prefer less blend.",
        });
      }
    }
  }

  const seen = new Set();
  return picks.filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  }).slice(0, 2);
}

function formatRecommendationReply(session) {
  const picks = buildPicks(session);
  const lines = [
    "Based on what you shared, here are my top picks:",
    "",
  ];

  for (const pick of picks) {
    const product = CATALOG_PRODUCTS.find((p) => p.id === pick.id);
    if (!product) continue;
    lines.push(`• ${product.label} — ${pick.why}`);
    const price250 = formatPriceLine(pick.id, "250g");
    const price500 = formatLineItemExists(pick.id, "500g")
      ? formatPriceLine(pick.id, "500g")
      : "";
    if (price250) lines.push(`  ${price250}`);
    if (price500) lines.push(`  ${price500}`);
    lines.push("");
  }

  lines.push(
    "Would you like 250g to try, or 500g / 1kg for daily drinking? Pickup at the shop or Maxim delivery?"
  );
  return lines.join("\n");
}

function formatLineItemExists(productId, size) {
  const product = CATALOG_PRODUCTS.find((p) => p.id === productId);
  return Boolean(product && buildLineItem(product, size, 1));
}

const BREW_QUESTION = `I'd love to help you pick the right bean. How do you usually brew?

• Reply 1 — Espresso machine (lattes, cappuccinos)
• Reply 2 — Pour-over / filter (V60, Chemex, drip)
• Reply 3 — Not sure yet`;

const TASTE_QUESTION = `Great — for espresso, what taste do you lean toward?

• Reply 1 — Balanced chocolate + fruit (our Prime blend)
• Reply 2 — Deeper chocolate & nutty (single origin)
• Reply 3 — Bright & fruity (Ethiopia)`;

/**
 * Process recommendation wizard. Returns { handled, reply } when bot should send wizard/result directly.
 */
function processRecommendationFlow(senderId, userText) {
  const text = String(userText || "").trim();
  let session = getSession(senderId);

  if (!session && isRecommendationIntent(text)) {
    session = startSession(senderId);
    return { handled: true, reply: BREW_QUESTION, interest: "recommendation started" };
  }

  if (!session) return { handled: false };

  if (wantsToSkipWizardForOrderOrProduct(text)) {
    clearSession(senderId);
    return { handled: false };
  }

  session.updatedAt = Date.now();

  if (session.step === "brew") {
    const brew = parseBrewChoice(text);
    if (!brew) {
      return {
        handled: true,
        reply: `Please reply 1, 2, or 3 (espresso, filter, or not sure).\n\n${BREW_QUESTION}`,
      };
    }
    session.brew = brew;
    if (brew === "filter") {
      session.step = "done";
      const reply = formatRecommendationReply(session);
      clearSession(senderId);
      return { handled: true, reply, interest: "filter recommendation" };
    }
    session.step = "taste";
    return { handled: true, reply: TASTE_QUESTION };
  }

  if (session.step === "taste") {
    const taste = parseTasteChoice(text);
    if (!taste) {
      return {
        handled: true,
        reply: `Please reply 1, 2, or 3.\n\n${TASTE_QUESTION}`,
      };
    }
    session.taste = taste;
    session.step = "done";
    const reply = formatRecommendationReply(session);
    clearSession(senderId);
    return { handled: true, reply, interest: `espresso ${taste} recommendation` };
  }

  return { handled: false };
}

function buildRecommendationSystemNote() {
  return (
    "PRODUCT RECOMMENDER: Customer may reply 1/2/3 to a bean picker flow. " +
    "If they skipped the wizard to name a bean or order, help them directly — do not send them back to 1/2/3. " +
    "If they completed the wizard, reinforce the picks given — do not contradict. " +
    "If they ask for recommendations anew, you may start fresh consultative selling per SALES ASSISTANT rules."
  );
}

module.exports = {
  isRecommendationIntent,
  processRecommendationFlow,
  buildRecommendationSystemNote,
  clearSession,
};
