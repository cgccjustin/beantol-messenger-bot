const { isCustomerOwnLogisticsIntent } = require("./cebu-area-delivery");

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
  appointment: 2,
  quoted: 3,
  ordering: 4,
  wholesale: 5,
  delivery: 6,
  handoff: 7,
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

  const sizeMatch = combined.match(/\b(250g|500g|1kg|\d+(?:\.\d+)?\s*kg)\b/i);
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

function parseBeanAndSize(interest, text, historyTexts = []) {
  const combined = [interest, text, ...historyTexts].filter(Boolean).join(" ");
  let bean = "";
  for (const entry of BEAN_INTERESTS) {
    if (entry.pattern.test(combined)) {
      bean = entry.label;
      break;
    }
  }
  const sizeMatch = combined.match(/\b(250g|500g|1kg|\d+(?:\.\d+)?\s*kg)\b/i);
  const size = sizeMatch ? sizeMatch[0].replace(/\s+/g, "") : "";
  return { bean, size };
}

function detectFulfillment(text) {
  const t = String(text || "");
  if (/\b(?:pickup|pick-up|pick up|pick it up|will pick up|for pick up|self-?collect|kuha sa shop|moadto|mangadto)\b/i.test(t)) {
    return "pickup";
  }
  if (/\b(?:shop|store)\b/i.test(t) && !/\b(?:deliver|delivery|maxim|padala|hatod)\b/i.test(t)) {
    return "pickup";
  }
  if (/\b(?:deliver|delivery|maxim|padala|hatod|shipping|ship)\b/i.test(t)) {
    return "delivery";
  }
  return "";
}

