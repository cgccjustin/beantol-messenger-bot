const { detectFulfillment, extractName, extractPhone, normalizePhoneInputText } = require("./lead-capture");
const { scopeKey } = require("./tenant-context");
const { resolveProfile } = require("./tenant-system-rules");
const { isOrderCaptureEnabledForTenant } = require("./tenant-google");
const {
  getShopAddress,
  getShopHours,
  businessName,
} = require("./tenant-messages");
const {
  getCatalogProducts,
} = require("./tenant-catalog");

const SESSION_TTL_MS =
  Number(process.env.CAFE_ORDER_SESSION_HOURS || 4) * 60 * 60 * 1000;

/** @type {Map<string, object>} */
const sessions = new Map();

const CAFE_ORDER_INTENT =
  /\b(?:order|buy|kuha|gusto ko|get me|can i get|can i have|i(?:'d| would) like|i want|give me|have (?:one|some)|pa order|order ko|mo order|paliton|kuhaon)\b/i;

const ORDER_ACK =
  /^(?:ok(?:ay)?|sige|yes|oo|opo|sure|go ahead|proceed|yep|yeah|sounds good|got it|please|confirm(?:ed)?|noted)(?:\s+(?:proceed|go ahead|confirm(?:ed)?|na|po|thanks|thank you))*[!.?\s]*$/i;

const ORDER_CONFIRM_NOISE =
  /\b(?:ok(?:ay)?(?:\s+(?:proceed|go ahead|confirm(?:ed)?|na|po))?|proceed|go ahead|confirm(?:ed)?|yes|yep|oo|opo|sige|sure|got it|noted|please|thanks|thank you)\b[\s!.]*$/i;

const FRUSTRATION_PATTERN =
  /\b(?:i already|already did|already told|told you|mentioned already|naa na|nahuman na|gipa na|naka order na|same (?:order|na)|repeat)\b/i;

const OFF_TOPIC_CAFE_CHAT =
  /\b(?:best\s*seller|bestseller|what do you recommend|who is|what are your hours|fun fact|tell me about|promo|deal|sale|soft launch|menu|price list|open today|closed today|how to order|how can i order)\b/i;

const FULFILLMENT_KEYWORD_LINE = /^(?:pickup|delivery|deliver|padala|hatod)$/i;

const SIMPLE_GREETING =
  /^(?:hi|hello|hey|helo|good morning|good afternoon|good evening|kamusta|musta|hello po|hi po|good day|thanks|thank you|salamat)[!.?\s]*$/i;

const MIXED_PRODUCT_QUESTION =
  /\b(?:what(?:'s|\s+is)\s+(?:this|that|it)|unsay ni|ano ni|what are these|tell me about this)\b/i;

const MENU_BROWSE_INQUIRY =
  /\b(?:menu|price list|list(?:\s+your)?\s+(?:drinks|menu|items)|what do you (?:have|sell|offer)|unsay naa|available drinks)\b/i;

const ADDRESS_LINE_HINT =
  /\b(?:iligan|cebu|city|street|st\.|brgy|barangay|purok|village|subdivision|blk|block|mahayahay|address|deliver|province| ave|road|rd\.)\b/i;

const HINTS_TTL_MS = Number(process.env.CAFE_ORDER_HINTS_HOURS || 2) * 60 * 60 * 1000;
const ORDER_IDLE_NUDGE_MS =
  Number(process.env.CAFE_ORDER_IDLE_MINUTES || 30) * 60 * 1000;

/** @type {Map<string, { fulfillment?: string, paymentAsk?: boolean, contextSnippet?: string, updatedAt: number }>} */
const pendingOrderHints = new Map();

/** @type {Map<string, { items: object[], tenantId: string, updatedAt: number }>} */
const pendingOrderItems = new Map();

const PRODUCT_BLURBS = {
  "offbeat-brew": {
    "offbeat-white":
      "Offbeat White (₱140) is our smooth, creamy cold brew — signature cold brew concentrate blended with our house milk mixture. Bold caffeine kick with a velvety, balanced finish. Cold brew based, not espresso.",
    "offbeat-black":
      "Offbeat Black (₱130) is pure, bold cold brew — no cream, no sweetener. Clean, smooth, and full of character. Cold brew based, not espresso.",
    "offbeat-mocha":
      "Offbeat Mocha (₱160) is a cold brew–based mocha — rich coffee and chocolate in a ready-to-drink bottle. Cold only.",
    "offbeat-dulce":
      "Offbeat Dulce (₱160) is a cold brew–based dulce drink — sweet, smooth, and ready to drink cold.",
    "choco-unplugged":
      "Choco Unplugged (₱170) is a non-coffee chocolate drink from our Unplugged series.",
    "matcha-unplugged":
      "Matcha Unplugged (₱180) is a non-coffee matcha drink from our Unplugged series.",
    "strawberry-unplugged":
      "Strawberry Unplugged (₱170) is a non-coffee strawberry drink from our Unplugged series.",
  },
  "kape-kristiano": {
    "kk-latte-hot":
      "Latte (hot, ₱150) — classic espresso with steamed milk, served hot.",
    "kk-latte-cold":
      "Latte (cold, ₱160) — classic espresso with milk, served iced.",
    "kk-cappuccino-hot":
      "Cappuccino (hot, ₱155) — espresso with steamed milk and foam.",
    "kk-cappuccino-cold":
      "Cappuccino (cold, ₱165) — espresso with milk and foam, served iced.",
    "kk-americano-hot":
      "Americano (hot, ₱130) — espresso diluted with hot water for a clean, bold cup.",
    "kk-americano-cold":
      "Americano (cold, ₱140) — espresso with water, served iced.",
    "kk-spanish-latte-hot":
      "Spanish Latte (hot, ₱160) — sweet, creamy Spanish-style latte served hot.",
    "kk-spanish-latte-cold":
      "Spanish Latte (cold, ₱170) — sweet, creamy Spanish-style latte served iced.",
    "kk-mocha-hot":
      "Mocha (hot, ₱160) — espresso with chocolate and steamed milk.",
    "kk-mocha-cold":
      "Mocha (cold, ₱170) — espresso, chocolate, and milk served iced.",
    "kk-white-brew":
      "White Brew (₱180) — a KK Favorite: smooth, creamy cold coffee drink.",
    "kk-cloud-cream-brew":
      "Cloud Cream Brew (₱190) — a KK Favorite: rich, creamy layered cold brew.",
    "kk-himalayan-latte":
      "Himalayan Latte (₱200) — a KK Favorite with a distinctive sweet-salty profile.",
    "kk-fizzy-berry":
      "Fizzy Berry (₱180) — a KK Favorite: refreshing sparkling berry drink.",
    "kk-fizzy-cucumber":
      "Fizzy Cucumber (₱180) — a KK Favorite: light, refreshing cucumber fizz.",
    "kk-fizzy-lemon":
      "Fizzy Lemon (₱180) — a KK Favorite: bright sparkling lemon drink.",
    "kk-pour-over":
      "Pour Over (₱170) — hand-poured coffee brewed to order from our bean selection.",
    "kk-chocolate":
      "Chocolate (₱150) — non-coffee chocolate drink, served cold.",
    "kk-strawberry":
      "Strawberry (₱170) — non-coffee strawberry drink, served cold.",
    "kk-passion-fruit":
      "Passion Fruit (₱170) — non-coffee passion fruit drink, served cold.",
    "kk-oolong-tea":
      "Oolong Tea (hot, ₱150) — hot oolong tea.",
    "kk-tablea-tsokolate":
      "Tablea Tsokolate (hot, ₱135) — traditional Filipino hot chocolate.",
    "kk-ensaymada-plain":
      "I Love You Ensaymada without filling (₱85) — soft Filipino sweet bread.",
    "kk-ensaymada-filled":
      "I Love You Ensaymada with filling (₱95) — ensaymada with sweet filling.",
    "kk-carbonara":
      "Creamy Carbonara (₱200) — pasta with creamy sauce.",
    "kk-pork-chop":
      "Pork Chop with Egg (₱145) — meal with rice.",
    "kk-sisig":
      "Sisig with Egg (₱130) — sizzling sisig meal with egg.",
    "kk-humba":
      "Humba with Egg (₱150) — Filipino braised pork meal with egg.",
  },
};

const KAPE_MENU_SECTIONS = [
  {
    title: "Classic Drinks (Hot / Cold)",
    ids: [
      "kk-latte-hot",
      "kk-latte-cold",
      "kk-cappuccino-hot",
      "kk-cappuccino-cold",
      "kk-americano-hot",
      "kk-americano-cold",
      "kk-spanish-latte-hot",
      "kk-spanish-latte-cold",
      "kk-mocha-hot",
      "kk-mocha-cold",
    ],
  },
  {
    title: "KK Favorites (Cold only)",
    ids: [
      "kk-white-brew",
      "kk-cloud-cream-brew",
      "kk-fizzy-berry",
      "kk-fizzy-cucumber",
      "kk-fizzy-lemon",
      "kk-himalayan-latte",
    ],
  },
  {
    title: "Non-Coffee Based",
    ids: [
      "kk-chocolate",
      "kk-strawberry",
      "kk-passion-fruit",
      "kk-oolong-tea",
      "kk-tablea-tsokolate",
    ],
  },
  { title: "Pour Over", ids: ["kk-pour-over"] },
  {
    title: "Sweet Treats & Snacks",
    ids: [
      "kk-flavored-fries",
      "kk-empanada",
      "kk-ensaymada-plain",
      "kk-ensaymada-filled",
      "kk-carbonara",
      "kk-suman",
      "kk-siomai",
      "kk-garlic-bread",
      "kk-cheesecake",
    ],
  },
  {
    title: "Meals",
    ids: ["kk-pork-chop", "kk-sisig", "kk-humba", "kk-ramyun"],
  },
  {
    title: "Extras",
    ids: ["kk-bottled-water", "kk-rice", "kk-egg-addon"],
  },
];

const MENU_PRICES = {
  "offbeat-brew": {
    "offbeat-black": 130,
    "offbeat-white": 140,
    "offbeat-mocha": 160,
    "offbeat-dulce": 160,
    "choco-unplugged": 170,
    "matcha-unplugged": 180,
    "strawberry-unplugged": 170,
  },
  "kape-kristiano": {
    "kk-latte-hot": 150,
    "kk-latte-cold": 160,
    "kk-cappuccino-hot": 155,
    "kk-cappuccino-cold": 165,
    "kk-americano-hot": 130,
    "kk-americano-cold": 140,
    "kk-spanish-latte-hot": 160,
    "kk-spanish-latte-cold": 170,
    "kk-mocha-hot": 160,
    "kk-mocha-cold": 170,
    "kk-white-brew": 180,
    "kk-cloud-cream-brew": 190,
    "kk-fizzy-berry": 180,
    "kk-fizzy-cucumber": 180,
    "kk-fizzy-lemon": 180,
    "kk-himalayan-latte": 200,
    "kk-chocolate": 150,
    "kk-strawberry": 170,
    "kk-passion-fruit": 170,
    "kk-oolong-tea": 150,
    "kk-tablea-tsokolate": 135,
    "kk-pour-over": 170,
    "kk-flavored-fries": 80,
    "kk-empanada": 100,
    "kk-ensaymada-plain": 85,
    "kk-ensaymada-filled": 95,
    "kk-carbonara": 200,
    "kk-suman": 60,
    "kk-siomai": 50,
    "kk-garlic-bread": 90,
    "kk-cheesecake": 95,
    "kk-pork-chop": 145,
    "kk-sisig": 130,
    "kk-humba": 150,
    "kk-ramyun": 120,
    "kk-bottled-water": 25,
    "kk-rice": 25,
    "kk-egg-addon": 25,
  },
};

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatPeso(amount) {
  return `₱${Number(amount).toLocaleString("en-PH")}`;
}

function isCafeOrderFlowEnabled(tenant) {
  const t = tenant || {};
  return resolveProfile(t) === "cafe" && isOrderCaptureEnabledForTenant(t);
}

function getSession(senderId) {
  const session = sessions.get(scopeKey(senderId));
  if (!session) return null;
  if (Date.now() - session.updatedAt > SESSION_TTL_MS) {
    sessions.delete(scopeKey(senderId));
    return null;
  }
  return session;
}

function clearCafeOrderSession(senderId) {
  sessions.delete(scopeKey(senderId));
}

function isCafeOrderFlowActive(senderId) {
  const session = getSession(senderId);
  return Boolean(session && session.step !== "closed");
}

function startSession(senderId, data = {}) {
  const now = Date.now();
  const session = {
    step: data.step || "choose_fulfillment",
    items: data.items || [],
    fulfillment: data.fulfillment || "",
    deliveryDetails: data.deliveryDetails || null,
    tenantId: data.tenantId || "",
    updatedAt: now,
    lastCustomerAt: now,
  };
  sessions.set(scopeKey(senderId), session);
  return session;
}

function touchSessionActivity(session) {
  if (!session) return;
  session.lastCustomerAt = Date.now();
  session.updatedAt = Date.now();
}

function sessionWasIdle(session) {
  if (!session) return false;
  const ref = session.lastCustomerAt || session.updatedAt;
  return Date.now() - ref > ORDER_IDLE_NUDGE_MS;
}

function applyExplicitQuantities(items, text) {
  if (!items?.length) return items || [];
  const t = String(text || "");
  return items.map((item) => {
    const labelKey = item.label.toLowerCase();
    let qty = parseQuantityNearKey(t, labelKey);
    if (!qty) {
      for (const key of ["offbeat white", "offbeat black", "white", "black", "mocha", "dulce"]) {
        if (labelKey.includes(key.replace("offbeat ", "")) || labelKey.includes(key)) {
          qty = parseQuantityNearKey(t, key);
          if (qty) break;
        }
      }
    }
    if (qty && qty >= 1) return { ...item, qty };
    return item;
  });
}

function buildStaleSessionWelcomePrefix(session) {
  if (!sessionWasIdle(session)) return "";
  const summary = session.items?.map((i) => `${i.qty}× ${i.label}`).join(", ");
  return summary
    ? `Welcome back! Picking up your order (${summary}).\n\n`
    : "Welcome back!\n\n";
}

function buildOrderConfirmationReply(session, tenant, options = {}) {
  const { fulfillment = session.fulfillment, details = session.deliveryDetails, paymentAsk = false } =
    options;
  const deliveryDetails =
    fulfillment === "delivery" && details
      ? finalizeDeliveryDetails(
          {
            ...details,
            phone:
              details.phone ||
              extractPhone(details.raw || "") ||
              extractPhoneFromMessageHistory([], details.raw || ""),
          },
          details.raw
        )
      : null;
  const lines = [
    buildStaleSessionWelcomePrefix(session),
    "Here's what I have — please confirm:",
    "",
    formatLineItemsSummary(session.items, tenant),
  ];
  const { total, priced } = computeOrderTotal(session.items, tenant);
  if (priced) lines.push(`Subtotal: ${formatPeso(total)}`);
  const promo = promoNote(session.items, tenant);
  if (promo) lines.push(promo.trim());

  if (fulfillment === "delivery" && deliveryDetails) {
    lines.push(
      "",
      "Delivery:",
      `• Name: ${deliveryDetails.name || "(please confirm)"}`,
      `• Address: ${deliveryDetails.address || deliveryDetails.raw || "(please confirm)"}`,
      `• Contact: ${deliveryDetails.phone || "(mobile number needed)"}`
    );
    if (!deliveryDetails.phone) {
      if (paymentAsk) lines.push("", buildPaymentModeNote(tenant));
      lines.push("", buildPhoneCollectPrompt(tenant, deliveryDetails));
      return lines.filter((line) => line !== "").join("\n");
    }
  } else if (fulfillment === "pickup") {
    lines.push("", "Pickup at our shop during shop hours.");
  }

  if (paymentAsk) {
    lines.push("", buildPaymentModeNote(tenant));
  }

  lines.push(
    "",
    "Reply OK to confirm and we'll send payment details — or tell me what to change."
  );
  return lines.filter((line) => line !== "").join("\n");
}

function buildCafeOrderIdleSystemNote(senderId, tenant) {
  const session = getSession(senderId);
  if (!session?.items?.length || !sessionWasIdle(session)) return "";
  const summary = session.items.map((i) => `${i.qty}× ${i.label}`).join(", ");
  return (
    `RETURNING CUSTOMER (strict): They stepped away and came back after ${Math.round((Date.now() - (session.lastCustomerAt || session.updatedAt)) / 60000)}+ minutes. ` +
    `Pending order: ${summary}. Step: ${session.step}. ` +
    "Briefly welcome them back, then help with their question AND steer back to completing the order."
  );
}

function finalizeConfirmedCafeOrder(senderId, session, tenant, options = {}, trigger = "cafe order confirmed") {
  const { agentAvailable = false, paymentAsk = false } = options;
  session.step = "awaiting_payment";
  touchSessionActivity(session);
  sessions.set(scopeKey(senderId), session);

  let reply = buildOrderClosure(session, tenant, {
    agentAvailable,
    fulfillment: session.fulfillment,
    details: session.deliveryDetails,
  });
  if (paymentAsk) {
    reply = `${buildPaymentModeNote(tenant)}\n\n${reply}`;
  }

  return {
    handled: true,
    reply,
    captureOrder: {
      cafeOrderCapture: true,
      isOrderIntent: true,
      fulfillment: session.fulfillment || "",
      orderStatus: "awaiting_payment",
      address: session.deliveryDetails?.address || session.deliveryDetails?.raw || "",
      phone: session.deliveryDetails?.phone || "",
      name: session.deliveryDetails?.name || "",
      bean: session.items.map((i) => `${i.qty}× ${i.label}`).join(", "),
      lineItems: formatLineItemsSummary(session.items, tenant),
      trigger,
    },
    notifyDelivery: session.fulfillment === "delivery",
  };
}

function parseQuantityNearKey(text, key) {
  const re = new RegExp(
    `(\\d+)\\s*(?:x|pcs?|bottles?|btl)?\\s*${escapeRegExp(key)}|${escapeRegExp(key)}\\s*[x×]?\\s*(\\d+)`,
    "i"
  );
  const m = String(text || "").match(re);
  if (!m) return null;
  return parseInt(m[1] || m[2], 10) || 1;
}

function parseCafeOrderFromText(text, tenant) {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return null;

  const products = getCatalogProducts(tenant);
  if (!products.length) return null;

  const candidates = [];
  for (const product of products) {
    for (const key of [...(product.keys || []), product.label.toLowerCase()]) {
      candidates.push({ product, key, len: key.length });
    }
  }
  candidates.sort((a, b) => b.len - a.len);

  const found = new Map();
  const ranges = [];
  for (const { product, key } of candidates) {
    if (found.has(product.id)) continue;
    const re = new RegExp(`\\b${escapeRegExp(key)}\\b`, "i");
    const m = re.exec(t);
    if (!m) continue;
    const start = m.index;
    const end = start + m[0].length;
    const overlaps = ranges.some((r) => start < r.end && end > r.start);
    if (overlaps) continue;
    ranges.push({ start, end });
    const qty = parseQuantityNearKey(t, key) || 1;
    found.set(product.id, { productId: product.id, label: product.label, qty });
  }

  return found.size ? [...found.values()] : null;
}

function unitPrice(tenant, productId) {
  const map = MENU_PRICES[tenant?.id] || {};
  return map[productId] ?? null;
}

function computeOrderTotal(items, tenant) {
  let total = 0;
  let priced = true;
  for (const item of items) {
    const price = unitPrice(tenant, item.productId);
    if (price == null) {
      priced = false;
      continue;
    }
    total += price * item.qty;
  }
  return { total, priced };
}

function formatLineItemsSummary(items, tenant) {
  const lines = [];
  for (const item of items) {
    const price = unitPrice(tenant, item.productId);
    const pricePart = price != null ? ` — ${formatPeso(price * item.qty)}` : "";
    lines.push(`• ${item.qty}× ${item.label}${pricePart}`);
  }
  return lines.join("\n");
}

function promoNote(items, tenant) {
  if (tenant?.id !== "offbeat-brew") return "";
  const ids = new Set(items.map((i) => i.productId));
  if (ids.has("offbeat-white") || ids.has("offbeat-black")) {
    return (
      "\n\nSoft Launch Promo: Buy 1 Get 1 at 50% off on Offbeat White or Black — ask us if you'd like to add the second bottle."
    );
  }
  return "";
}

function isShortAffirmation(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 48) return false;
  return /^(?:ok(?:ay)?|yes|yep|oo|opo|confirm(?:ed)?|got it|noted|see you|sige|thanks|thank you|salamat)$/i.test(
    t
  );
}

function looksLikeCafeDeliveryDetails(text) {
  const t = normalizeDeliveryInputText(text).trim();
  if (t.length < 10) return false;
  const phone = extractPhone(t);
  if (!phone) return false;

  const lines = t.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 1 && lineHasPhone(lines[0])) return true;
  if (lines.length >= 2 && lines.some((line) => lineHasPhone(line))) return true;
  if (lines.length >= 3) return true;
  if (lines.length >= 2 && t.length >= 20) return true;

  if (ADDRESS_LINE_HINT.test(t)) return true;

  return t.length >= 45;
}

function stripPhoneFromText(text, phone) {
  if (!text) return "";
  let working = normalizePhoneInputText(text);
  if (phone) {
    working = working.replace(phone, " ");
    const digits = phone.replace(/\D/g, "");
    if (digits.length >= 10) {
      working = working.replace(new RegExp(digits.split("").join("[\\s\\-.()]*"), "g"), " ");
    }
  }
  return working
    .replace(/\b(?:mobile|cell(?:phone)?|phone|contact|cp|tel(?:ephone)?|no\.?|number)\s*[:\-]?\s*$/i, "")
    .replace(/\s+/g, " ")
    .replace(/^[,.\s-]+|[,.\s-]+$/g, "")
    .trim();
}

function stripDeliveryLineLabel(line) {
  return String(line || "")
    .trim()
    .replace(/^(?:\d+[.)]\s*)+/, "")
    .replace(
      /^(?:name|address|mobile(?:\s+number)?|cell(?:phone)?(?:\s+number)?|contact(?:\s+(?:name|number))?|phone(?:\s+number)?|cp|tel(?:ephone)?)\s*[:\-]\s*/i,
      ""
    )
    .trim();
}

const DELIVERY_LABEL_ONLY =
  /^(?:\d+[.)]\s*)?(?:mobile(?:\s+number)?|cell(?:phone)?(?:\s+number)?|contact(?:\s+(?:name|number))?|phone(?:\s+number)?|cp|tel(?:ephone)?|name|address|contact)\s*[:\-]?\s*$/i;

