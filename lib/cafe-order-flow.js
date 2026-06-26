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
  matchCatalogFromText,
} = require("./tenant-catalog");

const SESSION_TTL_MS =
  Number(process.env.CAFE_ORDER_SESSION_HOURS || 4) * 60 * 60 * 1000;

/** @type {Map<string, object>} */
const sessions = new Map();

const CAFE_ORDER_INTENT =
  /\b(?:order|buy|kuha|gusto ko|get me|can i get|pa order|order ko|mo order|paliton|kuhaon)\b/i;

const FRUSTRATION_PATTERN =
  /\b(?:i already|already did|already told|told you|mentioned already|naa na|nahuman na|gipa na|naka order na|same (?:order|na)|repeat)\b/i;

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

  const found = new Map();
  for (const product of products) {
    const keys = [...(product.keys || []), product.label.toLowerCase()];
    for (const key of keys.sort((a, b) => b.length - a.length)) {
      if (!new RegExp(`\\b${escapeRegExp(key)}\\b`, "i").test(t)) continue;
      const qty = parseQuantityNearKey(t, key) || 1;
      if (!found.has(product.id)) {
        found.set(product.id, { productId: product.id, label: product.label, qty });
      }
      break;
    }
  }

  if (!found.size) {
    const single = matchCatalogFromText(text, tenant);
    if (single) {
      const qtyMatch = t.match(/\b(\d+)\b/);
      found.set(single.id, {
        productId: single.id,
        label: single.label,
        qty: qtyMatch ? parseInt(qtyMatch[1], 10) : 1,
      });
    }
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
  if (t.length < 20) return false;
  const phone = extractPhone(t);
  if (!phone) return false;

  const lines = t.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length >= 2 && t.length >= 28) return true;

  if (
    /\b(?:iligan|street|st\.|brgy|barangay|purok|city|address|blk|block|subdivision|village|deliver)\b/i.test(
      t
    )
  ) {
    return true;
  }

  return t.length >= 45;
}

function looksLikeNameLine(line) {
  const t = String(line || "").trim();
  if (!t || t.length > 48) return false;
  if (extractPhone(t)) return false;
  if (/\d{3,}/.test(t)) return false;
  const words = t.split(/\s+/);
  if (words.length < 1 || words.length > 5) return false;
  return /^[A-Za-z][A-Za-z\s.'-]+$/.test(t);
}

function isPhoneOnlyLine(line) {
  const t = String(line || "").trim();
  const phone = extractPhone(t);
  if (!phone) return false;
  const remainder = t.replace(phone, "").replace(/[\s,.\-()+]/g, "");
  return remainder.length === 0;
}

function parseDeliveryDetails(text) {
  const t = String(text || "").trim();
  const phone = extractPhone(t);
  let name = extractName(t);
  const lines = t.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const addressParts = [];

  if (lines.length >= 2) {
    for (const line of lines) {
      if (isPhoneOnlyLine(line)) continue;
      const linePhone = extractPhone(line);
      if (linePhone && isPhoneOnlyLine(line)) continue;
      if (!name && looksLikeNameLine(line)) {
        name = line;
        continue;
      }
      let addrLine = line;
      if (linePhone) {
        addrLine = line.replace(linePhone, "").trim().replace(/^[,.\s-]+|[,.\s-]+$/g, "");
      }
      if (addrLine && addrLine !== name) addressParts.push(addrLine);
    }
  }

  let address = addressParts.join(", ").trim();
  if (!address) {
    address = t;
    if (name) address = address.replace(name, "").trim();
    if (phone) address = address.replace(phone, "").trim();
    address = address.replace(/\r?\n+/g, ", ").replace(/^[,.\s-]+|[,.\s-]+$/g, "").trim();
  }

  return { raw: t, phone, name, address: address || t };
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
  return "Payment: reply GCash when you're ready and we'll send payment details in chat.";
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
    tenant?.id === "offbeat-brew"
      ? "• Delivery via Maxim or Grab (Iligan area — rider fee paid by you)"
      : "• Delivery (see our delivery options in chat)",
    "",
    "Reply pickup or delivery."
  );
  return lines.filter((line) => line !== "").join("\n");
}