function extractName(text) {
  const t = String(text || "");
  const labeled = t.match(/\bname[:\s]+([A-Za-z][A-Za-z\s.'-]{1,40})/i);
  if (labeled) return labeled[1].trim();
  const leading = t.match(/^([A-Za-z][A-Za-z\s.'-]{1,30}),/);
  if (leading) return leading[1].trim();
  return "";
}

function detectPaymentStatus(text) {
  const t = String(text || "");
  if (
    /\b(?:proof of payment|payment proof|paid|payment sent|sent payment|nagbayad|na bayad|screenshot|payment done)\b/i.test(
      t
    )
  ) {
    return "paid";
  }
  if (/\b(?:gcash|unionbank|bayad|payment|magbayad)\b/i.test(t)) {
    return "unpaid";
  }
  return "unpaid";
}

const ORDER_INTENT_PATTERN =
  /\b(?:order|buy|purchase|checkout|mag order|gusto ko order|place order|kuha ko|i want to get|i'll take|ill take)\b/i;

const ADD_TO_ORDER_PATTERN =
  /\b(?:add|also want|also add|another|one more|include|plus|new order|order again)\b/i;

function analyzeOrderSignal(userText, options = {}) {
  const t = String(userText || "").trim();

  if (options.isPaymentProofImage) {
    const historyTexts = options.historyTexts || [];
    const interest = extractInterest(historyTexts.join("\n") || t, historyTexts);
    const { bean, size } = parseBeanAndSize(interest, t, historyTexts);
    return {
      bean,
      size,
      phone: extractPhone(t) || extractPhone(historyTexts.join("\n")),
      name: extractName(t),
      interest,
      fulfillment: detectFulfillment(historyTexts.join("\n")) || "",
      address: "",
      paymentStatus: "paid",
      orderStatus: "awaiting_payment",
      trigger: "payment proof image",
    };
  }

  if (!t || t.length < 2) return null;

  const {
    isDeliveryDetails = false,
    isOrderIntent = false,
    historyTexts = [],
  } = options;

  const interest = extractInterest(t, historyTexts);
  const addToOrder = ADD_TO_ORDER_PATTERN.test(t) && Boolean(interest);
  const orderIntent = isOrderIntent || ORDER_INTENT_PATTERN.test(t) || addToOrder;
  const paymentStatus = detectPaymentStatus(t);
  const paymentMention =
    paymentStatus === "paid" ||
    /\b(?:gcash|unionbank|proof|bayad|payment|magbayad)\b/i.test(t);

  if (!orderIntent && !isDeliveryDetails && !paymentMention) return null;

  const { bean, size } = parseBeanAndSize(interest, t, historyTexts);
  const phone = extractPhone(t);
  const name = extractName(t);
  const fulfillment =
    detectFulfillment(t) || (isDeliveryDetails ? "delivery" : "");

  if (!orderIntent && !isDeliveryDetails && !bean && !size && !paymentMention) {
    return null;
  }

  let orderStatus = "inquiry";
  if (isDeliveryDetails) orderStatus = "pending";
  if (paymentStatus === "paid") orderStatus = "awaiting_payment";

  return {
    bean,
    size,
    phone,
    name,
    interest,
    fulfillment,
    address: isDeliveryDetails ? t.slice(0, 400) : "",
    paymentStatus,
    orderStatus,
    trigger: isDeliveryDetails
      ? "delivery details"
      : addToOrder
        ? "add to order"
        : orderIntent
          ? "order intent"
          : "payment mention",
  };
}

/** Pure stock check — not pricing, sizing, or order intent. */
function isProductAvailabilityInquiry(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (
    /\b(?:price|prices|how much|tagpila|hm|magkano|cost|presyo|order|buy|purchase|wholesale|bulk|quote|quotation|\d+(?:\.\d+)?\s*kg|250g|500g|1kg)\b/i.test(
      t
    )
  ) {
    return false;
  }
  return (
    /\b(?:do you have|you have|have you|do you carry|do you sell|meron|available|in stock|may (?:ba|pa)|naa (?:ba|mo|y)|available ba)\b/i.test(
      t
    ) || /^(?:may|meron|naa)\s+.+\?$/i.test(t)
  );
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
    !isCustomerOwnLogisticsIntent(t) &&
    /\b(?:appointment|book(?:ing)?|schedule a visit|visit the shop|cupping|callback|call me back)\b/i.test(
      t
    ) &&
    !/\b(?:book(?:ing)?|schedule).*(?:delivery(?:\s+person|\s+rider)?|rider|courier|logistics)\b/i.test(t)
  ) {
    return {
      stage: "appointment",
      trigger: "appointment request",
      phone,
      interest,
    };
  }

  if (
    /\b(?:wholesale|bulk|6\s*kg|(?:[7-9]|\d{2,})\s*kg|café|cafe|coffee shop|coffee shop supply|reseller|distributor|supply for)\b/i.test(
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
    /\b(?:add|also want|also add|another|one more|include|plus|new order|order again)\b/i.test(
      t
    ) &&
    interest
  ) {
    return {
      stage: "ordering",
      trigger: "add to order",
      phone,
      interest,
    };
  }

  if (interest && isProductAvailabilityInquiry(t)) {
    return {
      stage: "browsing",
      trigger: "product availability inquiry",
      phone,
      interest,
    };
  }

  if (
    /\b(?:price|prices|how much|tagpila|hm|magkano|cost|presyo)\b/i.test(t) ||
    (interest && /\b(?:250g|500g|1kg|\d+(?:\.\d+)?\s*kg)\b/i.test(t))
  ) {
    return {
      stage: "quoted",
      trigger: interest ? "product or price inquiry" : "price inquiry",
      phone,
      interest,
    };
  }

  if (interest) {
    return {
      stage: "browsing",
      trigger: "product interest",
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
  analyzeOrderSignal,
  extractPhone,
  extractInterest,
  extractName,
  parseBeanAndSize,
  detectFulfillment,
  detectPaymentStatus,
  mergeStage,
  STAGE_RANK,
  ORDER_INTENT_PATTERN,
  ADD_TO_ORDER_PATTERN,
  isProductAvailabilityInquiry,
};