function isDeliveryLabelOnlyLine(line) {
  return DELIVERY_LABEL_ONLY.test(String(line || "").trim());
}

function lineHasEmbeddedPhoneWithAddress(line, phone) {
  if (!phone || !line) return false;
  const t = String(line || "").trim();
  if (!extractPhone(t)) return false;
  const remainder = phoneLineRemainder(t, phone);
  return remainder.length >= 8 || looksLikeAddressLine(remainder);
}

function stripAffirmationFromAddress(address) {
  return String(address || "")
    .replace(/\s*,\s*ok(?:ay)?(?:\s+proceed)?[\s!.]*$/i, "")
    .replace(/\s*,\s*(?:proceed|go ahead|confirm(?:ed)?|yes|yep|sige)[\s!.]*$/i, "")
    .replace(ORDER_CONFIRM_NOISE, "")
    .replace(/^[,.\s-]+|[,.\s-]+$/g, "")
    .trim();
}

function normalizeDeliveryInputText(text) {
  return String(text || "")
    .replace(/\u2028|\u2029/g, "\n")
    .replace(/\r\n?/g, "\n");
}

function extractPhoneFromMessageHistory(recentUserTexts = [], userText = "") {
  for (const msg of [...recentUserTexts, userText].reverse()) {
    const t = normalizeDeliveryInputText(msg).trim();
    if (!t) continue;
    const whole = extractPhone(t);
    if (whole && (isPhoneOnlyLine(t) || lineHasPhone(t))) return whole;
    const lines = t.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lineHasPhone(lines[i])) continue;
      const phone = extractPhone(lines[i]);
      if (phone) return phone;
    }
  }
  return "";
}

function resolveDeliveryDetails(existing, recentUserTexts = [], userText = "", tenant = null) {
  const normalizedText = normalizeDeliveryInputText(userText).trim();
  const block = extractLatestDeliveryBlock(recentUserTexts, normalizedText, tenant);
  const combined = [...recentUserTexts, normalizedText].filter(Boolean).join("\n");
  const parseSource = block || normalizedText || combined;
  let parsed = null;

  if (parseSource && (looksLikeCafeDeliveryDetails(parseSource) || extractPhone(parseSource))) {
    parsed = parseDeliveryDetails(parseSource);
  }
  if (!parsed) {
    parsed = parsePartialDeliveryBlock(recentUserTexts, normalizedText, tenant);
  }

  let merged = parsed ? mergeDeliveryDetails(existing, parsed) : existing || null;
  if (!merged && (existing || combined.trim())) {
    merged = finalizeDeliveryDetails(existing || {}, combined);
  }
  if (!merged) return null;

  const phoneFromHistory = extractPhoneFromMessageHistory(recentUserTexts, normalizedText);
  const phoneFromCombined = extractPhone(combined);
  const phone = merged.phone || phoneFromHistory || phoneFromCombined || "";
  if (!phone) return merged;

  return finalizeDeliveryDetails(
    {
      ...merged,
      phone,
      raw: merged.raw || block || normalizedText || combined,
    },
    merged.raw || block || normalizedText || combined
  );
}

function mergeDeliveryDetails(existing, parsed) {
  if (!parsed) return existing || null;
  const base = existing || { raw: "", phone: "", name: "", address: "" };
  const merged = finalizeDeliveryDetails(
    {
      raw: parsed.raw || base.raw || "",
      phone: parsed.phone || base.phone || "",
      name: parsed.name || base.name || "",
      address: parsed.address || base.address || "",
    },
    parsed.raw || base.raw || ""
  );
  if (!merged.phone && base.phone) merged.phone = base.phone;
  if (!merged.name && base.name) merged.name = base.name;
  if (merged.address) merged.address = stripAffirmationFromAddress(merged.address);
  return merged;
}

function finalizeDeliveryDetails(details, rawText = "") {
  const raw = String(rawText || details?.raw || "").trim();
  let phone =
    details?.phone ||
    extractPhone(raw) ||
    extractPhone(details?.address || "") ||
    extractPhone(details?.name || "") ||
    "";

  if (!phone && raw) {
    for (const line of raw.split(/\r?\n/)) {
      const fromLine = extractPhone(String(line || "").trim());
      if (fromLine) {
        phone = fromLine;
        break;
      }
    }
  }

  let name = String(details?.name || "").trim();
  let address = stripAffirmationFromAddress(String(details?.address || "").trim());

  if (phone && address) {
    address = stripAffirmationFromAddress(stripPhoneFromText(address, phone) || address);
  }
  if (name && (isDeliveryLabelOnlyLine(name) || isPhoneOnlyLine(name))) {
    name = "";
  }
  if (!name) {
    name = extractName(raw) || "";
  }
  if (isDeliveryLabelOnlyLine(name)) name = "";

  return {
    raw: raw || details?.raw || "",
    phone,
    name,
    address: address || stripAffirmationFromAddress(raw),
  };
}

