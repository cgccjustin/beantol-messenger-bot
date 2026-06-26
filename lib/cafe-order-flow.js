const { detectFulfillment, extractName, extractPhone } = require("./lead-capture");
const { wantsToSkipWizardForOrderOrProduct } = require("./wizard-exit");
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
  /\b(?:order|buy|kuha|gusto ko|get me|can i get|pa order|order ko|mo order|paliton|kuhaon)\b/i;

const FRUSTRATION_PATTERN =
  /\b(?:i already|already did|already told|told you|mentioned already|naa na|nahuman na|gipa na|naka order na|same (?:order|na)|repeat)\b/i;

const OFF_TOPIC_CAFE_CHAT =
  /\b(?:best\s*seller|bestseller|what do you recommend|who is|what are your hours|fun fact|tell me about|promo|deal|sale|soft launch|menu|price list|open today|closed today|how to order|how can i order)\b/i;

const FULFILLMENT_KEYWORD_LINE = /^(?:pickup|delivery|deliver|padala|hatod)$/i;

const SIMPLE_GREETING =
  /^(?:hi|hello|hey|helo|good morning|good afternoon|good evening|kamusta|musta|hello po|hi po|good day|thanks|thank you|salamat|ok|okay|sige)[!.?\s]*$/i;

const MIXED_PRODUCT_QUESTION =
  /\b(?:what is this|what's this|what is that|what's that|unsay ni|ano ni|what are these|tell me about this|what is it|what's it)\b/i;

const MENU_BROWSE_INQUIRY =
  /\b(?:menu|price list|list(?:\s+your)?\s+(?:drinks|menu|items)|what do you (?:have|sell|offer)|unsay naa|available drinks)\b/i;

const ADDRESS_LINE_HINT =
  /\b(?:iligan|cebu|city|street|st\.|brgy|barangay|purok|village|subdivision|blk|block|mahayahay|address|deliver|province| ave|road|rd\.)\b/i;

const HINTS_TTL_MS = Number(process.env.CAFE_ORDER_HINTS_HOURS || 2) * 60 * 60 * 1000;

/** @type {Map<string, { fulfillment?: string, paymentAsk?: boolean, contextSnippet?: string, updatedAt: number }>} */
const pendingOrderHints = new Map();

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
  const session = {
    step: data.step || "choose_fulfillment",
    items: data.items || [],
    fulfillment: data.fulfillment || "",
    deliveryDetails: null,
    tenantId: data.tenantId || "",
    updatedAt: Date.now(),
  };
  sessions.set(scopeKey(senderId), session);
  return session;
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
  const t = String(text || "").trim();
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

function hasMixedProductQuestion(text) {
  return MIXED_PRODUCT_QUESTION.test(String(text || ""));
}

function isMenuBrowseMessage(text, tenant) {
  const t = String(text || "").trim();
  if (!t || parseCafeOrderFromText(t, tenant)?.length) return false;
  return MENU_BROWSE_INQUIRY.test(t);
}

function messageSpecifiesQuantity(text) {
  const t = String(text || "").toLowerCase();
  return (
    /\b\d+\s*(?:x|×|pcs?|bottles?|btl)\b/.test(t) ||
    /\b(?:x|×)\s*\d+\b/.test(t) ||
    /\b(?:one|two|three|four|five|isa|duha|tulo|upat|lima)\s+(?:offbeat|bottle|white|black|mocha|dulce)/i.test(t) ||
    /\b\d+\s+(?:offbeat|white|black|mocha|dulce)\b/.test(t)
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
    "How many would you like? Reply with a number (e.g. 1 or 2 bottles).",
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

function isOffTopicCafeOrderMessage(text, tenant) {
  if (isSimpleGreeting(text)) return true;
  if (isMenuBrowseMessage(text, tenant)) return true;
  if (hasMixedProductQuestion(text)) return true;
  const t = String(text || "").trim();
  if (!t) return false;
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

function isDeliveryFragmentMessage(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (isOffTopicCafeOrderMessage(t, null)) return false;
  if (CAFE_ORDER_INTENT.test(t)) return false;
  if (isFulfillmentKeywordLine(t)) return false;
  if (isPhoneOnlyLine(t) || lineHasPhone(t)) return true;
  if (/\b(?:offbeat|kape kristiano|order ko|payment|gcash|unsay|mode of)\b/i.test(t)) return false;
  if (ADDRESS_LINE_HINT.test(t)) return true;
  if (looksLikePersonNameLine(t) && !looksLikeAddressLine(t)) return true;
  return false;
}

function extractLatestDeliveryBlock(recentUserTexts = [], userText = "") {
  const messages = [...recentUserTexts, userText].filter(Boolean);
  const fragments = [];
  for (let i = messages.length - 1; i >= 0 && fragments.length < 5; i--) {
    const msg = messages[i];
    if (isDeliveryFragmentMessage(msg)) {
      fragments.unshift(msg);
    } else if (fragments.length) {
      break;
    }
  }
  if (fragments.length) {
    const blob = fragments.join("\n");
    if (looksLikeCafeDeliveryDetails(blob)) return blob;
  }
  const current = String(userText || "").trim();
  if (current && looksLikeCafeDeliveryDetails(current)) return current;
  return current;
}

function parseMultilineDeliveryDetails(lines, phoneFromText) {
  const phoneLineIdx = findLastPhoneLineIndex(lines);
  let phone = phoneFromText || "";
  let remaining = [...lines];

  if (phoneLineIdx >= 0) {
    phone = extractPhone(lines[phoneLineIdx]) || phone;
    remaining = lines.filter((_, index) => index !== phoneLineIdx);
  } else if (!phone) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const candidate = extractPhone(lines[i]);
      if (candidate) {
        phone = candidate;
        remaining = lines.filter((_, index) => index !== i);
        break;
      }
    }
  }

  remaining = remaining
    .map((line) => String(line || "").trim())
    .filter((line) => line && isLikelyDeliveryContentLine(line));

  if (remaining.length === 2) {
    const [first, second] = remaining;
    if (looksLikePersonNameLine(second) && looksLikeAddressLine(first)) {
      return { name: second, address: first, phone };
    }
    if (looksLikePersonNameLine(first) && looksLikeAddressLine(second)) {
      return { name: first, address: second, phone };
    }
    if (phoneLineIdx === lines.length - 1) {
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

function parseDeliveryDetails(text) {
  const t = String(text || "").trim();
  const phone = extractPhone(t);
  const lines = t.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  if (lines.length >= 2) {
    const parsed = parseMultilineDeliveryDetails(lines, phone);
    if (parsed && (parsed.address || parsed.name)) {
      return {
        raw: t,
        phone: parsed.phone || phone || "",
        name: parsed.name || "",
        address: parsed.address || parsed.name || t,
      };
    }
  }

  const inline = parseInlineDeliveryBlob(t, phone);
  if (inline) {
    return {
      raw: t,
      phone: inline.phone || phone || "",
      name: inline.name || "",
      address: inline.address || t,
    };
  }

  let name = extractName(t) || "";
  let address = t;
  if (name) address = address.replace(name, "").trim();
  if (phone) address = address.replace(phone, "").trim();
  address = address.replace(/\r?\n+/g, ", ").replace(/^[,.\s-]+|[,.\s-]+$/g, "").trim();

  return {
    raw: t,
    phone: phone || "",
    name,
    address: address || t,
  };
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
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 3) return false;
  if (!/^[A-Za-z][A-Za-z\s.'-]+$/.test(t)) return false;
  if (words.length === 1 && t.length >= 10) return false;
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
  }
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
  if (/\b(?:pickup lang|kuhaon? sa shop|moadto ko sa shop)\b/i.test(t)) {
    return "pickup";
  }
  return "";
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

  if (isSimpleGreeting(userText)) {
    resetCafeOrderContext(senderId);
    return { started: false };
  }

  if (hasMixedProductQuestion(userText)) {
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

  let items = filterInStockItems(parseCafeOrderFromText(userText, tenant) || []);
  if (!items.length && isActiveOrderContinuation(userText, lastAssistantReply, tenant)) {
    items = filterInStockItems(parseCafeOrderFromText(contextText, tenant) || []);
  }
  if (!items.length) return { started: false };
  if (!hasCafeOrderIntent(userText, recentUserTexts, tenant, { lastAssistantReply })) {
    return { started: false };
  }

  let fulfillment = fulfillmentInCurrent;
  const paymentAsk = asksPaymentMode(userText);
  const deliveryBlock = extractLatestDeliveryBlock([], userText);
  const captureBase = {
    cafeOrderCapture: true,
    isOrderIntent: true,
    bean: items.map((i) => `${i.qty}× ${i.label}`).join(", "),
    lineItems: formatLineItemsSummary(items, tenant),
  };

  if (fulfillment === "delivery" && looksLikeCafeDeliveryDetails(deliveryBlock)) {
    const details = parseDeliveryDetails(deliveryBlock);
    consumeCafeOrderHints(senderId);
    startSession(senderId, {
      items,
      tenantId: tenant.id,
      step: "awaiting_payment",
      fulfillment: "delivery",
      deliveryDetails: details,
    });
    const session = getSession(senderId);
    let reply = buildOrderClosure(session, tenant, {
      agentAvailable,
      fulfillment: "delivery",
      details,
    });
    if (paymentAsk) {
      reply = `${buildPaymentModeNote(tenant)}\n\n${reply}`;
    }
    return {
      started: true,
      reply,
      captureOrder: {
        ...captureBase,
        fulfillment: "delivery",
        orderStatus: "awaiting_payment",
        address: details.address || details.raw,
        phone: details.phone,
        name: details.name,
        trigger: "cafe order one-shot delivery",
      },
      notifyDelivery: true,
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
      const partial = parseDeliveryDetails(deliveryBlock);
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
  const needsQty = !messageSpecifiesQuantity(userText);
  const step = needsQty ? "confirm_quantity" : "choose_fulfillment";
  startSession(senderId, { items, tenantId: tenant.id, step });
  return {
    started: true,
    reply: needsQty
      ? buildQuantityPrompt(items, tenant)
      : buildOrderAckAndFulfillmentPrompt(items, tenant, { paymentAsk }),
    captureOrder: {
      ...captureBase,
      orderStatus: "inquiry",
      trigger: needsQty ? "cafe order quantity" : "cafe order started",
    },
  };
}

function tryResumeCafeOrderFlow(senderId, userText, tenant, options = {}) {
  if (!isCafeOrderFlowEnabled(tenant)) return { resumed: false };
  if (getSession(senderId)) return { resumed: false };
  if (isSimpleGreeting(userText) || isOffTopicCafeOrderMessage(userText, tenant)) {
    resetCafeOrderContext(senderId);
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

  if (askedFulfillment) {
    let resolvedFulfillment = detectCafeFulfillment(userText);
    if (!resolvedFulfillment) return { resumed: false };
    const deliveryBlock = extractLatestDeliveryBlock([], userText);
    const step =
      resolvedFulfillment === "delivery"
        ? looksLikeCafeDeliveryDetails(deliveryBlock)
          ? "awaiting_payment"
          : "delivery_collect"
        : "choose_fulfillment";
    if (step !== "choose_fulfillment") consumeCafeOrderHints(senderId);
    startSession(senderId, {
      items,
      tenantId: tenant.id,
      step,
      fulfillment: resolvedFulfillment || "",
      deliveryDetails:
        step === "awaiting_payment" ? parseDeliveryDetails(deliveryBlock) : null,
    });
    return { resumed: true, processNow: true };
  }

  if (askedDeliveryDetails) {
    const deliveryBlock = extractLatestDeliveryBlock([], userText);
    if (!looksLikeCafeDeliveryDetails(deliveryBlock)) return { resumed: false };
    const step = looksLikeCafeDeliveryDetails(deliveryBlock) ? "awaiting_payment" : "delivery_collect";
    startSession(senderId, {
      items,
      tenantId: tenant.id,
      step,
      fulfillment: "delivery",
      deliveryDetails:
        step === "awaiting_payment" ? parseDeliveryDetails(deliveryBlock) : null,
    });
    return { resumed: true, processNow: true };
  }

  return { resumed: false };
}

function processCafeOrderFlowPreAi(senderId, userText, tenant, options = {}) {
  const session = getSession(senderId);
  if (!session || session.step === "closed") return { handled: false };

  const { agentAvailable = false, isWeekend = false, recentUserTexts = [] } = options;
  const text = String(userText || "").trim();

  if (isSimpleGreeting(text) || isOffTopicCafeOrderMessage(text, tenant)) {
    resetCafeOrderContext(senderId);
    return { handled: false };
  }

  const contextText = mergeOrderContext(text, recentUserTexts);
  const paymentAskCurrent = asksPaymentMode(text);

  if (wantsToSkipWizardForOrderOrProduct(text)) {
    clearCafeOrderSession(senderId);
    return { handled: false };
  }

  if (FRUSTRATION_PATTERN.test(text) && session.items?.length) {
    return {
      handled: true,
      reply: buildOrderReminderReply(session, tenant),
    };
  }

  if (session.step === "confirm_quantity") {
    const qty = parseQuantityFromReply(text, session.items);
    if (qty) {
      for (const item of session.items) {
        item.qty = qty;
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
    return {
      handled: true,
      reply: "Please reply with how many you'd like (e.g. 1 or 2).",
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
      const deliveryBlock = extractLatestDeliveryBlock([], text);
      if (looksLikeCafeDeliveryDetails(deliveryBlock)) {
        const details = parseDeliveryDetails(deliveryBlock);
        return completeDeliveryOrder(senderId, session, tenant, details, {
          agentAvailable,
          paymentAsk: paymentAskCurrent,
        }, "cafe order delivery");
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
    let detailsSource = extractLatestDeliveryBlock([], text);
    if (!looksLikeCafeDeliveryDetails(detailsSource)) {
      detailsSource = extractLatestDeliveryBlock(recentUserTexts.slice(-4), text);
    }
    if (looksLikeCafeDeliveryDetails(detailsSource)) {
      const details = parseDeliveryDetails(detailsSource);
      return completeDeliveryOrder(
        senderId,
        session,
        tenant,
        details,
        { agentAvailable, paymentAsk: paymentAskCurrent },
        "cafe order delivery details"
      );
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
  processCafeOrderFlowPreAi,
  buildCafeOrderSystemNote,
  buildPaymentModeNote,
  getCafeOrderPaymentSummary,
  parseCafeOrderFromText,
  asksPaymentMode,
  isPaymentModeQuestion: asksPaymentMode,
};