function buildOrderAckForDeliveryCollect(items, tenant, options = {}) {
  const { paymentAsk = false } = options;
  const lines = [buildOrderSummaryBlock(items, tenant), "", "Noted — delivery via Maxim or Grab (Iligan area)."];
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
    "When you're ready to pay, reply GCash and we'll send the QR code in chat.",
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
    "When you're ready to pay, reply GCash and we'll send the QR code in chat.",
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
      "We'll arrange delivery once payment is confirmed. The rider fee is paid separately to Maxim/Grab."
    );
  } else if (fulfillment === "pickup") {
    lines.push("", "Your pickup order is noted.");
  }

  lines.push(
    promoNote(session.items, tenant),
    "",
    "Next step: reply GCash when you're ready to pay — we'll send the QR code in chat.",
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
      ? "We're waiting for payment — reply GCash for the QR code, or send your payment screenshot if you already paid."
      : "Reply pickup or delivery if we still need that, or GCash when you're ready to pay."
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
  }
  return parts.join("\n");
}

function hasCafeOrderIntent(text, historyTexts = []) {
  const combined = [text, ...historyTexts].filter(Boolean).join(" ");
  return CAFE_ORDER_INTENT.test(combined);
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

  const { recentUserTexts = [], isWeekend = false, agentAvailable = false } = options;
  const items =
    parseCafeOrderFromText(userText, tenant) ||
    parseCafeOrderFromText([...recentUserTexts, userText].join("\n"), tenant);
  if (!items?.length) return { started: false };
  if (!hasCafeOrderIntent(userText, recentUserTexts)) return { started: false };

  const fulfillment = detectCafeFulfillment(userText);
  const paymentAsk = asksPaymentMode(userText);
  const captureBase = {
    cafeOrderCapture: true,
    isOrderIntent: true,
    bean: items.map((i) => `${i.qty}× ${i.label}`).join(", "),
    lineItems: formatLineItemsSummary(items, tenant),
  };

  if (fulfillment === "delivery" && looksLikeCafeDeliveryDetails(userText)) {
    const details = parseDeliveryDetails(userText);
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
    startSession(senderId, {
      items,
      tenantId: tenant.id,
      step: "delivery_collect",
      fulfillment: "delivery",
    });
    return {
      started: true,
      reply: buildOrderAckForDeliveryCollect(items, tenant, { paymentAsk }),
      captureOrder: {
        ...captureBase,
        fulfillment: "delivery",
        orderStatus: "inquiry",
        trigger: "cafe order started delivery",
      },
    };
  }

  if (fulfillment === "pickup") {
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

  startSession(senderId, { items, tenantId: tenant.id, step: "choose_fulfillment" });
  return {
    started: true,
    reply: buildOrderAckAndFulfillmentPrompt(items, tenant, { paymentAsk }),
    captureOrder: {
      ...captureBase,
      orderStatus: "inquiry",
      trigger: "cafe order started",
    },
  };
}

function tryResumeCafeOrderFlow(senderId, userText, tenant, options = {}) {
  if (!isCafeOrderFlowEnabled(tenant)) return { resumed: false };
  if (getSession(senderId)) return { resumed: false };

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
    startSession(senderId, { items, tenantId: tenant.id, step: "choose_fulfillment" });
    return { resumed: true, processNow: true };
  }

  if (askedDeliveryDetails && looksLikeCafeDeliveryDetails(userText)) {
    startSession(senderId, {
      items,
      tenantId: tenant.id,
      step: "delivery_collect",
      fulfillment: "delivery",
    });
    return { resumed: true, processNow: true };
  }

  return { resumed: false };
}

function processCafeOrderFlowPreAi(senderId, userText, tenant, options = {}) {
  const session = getSession(senderId);
  if (!session || session.step === "closed") return { handled: false };

  const { agentAvailable = false, isWeekend = false } = options;
  const text = String(userText || "").trim();

  if (wantsToSkipWizardForOrderOrProduct(text) && session.step === "choose_fulfillment") {
    clearCafeOrderSession(senderId);
    return { handled: false };
  }

  if (FRUSTRATION_PATTERN.test(text) && session.items?.length) {
    return {
      handled: true,
      reply: buildOrderReminderReply(session, tenant),
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
      session.step = "delivery_collect";
      session.fulfillment = "delivery";
      session.updatedAt = Date.now();
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
    if (looksLikeCafeDeliveryDetails(text)) {
      const details = parseDeliveryDetails(text);
      session.deliveryDetails = details;
      session.step = "awaiting_payment";
      session.updatedAt = Date.now();
      sessions.set(scopeKey(senderId), session);
      return {
        handled: true,
        reply: buildOrderClosure(session, tenant, {
          agentAvailable,
          fulfillment: "delivery",
          details,
        }),
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
          trigger: "cafe order delivery details",
        },
        notifyDelivery: true,
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
  tryStartCafeOrderFlow,
  tryResumeCafeOrderFlow,
  processCafeOrderFlowPreAi,
  buildCafeOrderSystemNote,
  getCafeOrderPaymentSummary,
  parseCafeOrderFromText,
};