function isShortDeliveryBridgeMessage(text) {
  const t = String(text || "").trim();
  return /^(?:ok(?:ay)?|here|here you go|here's|this|sending|sent|done|ya|sige|eto|a(?:na|ni))[\s!.]*$/i.test(t);
}

function phoneLineRemainder(line, phone) {
  const escaped = phone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return String(line || "")
    .replace(new RegExp(escaped, "g"), "")
    .replace(/[\s,.\-()+#]/g, " ")
    .replace(
      /\b(?:mobile|cell(?:phone)?|phone|contact|number|cp|tel(?:ephone)?|no|mobi|num|my|this|is|aka)\b/gi,
      " "
    )
    .replace(/\s+/g, "")
    .trim();
}

function isPhoneOnlyLine(line) {
  const t = String(line || "").trim();
  const phone = extractPhone(t);
  if (!phone) return false;
  return phoneLineRemainder(t, phone).length === 0;
}

function lineHasPhone(line) {
  return Boolean(extractPhone(String(line || "")));
}

function findLastPhoneLineIndex(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lineHasPhone(lines[i])) return i;
  }
  return -1;
}

function normalizeInquiryText(text) {
  return String(text || "")
    .replace(/[\u2018\u2019\u2032`]/g, "'")
    .replace(/\u00A0/g, " ");
}

function hasMixedProductQuestion(text) {
  const t = normalizeInquiryText(text);
  return MIXED_PRODUCT_QUESTION.test(t);
}

function buildMixedProductQuestionNote(userText, tenant) {
  if (!hasMixedProductQuestion(userText)) return "";
  const items = parseCafeOrderFromText(userText, tenant) || [];
  const productHint = items.length
    ? ` They mentioned: ${items.map((i) => i.label).join(", ")}.`
    : "";
  return (
    "MIXED MESSAGE (strict): Customer asked what a product is (e.g. What's this?) while also ordering or naming a drink." +
    productHint +
    " Describe ONLY the drink(s) they named — do NOT compare to other menu items unless they asked for a comparison." +
    " Answer the product question FIRST using drink descriptions from KNOWLEDGE CONTEXT." +
    " If they already gave quantity, pickup/delivery, or delivery address in the same message, acknowledge those — do NOT re-ask." +
    " Then invite them to continue only with what's still missing. Do NOT skip the explanation or jump straight to quantity."
  );
}

function isOrderAcknowledgment(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 64 || /\d/.test(t)) return false;
  return ORDER_ACK.test(t);
}

function getProductBlurb(tenant, productId) {
  const custom = PRODUCT_BLURBS[tenant?.id]?.[productId];
  if (custom) return custom;
  const product = getCatalogProducts(tenant).find((p) => p.id === productId);
  if (!product) return "";
  const price = unitPrice(tenant, productId);
  const priceStr = price != null ? ` (${formatPeso(price)})` : "";
  const shop = tenant?.id === "kape-kristiano" ? "Kape Kristiano" : "our menu";
  return `${product.label}${priceStr} — from ${shop}.`;
}

function quantityUnitHint(tenant) {
  return tenant?.id === "offbeat-brew" ? " (e.g. 1 or 2 bottles)" : " (e.g. 1 or 2)";
}

function buildMixedProductOrderReply(items, tenant) {
  const lines = [];
  for (const item of items) {
    const blurb = getProductBlurb(tenant, item.productId);
    lines.push(blurb || `${item.label} — one of our menu items.`);
  }
  lines.push("", `How many would you like? Reply with a number${quantityUnitHint(tenant)}.`);
  return lines.join("\n\n");
}

function stashPendingCafeOrderItems(senderId, items, tenantId) {
  if (!items?.length) return;
  pendingOrderItems.set(scopeKey(senderId), {
    items: items.map((i) => ({ ...i })),
    tenantId: tenantId || "",
    updatedAt: Date.now(),
  });
}

function peekPendingCafeOrderItems(senderId) {
  const key = scopeKey(senderId);
  const pending = pendingOrderItems.get(key);
  if (!pending) return null;
  if (Date.now() - pending.updatedAt > HINTS_TTL_MS) {
    pendingOrderItems.delete(key);
    return null;
  }
  return pending;
}

function consumePendingCafeOrderItems(senderId) {
  const pending = peekPendingCafeOrderItems(senderId);
  if (pending) pendingOrderItems.delete(scopeKey(senderId));
  return pending;
}

function lastReplyInvitesOrder(lastAssistantReply) {
  const last = String(lastAssistantReply || "");
  return /\b(?:how many|would you like to order|specific drink|pickup or delivery|is there a specific drink|like to order)\b/i.test(
    last
  );
}

function lastReplyDescribesProduct(lastAssistantReply) {
  const last = String(lastAssistantReply || "");
  return /\b(?:cold brew|creamy|velvety|house milk|signature cold brew|offbeat white|offbeat black|our menu features|ready-to-drink bottled|kk favorite|white brew|cloud cream|spanish latte|latte \(hot|from kape kristiano|from our menu)\b/i.test(
    last
  );
}

function recentContextHasOrderIntent(recentUserTexts = []) {
  return recentUserTexts.some(
    (entry) =>
      CAFE_ORDER_INTENT.test(entry) ||
      hasMixedProductQuestion(entry) ||
      /\b(?:can i have|what is that|what's that|what is this)\b/i.test(entry)
  );
}

function formatMenuLine(product, tenant) {
  const price = unitPrice(tenant, product.id);
  let oos = false;
  try {
    const { isProductIdOutOfStock } = require("./inventory-availability");
    oos = isProductIdOutOfStock(product.id);
  } catch {
    oos = false;
  }
  if (oos) return `- ${product.label}: Currently out of stock`;
  return price != null ? `- ${product.label}: ₱${price}` : `- ${product.label}`;
}

function catalogProductsByIds(tenant, ids = []) {
  const byId = new Map(getCatalogProducts(tenant).map((p) => [p.id, p]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

function buildMenuSectionsReply(intro, sections, tenant, footerLines = []) {
  const lines = [intro, ""];
  for (const section of sections) {
    const products = catalogProductsByIds(tenant, section.ids);
    if (!products.length) continue;
    lines.push(`*${section.title}*:`);
    lines.push(...products.map((p) => formatMenuLine(p, tenant)));
    lines.push("");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function buildCafeMenuReply(tenant) {
  if (tenant?.id === "offbeat-brew") {
    const products = getCatalogProducts(tenant);
    const coffee = products.filter((p) => p.id.startsWith("offbeat-"));
    const unplugged = products.filter((p) => p.id.endsWith("-unplugged"));
    return buildMenuSectionsReply(
      "Our menu features refreshing drinks — all ready-to-drink bottled:",
      [
        { title: "Coffee Series (Cold Brew Only)", ids: coffee.map((p) => p.id) },
        { title: "Unplugged Series (non-coffee)", ids: unplugged.map((p) => p.id) },
      ],
      tenant,
      [
        "We serve drinks only — no food or snack menu.",
        "",
        "Special promo: Buy 1 Offbeat White or Offbeat Black, get the second bottle at 50% off!",
        "",
        "Is there a specific drink you'd like to order?",
      ]
    );
  }

  if (tenant?.id === "kape-kristiano") {
    return buildMenuSectionsReply(
      "Here's our menu at Kape Kristiano — coffee, treats, and meals:",
      KAPE_MENU_SECTIONS,
      tenant,
      [
        "Classic drinks are available hot or cold where listed. KK Favorites are cold only.",
        "",
        "Is there something you'd like to order?",
      ]
    );
  }

  return null;
}

function tryHandleCafeMenuInquiry(userText, tenant) {
  if (!isCafeOrderFlowEnabled(tenant)) return { handled: false };
  if (!isMenuBrowseMessage(userText, tenant)) return { handled: false };
  const reply = buildCafeMenuReply(tenant);
  if (!reply) return { handled: false };
  return { handled: true, reply };
}

function isMenuBrowseMessage(text, tenant) {
  const t = String(text || "").trim();
  if (!t || parseCafeOrderFromText(t, tenant)?.length) return false;
  return MENU_BROWSE_INQUIRY.test(t);
}

function messageSpecifiesQuantity(text) {
  if (parseQuantityFromReply(String(text || ""))) return true;
  const t = String(text || "").toLowerCase();
  return (
    /\b\d+\s*(?:x|×|pcs?|bottles?|btl|orders?|cups?|plates?)\b/.test(t) ||
    /\b(?:x|×)\s*\d+\b/.test(t) ||
    /\b(?:one|two|three|four|five|isa|duha|tulo|upat|lima)\s+(?:offbeat|bottle|latte|cappuccino|americano|mocha|spanish|brew|sisig|ramyun|empanada|white|black|dulce)/i.test(
      t
    ) ||
    /\b\d+\s+(?:offbeat|latte|cappuccino|americano|mocha|spanish|white|black|dulce|sisig|ramyun)\b/.test(t)
  );
}

function parseQuantityFromReply(text, items = []) {
  const t = String(text || "").trim();
  const bare = t.match(/^(\d{1,2})$/);
  if (bare) {
    const n = parseInt(bare[1], 10);
    if (n >= 1 && n <= 99) return n;
  }
  for (const item of items) {
    const q = parseQuantityNearKey(t, item.label.toLowerCase());
    if (q) return q;
  }
  const global =
    t.match(/\b(\d{1,2})\s*(?:x|×|pcs?|bottles?|btl|orders?|cups?|plates?)\b/i) ||
    t.match(/\b(?:order|want|get|like|need)\s+(?:me\s+)?(\d{1,2})\b/i) ||
    t.match(/\b(?:i(?:'d| would)\s+like\s+to\s+order\s+)(\d{1,2})\b/i);
  if (global) {
    const n = parseInt(global[1], 10);
    if (n >= 1 && n <= 99) return n;
  }
  const words = {
    one: 1, isa: 1, two: 2, duha: 2, three: 3, tulo: 3, four: 4, upat: 4, five: 5, lima: 5,
  };
  const wordMatch = t.match(/\b(one|two|three|four|five|isa|duha|tulo|upat|lima)\b/i);
  if (wordMatch) return words[wordMatch[1].toLowerCase()] || null;
  return null;
}

function buildQuantityPrompt(items, tenant) {
  const labels = items.map((i) => i.label).join(", ");
  return [
    `Got it — ${labels}!`,
    "",
    `How many would you like${quantityUnitHint(tenant)}? You can say the number in any way (e.g. 2, two bottles, or "2 please").`,
  ].join("\n");
}

function isSimpleGreeting(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 48) return false;
  return SIMPLE_GREETING.test(t);
}

function resetCafeOrderContext(senderId) {
  clearCafeOrderSession(senderId);
  consumeCafeOrderHints(senderId);
  consumePendingCafeOrderItems(senderId);
}

function isActiveOrderContinuation(text, lastAssistantReply = "", tenant) {
  const t = String(text || "").trim();
  if (!t || isSimpleGreeting(t)) return false;
  if (CAFE_ORDER_INTENT.test(t)) return true;
  if (detectCafeFulfillment(t)) return true;
  if (parseCafeOrderFromText(t, tenant)?.length) return true;
  const last = String(lastAssistantReply || "");
  return /\b(?:out of stock|may i suggest|instead\?|pickup or delivery|complete address|contact name|mobile number|how would you like)\b/i.test(
    last
  );
}

function isCafeOrderCancellation(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (/^(?:cancel(?:led)?|cancelled)(?:[\s!.?]*|$)/i.test(t)) return true;
  if (/^no[\s,]*(cancel|thanks|thank you|never\s*mind|nevermind)/i.test(t)) return true;
  return /\b(?:cancel(?:\s+(?:my|the|that|this|it))?\s*(?:order)?|never\s*mind(?:\s+(?:the|that|this))?\s*(?:order)?|forget(?:\s+(?:the|my|that|this))?\s*(?:order)?|stop(?:\s+(?:the|that|this|my))?\s*(?:order)?|don't want(?:\s+(?:it|that|this))?|dont want(?:\s+(?:it|that|this))?|wag na|ayaw na|dili na)\b/i.test(
    t
  );
}

const CAFE_ORDER_CHANGE_PATTERN =
  /\b(?:something else|different|change(?:\s+my)?\s+order|not that|don't want|dont want|do not want|other drink|another drink|instead|no i want|no,?\s*i want|no[\s,]+cancel|wag na|dili na|lahi|iba(?:ng)?)\b/i;

function isFulfillmentOnlyIntent(text, tenant) {
  const t = String(text || "").trim();
  if (!t) return false;
  const fulfillment = detectCafeFulfillment(t);
  if (!fulfillment) return false;
  if (messageNamesCafeProduct(t, tenant)) return false;
  if (parseCafeOrderFromText(t, tenant)?.length) return false;
  return true;
}

function messageNamesCafeProduct(text, tenant) {
  return filterInStockItems(parseCafeOrderFromText(text, tenant) || []).length > 0;
}

function isGenericCafeOrderInquiry(text, tenant) {
  const t = String(text || "").trim();
  if (!t || messageNamesCafeProduct(t, tenant)) return false;
  if (isMenuBrowseMessage(t, tenant)) return false;
  if (isCafeOrderChangeRequest(t)) return false;
  if (isFulfillmentOnlyIntent(t, tenant)) return true;
  if (
    /\b(?:can i order|could i order|may i order|i(?:'d| would) like to order|want to order|like to order|order something|order coffee|order drinks?|order kape)\b/i.test(
      t
    )
  ) {
    return true;
  }
  if (
    /\b(?:want\s+(?:something|it|a|some|drinks?|coffee).*deliver|deliver(?:y|ed)?\s+please|for\s+delivery|something\s+delivered|pa[\s-]?deliver|padeliver|want\s+delivery)\b/i.test(
      t
    )
  ) {
    return true;
  }
  if (/\b(?:mag order|order ko|mo order)\b/i.test(t)) return true;
  if (/^(?:order|order po)[!.?\s]*$/i.test(t)) return true;
  return false;
}

function isCafeOrderChangeRequest(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (isCafeOrderCancellation(t)) return true;
  return CAFE_ORDER_CHANGE_PATTERN.test(t);
}

function buildGenericOrderStartReply(tenant, options = {}) {
  const { fulfillment = "" } = options;
  let intro = "";
  if (fulfillment === "delivery") {
    intro =
      tenant?.id === "offbeat-brew"
        ? "Sure — we can arrange delivery via Maxim or Grab (Iligan area). "
        : "Sure — we can arrange delivery. ";
  } else if (fulfillment === "pickup") {
    intro = "Sure — pickup at our shop works. ";
  }
  const menu = buildCafeMenuReply(tenant);
  if (menu) {
    return `${intro}${menu}\n\nWhat would you like to order? Reply with the drink name.`;
  }
  return `${intro}What would you like to order? Tell me the drink name and how many you'd like.`;
}

function buildPendingOrderResumeReply(items, tenant) {
  const summary = items.map((i) => (i.qty > 1 ? `${i.qty}× ${i.label}` : i.label)).join(", ");
  const lines = [
    `You still have ${summary} from earlier on file.`,
    "",
    "Reply YES to continue with that order, or tell me what else you'd like.",
  ];
  const menu = buildCafeMenuReply(tenant);
  if (menu) lines.push("", menu);
  return lines.join("\n");
}

function buildQuantityReprompt(items, tenant) {
  const labels = items.map((i) => i.label).join(", ");
  return [
    `For ${labels}, how many would you like${quantityUnitHint(tenant)}? You can include other questions in the same message — I'll note your order and answer.`,
  ].join("\n");
}

function messageAnswersCurrentOrderStep(text, session, tenant, recentUserTexts = []) {
  if (!session) return false;
  const t = normalizeDeliveryInputText(text).trim();
  if (session.step === "confirm_quantity") {
    return Boolean(
      parseMessageQuantity(t, session.items) ||
        parseMessageQuantity(mergeOrderContext(t, recentUserTexts), session.items) ||
        isOrderAcknowledgment(t) ||
        messageNamesCafeProduct(t, tenant) ||
        isCafeOrderChangeRequest(t) ||
        isGenericCafeOrderInquiry(t, tenant) ||
        detectCafeFulfillment(t)
    );
  }
  if (session.step === "offer_resume") {
    return (
      isOrderAcknowledgment(t) ||
      /^(?:yes|yeah|yep|continue|same|that one|proceed|go ahead|oo|opo|sige)/i.test(t) ||
      messageNamesCafeProduct(t, tenant) ||
      isCafeOrderChangeRequest(t) ||
      isGenericCafeOrderInquiry(t, tenant)
    );
  }
  if (session.step === "choose_fulfillment") {
    return Boolean(
      detectCafeFulfillment(t) ||
        isGenericCafeOrderInquiry(t, tenant) ||
        isCafeOrderChangeRequest(t) ||
        messageNamesCafeProduct(t, tenant)
    );
  }
  if (session.step === "delivery_collect") {
    const block = extractLatestDeliveryBlock(recentUserTexts, t, tenant);
    return (
      looksLikeCafeDeliveryDetails(block) ||
      looksLikePartialCafeDeliveryDetails(block) ||
      looksLikePartialCafeDeliveryDetails(t) ||
      lineHasPhone(t) ||
      isDeliveryFragmentMessage(t, tenant)
    );
  }
  if (session.step === "pickup_pending") return isShortAffirmation(t);
  if (session.step === "confirm_order") {
    return (
      isOrderAcknowledgment(t) ||
      /^confirm(ed)?$/i.test(t) ||
      lineHasPhone(t) ||
      looksLikeCafeDeliveryDetails(t) ||
      looksLikePartialCafeDeliveryDetails(t)
    );
  }
  if (session.step === "awaiting_payment") {
    return asksPaymentMode(t) || FRUSTRATION_PATTERN.test(t);
  }
  return false;
}

/** Customer asked something unrelated while mid-order — answer it, then nudge back to the wizard. */
function isCafeOrderDigression(text, tenant, session = null, recentUserTexts = []) {
  const t = normalizeDeliveryInputText(text).trim();
  if (!t || isCafeOrderCancellation(t)) return false;
  if (session && messageContainsOrderProgress(t, session, tenant, recentUserTexts)) {
    return hasEmbeddedSideQuestion(t, tenant, session, recentUserTexts);
  }
  if (session && messageAnswersCurrentOrderStep(t, session, tenant, recentUserTexts)) return false;
  if (isGenericCafeOrderInquiry(t, tenant) || isCafeOrderChangeRequest(t)) return false;
  if (messageNamesCafeProduct(t, tenant)) return false;
  if (asksPaymentMode(t) || /\b(?:gcash|qr\s*code|\bqr\b)\b/i.test(t)) return false;
  if (isDeliveryFragmentMessage(t)) return false;
  if (looksLikeCafeDeliveryDetails(t)) return false;
  if (hasMixedProductQuestion(t)) return false;
  if (OFF_TOPIC_CAFE_CHAT.test(t)) return true;
  if (isMenuBrowseMessage(t, tenant)) return true;
  if (/\?/.test(t) && !parseCafeOrderFromText(t, tenant)?.length) return true;
  if (
    /\b(?:what|how|where|when|why|who|do you|can you|are you|tell me|unsay|unsa|ano|paano|pwede|pila|asa|kanus|kinsa|sino)\b/i.test(
      t
    ) &&
    !CAFE_ORDER_INTENT.test(t)
  ) {
    return true;
  }
  return false;
}

function buildCafeOrderResumeNudge(session, tenant) {
  if (!session?.items?.length) return "";
  const summary = session.items.map((i) => `${i.qty}× ${i.label}`).join(", ");
  const labels = session.items.map((i) => i.label).join(", ");
  const prompts = {
    confirm_quantity: `Still working on your ${labels} order — how many bottles? (You can also ask other questions in the same message.)`,
    offer_resume: `You still have ${summary} on file — reply YES to continue, or tell me what else you'd like.`,
    confirm_order: `Your order (${summary}) is ready to confirm — reply OK when you're good to proceed to payment.`,
    choose_fulfillment: `For ${summary}, would you like pickup or delivery?`,
    delivery_collect: `For ${summary} delivery — send address, contact name, and mobile number (all in one message is fine).`,
    pickup_pending: `Would you still like ${summary} for pickup? Reply OK to continue.`,
    awaiting_payment: `Your order (${summary}) is on file — reply GCash for the QR code, or send payment proof if you already paid.`,
  };
  const prompt =
    prompts[session.step] || `Would you still like to place an order for ${summary}?`;
  return `\n\n—\n${prompt}`;
}

function shouldAppendCafeOrderNudge(reply, session) {
  if (!session?.items?.length) return false;
  const r = String(reply || "").toLowerCase();
  if (
    /\b(?:would you still like|would you like to proceed|how many(?:\s+bottles|\s+would you like)?|pickup or delivery|reply pickup|send delivery details|complete address|got it — here's what|gcash|payment proof|on file)\b/.test(
      r
    )
  ) {
    return false;
  }
  return true;
}

function appendCafeOrderResumeNudge(reply, senderId, tenant) {
  const session = getSession(senderId);
  if (!session || !shouldAppendCafeOrderNudge(reply, session)) {
    return String(reply || "").trim();
  }
  const prefix = buildStaleSessionWelcomePrefix(session);
  const body = String(reply || "").trim();
  if (prefix && !body.toLowerCase().startsWith("welcome back")) {
    return `${prefix}${body}${buildCafeOrderResumeNudge(session, tenant)}`;
  }
  return `${body}${buildCafeOrderResumeNudge(session, tenant)}`;
}

function buildCafeOrderDigressionSystemNote(senderId, tenant, userText) {
  const session = getSession(senderId);
  if (!session?.items?.length) return "";
  if (!isCafeOrderDigression(userText, tenant, session)) return "";
  const summary = session.items.map((i) => `${i.qty}× ${i.label}`).join(", ");
  const fulfillmentNote = session.fulfillment
    ? ` Fulfillment: ${session.fulfillment}.`
    : "";
  return [
    buildCafeOrderSystemNote(senderId, tenant),
    "",
    "DIGRESSION (strict): Customer asked something while ordering.",
    `Pending order: ${summary}. Step: ${session.step}.${fulfillmentNote}`,
    "If their message also included order details (quantity, pickup/delivery, address, phone), those are ALREADY saved — do not re-ask.",
    "Answer their question fully and naturally first (use KNOWLEDGE CONTEXT).",
    "Do NOT restart the order or ask what drink they want again.",
    "Keep the answer concise (2–5 sentences). Briefly acknowledge they can continue their order after.",
    "The bot will append a resume prompt — do not repeat pickup/delivery or quantity questions in full.",
  ].join("\n");
}

function isOffTopicCafeOrderMessage(text, tenant) {
  if (isSimpleGreeting(text)) return true;
  if (isMenuBrowseMessage(text, tenant)) return true;
  if (hasMixedProductQuestion(text)) return true;
  const t = String(text || "").trim();
  if (!t) return false;
  if (isCafeOrderCancellation(t)) return false;
  if (OFF_TOPIC_CAFE_CHAT.test(t)) return true;
  if (/^(?:hi|hello|hey|good\s+(?:morning|afternoon|evening))\b/i.test(t) && /\?/.test(t)) {
    if (!tenant) return true;
    if (!parseCafeOrderFromText(t, tenant)?.length) return true;
  }
  if (asksPaymentMode(t) || /\b(?:gcash|qr\s*code|\bqr\b)\b/i.test(t)) return false;
  return false;
}

function isFulfillmentKeywordLine(line) {
  return FULFILLMENT_KEYWORD_LINE.test(String(line || "").trim());
}

function isLikelyDeliveryContentLine(line) {
  const t = String(line || "").trim();
  if (!t || isFulfillmentKeywordLine(t)) return false;
  if (CAFE_ORDER_INTENT.test(t)) return false;
  if (OFF_TOPIC_CAFE_CHAT.test(t)) return false;
  if (/\b(?:payment|gcash|unsay|mode of)\b/i.test(t)) return false;
  if (lineHasPhone(t) || isPhoneOnlyLine(t)) return true;
  if (ADDRESS_LINE_HINT.test(t)) return true;
  if (looksLikePersonNameLine(t) && !looksLikeAddressLine(t)) return true;
  if (looksLikeAddressLine(t)) return true;
  if (t.split(/\s+/).length > 6) return false;
  return t.length <= 40;
}

function isDeliveryFragmentMessage(text, tenant = null) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (isOrderAcknowledgment(t) || isShortAffirmation(t)) return false;
  if (isOffTopicCafeOrderMessage(t, tenant)) return false;
  if (CAFE_ORDER_INTENT.test(t)) return false;
  if (isFulfillmentKeywordLine(t)) return false;
  if (isPhoneOnlyLine(t) || lineHasPhone(t)) return true;
  if (/\b(?:offbeat|kape kristiano|order ko|payment|gcash|unsay|mode of)\b/i.test(t)) return false;
  if (ADDRESS_LINE_HINT.test(t)) return true;
  if (looksLikePersonNameLine(t) && !looksLikeAddressLine(t)) return true;
  return false;
}

function enrichDeliveryBlockWithRecentContext(blob, messages, tenant = null) {
  if (!blob || !messages?.length) return blob;
  const lines = blob.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const hasAddress = lines.some((line) => looksLikeAddressLine(line) || ADDRESS_LINE_HINT.test(line));
  const hasName = lines.some((line) => looksLikePersonNameLine(line));
  if (hasAddress && hasName && extractPhone(blob)) return blob;

  const prefix = [];
  for (let i = messages.length - 1; i >= 0 && prefix.length < 4; i--) {
    const msg = String(messages[i] || "").trim();
    if (!msg || blob.includes(msg)) continue;
    if (isShortDeliveryBridgeMessage(msg)) continue;
    if (isDeliveryFragmentMessage(msg, tenant)) prefix.unshift(msg);
    else if (prefix.length) break;
  }
  if (!prefix.length) return blob;
  return `${prefix.join("\n")}\n${blob}`.trim();
}

function extractLatestDeliveryBlock(recentUserTexts = [], userText = "", tenant = null) {
  const normalizedCurrent = normalizeDeliveryInputText(userText).trim();
  const messages = [...recentUserTexts, normalizedCurrent].filter(Boolean).map((msg) =>
    normalizeDeliveryInputText(msg).trim()
  );
  const fragments = [];
  for (let i = messages.length - 1; i >= 0 && fragments.length < 5; i--) {
    const msg = messages[i];
    if (isDeliveryFragmentMessage(msg, tenant)) {
      fragments.unshift(msg);
    } else if (fragments.length && isShortDeliveryBridgeMessage(msg)) {
      continue;
    } else if (fragments.length) {
      break;
    }
  }

  let blob = fragments.length ? fragments.join("\n") : normalizedCurrent;
  blob = enrichDeliveryBlockWithRecentContext(blob, messages, tenant);

  if (blob && !extractPhone(blob)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = String(messages[i] || "").trim();
      if (msg && (isPhoneOnlyLine(msg) || lineHasPhone(msg))) {
        blob = blob ? `${msg}\n${blob}` : msg;
        blob = enrichDeliveryBlockWithRecentContext(blob, messages, tenant);
        break;
      }
    }
  }

  if (blob && looksLikeCafeDeliveryDetails(blob)) return blob;
  if (normalizedCurrent && looksLikeCafeDeliveryDetails(normalizedCurrent)) return normalizedCurrent;
  return normalizedCurrent;
}

function parseMultilineDeliveryDetails(lines, phoneFromText) {
  const normalizedLines = lines.map(stripDeliveryLineLabel).filter(Boolean);
  const phoneLineIdx = findLastPhoneLineIndex(normalizedLines);
  let phone = phoneFromText || "";
  let remaining = [...normalizedLines];

  if (phoneLineIdx >= 0) {
    const phoneLine = normalizedLines[phoneLineIdx];
    phone = extractPhone(phoneLine) || phone;
    if (lineHasEmbeddedPhoneWithAddress(phoneLine, phone)) {
      remaining = normalizedLines.map((line, idx) =>
        idx === phoneLineIdx ? stripPhoneFromText(line, phone) : line
      );
    } else {
      remaining = normalizedLines.filter((_, index) => index !== phoneLineIdx);
    }
  } else if (!phone) {
    for (let i = normalizedLines.length - 1; i >= 0; i--) {
      const candidate = extractPhone(normalizedLines[i]);
      if (candidate) {
        phone = candidate;
        if (lineHasEmbeddedPhoneWithAddress(normalizedLines[i], candidate)) {
          remaining = normalizedLines.map((line, idx) =>
            idx === i ? stripPhoneFromText(line, candidate) : line
          );
        } else {
          remaining = normalizedLines.filter((_, index) => index !== i);
        }
        break;
      }
    }
  }

  remaining = remaining
    .filter((line) => line && !isDeliveryLabelOnlyLine(line))
    .filter((line) => isLikelyDeliveryContentLine(line));

  if (remaining.length === 2) {
    const [first, second] = remaining;
    if (looksLikePersonNameLine(second) && looksLikeAddressLine(first)) {
      return { name: second, address: first, phone };
    }
    if (looksLikePersonNameLine(first) && looksLikeAddressLine(second)) {
      return { name: first, address: second, phone };
    }
    if (phoneLineIdx === normalizedLines.length - 1) {
      return { address: first, name: second, phone };
    }
  }

  if (remaining.length === 1) {
    const line = remaining[0];
    if (looksLikePersonNameLine(line) && !looksLikeAddressLine(line)) {
      return { name: line, address: "", phone };
    }
    return { name: "", address: line, phone };
  }

  if (remaining.length >= 2) {
    let name = "";
    const addressParts = [];
    for (const line of remaining) {
      if (!name && looksLikePersonNameLine(line) && !looksLikeAddressLine(line)) {
        name = line;
        continue;
      }
      addressParts.push(line);
    }
    return {
      name,
      address: addressParts.join(", ").trim(),
      phone,
    };
  }

  return null;
}

function parseInlineDeliveryBlob(text, phone) {
  let working = String(text || "");
  working = working.replace(
    /\b(?:mao ni akong address|this is my address|my address is|address:?|deliver to:?)\s*/gi,
    " "
  );
  if (phone) {
    working = working.replace(phone, " ");
    const digits = phone.replace(/\D/g, "");
    if (digits) {
      working = working.replace(new RegExp(digits.split("").join("[\\s.-]*"), "g"), " ");
    }
    working = working.replace(/\s+/g, " ").trim();
  }

  const labeledName = working.match(/\b(?:name[:\s]+|contact[:\s]+)([A-Za-z][A-Za-z\s.'-]{1,40})/i);
  if (labeledName) {
    const name = labeledName[1].trim();
    const address = working.replace(labeledName[0], "").replace(/\s+/g, " ").trim();
    return { name, address: address || working.trim(), phone };
  }

  const trailingName = working.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s*$/);
  if (trailingName && working.length > trailingName[1].length + 8) {
    const name = trailingName[1].trim();
    const address = working.slice(0, trailingName.index).replace(/[,\s-]+$/g, "").trim();
    if (address.length >= 4) {
      return { name, address, phone };
    }
  }

  return null;
}

function parseCommaSeparatedDelivery(text, phone) {
  const parts = String(text || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  const phonePartIdx = parts.findIndex((part) => lineHasPhone(part));
  if (phonePartIdx < 0 && !phone) return null;
  const resolvedPhone = phone || extractPhone(parts[phonePartIdx] || "") || "";
  const content = parts.filter((_, idx) => idx !== phonePartIdx);
  if (!content.length) return null;
  if (content.length === 1) {
    return { name: "", address: content[0], phone: resolvedPhone };
  }
  const [first, second] = content;
  if (looksLikePersonNameLine(second) && !looksLikePersonNameLine(first)) {
    return { name: second, address: first, phone: resolvedPhone };
  }
  if (looksLikePersonNameLine(first) && !looksLikePersonNameLine(second)) {
    return { name: first, address: second, phone: resolvedPhone };
  }
  return { name: second, address: first, phone: resolvedPhone };
}

function parseDeliveryDetails(text) {
  const t = normalizeDeliveryInputText(text).trim();
  const phone = extractPhone(t);
  const lines = t.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  if (lines.length === 1 && t.includes(",")) {
    const commaParsed = parseCommaSeparatedDelivery(t, phone);
    if (commaParsed && (commaParsed.address || commaParsed.name)) {
      return finalizeDeliveryDetails(
        {
          raw: t,
          phone: commaParsed.phone || phone || "",
          name: commaParsed.name || "",
          address: commaParsed.address || commaParsed.name || t,
        },
        t
      );
    }
  }

  if (lines.length >= 2) {
    const parsed = parseMultilineDeliveryDetails(lines, phone);
    if (parsed && (parsed.address || parsed.name)) {
      return finalizeDeliveryDetails(
        {
          raw: t,
          phone: parsed.phone || phone || "",
          name: parsed.name || "",
          address: parsed.address || parsed.name || t,
        },
        t
      );
    }
  }

  const inline = parseInlineDeliveryBlob(t, phone);
  if (inline) {
    return finalizeDeliveryDetails(
      {
        raw: t,
        phone: inline.phone || phone || "",
        name: inline.name || "",
        address: inline.address || t,
      },
      t
    );
  }

  let name = extractName(t) || "";
  let address = t;
  if (name) address = address.replace(name, "").trim();
  if (phone) address = stripPhoneFromText(address, phone);
  address = address.replace(/\r?\n+/g, ", ").replace(/^[,.\s-]+|[,.\s-]+$/g, "").trim();

  return finalizeDeliveryDetails(
    {
      raw: t,
      phone: phone || "",
      name,
      address: address || t,
    },
    t
  );
}

function combineOrderContext(userText, recentUserTexts = []) {
  return [...recentUserTexts, userText].filter(Boolean).join("\n");
}

function stashCafeOrderHints(senderId, userText, recentUserTexts = []) {
  const contextText = combineOrderContext(userText, recentUserTexts);
  const fulfillment = detectCafeFulfillment(contextText);
  const paymentAsk = asksPaymentMode(contextText);
  const hasDeliveryInfo = looksLikeCafeDeliveryDetails(contextText);
  if (!fulfillment && !paymentAsk && !hasDeliveryInfo) return;

  pendingOrderHints.set(scopeKey(senderId), {
    fulfillment: fulfillment || "",
    paymentAsk,
    contextSnippet: contextText.slice(-800),
    updatedAt: Date.now(),
  });
}

function peekCafeOrderHints(senderId) {
  const key = scopeKey(senderId);
  const hints = pendingOrderHints.get(key);
  if (!hints) return null;
  if (Date.now() - hints.updatedAt > HINTS_TTL_MS) {
    pendingOrderHints.delete(key);
    return null;
  }
  return hints;
}

function consumeCafeOrderHints(senderId) {
  const key = scopeKey(senderId);
  const hints = peekCafeOrderHints(senderId);
  if (hints) pendingOrderHints.delete(key);
  return hints;
}

function mergeOrderContext(userText, recentUserTexts = [], hints = null) {
  const parts = [];
  if (hints?.contextSnippet) parts.push(hints.contextSnippet);
  parts.push(...recentUserTexts, userText);
  return parts.filter(Boolean).join("\n");
}

function looksLikeAddressLine(line) {
  const t = String(line || "").trim();
  if (!t) return false;
  if (ADDRESS_LINE_HINT.test(t)) return true;
  if (/[,#]/.test(t)) return true;
  if (t.length > 24) return true;
  if (t.split(/\s+/).length >= 3) return true;
  return false;
}

function looksLikePersonNameLine(line) {
  const t = String(line || "").trim();
  if (!t || t.length > 40) return false;
  if (extractPhone(t) || /\d{3,}/.test(t)) return false;
  if (ADDRESS_LINE_HINT.test(t)) return false;
  if (isOrderAcknowledgment(t) || isShortAffirmation(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 3) return false;
  if (!/^[A-Za-z][A-Za-z\s.'-]+$/.test(t)) return false;
  if (words.length === 1 && t.length >= 10) return false;
  if (/^(?:ok(?:ay)?|yes|proceed|sige|sure|confirm(?:ed)?)$/i.test(words[0])) return false;
  return true;
}

function asksPaymentMode(text) {
  return /\b(?:mode of payment|payment method|how (?:to|do i|can i) pay|uns[ay]\s*(?:ang\s*)?(?:mode|payment|bayad)|unsa(?:y|\s+man)\s*(?:ang\s*)?(?:mode|payment|bayad)|paano (?:mag)?bayad|unsaon pagbayad|accept (?:gcash|cash)|pwede (?:ba )?(?:gcash|maya|cash))\b/i.test(
    String(text || "")
  );
}

function buildPaymentModeNote(tenant) {
  if (tenant?.id === "offbeat-brew") {
    return (
      "Payment: GCash via QR code in chat — reply GCash and we'll send the QR to scan. " +
      "Cash on pickup is also OK if you choose pickup."
    );
  }
  if (tenant?.id === "kape-kristiano") {
    return (
      "Payment: GCash or UnionBank — reply GCash or UnionBank for payment details. " +
      "Send your proof of payment in this chat after paying."
    );
  }
  return "Payment: reply GCash when you're ready and we'll send payment details in chat.";
}

function deliveryOptionLine(tenant) {
  if (tenant?.id === "offbeat-brew") {
    return "• Delivery via Maxim or Grab (Iligan area — rider fee paid by you)";
  }
  if (tenant?.id === "kape-kristiano") {
    return "• Delivery via Maxim (Cebu City, Mandaue, Talisay, Lapu-Lapu — rider fee paid by you)";
  }
  return "• Delivery (see our delivery options in chat)";
}

function deliveryNotedLine(tenant) {
  if (tenant?.id === "offbeat-brew") {
    return "Noted — delivery via Maxim or Grab (Iligan area).";
  }
  if (tenant?.id === "kape-kristiano") {
    return "Noted — delivery via Maxim (Cebu City, Mandaue, Talisay, Lapu-Lapu).";
  }
  return "Noted — delivery requested.";
}

function deliveryRiderNote(tenant) {
  if (tenant?.id === "offbeat-brew") {
    return "The rider fee is paid separately to Maxim or Grab.";
  }
  if (tenant?.id === "kape-kristiano") {
    return "The Maxim delivery fee is paid separately to the rider.";
  }
  return "The delivery fee is paid separately to the rider.";
}

function buildPayPromptLine(tenant) {
  if (tenant?.id === "offbeat-brew") {
    return "Next step: reply GCash when you're ready to pay — we'll send the QR code in chat.";
  }
  if (tenant?.id === "kape-kristiano") {
    return "Next step: pay via GCash or UnionBank — reply GCash or UnionBank for details.";
  }
  return "Next step: reply GCash when you're ready to pay.";
}

function buildOrderSummaryBlock(items, tenant) {
  const summary = formatLineItemsSummary(items, tenant);
  const { total, priced } = computeOrderTotal(items, tenant);
  const lines = ["Great choice! Here's your order:", "", summary];
  if (priced) lines.push("", `Subtotal: ${formatPeso(total)}`);
  const promo = promoNote(items, tenant);
  if (promo) lines.push(promo.trim());
  return lines.join("\n");
}

function buildOrderAckAndFulfillmentPrompt(items, tenant, options = {}) {
  const { paymentAsk = false } = options;
  const lines = [buildOrderSummaryBlock(items, tenant), ""];
  if (paymentAsk) {
    lines.push(buildPaymentModeNote(tenant), "");
  }
  lines.push(
    "How would you like to receive it?",
    "• Pickup at our shop",
    deliveryOptionLine(tenant),
    "",
    "Reply pickup or delivery."
  );
  return lines.filter((line) => line !== "").join("\n");
}

function buildOrderAckForDeliveryCollect(items, tenant, options = {}) {
  const { paymentAsk = false } = options;
  const lines = [buildOrderSummaryBlock(items, tenant), "", deliveryNotedLine(tenant)];
  if (paymentAsk) {
    lines.push("", buildPaymentModeNote(tenant));
  }
  lines.push("", buildDeliveryCollectPrompt(tenant));
  return lines.join("\n");
}

function buildOrderAckForPickup(items, tenant, options = {}) {
  const { isWeekend = false, paymentAsk = false } = options;
  const lines = [buildOrderSummaryBlock(items, tenant), "", "Noted — pickup at our shop:", ""];
  if (paymentAsk) {
    lines.push(buildPaymentModeNote(tenant), "");
  }
  lines.push(`📍 ${getShopAddress(tenant)}`, `🕐 ${getShopHours(tenant)}`);
  if (isWeekend) {
    lines.push(
      "",
      "Our shop is closed today. We can prepare your order when we resume operations once payment is confirmed."
    );
  }
  lines.push(
    "",
    buildPayPromptLine(tenant).replace(/^Next step: /, "When you're ready to pay: "),
    "",
    "Reply OK when you've noted the pickup details."
  );
  return lines.join("\n");
}

function buildPhoneCollectPrompt(tenant, details = null) {
  const first = (details?.name || "").split(/\s+/)[0];
  const prefix = first ? `Almost there, ${first}!` : "Almost there!";
  return `${prefix} Please send your mobile number for the delivery rider (e.g. 09171234567).`;
}

function looksLikePartialCafeDeliveryDetails(text) {
  const t = String(text || "").trim();
  if (!t || t.length < 8 || extractPhone(t) || isOrderAcknowledgment(t)) return false;
  const lines = t.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const hasAddress = lines.some((line) => looksLikeAddressLine(line) || ADDRESS_LINE_HINT.test(line));
  const hasName = lines.some((line) => looksLikePersonNameLine(line));
  return hasAddress && hasName;
}

function parsePartialDeliveryBlock(recentUserTexts = [], userText = "", tenant = null) {
  const block = extractLatestDeliveryBlock(recentUserTexts, userText, tenant);
  const t = String(block || userText || "").trim();
  if (!t) return null;
  if (extractPhone(t)) return parseDeliveryDetails(t);
  const lines = t.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const parsed = parseMultilineDeliveryDetails(lines, "");
  if (!parsed || (!parsed.address && !parsed.name)) return null;
  return finalizeDeliveryDetails(
    {
      raw: t,
      phone: "",
      name: parsed.name || "",
      address: parsed.address || parsed.name || "",
    },
    t
  );
}

function buildDeliveryCollectPrompt(tenant) {
  if (tenant?.id === "offbeat-brew") {
    return (
      "Delivery via Maxim or Grab (Iligan area). Please send in one message:\n\n" +
      "1) Complete delivery address\n" +
      "2) Contact name\n" +
      "3) Mobile number\n\n" +
      "The rider fee is paid by you separately from your drink order."
    );
  }
  if (tenant?.id === "kape-kristiano") {
    return (
      "Delivery via Maxim (Cebu City, Mandaue, Talisay, Lapu-Lapu). Please send in one message:\n\n" +
      "1) Complete delivery address\n" +
      "2) Contact name\n" +
      "3) Mobile number\n\n" +
      "The Maxim delivery fee is paid by you separately from your order."
    );
  }
  return (
    "Please send your complete delivery address, contact name, and mobile number in one message."
  );
}

function buildPickupInstructions(tenant, options = {}) {
  const { isWeekend = false } = options;
  const lines = [
    "Great — pickup at our shop:",
    "",
    `📍 ${getShopAddress(tenant)}`,
    `🕐 ${getShopHours(tenant)}`,
  ];
  if (isWeekend) {
    lines.push(
      "",
      "Our shop is closed today. We can prepare your order when we resume operations once payment is confirmed."
    );
  }
  lines.push(
    "",
    buildPayPromptLine(tenant).replace(/^Next step: /, ""),
    "",
    "Reply OK when you've noted the pickup details."
  );
  return lines.join("\n");
}

function buildOrderClosure(session, tenant, options = {}) {
  const { agentAvailable = false, fulfillment = "delivery", details = null } = options;
  const brand = businessName(tenant);
  const summary = formatLineItemsSummary(session.items, tenant);
  const { total, priced } = computeOrderTotal(session.items, tenant);
  const firstName = (details?.name || "").split(/\s+/)[0];

  const lines = [
    firstName ? `Thanks, ${firstName}!` : "Thanks!",
    "",
    "Here's your order summary:",
    summary,
  ];
  if (priced) lines.push(`Total: ${formatPeso(total)}`);

  if (fulfillment === "delivery" && details) {
    lines.push(
      "",
      "Delivery details:",
      `• Name: ${details.name || "(please confirm if missing)"}`,
      `• Address: ${details.address || details.raw || "(please confirm if missing)"}`,
      `• Contact: ${details.phone || "(please confirm if missing)"}`,
      "",
      `We'll arrange delivery once payment is confirmed. ${deliveryRiderNote(tenant)}`
    );
  } else if (fulfillment === "pickup") {
    lines.push("", "Your pickup order is noted.");
  }

  lines.push(
    promoNote(session.items, tenant),
    "",
    buildPayPromptLine(tenant),
    "After paying, send your payment screenshot here. Our team will confirm and prepare your order.",
    "",
    `Thank you for choosing ${brand}!`
  );

  if (agentAvailable) {
    lines.push("", "Need a person? Reply YES and a team member can follow up.");
  }

  return lines.filter((line) => line !== "").join("\n");
}

function buildOrderReminderReply(session, tenant) {
  const summary = formatLineItemsSummary(session.items, tenant);
  const { total, priced } = computeOrderTotal(session.items, tenant);
  const lines = [
    "No worries — I still have your order on file:",
    "",
    summary,
  ];
  if (priced) lines.push(`Total: ${formatPeso(total)}`);
  if (session.fulfillment === "delivery" && session.deliveryDetails) {
    const d = session.deliveryDetails;
    lines.push(
      "",
      "Delivery to:",
      `• ${d.name || "—"}`,
      `• ${d.address || d.raw || "—"}`,
      `• ${d.phone || "—"}`
    );
  }
  lines.push(
    "",
    session.step === "awaiting_payment"
      ? `We're waiting for payment — ${buildPayPromptLine(tenant).replace(/^Next step: /, "").toLowerCase()} Send your payment screenshot if you already paid.`
      : "Reply pickup or delivery if we still need that, or ask about payment when you're ready."
  );
  return lines.join("\n");
}

function buildCafeOrderSystemNote(senderId, tenant) {
  const session = getSession(senderId);
  if (!session?.items?.length) return "";
  const summary = formatLineItemsSummary(session.items, tenant);
  const parts = [
    "ACTIVE CAFE ORDER (strict): The customer is mid-order. Do NOT ask what drink or item they want again.",
    `Items: ${summary.replace(/\n/g, "; ")}`,
  ];
  if (session.fulfillment) parts.push(`Fulfillment: ${session.fulfillment}`);
  if (session.deliveryDetails) {
    const d = session.deliveryDetails;
    parts.push(`Delivery name: ${d.name || "—"}`);
    parts.push(`Delivery address: ${d.address || d.raw || "—"}`);
    parts.push(`Delivery phone: ${d.phone || "—"}`);
  }
  if (session.step === "awaiting_payment") {
    parts.push(
      "Status: awaiting payment — remind them to reply GCash for QR or send payment proof. Do NOT restart the order from scratch."
    );
  } else if (session.step === "confirm_quantity") {
    parts.push("Status: awaiting quantity — ask how many bottles they want, then pickup or delivery.");
  } else if (session.step === "offer_resume") {
    parts.push(
      "Status: pending order on file — customer asked to order again. Offer YES to continue this order or let them pick something else."
    );
  } else if (session.step === "confirm_order") {
    parts.push("Status: awaiting customer OK on order summary before payment.");
  } else if (session.step === "choose_fulfillment") {
    parts.push("Status: awaiting pickup or delivery choice.");
  } else if (session.step === "delivery_collect") {
    parts.push("Status: awaiting delivery address, contact name, and mobile number.");
  } else if (session.step === "pickup_pending") {
    parts.push("Status: pickup order — confirm and guide to payment when ready.");
  }
  parts.push(
    "CLOSING (strict): Help close the sale — after side questions, steer back to the next missing step. Never abandon the pending order silently."
  );
  return parts.join("\n");
}

function hasCafeOrderIntent(text, historyTexts = [], tenant, options = {}) {
  const { lastAssistantReply = "" } = options;
  if (isSimpleGreeting(text)) return false;

  const t = String(text || "").trim();
  if (CAFE_ORDER_INTENT.test(t)) return true;
  if (detectCafeFulfillment(t)) return true;

  const items = parseCafeOrderFromText(t, tenant);
  if (!items?.length) return false;

  const lastBot = String(lastAssistantReply || "");
  if (
    /\bout of stock\b/i.test(lastBot) ||
    /\bmay i suggest\b/i.test(lastBot) ||
    /\binstead\?\b/i.test(lastBot)
  ) {
    return true;
  }

  return historyTexts.some(
    (entry) =>
      CAFE_ORDER_INTENT.test(entry) ||
      /\bout of stock\b/i.test(entry) ||
      /\bmay i suggest\b/i.test(entry) ||
      /\binstead\?\b/i.test(entry)
  );
}

function filterInStockItems(items) {
  try {
    const { isProductIdOutOfStock } = require("./inventory-availability");
    return items.filter((item) => !isProductIdOutOfStock(item.productId));
  } catch {
    return items;
  }
}

function completeDeliveryOrder(senderId, session, tenant, details, options = {}, trigger = "cafe order delivery complete") {
  const { agentAvailable = false, paymentAsk = false } = options;
  session.step = "awaiting_payment";
  session.fulfillment = "delivery";
  session.deliveryDetails = details;
  session.updatedAt = Date.now();
  sessions.set(scopeKey(senderId), session);

  let reply = buildOrderClosure(session, tenant, {
    agentAvailable,
    fulfillment: "delivery",
    details,
  });
  if (paymentAsk) {
    reply = `${buildPaymentModeNote(tenant)}\n\n${reply}`;
  }

  return {
    handled: true,
    reply,
    captureOrder: {
      cafeOrderCapture: true,
      isOrderIntent: true,
      fulfillment: "delivery",
      orderStatus: "awaiting_payment",
      address: details.address || details.raw,
      phone: details.phone,
      name: details.name,
      bean: session.items.map((i) => `${i.qty}× ${i.label}`).join(", "),
      lineItems: formatLineItemsSummary(session.items, tenant),
      trigger,
    },
    notifyDelivery: true,
  };
}

function detectCafeFulfillment(text) {
  const base = detectFulfillment(text);
  if (base) return base;
  const t = String(text || "");
  if (/\b(?:pa[\s-]?deliver|deliver lang|ipadala|hatod lang|pa[\s-]?hatod|padala lang|deliver nako|hatod nako)\b/i.test(t)) {
    return "delivery";
  }
  if (/\b(?:for delivery|this is for delivery|want (?:it |this )?(?:for )?delivery|delivery please|via delivery|for deliver)\b/i.test(t)) {
    return "delivery";
  }
  if (/\b(?:for pickup|this is for pickup|pickup please)\b/i.test(t)) {
    return "pickup";
  }
  if (/\b(?:pickup lang|kuhaon? sa shop|moadto ko sa shop)\b/i.test(t)) {
    return "pickup";
  }
  return "";
}

function parseMessageQuantity(text, items = []) {
  return parseQuantityFromReply(text, items);
}

const CAFE_STEP_RANK = {
  offer_resume: 1,
  confirm_quantity: 2,
  choose_fulfillment: 3,
  delivery_collect: 4,
  pickup_pending: 4,
  confirm_order: 5,
  awaiting_payment: 6,
  closed: 99,
};

function hasUsableDeliveryDetails(details) {
  return Boolean(
    details &&
      (details.phone || details.address || details.name) &&
      (details.phone || (details.address && details.name))
  );
}

function hasCompleteDeliveryDetails(details) {
  return Boolean(details?.phone && (details.address || details.name));
}

function parseHolisticOrderMessage(text, recentUserTexts = [], tenant, session) {
  const contextText = mergeOrderContext(text, recentUserTexts);
  const itemsInMsg = filterInStockItems(parseCafeOrderFromText(text, tenant) || []);
  let items = itemsInMsg.length
    ? applyExplicitQuantities(itemsInMsg, contextText)
    : applyExplicitQuantities(
        (session?.items || []).map((item) => ({ ...item })),
        contextText
      );

  const qty =
    parseMessageQuantity(text, items) ||
    parseMessageQuantity(contextText, items) ||
    null;
  if (qty) {
    for (const item of items) item.qty = qty;
  }

  const fulfillment =
    detectCafeFulfillment(text) ||
    detectCafeFulfillment(contextText) ||
    session?.fulfillment ||
    "";

  const deliveryBlock = extractLatestDeliveryBlock(recentUserTexts, text, tenant);
  const shouldResolveDelivery =
    fulfillment === "delivery" ||
    looksLikeCafeDeliveryDetails(deliveryBlock) ||
    looksLikePartialCafeDeliveryDetails(deliveryBlock) ||
    Boolean(session?.deliveryDetails);
  const deliveryDetails = shouldResolveDelivery
    ? resolveDeliveryDetails(session?.deliveryDetails || null, recentUserTexts, text, tenant)
    : session?.deliveryDetails || null;

  const hasQty = items.length > 0 && items.every((item) => item.qty > 0);
  const hasExplicitQty = hasExplicitQuantity(text, contextText, items, session);
  const hasPartialDelivery = hasUsableDeliveryDetails(deliveryDetails);
  const hasFullDelivery = hasCompleteDeliveryDetails(deliveryDetails);
  const paymentAsk = asksPaymentMode(text) || asksPaymentMode(contextText);

  return {
    items,
    qty,
    fulfillment,
    deliveryDetails,
    deliveryBlock,
    hasQty,
    hasExplicitQty,
    hasPartialDelivery,
    hasFullDelivery,
    hasDeliveryDetails: hasFullDelivery,
    paymentAsk,
    itemsInMsg: itemsInMsg.length > 0,
    contextText,
  };
}

function inferStepFromHolistic(parsed, session = null) {
  const { hasExplicitQty, hasQty, fulfillment, hasPartialDelivery, hasFullDelivery } = parsed;
  if (!hasQty || !hasExplicitQty) return "confirm_quantity";
  if (fulfillment === "delivery") {
    if (hasFullDelivery || hasPartialDelivery) return "confirm_order";
    return "delivery_collect";
  }
  if (fulfillment === "pickup") return "confirm_order";
  return "choose_fulfillment";
}

function hasExplicitQuantity(text, contextText, items, session = null) {
  if (parseMessageQuantity(text, items) || parseMessageQuantity(contextText, items)) return true;
  if (messageSpecifiesQuantity(text) || messageSpecifiesQuantity(contextText)) return true;
  if (session?.step && (CAFE_STEP_RANK[session.step] || 0) >= CAFE_STEP_RANK.choose_fulfillment) {
    return items.length > 0 && items.every((item) => item.qty > 0);
  }
  return false;
}

function messageContainsOrderProgress(text, session, tenant, recentUserTexts = []) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (isCafeOrderCancellation(t) || isCafeOrderChangeRequest(t)) return true;
  if (messageNamesCafeProduct(t, tenant)) return true;
  if (parseMessageQuantity(t, session?.items || []) || parseMessageQuantity(mergeOrderContext(t, recentUserTexts), session?.items || [])) {
    return true;
  }
  if (detectCafeFulfillment(t)) return true;
  if (isOrderAcknowledgment(t) || /^confirm(ed)?$/i.test(t)) return true;
  const block = extractLatestDeliveryBlock(recentUserTexts, t, tenant);
  if (
    looksLikeCafeDeliveryDetails(block) ||
    looksLikePartialCafeDeliveryDetails(block) ||
    looksLikeCafeDeliveryDetails(t) ||
    looksLikePartialCafeDeliveryDetails(t) ||
    lineHasPhone(t)
  ) {
    return true;
  }
  if (asksPaymentMode(t)) return true;
  return false;
}

function hasEmbeddedSideQuestion(text, tenant, session = null, recentUserTexts = []) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (hasMixedProductQuestion(t)) return true;
  if (OFF_TOPIC_CAFE_CHAT.test(t)) return true;
  if (isMenuBrowseMessage(t, tenant)) return true;
  const hasOrder = session
    ? messageContainsOrderProgress(t, session, tenant, recentUserTexts)
    : Boolean(parseCafeOrderFromText(t, tenant)?.length || detectCafeFulfillment(t));
  if (!hasOrder) return false;
  if (/\?/.test(t)) return true;
  if (
    /\b(?:what|how|where|when|why|who|do you|can you|are you|tell me|unsay|unsa|ano|paano|pwede|pila|asa|kanus|kinsa|sino)\b/i.test(
      t
    )
  ) {
    return true;
  }
  return false;
}

function sessionMadeProgress(session, parsed) {
  if (parsed.qty && session.step === "confirm_quantity") return true;
  const prevRank = CAFE_STEP_RANK[session.step] || 0;
  const nextStep = inferStepFromHolistic(parsed, session);
  const nextRank = CAFE_STEP_RANK[nextStep] || 0;
  if (nextRank > prevRank) return true;
  if (parsed.itemsInMsg) return true;
  if (parsed.hasExplicitQty && session.step === "confirm_quantity") return true;
  if (parsed.fulfillment && !session.fulfillment) return true;
  if (parsed.fulfillment && parsed.fulfillment !== session.fulfillment) return true;
  if (parsed.deliveryDetails) {
    const old = session.deliveryDetails || {};
    const neu = parsed.deliveryDetails;
    if ((neu.phone && neu.phone !== old.phone) || (neu.address && neu.address !== old.address) || (neu.name && neu.name !== old.name)) {
      return true;
    }
  }
  return false;
}

function buildHolisticAdvanceReply(session, tenant, parsed, options = {}) {
  const { paymentAsk = false, isWeekend = false } = options;
  if (session.step === "confirm_order") {
    return buildOrderConfirmationReply(session, tenant, {
      fulfillment: session.fulfillment,
      details: session.deliveryDetails,
      paymentAsk: paymentAsk || parsed.paymentAsk,
    });
  }
  if (session.step === "choose_fulfillment") {
    return buildOrderAckAndFulfillmentPrompt(session.items, tenant, {
      paymentAsk: paymentAsk || parsed.paymentAsk,
    });
  }
  if (session.step === "delivery_collect") {
    const lines = [buildOrderAckForDeliveryCollect(session.items, tenant, { paymentAsk: paymentAsk || parsed.paymentAsk })];
    if (parsed.hasPartialDelivery && session.deliveryDetails) {
      const d = session.deliveryDetails;
      lines.push(
        "",
        "I already have some delivery info — send anything missing, or confirm if complete:",
        `• Name: ${d.name || "(missing)"}`,
        `• Address: ${d.address || d.raw || "(missing)"}`,
        `• Contact: ${d.phone || "(missing)"}`
      );
    }
    return lines.join("\n");
  }
  if (session.step === "confirm_quantity") {
    return buildQuantityPrompt(session.items, tenant);
  }
  if (session.step === "pickup_pending") {
    return buildOrderAckForPickup(session.items, tenant, { isWeekend, paymentAsk: paymentAsk || parsed.paymentAsk });
  }
  return buildOrderReminderReply(session, tenant);
}

function buildHolisticCaptureMeta(session, tenant, trigger) {
  return {
    cafeOrderCapture: true,
    isOrderIntent: true,
    bean: session.items.map((i) => `${i.qty}× ${i.label}`).join(", "),
    lineItems: formatLineItemsSummary(session.items, tenant),
    fulfillment: session.fulfillment || undefined,
    orderStatus: session.step === "confirm_order" ? "pending_confirm" : "inquiry",
    address: session.deliveryDetails?.address || session.deliveryDetails?.raw,
    phone: session.deliveryDetails?.phone,
    name: session.deliveryDetails?.name,
    trigger,
  };
}

function applyHolisticParsedToSession(session, parsed) {
  if (parsed.items?.length) session.items = parsed.items;
  if (parsed.fulfillment) session.fulfillment = parsed.fulfillment;
  if (parsed.deliveryDetails) session.deliveryDetails = parsed.deliveryDetails;
  session.step = inferStepFromHolistic(parsed, session);
}

function tryHolisticSessionAdvance(senderId, session, text, tenant, options = {}) {
  const { recentUserTexts = [], paymentAskCurrent = false, isWeekend = false } = options;
  if (!session?.items?.length) return { handled: false };
  if (session.step === "offer_resume" || session.step === "closed") return { handled: false };

  const parsed = parseHolisticOrderMessage(text, recentUserTexts, tenant, session);
  const sideQuestion = hasEmbeddedSideQuestion(text, tenant, session, recentUserTexts);
  const progress = sessionMadeProgress(session, parsed);

  if (session.step === "awaiting_payment") {
    if (!progress && !sideQuestion) return { handled: false };
    applyHolisticParsedToSession(session, parsed);
    touchSessionActivity(session);
    sessions.set(scopeKey(senderId), session);
    if (sideQuestion && !progress) return { handled: false, digression: true };
    return {
      handled: true,
      reply: buildOrderReminderReply(session, tenant),
    };
  }

  if (!progress && !sideQuestion) return { handled: false };

  if (progress) {
    applyHolisticParsedToSession(session, parsed);
    touchSessionActivity(session);
    sessions.set(scopeKey(senderId), session);
    if (sideQuestion) {
      return { handled: false, digression: true };
    }
    return {
      handled: true,
      reply: buildHolisticAdvanceReply(session, tenant, parsed, {
        paymentAsk: paymentAskCurrent,
        isWeekend,
      }),
      captureOrder: buildHolisticCaptureMeta(session, tenant, "cafe order holistic advance"),
      notifyDelivery:
        session.step === "confirm_order" &&
        session.fulfillment === "delivery" &&
        hasCompleteDeliveryDetails(session.deliveryDetails),
    };
  }

  if (sideQuestion) return { handled: false, digression: true };
  return { handled: false };
}

function resolveRichOrderFromMessage(userText, recentUserTexts, tenant, items, hints = null) {
  const baseSession = { items: items.map((i) => ({ ...i })), fulfillment: "", deliveryDetails: null, step: "confirm_quantity" };
  const parsed = parseHolisticOrderMessage(userText, recentUserTexts, tenant, baseSession);
  if (hints?.fulfillment && !parsed.fulfillment) {
    parsed.fulfillment = hints.fulfillment;
  }
  if (hints?.paymentAsk) parsed.paymentAsk = true;
  parsed.items = parsed.items.length ? parsed.items : baseSession.items;
  return parsed;
}

function determineStepFromRichOrder(resolved, session = null) {
  return inferStepFromHolistic(resolved, session);
}

function buildRichMixedOrderReply(items, tenant, resolved) {
  const { qty, fulfillment, hasDeliveryDetails, paymentAsk } = resolved;
  const lines = [];
  for (const item of items) {
    const blurb = getProductBlurb(tenant, item.productId);
    lines.push(blurb || `${item.label} — one of our menu items.`);
  }

  const hasQty = qty || items.every((i) => i.qty > 0);
  if (hasQty || fulfillment) {
    const noted = [];
    if (hasQty) noted.push(items.map((i) => `${i.qty}× ${i.label}`).join(", "));
    if (fulfillment === "delivery") noted.push("Delivery");
    else if (fulfillment === "pickup") noted.push("Pickup");
    lines.push("", "Got it — here's what I have:", noted.map((n) => `• ${n}`).join("\n"));
  }

  if (paymentAsk) {
    lines.push("", buildPaymentModeNote(tenant));
  }

  if (fulfillment === "delivery" && hasDeliveryDetails) {
    // Caller should use buildOrderConfirmationReply instead.
  } else if (fulfillment === "delivery" && hasQty) {
    lines.push("", deliveryNotedLine(tenant), "", buildDeliveryCollectPrompt(tenant));
  } else if (fulfillment === "pickup" && hasQty) {
    lines.push("", "Reply OK to confirm, or send any changes.");
  } else if (hasQty && !fulfillment) {
    lines.push(
      "",
      "How would you like to receive it?",
      "• Pickup at our shop",
      deliveryOptionLine(tenant),
      "",
      "Reply pickup or delivery."
    );
  } else {
    lines.push("", `How many would you like${quantityUnitHint(tenant)}? You can say it naturally (e.g. 2, two bottles) or include other questions in the same message.`);
  }

  return lines.filter(Boolean).join("\n\n");
}

function buildRichOrderCaptureMeta(items, tenant, resolved, step) {
  const captureBase = {
    cafeOrderCapture: true,
    isOrderIntent: true,
    bean: items.map((i) => `${i.qty}× ${i.label}`).join(", "),
    lineItems: formatLineItemsSummary(items, tenant),
  };
  if (resolved.fulfillment) captureBase.fulfillment = resolved.fulfillment;
  if (step === "confirm_order") {
    captureBase.orderStatus = "pending_confirm";
  } else if (step === "delivery_collect") {
    captureBase.orderStatus = "inquiry";
  } else {
    captureBase.orderStatus = "inquiry";
  }
  return captureBase;
}

function tryStartCafeOrderFlow(senderId, userText, tenant, options = {}) {
  if (!isCafeOrderFlowEnabled(tenant)) return { started: false };
  if (getSession(senderId)) return { started: false };

  const {
    recentUserTexts = [],
    isWeekend = false,
    agentAvailable = false,
    lastAssistantReply = "",
  } = options;

  if (isOrderAcknowledgment(userText)) {
    const pending = peekPendingCafeOrderItems(senderId);
    const contextText = mergeOrderContext("", recentUserTexts, peekCafeOrderHints(senderId));
    let items =
      pending?.items ||
      filterInStockItems(parseCafeOrderFromText(contextText, tenant) || []);
    const shouldContinue =
      items.length &&
      (pending ||
        lastReplyInvitesOrder(lastAssistantReply) ||
        lastReplyDescribesProduct(lastAssistantReply) ||
        recentContextHasOrderIntent(recentUserTexts));
    if (shouldContinue) {
      consumePendingCafeOrderItems(senderId);
      consumeCafeOrderHints(senderId);
      startSession(senderId, {
        items,
        tenantId: tenant.id,
        step: "confirm_quantity",
      });
      const captureBase = {
        cafeOrderCapture: true,
        isOrderIntent: true,
        bean: items.map((i) => `${i.qty}× ${i.label}`).join(", "),
        lineItems: formatLineItemsSummary(items, tenant),
      };
      return {
        started: true,
        reply: buildQuantityPrompt(items, tenant),
        captureOrder: {
          ...captureBase,
          orderStatus: "inquiry",
          trigger: "cafe order ack continue",
        },
      };
    }
  }

  if (isSimpleGreeting(userText)) {
    resetCafeOrderContext(senderId);
    return { started: false };
  }

  if (hasMixedProductQuestion(userText)) {
    const contextText = mergeOrderContext(userText, recentUserTexts, peekCafeOrderHints(senderId));
    let items = filterInStockItems(parseCafeOrderFromText(userText, tenant) || []);
    if (!items.length) {
      items = filterInStockItems(parseCafeOrderFromText(contextText, tenant) || []);
    }
    const orderish =
      hasCafeOrderIntent(userText, recentUserTexts, tenant, { lastAssistantReply }) ||
      CAFE_ORDER_INTENT.test(userText);
    if (items.length && orderish) {
      const resolved = resolveRichOrderFromMessage(
        userText,
        recentUserTexts,
        tenant,
        items,
        peekCafeOrderHints(senderId)
      );
      items = resolved.items;
      const step = determineStepFromRichOrder(resolved);
      const sessionData = {
        items,
        tenantId: tenant.id,
        step,
        fulfillment: resolved.fulfillment || "",
      };
      if (
        step === "confirm_order" &&
        resolved.fulfillment === "delivery" &&
        resolved.hasDeliveryDetails
      ) {
        sessionData.deliveryDetails = parseDeliveryDetails(resolved.deliveryBlock);
      }
      consumeCafeOrderHints(senderId);
      consumePendingCafeOrderItems(senderId);
      const session = startSession(senderId, sessionData);
      const captureBase = buildRichOrderCaptureMeta(items, tenant, resolved, step);
      let reply;
      if (step === "confirm_order") {
        reply = buildOrderConfirmationReply(session, tenant, {
          fulfillment: resolved.fulfillment,
          details: session.deliveryDetails,
          paymentAsk: resolved.paymentAsk,
        });
      } else {
        reply = buildRichMixedOrderReply(items, tenant, resolved);
      }
      const captureOrder = {
        ...captureBase,
        trigger: "cafe order product question",
      };
      if (step === "confirm_order" && resolved.fulfillment === "delivery" && session.deliveryDetails) {
        const details = session.deliveryDetails;
        captureOrder.address = details.address || details.raw;
        captureOrder.phone = details.phone;
        captureOrder.name = details.name;
      }
      return {
        started: true,
        reply,
        skipNudge: true,
        captureOrder,
      };
    }
    if (items.length) {
      stashPendingCafeOrderItems(senderId, items, tenant.id);
    }
    return { started: false };
  }

  if (isMenuBrowseMessage(userText, tenant)) {
    resetCafeOrderContext(senderId);
    return { started: false };
  }

  let hints = peekCafeOrderHints(senderId);
  const fulfillmentInCurrent = detectCafeFulfillment(userText);
  const deliveryInCurrent = looksLikeCafeDeliveryDetails(
    extractLatestDeliveryBlock([], userText)
  );
  if (!fulfillmentInCurrent && !deliveryInCurrent) {
    consumeCafeOrderHints(senderId);
    hints = null;
  }

  const contextText = mergeOrderContext(userText, recentUserTexts, hints);

  if (isGenericCafeOrderInquiry(userText, tenant)) {
    const fulfillment = detectCafeFulfillment(userText);
    const freshStart = isFulfillmentOnlyIntent(userText, tenant) || fulfillment;
    const pending = freshStart ? null : peekPendingCafeOrderItems(senderId);
    if (pending?.items?.length) {
      consumeCafeOrderHints(senderId);
      consumePendingCafeOrderItems(senderId);
      startSession(senderId, {
        items: pending.items.map((i) => ({ ...i })),
        tenantId: tenant.id,
        step: "offer_resume",
      });
      return {
        started: true,
        reply: buildPendingOrderResumeReply(pending.items, tenant),
        captureOrder: {
          cafeOrderCapture: true,
          isOrderIntent: true,
          bean: pending.items.map((i) => `${i.qty}× ${i.label}`).join(", "),
          lineItems: formatLineItemsSummary(pending.items, tenant),
          orderStatus: "inquiry",
          trigger: "cafe order resume offer",
        },
      };
    }
    resetCafeOrderContext(senderId);
    if (fulfillment) {
      stashCafeOrderHints(senderId, userText, recentUserTexts);
    }
    return {
      started: true,
      reply: buildGenericOrderStartReply(tenant, { fulfillment }),
      captureOrder: {
        cafeOrderCapture: true,
        isOrderIntent: true,
        stage: "browsing",
        trigger: "cafe generic order",
      },
    };
  }

  let items = filterInStockItems(parseCafeOrderFromText(userText, tenant) || []);
  if (
    !items.length &&
    !isGenericCafeOrderInquiry(userText, tenant) &&
    !isFulfillmentOnlyIntent(userText, tenant) &&
    isActiveOrderContinuation(userText, lastAssistantReply, tenant)
  ) {
    items = filterInStockItems(parseCafeOrderFromText(contextText, tenant) || []);
  }
  if (!items.length) return { started: false };
  items = applyExplicitQuantities(items, contextText);
  if (!hasCafeOrderIntent(userText, recentUserTexts, tenant, { lastAssistantReply })) {
    return { started: false };
  }

  let fulfillment = fulfillmentInCurrent;
  const paymentAsk = asksPaymentMode(userText);
  const deliveryBlock = extractLatestDeliveryBlock(recentUserTexts, userText, tenant);
  const captureBase = {
    cafeOrderCapture: true,
    isOrderIntent: true,
    bean: items.map((i) => `${i.qty}× ${i.label}`).join(", "),
    lineItems: formatLineItemsSummary(items, tenant),
  };

  if (fulfillment === "delivery" && looksLikeCafeDeliveryDetails(deliveryBlock)) {
    const details = resolveDeliveryDetails(null, recentUserTexts, deliveryBlock, tenant);
    consumeCafeOrderHints(senderId);
    const session = startSession(senderId, {
      items,
      tenantId: tenant.id,
      step: "confirm_order",
      fulfillment: "delivery",
      deliveryDetails: details,
    });
    return {
      started: true,
      reply: buildOrderConfirmationReply(session, tenant, {
        fulfillment: "delivery",
        details,
        paymentAsk,
      }),
      captureOrder: {
        ...captureBase,
        fulfillment: "delivery",
        orderStatus: "pending_confirm",
        address: details.address || details.raw,
        phone: details.phone,
        name: details.name,
        trigger: "cafe order one-shot delivery",
      },
    };
  }

  if (fulfillment === "delivery") {
    consumeCafeOrderHints(senderId);
    startSession(senderId, {
      items,
      tenantId: tenant.id,
      step: "delivery_collect",
      fulfillment: "delivery",
    });
    const detailLines = [];
    if (deliveryInCurrent && looksLikeCafeDeliveryDetails(deliveryBlock)) {
      const partial = resolveDeliveryDetails(null, recentUserTexts, deliveryBlock, tenant);
      if (partial.address || partial.name || partial.phone) {
        detailLines.push(
          "",
          "We already have some delivery info from your earlier message — send any missing details, or confirm if this is complete:",
          `• Name: ${partial.name || "(missing)"}`,
          `• Address: ${partial.address || partial.raw || "(missing)"}`,
          `• Contact: ${partial.phone || "(missing)"}`
        );
      }
    }
    return {
      started: true,
      reply: `${buildOrderAckForDeliveryCollect(items, tenant, { paymentAsk })}${detailLines.join("\n")}`,
      captureOrder: {
        ...captureBase,
        fulfillment: "delivery",
        orderStatus: "inquiry",
        trigger: "cafe order started delivery",
      },
    };
  }

  if (fulfillment === "pickup") {
    consumeCafeOrderHints(senderId);
    const needsQty = !messageSpecifiesQuantity(userText);
    if (!needsQty) {
      const session = startSession(senderId, {
        items,
        tenantId: tenant.id,
        step: "confirm_order",
        fulfillment: "pickup",
      });
      return {
        started: true,
        reply: buildOrderConfirmationReply(session, tenant, {
          fulfillment: "pickup",
          paymentAsk,
        }),
        captureOrder: {
          ...captureBase,
          fulfillment: "pickup",
          orderStatus: "pending_confirm",
          trigger: "cafe order one-shot pickup",
        },
      };
    }
    startSession(senderId, {
      items,
      tenantId: tenant.id,
      step: "pickup_pending",
      fulfillment: "pickup",
    });
    return {
      started: true,
      reply: buildOrderAckForPickup(items, tenant, { isWeekend, paymentAsk }),
      captureOrder: {
        ...captureBase,
        fulfillment: "pickup",
        orderStatus: "inquiry",
        trigger: "cafe order started pickup",
      },
    };
  }

  consumeCafeOrderHints(senderId);
  const resolved = resolveRichOrderFromMessage(userText, recentUserTexts, tenant, items, hints);
  const step = determineStepFromRichOrder(resolved);
  const sessionData = {
    items: resolved.items,
    tenantId: tenant.id,
    step,
    fulfillment: resolved.fulfillment || "",
  };
  if (resolved.fulfillment === "delivery" && resolved.deliveryDetails) {
    sessionData.deliveryDetails = resolved.deliveryDetails;
  }
  const session = startSession(senderId, sessionData);
  let reply;
  if (step === "confirm_order") {
    reply = buildOrderConfirmationReply(session, tenant, {
      fulfillment: resolved.fulfillment,
      details: session.deliveryDetails,
      paymentAsk: resolved.paymentAsk,
    });
  } else {
    reply = buildHolisticAdvanceReply(session, tenant, resolved, {
      paymentAsk: resolved.paymentAsk,
      isWeekend,
    });
  }
  return {
    started: true,
    reply,
    captureOrder: {
      ...captureBase,
      fulfillment: resolved.fulfillment || undefined,
      orderStatus: step === "confirm_order" ? "pending_confirm" : "inquiry",
      address: session.deliveryDetails?.address || session.deliveryDetails?.raw,
      phone: session.deliveryDetails?.phone,
      name: session.deliveryDetails?.name,
      trigger:
        step === "confirm_quantity"
          ? "cafe order quantity"
          : step === "confirm_order"
            ? "cafe order one-shot confirm"
            : "cafe order started",
    },
  };
}

function tryResumeCafeOrderFlow(senderId, userText, tenant, options = {}) {
  if (!isCafeOrderFlowEnabled(tenant)) return { resumed: false };
  if (getSession(senderId)) return { resumed: false };
  if (isCafeOrderCancellation(userText)) {
    resetCafeOrderContext(senderId);
    return { resumed: false };
  }
  if (isSimpleGreeting(userText) || isOffTopicCafeOrderMessage(userText, tenant)) {
    return { resumed: false };
  }

  const { lastAssistantReply = "", recentUserTexts = [] } = options;
  const last = String(lastAssistantReply || "");
  if (!last) return { resumed: false };

  const historyText = [...recentUserTexts, userText].join("\n");
  const items = parseCafeOrderFromText(historyText, tenant);
  if (!items?.length) return { resumed: false };

  const askedFulfillment =
    /pick[- ]?up|delivery|rider|maxim|grab|receive your order|how would you like/i.test(last) &&
    /(?:order|offbeat|white|black|mocha|dulce|drink|bottle|coffee)/i.test(last);

  const askedDeliveryDetails =
    /(?:complete address|contact name|mobile number|delivery address|send (?:me|us)|give me your)/i.test(
      last
    );

  if (askedDeliveryDetails) {
    const deliveryBlock = extractLatestDeliveryBlock(recentUserTexts, userText, tenant);
    const hasFull = looksLikeCafeDeliveryDetails(deliveryBlock) || looksLikeCafeDeliveryDetails(userText);
    const hasPartial =
      looksLikePartialCafeDeliveryDetails(deliveryBlock) || looksLikePartialCafeDeliveryDetails(userText);
    const hasPhone = Boolean(extractPhoneFromMessageHistory(recentUserTexts, userText));
    if (!hasFull && !hasPartial && !hasPhone) return { resumed: false };

    const details = resolveDeliveryDetails(null, recentUserTexts, userText, tenant);
    const step =
      details?.phone && (details.address || details.name) ? "confirm_order" : "delivery_collect";
    consumeCafeOrderHints(senderId);
    startSession(senderId, {
      items,
      tenantId: tenant.id,
      step,
      fulfillment: "delivery",
      deliveryDetails: details?.address || details?.name || details?.phone ? details : null,
    });
    return { resumed: true, processNow: true };
  }

  if (askedFulfillment) {
    let resolvedFulfillment = detectCafeFulfillment(userText);
    const deliveryBlock = extractLatestDeliveryBlock(recentUserTexts, userText, tenant);
    if (
      !resolvedFulfillment &&
      (looksLikeCafeDeliveryDetails(deliveryBlock) || looksLikePartialCafeDeliveryDetails(deliveryBlock))
    ) {
      resolvedFulfillment = "delivery";
    }
    if (!resolvedFulfillment) return { resumed: false };

    if (resolvedFulfillment === "delivery") {
      const details = resolveDeliveryDetails(null, recentUserTexts, userText, tenant);
      const step =
        details?.phone && (details.address || details.name) ? "confirm_order" : "delivery_collect";
      consumeCafeOrderHints(senderId);
      startSession(senderId, {
        items,
        tenantId: tenant.id,
        step,
        fulfillment: "delivery",
        deliveryDetails: details?.address || details?.name || details?.phone ? details : null,
      });
      return { resumed: true, processNow: true };
    }

    consumeCafeOrderHints(senderId);
    startSession(senderId, {
      items,
      tenantId: tenant.id,
      step: "choose_fulfillment",
      fulfillment: resolvedFulfillment || "",
    });
    return { resumed: true, processNow: true };
  }

  return { resumed: false };
}

function tryAdvanceSessionFromRichMessage(senderId, session, text, tenant, options = {}) {
  const { recentUserTexts = [], paymentAskCurrent = false } = options;
  if (session.step !== "choose_fulfillment") return { handled: false };

  const choice = detectCafeFulfillment(text);
  if (choice !== "delivery") return { handled: false };

  const block = extractLatestDeliveryBlock(recentUserTexts, text, tenant);
  if (!looksLikeCafeDeliveryDetails(block)) return { handled: false };

  const details = resolveDeliveryDetails(null, recentUserTexts, text, tenant);
  session.fulfillment = "delivery";
  session.step = "confirm_order";
  session.deliveryDetails = details;
  touchSessionActivity(session);
  sessions.set(scopeKey(senderId), session);
  return {
    handled: true,
    reply: buildOrderConfirmationReply(session, tenant, {
      fulfillment: "delivery",
      details,
      paymentAsk: paymentAskCurrent,
    }),
    captureOrder: {
      cafeOrderCapture: true,
      isOrderIntent: true,
      fulfillment: "delivery",
      orderStatus: "pending_confirm",
      address: details.address || details.raw,
      phone: details.phone,
      name: details.name,
      bean: session.items.map((i) => `${i.qty}× ${i.label}`).join(", "),
      lineItems: formatLineItemsSummary(session.items, tenant),
      trigger: "cafe order rich delivery",
    },
  };
}

function processCafeOrderFlowPreAi(senderId, userText, tenant, options = {}) {
  const session = getSession(senderId);
  if (!session || session.step === "closed") return { handled: false };

  touchSessionActivity(session);
  sessions.set(scopeKey(senderId), session);

  const { agentAvailable = false, isWeekend = false, recentUserTexts = [] } = options;
  const text = String(userText || "").trim();
  const paymentAskCurrent = asksPaymentMode(text);

  if (isCafeOrderCancellation(text)) {
    resetCafeOrderContext(senderId);
    return {
      handled: true,
      reply:
        "No problem — I've cancelled that order. If you'd like something else from our menu, just tell me what you'd like.",
    };
  }

  if (isSimpleGreeting(text)) {
    return {
      handled: true,
      reply: `Hello!${buildCafeOrderResumeNudge(session, tenant)}`,
    };
  }

  const holistic = tryHolisticSessionAdvance(senderId, session, text, tenant, {
    recentUserTexts,
    paymentAskCurrent,
    isWeekend,
    agentAvailable,
  });
  if (holistic.handled) return holistic;
  if (holistic.digression) {
    touchSessionActivity(session);
    sessions.set(scopeKey(senderId), session);
    return { handled: false, digression: true };
  }

  if (isCafeOrderDigression(text, tenant, session, recentUserTexts)) {
    session.updatedAt = Date.now();
    sessions.set(scopeKey(senderId), session);
    return { handled: false, digression: true };
  }

  const contextText = mergeOrderContext(text, recentUserTexts);

  if (
    session.items?.length &&
    (isGenericCafeOrderInquiry(text, tenant) || isFulfillmentOnlyIntent(text, tenant)) &&
    session.step !== "offer_resume" &&
    session.step !== "awaiting_payment"
  ) {
    if (isFulfillmentOnlyIntent(text, tenant) || !messageNamesCafeProduct(text, tenant)) {
      const fulfillment = detectCafeFulfillment(text);
      resetCafeOrderContext(senderId);
      if (fulfillment) {
        stashCafeOrderHints(senderId, text, recentUserTexts);
      }
      return {
        handled: true,
        reply: buildGenericOrderStartReply(tenant, { fulfillment }),
      };
    }
    session.step = "offer_resume";
    touchSessionActivity(session);
    sessions.set(scopeKey(senderId), session);
    return {
      handled: true,
      reply: buildPendingOrderResumeReply(session.items, tenant),
    };
  }

  const richAdvance = tryAdvanceSessionFromRichMessage(senderId, session, text, tenant, {
    recentUserTexts,
    agentAvailable,
    paymentAskCurrent: paymentAskCurrent,
  });
  if (richAdvance.handled) return richAdvance;

  if (FRUSTRATION_PATTERN.test(text) && session.items?.length) {
    return {
      handled: true,
      reply: buildOrderReminderReply(session, tenant),
    };
  }

  if (session.step === "offer_resume") {
    if (
      isOrderAcknowledgment(text) ||
      /^(?:yes|yeah|yep|continue|same|that one|proceed|go ahead|oo|opo|sige)/i.test(text)
    ) {
      session.step = "confirm_quantity";
      touchSessionActivity(session);
      sessions.set(scopeKey(senderId), session);
      return {
        handled: true,
        reply: buildQuantityPrompt(session.items, tenant),
      };
    }
    if (isCafeOrderChangeRequest(text)) {
      resetCafeOrderContext(senderId);
      return {
        handled: true,
        reply: buildGenericOrderStartReply(tenant),
      };
    }
    const revised = filterInStockItems(parseCafeOrderFromText(text, tenant) || []);
    if (revised?.length) {
      session.items = applyExplicitQuantities(revised, text);
      session.step = "confirm_quantity";
      touchSessionActivity(session);
      sessions.set(scopeKey(senderId), session);
      return {
        handled: true,
        reply: buildQuantityPrompt(session.items, tenant),
      };
    }
    return {
      handled: true,
      reply: buildPendingOrderResumeReply(session.items, tenant),
    };
  }

  if (session.step === "confirm_quantity") {
    const qty = parseQuantityFromReply(text, session.items);
    const revised = filterInStockItems(parseCafeOrderFromText(text, tenant) || []);

    if (
      isCafeOrderChangeRequest(text) ||
      isFulfillmentOnlyIntent(text, tenant) ||
      (isGenericCafeOrderInquiry(text, tenant) && !qty)
    ) {
      const fulfillment = detectCafeFulfillment(text);
      resetCafeOrderContext(senderId);
      if (fulfillment) {
        stashCafeOrderHints(senderId, text, recentUserTexts);
      }
      return {
        handled: true,
        reply: buildGenericOrderStartReply(tenant, { fulfillment }),
      };
    }

    if (revised?.length) {
      session.items = applyExplicitQuantities(revised, text);
      if (qty) {
        for (const item of session.items) {
          item.qty = qty;
        }
        session.step = "choose_fulfillment";
        touchSessionActivity(session);
        sessions.set(scopeKey(senderId), session);
        return {
          handled: true,
          reply: buildOrderAckAndFulfillmentPrompt(session.items, tenant, {
            paymentAsk: paymentAskCurrent,
          }),
          captureOrder: {
            cafeOrderCapture: true,
            isOrderIntent: true,
            bean: session.items.map((i) => `${i.qty}× ${i.label}`).join(", "),
            lineItems: formatLineItemsSummary(session.items, tenant),
            trigger: "cafe order product changed",
          },
        };
      }
      touchSessionActivity(session);
      sessions.set(scopeKey(senderId), session);
      return {
        handled: true,
        reply: buildQuantityPrompt(session.items, tenant),
      };
    }

    let resolvedQty = qty;
    if (!resolvedQty && isOrderAcknowledgment(text)) {
      resolvedQty = session.items[0]?.qty || 1;
    }
    if (resolvedQty) {
      for (const item of session.items) {
        item.qty = resolvedQty;
      }
      session.step = "choose_fulfillment";
      session.updatedAt = Date.now();
      sessions.set(scopeKey(senderId), session);
      return {
        handled: true,
        reply: buildOrderAckAndFulfillmentPrompt(session.items, tenant, {
          paymentAsk: paymentAskCurrent,
        }),
        captureOrder: {
          cafeOrderCapture: true,
          isOrderIntent: true,
          bean: session.items.map((i) => `${i.qty}× ${i.label}`).join(", "),
          lineItems: formatLineItemsSummary(session.items, tenant),
          trigger: "cafe order quantity confirmed",
        },
      };
    }

    if (hasMixedProductQuestion(text) || (/\?/.test(text) && !resolvedQty)) {
      session.updatedAt = Date.now();
      sessions.set(scopeKey(senderId), session);
      return { handled: false, digression: true };
    }

    return {
      handled: true,
      reply: buildQuantityReprompt(session.items, tenant),
    };
  }

  if (session.step === "confirm_order") {
    session.deliveryDetails = resolveDeliveryDetails(
      session.deliveryDetails,
      recentUserTexts,
      text,
      tenant
    );

    if (isOrderAcknowledgment(text) || /^confirm(ed)?$/i.test(text)) {
      const details = session.deliveryDetails || {};
      if (session.fulfillment === "delivery" && !details.phone) {
        touchSessionActivity(session);
        sessions.set(scopeKey(senderId), session);
        return {
          handled: true,
          reply: buildOrderConfirmationReply(session, tenant, {
            fulfillment: session.fulfillment,
            details,
            paymentAsk: paymentAskCurrent,
          }),
        };
      }
      return finalizeConfirmedCafeOrder(
        senderId,
        session,
        tenant,
        { agentAvailable, paymentAsk: paymentAskCurrent },
        "cafe order customer confirmed"
      );
    }
    if (lineHasPhone(text) && (isPhoneOnlyLine(text) || text.length <= 24)) {
      const phone = extractPhone(text);
      if (phone) {
        session.deliveryDetails = resolveDeliveryDetails(
          { ...(session.deliveryDetails || {}), phone, raw: session.deliveryDetails?.raw || text },
          recentUserTexts,
          text,
          tenant
        );
        touchSessionActivity(session);
        sessions.set(scopeKey(senderId), session);
        return {
          handled: true,
          reply: buildOrderConfirmationReply(session, tenant, {
            fulfillment: session.fulfillment,
            details: session.deliveryDetails,
            paymentAsk: paymentAskCurrent,
          }),
        };
      }
    }
    const revised = filterInStockItems(parseCafeOrderFromText(text, tenant) || []);
    if (revised?.length) {
      session.items = applyExplicitQuantities(revised, text);
    }
    const newFulfillment = detectCafeFulfillment(text);
    if (newFulfillment) session.fulfillment = newFulfillment;
    session.deliveryDetails = resolveDeliveryDetails(session.deliveryDetails, recentUserTexts, text, tenant);
    touchSessionActivity(session);
    sessions.set(scopeKey(senderId), session);
    return {
      handled: true,
      reply: buildOrderConfirmationReply(session, tenant, {
        fulfillment: session.fulfillment,
        details: session.deliveryDetails,
        paymentAsk: paymentAskCurrent,
      }),
    };
  }

  if (session.step === "choose_fulfillment") {
    const choice = detectCafeFulfillment(text);
    if (choice === "pickup") {
      session.step = "pickup_pending";
      session.fulfillment = "pickup";
      session.updatedAt = Date.now();
      sessions.set(scopeKey(senderId), session);
      return {
        handled: true,
        reply: buildPickupInstructions(tenant, { isWeekend }),
        captureOrder: {
          cafeOrderCapture: true,
          isOrderIntent: true,
          fulfillment: "pickup",
          bean: session.items.map((i) => `${i.qty}× ${i.label}`).join(", "),
          lineItems: formatLineItemsSummary(session.items, tenant),
          trigger: "cafe order pickup",
        },
      };
    }
    if (choice === "delivery") {
      session.fulfillment = "delivery";
      session.updatedAt = Date.now();
      const deliveryBlock = extractLatestDeliveryBlock(recentUserTexts, text, tenant);
      if (looksLikeCafeDeliveryDetails(deliveryBlock)) {
        const details = resolveDeliveryDetails(null, recentUserTexts, deliveryBlock, tenant);
        session.step = "confirm_order";
        session.deliveryDetails = details;
        touchSessionActivity(session);
        sessions.set(scopeKey(senderId), session);
        return {
          handled: true,
          reply: buildOrderConfirmationReply(session, tenant, {
            fulfillment: "delivery",
            details,
            paymentAsk: paymentAskCurrent,
          }),
          captureOrder: {
            cafeOrderCapture: true,
            isOrderIntent: true,
            fulfillment: "delivery",
            orderStatus: "pending_confirm",
            address: details.address || details.raw,
            phone: details.phone,
            name: details.name,
            bean: session.items.map((i) => `${i.qty}× ${i.label}`).join(", "),
            lineItems: formatLineItemsSummary(session.items, tenant),
            trigger: "cafe order delivery confirm",
          },
        };
      }
      session.step = "delivery_collect";
      sessions.set(scopeKey(senderId), session);
      return {
        handled: true,
        reply: buildDeliveryCollectPrompt(tenant),
        captureOrder: {
          cafeOrderCapture: true,
          isOrderIntent: true,
          fulfillment: "delivery",
          bean: session.items.map((i) => `${i.qty}× ${i.label}`).join(", "),
          lineItems: formatLineItemsSummary(session.items, tenant),
          trigger: "cafe order delivery",
        },
      };
    }
    return {
      handled: true,
      reply: "Please reply pickup or delivery so we can continue with your order.",
    };
  }

  if (session.step === "pickup_pending") {
    if (isShortAffirmation(text) || detectFulfillment(text) === "pickup") {
      session.step = "awaiting_payment";
      session.updatedAt = Date.now();
      sessions.set(scopeKey(senderId), session);
      return {
        handled: true,
        reply: buildOrderClosure(session, tenant, {
          agentAvailable,
          fulfillment: "pickup",
        }),
        captureOrder: {
          cafeOrderCapture: true,
          isOrderIntent: true,
          fulfillment: "pickup",
          orderStatus: "awaiting_payment",
          bean: session.items.map((i) => `${i.qty}× ${i.label}`).join(", "),
          lineItems: formatLineItemsSummary(session.items, tenant),
          trigger: "cafe order pickup confirmed",
        },
      };
    }
    return {
      handled: true,
      reply: "Reply OK when you're ready, or ask if you need anything about pickup or payment.",
    };
  }

  if (session.step === "delivery_collect") {
    const details = resolveDeliveryDetails(session.deliveryDetails, recentUserTexts, text, tenant);
    if (details && (details.address || details.name)) {
      session.fulfillment = "delivery";
      session.deliveryDetails = details;
      touchSessionActivity(session);
      sessions.set(scopeKey(senderId), session);

      session.step = "confirm_order";
      sessions.set(scopeKey(senderId), session);
      return {
        handled: true,
        reply: buildOrderConfirmationReply(session, tenant, {
          fulfillment: "delivery",
          details,
          paymentAsk: paymentAskCurrent,
        }),
        captureOrder: {
          cafeOrderCapture: true,
          isOrderIntent: true,
          fulfillment: "delivery",
          orderStatus: "pending_confirm",
          address: details.address || details.raw,
          phone: details.phone,
          name: details.name,
          bean: session.items.map((i) => `${i.qty}× ${i.label}`).join(", "),
          lineItems: formatLineItemsSummary(session.items, tenant),
          trigger: "cafe order delivery details",
        },
      };
    }

    return {
      handled: true,
      reply: buildDeliveryCollectPrompt(tenant),
    };
  }

  if (session.step === "awaiting_payment") {
    if (FRUSTRATION_PATTERN.test(text)) {
      return {
        handled: true,
        reply: buildOrderReminderReply(session, tenant),
      };
    }
    if (asksPaymentMode(text)) {
      return {
        handled: true,
        reply: `${buildOrderReminderReply(session, tenant)}\n\n${buildPaymentModeNote(tenant)}`,
      };
    }
  }

  return { handled: false };
}

function getCafeOrderPaymentSummary(senderId, tenant) {
  const session = getSession(senderId);
  if (!session?.items?.length) return null;
  const { total, priced } = computeOrderTotal(session.items, tenant);
  return {
    summary: session.items.map((i) => `${i.qty}× ${i.label}`).join(", "),
    subtotal: priced ? total : null,
  };
}

module.exports = {
  isCafeOrderFlowEnabled,
  isCafeOrderFlowActive,
  clearCafeOrderSession,
  stashCafeOrderHints,
  peekCafeOrderHints,
  tryStartCafeOrderFlow,
  tryResumeCafeOrderFlow,
  tryHandleCafeMenuInquiry,
  processCafeOrderFlowPreAi,
  buildCafeOrderSystemNote,
  buildCafeOrderDigressionSystemNote,
  buildCafeOrderIdleSystemNote,
  buildMixedProductQuestionNote,
  appendCafeOrderResumeNudge,
  buildPaymentModeNote,
  getCafeOrderPaymentSummary,
  parseCafeOrderFromText,
  hasMixedProductQuestion,
  isCafeOrderDigression,
  asksPaymentMode,
  isPaymentModeQuestion: asksPaymentMode,
  resolveDeliveryDetails,
  looksLikeCafeDeliveryDetails,
  looksLikePartialCafeDeliveryDetails,
  extractLatestDeliveryBlock,
  lineHasPhone,
};
