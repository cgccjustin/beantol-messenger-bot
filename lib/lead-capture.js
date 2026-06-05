const BEAN_INTERESTS = [
  { pattern: /\bbeantol prime\b|\bprime\b/i, label: "Beantol Prime" },
  { pattern: /\bbrazil santos\b|\bsantos\b/i, label: "Brazil Santos" },
  { pattern: /\bbrazil cerrado\b|\bcerrado\b/i, label: "Brazil Cerrado" },
  { pattern: /\bethiopia guji\b|\bguji\b/i, label: "Guji" },
  { pattern: /\bethiopia sidama\b|\bsidama\b/i, label: "Ethiopia Sidama" },
  { pattern: /\bmt\.?\s*apo\b|\bmount apo\b/i, label: "Mt. Apo" },
  { pattern: /\bellaga\b|\bdione ellaga\b/i, label: "Mt. Apo (Ellaga)" },
  { pattern: /\bkenya\b/i, label: "Kenya" },
];

const STAGE_RANK = {
  browsing: 1,
  quoted: 2,
  ordering: 3,
  wholesale: 4,
  delivery: 5,
  handoff: 6,
};

const SKIP_MESSAGES =
  /^(hi|hello|hey|good morning|good afternoon|good evening|thanks|thank you|salamat|ok|okay|po|yes|oo|no)$/i;

function extractPhone(text) {
  const t = String(text || "");
  const match =
    t.match(/\b(?:09\d{9}|\+?63[\s-]?9\d{9})\b/) ||
    t.match(/\b\d{3}[-.\s]?\d{3,4}[-.\s]?\d{4}\b/);
  return match ? match[0].replace(/\s+/g, "") : "";
}

function extractInterest(text, historyTexts = []) {
  const combined = [text, ...historyTexts].filter(Boolean).join(" ");
  const beans = [];
  for (const entry of BEAN_INTERESTS) {
    if (entry.pattern.test(combined) && !beans.includes(entry.label)) {
      beans.push(entry.label);
    }
  }

  const sizeMatch = combined.match(/\b(250g|500g|1kg|6\s*kg)\b/i);
  const size = sizeMatch ? sizeMatch[0].replace(/\s+/g, "") : "";

  if (!beans.length && !size) return "";
  if (beans.length && size) return `${beans.slice(0, 2).join(", ")} ${size}`;
  if (beans.length) return beans.slice(0, 2).join(", ");
  return size;
}

function mergeStage(existing, incoming) {
  if (!existing) return incoming || "";
  if (!incoming) return existing;
  const existingRank = STAGE_RANK[existing] || 0;
  const incomingRank = STAGE_RANK[incoming] || 0;
  return incomingRank >= existingRank ? incoming : existing;
}

function analyzeLeadSignal(userText, options = {}) {
  const t = String(userText || "").trim();
  if (!t || t.length < 2 || SKIP_MESSAGES.test(t)) return null;

  const {
    isHandoff = false,
    isDeliveryInquiry = false,
    isDeliveryDetails = false,
    deliveryTrigger = null,
    historyTexts = [],
  } = options;

  const phone = extractPhone(t);
  const interest = extractInterest(t, historyTexts);

  if (isHandoff) {
    return {
      stage: "handoff",
      trigger: "handoff request",
      phone,
      interest,
    };
  }

  if (isDeliveryDetails) {
    return {
      stage: "delivery",
      trigger: "delivery details submitted",
      phone,
      interest,
    };
  }

  if (deliveryTrigger || isDeliveryInquiry) {
    return {
      stage: "delivery",
      trigger: deliveryTrigger || "delivery inquiry",
      phone,
      interest,
    };
  }

  if (
    /\b(?:wholesale|bulk|6\s*kg|café|cafe|coffee shop|coffee shop supply|reseller|distributor|supply for)\b/i.test(
      t
    )
  ) {
    return {
      stage: "wholesale",
      trigger: "wholesale or bulk inquiry",
      phone,
      interest,
    };
  }

  if (
    /\b(?:order|buy|purchase|checkout|mag order|gusto ko order|place order|i want to get|kuha ko)\b/i.test(
      t
    )
  ) {
    return {
      stage: "ordering",
      trigger: "order intent",
      phone,
      interest,
    };
  }

  if (
    /\b(?:price|prices|how much|tagpila|hm|magkano|cost|presyo)\b/i.test(t) ||
    interest
  ) {
    return {
      stage: "quoted",
      trigger: interest ? "product or price inquiry" : "price inquiry",
      phone,
      interest,
    };
  }

  if (
    /\b(?:recommend|suggest|what should i|best for|help me choose|unsay maayo|unsa ang maayo)\b/i.test(
      t
    )
  ) {
    return {
      stage: "browsing",
      trigger: "recommendation request",
      phone,
      interest,
    };
  }

  return null;
}

module.exports = {
  analyzeLeadSignal,
  extractPhone,
  extractInterest,
  mergeStage,
  STAGE_RANK,
};
