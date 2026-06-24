/**
 * Beantol Messenger AI Bot
 * Receives messages from Facebook Messenger, replies using OpenAI.
 */

require("dotenv").config();
const express = require("express");
const https = require("https");
const nodemailer = require("nodemailer");
const OpenAI = require("openai");
const { formatPeso, requestedBelowMoqBulkKg, buildWholesalePricingSystemNote, buildNonWholesaleBulkSystemNote } = require("./lib/pricing");
const {
  isShopOpenNow,
  isShopClosedToday,
  getShopStatusSystemNote,
  getWeekendSystemNote,
  buildWeekendPickupReply,
  buildWeekendDeliveryReply,
  isWeekendPickupContext,
  isWeekendDeliveryContext,
} = require("./lib/shop-hours");
const {
  messageHasImageAttachment,
  resolvePaymentProofSubmission,
  markPaymentProofHandled,
  shouldSuppressAfterPaymentProof,
  inboundTextForImageMessage,
  buildPaymentProofAckReply,
} = require("./lib/payment-proof");
const { enqueueInboundMessage } = require("./lib/inbound-debounce");
const rag = require("./lib/rag");
const {
  syncGoogleDocs,
  syncAllGoogleDocs,
  isGoogleSyncConfigured,
  isAnyGoogleSyncConfigured,
} = require("./lib/google-docs-sync");
const {
  loadTenantRegistry,
  listTenants,
  getTenantById,
  getDefaultTenant,
  getTenantRegistry,
  resolveTenantForWebhook,
  registerTenantPageId,
  getPageAccessToken,
  tenantHasPageToken,
} = require("./lib/tenant-registry");
const { runWithTenant, getActiveTenant, scopeKey, parseScopedKey } = require("./lib/tenant-context");
const {
  getHandoffReply,
  getBotResumeReply,
  getNotifyEmail,
  getShopHours,
  businessName,
} = require("./lib/tenant-messages");
const {
  isCebuDeliveryZonesEnabled,
  isRecommendationsEnabled,
  isTenantFeatureEnabled,
} = require("./lib/tenant-features");
const { getSystemRulesForTenant } = require("./lib/tenant-system-rules");
const { isAppointmentCaptureEnabledForTenant } = require("./lib/tenant-google");
const { buildClosuresSystemNote } = require("./lib/shop-closures");
const {
  analyzeLeadSignal,
  analyzeOrderSignal,
  extractName,
  extractPhone,
  parseBeanAndSize,
  ORDER_INTENT_PATTERN,
  ADD_TO_ORDER_PATTERN,
} = require("./lib/lead-capture");
const {
  isLeadCaptureConfigured,
  recordLead,
  listLeads,
  findLeadRow,
  updateLeadTeamFields,
  TEAM_STATUSES,
} = require("./lib/leads");
const {
  isOrderCaptureConfigured,
  recordOrder,
  listOrders,
  updateOrderFields,
  ADMIN_ORDER_STATUSES,
} = require("./lib/orders");
const { resolveCustomerDisplayName } = require("./lib/meta-profile");
const { CATALOG_PRODUCTS, findCatalogProduct, matchCatalogFromText } = require("./lib/catalog");
const { getCatalogProducts } = require("./lib/tenant-catalog");
const {
  isInventorySheetConfigured,
  listInventory,
  refreshInventoryCache,
  reseedInventoryFromCatalog,
  ensureInventoryLoaded,
  updateProductFields,
  getCachedUnavailableLabels,
  getCachedInventoryItems,
  getCachedLowStockLabels,
  getLowStockThreshold,
  VALID_STATUSES,
} = require("./lib/inventory-sheet");
const { queueLogEvent, listEvents, isEventsLogConfigured } = require("./lib/events-log");
const {
  computeAnalytics,
  renderAnalyticsHtml,
  ARCHIVED_LEAD_STATUSES,
  ARCHIVED_ORDER_STATUSES,
} = require("./lib/analytics");
const {
  processRecommendationFlow,
  buildRecommendationSystemNote,
} = require("./lib/recommendations");
const {
  buildOutOfStockProductReply,
  buildInStockTasteRecommendationReply,
  enforceOutOfStockProductPolicy,
  filterAlternativesToInStock,
  buildTasteRecommendationInventoryHint,
  buildOutOfStockProductSystemHint,
  getUnavailableLabels,
} = require("./lib/inventory-availability");
const { requestChatCompletion, isTransientError } = require("./lib/openai-chat");
const {
  listPipelineLeads,
  buildSalesContextNote,
  formatStaleLeadsEmail,
  renderSalesPipelineHtml,
} = require("./lib/sales-pipeline");
const {
  isAppointmentCaptureConfigured,
  processAppointmentFlow,
  listAppointments,
  updateAppointmentStatus,
  VALID_STATUSES: APPOINTMENT_STATUSES,
  formatPreferredWhen,
} = require("./lib/appointments");
const {
  isQuoteCaptureConfigured,
  recordQuote,
  listQuotes,
  getQuoteById,
  renderQuoteHtml,
} = require("./lib/quotes");
const {
  processQuoteConfirmPreAi,
  processQuoteConfirmPostAi,
  getQuoteConfirmSession,
  isConfirmYes,
  assistantAlreadyAskedConfirm,
  isQuoteConfirmYesTurn,
} = require("./lib/quote-confirm");
const {
  processPostQuoteFlowPreAi,
  isPostQuotePickupConfirmTurn,
  isPostQuoteFlowActive,
  clearPostQuoteSession,
  resumePostQuoteFromRepliedMessage,
} = require("./lib/post-quote-flow");
const {
  recordOutboundMessage,
  resolveInboundReplyTo,
  hasReplyTag,
  isAgentOfferAcceptanceTurn,
} = require("./lib/message-reply-context");
const {
  resolveOutsideCebuDeliveryTurn,
  isOutsideCebuDeliveryInquiry,
  isOutsideCebuAgentOfferPending,
  clearOutsideCebuAgentOfferPending,
  getOutsideCebuSystemNote,
} = require("./lib/outside-cebu-delivery");
const { resolveCebuAreaDeliveryTurn, isCebuAreaDeliveryInquiry, getCebuDeliverySystemNote } = require("./lib/cebu-area-delivery");
const {
  isEquipmentSalesInquiry,
  getEquipmentSalesSystemNote,
  resolveEquipmentSalesTurn,
} = require("./lib/equipment-inquiry");
const {
  createWelcomeState,
  applyWelcomeToReply,
  welcomeOnlyReply,
} = require("./lib/welcome");
const {
  escapeHtml,
  adminUrl,
  renderPage,
  renderToolCard,
  optionTags,
  statCards,
  archiveCheckbox,
} = require("./lib/admin-ui");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || "gpt-4o-mini").trim();
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const HANDOFF_TIMEOUT_HOURS = Number(process.env.HANDOFF_TIMEOUT_HOURS || 24);
const HANDOFF_ADMIN_IDLE_MINUTES = Number(process.env.HANDOFF_ADMIN_IDLE_MINUTES || 15);
const HANDOFF_ADMIN_IDLE_MS = HANDOFF_ADMIN_IDLE_MINUTES * 60 * 1000;
const HANDOFF_NOTIFY_EMAIL =
  process.env.HANDOFF_NOTIFY_EMAIL || "cgccjustin@gmail.com";
const LEAD_NOTIFY_EMAIL =
  process.env.LEAD_NOTIFY_EMAIL || HANDOFF_NOTIFY_EMAIL;
const ORDER_NOTIFY_EMAIL =
  process.env.ORDER_NOTIFY_EMAIL || LEAD_NOTIFY_EMAIL;
const DELIVERY_ALERT_COOLDOWN_MS =
  Number(process.env.DELIVERY_ALERT_COOLDOWN_MINUTES || 240) * 60 * 1000;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM =
  process.env.EMAIL_FROM || "onboarding@resend.dev";
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;

const HANDOFF_REPLY =
  process.env.HANDOFF_REPLY ||
  "Got it — I am connecting you with our team. A Beantol team member will reply to you personally here in this chat as soon as they can. Please stay on this thread.";

const BOT_RESUME_REPLY =
  process.env.BOT_RESUME_REPLY ||
  "Our chat assistant is back on — you can ask about coffee, prices, orders, or delivery anytime.\n\n" +
  "Sorry if your message while our team was helping didn't get a reply from me. Did you ask something that still needs an answer, or was your concern already handled? If you have other inquiries, just send them here and I'm happy to help.";

const ADMIN_RESUME_COMMANDS = (process.env.ADMIN_RESUME_COMMANDS || "#bot")
  .split(",")
  .map((cmd) => cmd.trim().toLowerCase())
  .filter(Boolean);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const DEBUG_WEBHOOK = process.env.DEBUG_WEBHOOK === "true";
const PAGE_ID_ENV = process.env.PAGE_ID;
const INSTAGRAM_ACCOUNT_ID = process.env.INSTAGRAM_ACCOUNT_ID;
const INSTAGRAM_USERNAME = process.env.INSTAGRAM_USERNAME;
/** Business Suite / Page Inbox app id on echo webhooks (Meta Graph API v12+) */
const META_PAGE_INBOX_APP_ID =
  process.env.META_PAGE_INBOX_APP_ID || "26390203743090";
const META_APP_ID_ENV = process.env.META_APP_ID || "";
const SUPPORT_TIMEZONE = process.env.SUPPORT_TIMEZONE || "Asia/Manila";
const SUPPORT_HOURS_START = Number(process.env.SUPPORT_HOURS_START || 9);
const SUPPORT_HOURS_END = Number(process.env.SUPPORT_HOURS_END || 21);

const AFTER_HOURS_HANDOFF_REPLY =
  process.env.AFTER_HOURS_HANDOFF_REPLY ||
  "Sorry — there is no customer support agent available to chat at this hour. Our team can connect with you live on Messenger daily from 9:00 AM to 9:00 PM (Philippine time). I can still help you here with questions about coffee, prices, orders, and delivery. You can also leave your message and check back during support hours, or message again between 9 AM and 9 PM when an agent can assist. How can I help you now?";

/** @type {Map<string, { mode: "agent_requested" | "admin_active", handedOffAt: number, expiresAt: number, lastMessage: string, platform: string, lastAdminReplyAt?: number }>} */
const handoffSessions = new Map();

/** @type {Map<string, 'en' | 'tl' | 'ceb'>} */
const replyLanguagePrefs = new Map();

/** @type {Map<string, number>} senderId -> alert cooldown expiresAt */
const deliveryAlertCooldowns = new Map();

/** After delivery step-2 reply, bare YES / agent phrases trigger handoff */
const deliveryAgentOfferPending = new Map();
const DELIVERY_AGENT_OFFER_TTL_MS = 48 * 60 * 60 * 1000;

const {
  prewarmHistory,
  getChatHistory,
  appendChatHistory,
  sanitizeMessagesForOpenAi,
} = require("./lib/chat-history-store");

function getSupportLocalHour() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SUPPORT_TIMEZONE,
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  const hourPart = parts.find((p) => p.type === "hour");
  return Number(hourPart?.value ?? 0);
}

function isWithinLiveSupportHours() {
  const hour = getSupportLocalHour();
  return hour >= SUPPORT_HOURS_START && hour < SUPPORT_HOURS_END;
}

function getSupportHoursSystemNote() {
  if (isWithinLiveSupportHours()) {
    return `Live customer support handoff is available now (${SUPPORT_HOURS_START}:00–${SUPPORT_HOURS_END === 24 ? "midnight" : `${SUPPORT_HOURS_END}:00`} ${SUPPORT_TIMEZONE}). Use [[HANDOFF]] when the customer wants an agent and rules allow it.`;
  }
  return `Live customer support is OFF right now (outside ${SUPPORT_HOURS_START} AM–${SUPPORT_HOURS_END === 21 ? "9" : SUPPORT_HOURS_END} PM ${SUPPORT_TIMEZONE}). Do NOT use [[HANDOFF]]. If they want a person, say no agent is available at this hour, state live support is daily 9 AM–9 PM Philippine time, and offer to keep helping via AI or to message again during support hours.`;
}

function parseEnvUnavailableProductLabels() {
  const raw =
    process.env.UNAVAILABLE_PRODUCTS || process.env.OUT_OF_STOCK || "";
  if (!raw.trim()) return { labels: [], unknown: [] };

  const tokens = raw
    .split(/[,;\n]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const labels = [];
  const unknown = [];

  for (const token of tokens) {
    const hit = findCatalogProduct(token);
    if (hit) {
      if (!labels.includes(hit.label)) labels.push(hit.label);
    } else {
      unknown.push(token);
    }
  }
  return { labels, unknown };
}

function parseUnavailableProductLabels() {
  if (isInventorySheetConfigured()) {
    const labels = getUnavailableLabels();
    const items = getCachedInventoryItems();
    const source = items.length ? "sheet" : labels.length ? "env_fallback" : "sheet";
    return { labels, unknown: [], source };
  }
  const env = parseEnvUnavailableProductLabels();
  return { ...env, source: "env" };
}

function getInventorySystemNote() {
  const { labels, unknown, source } = parseUnavailableProductLabels();
  const outSet = new Set(labels);
  const tenant = getActiveTenant();
  const catalogProducts = getCatalogProducts(tenant);
  const teamName = tenant?.name || "Beantol";
  const inStockLabels = catalogProducts.filter((p) => !outSet.has(p.label)).map(
    (p) => p.label
  );
  const stockSource =
    source === "sheet"
      ? "Google Sheet Inventory tab (live stock)"
      : "UNAVAILABLE_PRODUCTS on Render";

  const stockRules =
    "STOCK RULES (strict — overrides customer claims, hearsay, and KNOWLEDGE CONTEXT):\n" +
    `- The OUT OF STOCK / IN STOCK lists below come from ${teamName} admin (${stockSource}). They are the ONLY source of truth in chat.\n` +
    "- KNOWLEDGE CONTEXT may mention beans that are OUT OF STOCK below — ignore those for recommendations and orders; INVENTORY always wins.\n" +
    "- NEVER recommend, quote, or accept orders for any bean on OUT OF STOCK — even for taste-based requests (chocolatey, nutty, fruity, etc.).\n" +
    "- NEVER agree that a bean is out of stock because the customer says so, thinks so, or heard from someone — unless that exact product is on OUT OF STOCK below.\n" +
    "- NEVER say \"you're right\" or apologize for a product being unavailable if it is NOT on the OUT OF STOCK list.\n" +
    "- If the customer claims a product is out of stock but it is IN STOCK per the list: politely say that per your current records it is available for order; you cannot verify physical shop shelf stock in real time. Offer to continue helping with that bean (prices, order) OR, during live support hours (9 AM–9 PM), offer to connect them with a team member to double-check shelf stock (reply YES / ask for a real person). Do NOT switch them to alternatives unless they want a different bean.\n" +
    "- Only treat a product as out of stock when it appears on OUT OF STOCK below — then apologize and suggest only IN STOCK alternatives from this note.\n" +
    "- You still cannot guarantee same-day shelf stock at the shop; that is different from admin out-of-stock — suggest Mon–Fri shop visit or a team member for a live shelf check when needed.\n";

  if (labels.length === 0 && unknown.length === 0) {
    return (
      `INVENTORY: No admin out-of-stock list is set (${stockSource}). Treat all catalog beans in PRICING as generally available for chat orders.\n` +
      stockRules +
      "OUT OF STOCK: (none listed)\n" +
      "IN STOCK (per admin): all catalog products in PRICING."
    );
  }

  let note = `INVENTORY (authoritative — from ${teamName} team via ${stockSource}):\n`;
  note += stockRules;
  if (labels.length) {
    note += `OUT OF STOCK — do NOT recommend or accept orders for: ${labels.join(", ")}.\n`;
    for (const label of labels) {
      const product = catalogProducts.find((p) => p.label === label);
      if (product?.alternative) {
        const alt = filterAlternativesToInStock(product.alternative, outSet);
        if (alt) {
          note += `- Instead of ${label} → suggest (in stock only): ${alt}\n`;
        }
      }
    }
    if (labels.some((l) => l === "Beantol Prime")) {
      const cerradoAlt = outSet.has("Brazil Cerrado")
        ? filterAlternativesToInStock("Brazil Santos or Ethiopia Sidama", outSet)
        : "Brazil Cerrado";
      if (cerradoAlt) {
        note +=
          `- Prime out of stock: suggest only in-stock alternatives — often ${cerradoAlt} for clients who wanted Prime's balanced chocolate profile.\n`;
      }
    }
  } else {
    note += "OUT OF STOCK: (none listed)\n";
  }
  if (inStockLabels.length) {
    note += `IN STOCK (per admin — recommend and quote normally): ${inStockLabels.join(", ")}.\n`;
  }
  const lowLabels = isInventorySheetConfigured() ? getCachedLowStockLabels() : [];
  const lowOnly = lowLabels.filter((l) => !outSet.has(l));
  if (lowOnly.length) {
    note += `LOW STOCK (limited quantity — still available but mention stock may run out soon; do NOT refuse orders unless customer asks): ${lowOnly.join(", ")}.\n`;
  }
  if (unknown.length) {
    note += `Unknown UNAVAILABLE_PRODUCTS tokens (fix on Render): ${unknown.join(", ")}. Valid examples: prime, beantol prime, brazil cerrado, sidama, kenya, mt apo ellaga\n`;
  }
  return note;
}

/** Facebook Page ID — used to detect admin messages when is_echo is missing */
let pageId = null;

/** Page / IG account IDs seen on outbound (echo) webhooks */
const outboundSenderIds = new Set();

/** Meta app id for PAGE_ACCESS_TOKEN — used to ignore our own API echoes */
let metaAppId = META_APP_ID_ENV;

/** Recent webhook events for admin debugging (in-memory) */
const webhookDebugLog = [];
const WEBHOOK_DEBUG_MAX = 60;

/** Last Meta webhook POST (in-memory — resets on Render restart) */
const webhookStats = {
  totalPosts: 0,
  lastPostAt: null,
  lastObject: null,
  lastEventCount: 0,
};

/** Message IDs sent by this bot — used to ignore echoes of our own replies */
const botSentMessageIds = new Set();
const BOT_MID_MAX = 500;

/** Detect if the customer wants bot reply language changed (not human handoff). */
function detectReplyLanguagePreference(text) {
  const t = text.trim();
  if (!t) return null;

  if (
    /\b(?:reply|respond|answer|speak|write|sagot|tubag).*(?:in )?english\b/i.test(t) ||
    /\benglish (?:only|please|na lang|pls|po)\b/i.test(t) ||
    /\bswitch (?:back )?to english\b/i.test(t) ||
    /\bback\s+to\s+english\b/i.test(t) ||
    /\benglish\s+balik\b/i.test(t) ||
    /\bbalik\s+(?:sa\s+)?english\b/i.test(t) ||
    /\b(?:balik|back)\b.*\b(?:english|inglish)\b/i.test(t) ||
    /\b(?:english|inglish)\b.*\b(?:balik|back)\b/i.test(t) ||
    (/\b(?:english|inglish)\b/i.test(t) &&
      /\b(?:balik|back|switch|return|na lang|nlng)\b/i.test(t))
  ) {
    return "en";
  }

  if (
    /\b(?:reply|respond|answer|speak|write).*(?:in )?(?:tagalog|filipino)\b/i.test(t) ||
    /\btagalog (?:only|please|na lang|pls|lang)\b/i.test(t) ||
    /paki-?tagalog/i.test(t) ||
    /\b(?:puede|pwede|puede)\s+ka\s+mag\s+tagalog\b/i.test(t)
  ) {
    return "tl";
  }

  if (
    /\b(?:reply|respond|answer|speak|write).*(?:in )?(?:cebuano|bisaya)\b/i.test(t) ||
    /\b(?:cebuano|bisaya) (?:only|please|na lang|pls|lang)\b/i.test(t) ||
    /\bbisaya lang\b/i.test(t) ||
    /\b(?:puede|pwede|puede)\s+ka\s+mag\s+(?:bisaya|cebuano)\b/i.test(t) ||
    /\b(?:can you|could you)\s+(?:speak|reply|talk|write)\s+(?:in\s+)?(?:bisaya|cebuano)\b/i.test(t) ||
    (/\b(?:mag|sa)\s+(?:bisaya|cebuano)\b/i.test(t) &&
      /\b(?:ka|mo|lang|please|pls|puede|pwede)\b/i.test(t))
  ) {
    return "ceb";
  }

  return null;
}

function isReplyLanguagePreferenceRequest(text) {
  return detectReplyLanguagePreference(text) !== null;
}

function updateReplyLanguagePreference(senderId, userText) {
  const pref = detectReplyLanguagePreference(userText);
  if (pref) replyLanguagePrefs.set(scopeKey(senderId), pref);
}

function getReplyLanguageInstruction(senderId) {
  const pref = replyLanguagePrefs.get(scopeKey(senderId)) || "en";
  if (pref === "tl") {
    return "LANGUAGE FOR THIS REPLY: Write the entire message in Tagalog. Continue in Tagalog until the customer asks to switch back to English.";
  }
  if (pref === "ceb") {
    return "LANGUAGE FOR THIS REPLY: Write the entire message in Cebuano/Bisaya. Continue in Cebuano until the customer asks to switch back to English.";
  }
  return (
    "LANGUAGE FOR THIS REPLY: Write the entire message in English only. " +
    "The customer may have written in Cebuano, Tagalog, or Bislish — you must still reply in English. " +
    "Do not use Cebuano, Bisaya, or Tagalog in your reply (except proper nouns like Beantol). " +
    "Do not mirror their language."
  );
}

const SIZE_IN_TEXT = /\b(250g|500g|1kg|6\s*kg|wholesale)\b/i;

function isAffirmativeWithoutSize(text) {
  const t = String(text || "").trim();
  if (!t || SIZE_IN_TEXT.test(t)) return false;
  if (
    /^(yes|yeah|yep|yup|sure|ok(?:ay)?|oo|oo po|yes po|yes please|yes pls|pls|please|go ahead|sige|go|opo|po)$/i.test(
      t
    )
  ) {
    return true;
  }
  return /^(yes|yeah|sure|ok|oo|yep)\b/i.test(t) && t.length <= 40;
}

function lastAssistantAskedForSize(senderId) {
  const history = getChatHistory(senderId);
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== "assistant") continue;
    const content = history[i].content || "";
    if (/\bwhich size\b/i.test(content)) return true;
    if (/\bwhat size\b/i.test(content)) return true;
    if (
      /\bplace an order\b/i.test(content) &&
      /\b(250g|500g|1kg)\b/.test(content) &&
      /\?/.test(content)
    ) {
      return true;
    }
    break;
  }
  return false;
}

function buildPendingSizeConfirmationNote(senderId, userText) {
  if (!isAffirmativeWithoutSize(userText) || !lastAssistantAskedForSize(senderId)) {
    return "";
  }
  const history = getChatHistory(senderId);
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== "assistant") continue;
    const content = history[i].content || "";
    if (
      mentionedFilterRoasts(content).length &&
      /\b(?:which size|what size|preferred size|confirm the size|available in 250g)\b/i.test(
        content
      )
    ) {
      return (
        "FILTER ROAST PROCEED: Customer agreed to a filter roast (250g only). Do NOT ask which size or " +
        "preferred size again. Include it as 250g in the order summary and ask pickup/delivery or " +
        "whether to proceed with the order."
      );
    }
    break;
  }
  return (
    "ORDER SIZE REQUIRED: You asked which size for an espresso bean. The customer replied affirmatively " +
    "but did NOT choose 250g, 500g, 1kg, or wholesale. Ask which size they want — do NOT assume 250g. " +
    "Do not summarize an order with a size until they choose one."
  );
}

function buildOrderCorrectionNote(userText) {
  const t = String(userText || "").trim();
  if (!t) return "";
  if (
    !/\b(?:not|instead|change|wrong|clarify|also wanted|also want|also add|add)\b/i.test(t) &&
    !/\b(?:1kg|500g|250g)\s+(?:of\s+)?(?:santos|cerrado|prime|guji|sidama)\b/i.test(t)
  ) {
    return "";
  }
  if (!/\b(?:santos|cerrado|prime|guji|sidama|mt\.?\s*apo|ellaga|kenya)\b/i.test(t)) {
    return "";
  }
  return (
    "ORDER CORRECTION: Customer is fixing or adding items. Filter roasts (Mt. Apo, Ellaga, Guji filter, Kenya) " +
    "are 250g retail ONLY — never 500g or 1kg (₱700 is Mt. Apo 250g). Apply a stated size only to the bean " +
    "they name (e.g. '1kg of Santos' updates Santos only; Mt. Apo without a size stays 250g). Replace wrong " +
    "sizes — never list the same bean twice at different sizes."
  );
}

function mentionedFilterRoasts(text) {
  const t = String(text || "");
  const items = [];
  if (/\bmt\.?\s*apo ellaga\b|\bellaga\b|\bdione ellaga\b/i.test(t)) {
    items.push("Mt. Apo (Ellaga)");
  } else if (/\bmt\.?\s*apo\b|\bmount apo\b/i.test(t)) {
    items.push("Mt. Apo");
  }
  if (/\bguji filter\b|\bfilter guji\b/i.test(t)) items.push("Guji (filter)");
  if (/\bkenya filter\b|\bfilter kenya\b/i.test(t)) items.push("Kenya (filter)");
  return items;
}

function buildFilterRoastOnlySizeNote(senderId, userText) {
  const history = getChatHistory(senderId);
  const combined = [
    userText,
    ...history.slice(-6).map((message) => message.content),
  ].join("\n");
  const items = mentionedFilterRoasts(combined);
  if (!items.length) return "";
  return (
    `FILTER ROAST — SINGLE SIZE ONLY: ${items.join(", ")} retail in 250g only. ` +
    "Do NOT ask which size, preferred size, or to confirm the size for these beans. " +
    "Use 250g automatically in the order summary. Ask whether to proceed with that item, " +
    "or pickup vs delivery if the rest of the order is ready."
  );
}

const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 90000);

const openaiHttpsAgent = new https.Agent({
  keepAlive: false,
  timeout: OPENAI_TIMEOUT_MS,
});

const openai = OPENAI_API_KEY
  ? new OpenAI({
      apiKey: OPENAI_API_KEY,
      maxRetries: 2,
      timeout: OPENAI_TIMEOUT_MS,
      httpAgent: openaiHttpsAgent,
    })
  : null;

function shouldSyncGoogleDocsOnStartup() {
  if (!isAnyGoogleSyncConfigured()) return false;
  return process.env.RAG_SYNC_ON_STARTUP !== "false";
}

async function bootstrapKnowledge() {
  loadTenantRegistry();
  rag.loadIndex();

  const tenants = listTenants();
  const anyGoogle = isAnyGoogleSyncConfigured();

  if (!anyGoogle) {
    for (const tenant of tenants) {
      if (!rag.isReady(tenant) && openai) {
        try {
          console.log(`RAG [${tenant.id}]: no index — building from sources...`);
          await rag.rebuildIndex(openai, tenant);
        } catch (err) {
          console.warn(`RAG [${tenant.id}]: auto-index failed:`, err.message);
        }
      }
    }
    return;
  }

  if (shouldSyncGoogleDocsOnStartup()) {
    try {
      console.log("RAG: syncing Google Docs for all tenants...");
      await syncAllGoogleDocs();
      if (openai) await rag.rebuildAllIndexes(openai);
      return;
    } catch (err) {
      console.warn("RAG: startup Google sync failed:", err.message);
      rag.loadIndex();
    }
  }

  for (const tenant of tenants) {
    if (!rag.isReady(tenant) && openai) {
      try {
        console.log(`RAG [${tenant.id}]: building index from sources...`);
        await rag.rebuildIndex(openai, tenant);
      } catch (err) {
        console.warn(`RAG [${tenant.id}]: auto-index failed:`, err.message);
      }
    }
  }
}

const HANDOFF_MARKER = "[[HANDOFF]]";

const HANDOFF_PATTERNS = [
  /\bhuman\b/i,
  /\breal person\b/i,
  /\breal live person\b/i,
  /\blive person\b/i,
  /\bi want to chat with an agent\b/i,
  /\bwant to chat with (?:a )?(?:agent|representative)\b/i,
  /\blocal person\b/i,
  /\btalk to (?:a )?(?:person|human|agent|staff|someone|representative)\b/i,
  /\bchat with (?:a )?(?:person|human|agent|staff|someone|representative)\b/i,
  /\bchat with (?:a )?(?:real|live) (?:person|human)\b/i,
  /\bspeak to (?:a )?(?:person|human|agent|staff|someone|representative)\b/i,
  /\b(?:need|want|get) (?:an? )?(?:agent|person|human|staff|someone|representative)\b/i,
  /\b(?:i )?need agent\b/i,
  /\bagent (?:to )?chat\b/i,
  /\bnot (?:an? )?ai\b/i,
  /\bno ai\b/i,
  /\bis anyone (?:available|there|online)\b/i,
  /\bcustomer service\b/i,
  /\bagent please\b/i,
  /\brepresentative\b/i,
  /\bconnect me (?:to|with)\b/i,
  /\bmay tao\b/i,
  /\bpwede.*(?:staff|tao|person|agent)\b/i,
  /\btawag.*staff\b/i,
  /\bchat in person\b/i,
  /\bavailable to chat\b/i,
  /\bteam member\b/i,
  /\bactual (?:person|human)\b/i,
];

const HANDOFF_INTENT_WORDS =
  /\b(need|want|get|talk|chat|speak|connect|call|ask|looking for|hanap|gusto|pwede|please|help)\b/i;
const HANDOFF_TARGET_WORDS =
  /\b(agent|human|person|people|staff|someone|representative|tao|employee|team member|real person|live person|operator)\b/i;

function isDeliveryInquiry(text) {
  const t = text.trim();
  if (!t) return false;
  return (
    /\b(?:delivery|deliver|deliveries|padala|hatod|shipping|ship|maxim)\b/i.test(t) ||
    /\b(?:pwede|puede|gusto|can i|can you).*(?:deliver|hatod|padala|maxim)\b/i.test(t) ||
    /\border.*(?:deliver|hatod|padala|maxim)\b/i.test(t) ||
    /\b(?:deliver|hatod|padala|maxim).*(?:order|coffee|beans)\b/i.test(t)
  );
}

function aiReplyIsDeliveryFlow(reply) {
  const r = (reply || "").trim();
  if (!r) return false;
  return (
    /\bmaxim\b/i.test(r) &&
    /\b(?:address|contact name|phone|mobile|contact number)\b/i.test(r)
  );
}

function aiReplyIsDeliveryDetailsConfirmation(reply) {
  const r = (reply || "").trim();
  if (!r) return false;
  return (
    /\bthanks for (?:the )?details\b/i.test(r) &&
    /\b(?:payment|pay).*(?:before|first|prior|settled|settle)/i.test(r) &&
    /\bmaxim\b/i.test(r) &&
    /\b(?:reply\s+)?yes\b|\bcustomer representative\b|\breal live person\b/i.test(
      r
    )
  );
}

function markDeliveryAgentOfferPending(senderId) {
  deliveryAgentOfferPending.set(scopeKey(senderId), Date.now());
}

function clearDeliveryAgentOfferPending(senderId) {
  deliveryAgentOfferPending.delete(scopeKey(senderId));
}

function isDeliveryAgentOfferPending(senderId) {
  const at = deliveryAgentOfferPending.get(scopeKey(senderId));
  if (!at) return false;
  if (Date.now() - at > DELIVERY_AGENT_OFFER_TTL_MS) {
    deliveryAgentOfferPending.delete(scopeKey(senderId));
    return false;
  }
  return true;
}

function wantsAgentAfterDeliveryOffer(text) {
  const t = text.trim();
  if (!t) return false;
  if (
    /^(yes|oo|yes po|oo po|yes please|oo please|yes,?\s*please|oo,?\s*please)$/i.test(
      t
    )
  ) {
    return true;
  }
  if (
    /^(yes|oo)\b/i.test(t) &&
    t.length <= 40 &&
    /\b(?:agent|representative|person|staff|tao|team)\b/i.test(t)
  ) {
    return true;
  }
  if (
    /\b(?:want|like|need|gusto).*(?:agent|representative|staff|person|tao)\b/i.test(
      t
    )
  ) {
    return true;
  }
  if (
    /\b(?:chat|talk|speak|connect).*(?:agent|representative|staff|person|tao)\b/i.test(
      t
    )
  ) {
    return true;
  }
  if (/\b(?:real|live)\s+(?:person|human)\b/i.test(t)) return true;
  if (/\bcustomer representative\b/i.test(t)) return true;
  return false;
}

function looksLikeDeliveryDetailsSubmission(text) {
  const t = text.trim();
  if (t.length < 25) return false;
  const hasPhone =
    /\b(?:09\d{9}|\+?63[\s-]?9\d{9})\b/.test(t) ||
    /\b\d{3}[-.\s]?\d{3,4}[-.\s]?\d{4}\b/.test(t);
  const hasAddressHint =
    /\b(?:street|st\.|ave|avenue|road|rd\.|barangay|brgy|city|cebu|village|subdivision|unit|floor|blk|block|purok|banilad|mandaue|lapu|consolacion)\b/i.test(
      t
    ) || t.length > 80;
  return hasPhone && hasAddressHint;
}

function wantsHumanHandoff(text, senderId) {
  const normalized = text.trim();
  if (!normalized) return false;
  if (isReplyLanguagePreferenceRequest(normalized)) return false;
  if (isDeliveryInquiry(normalized) && !/\b(?:person|human|agent|staff|tao|representative)\b/i.test(normalized)) {
    return false;
  }
  if (HANDOFF_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
  return (
    HANDOFF_INTENT_WORDS.test(normalized) && HANDOFF_TARGET_WORDS.test(normalized)
  );
}

function sanitizeBotReply(text) {
  let out = text.trim();
  const stripPatterns = [
    /call (?:us|me)(?:\s+on|\s+in)?\s*messenger[^\n]*/gi,
    /message us(?:\s+on)?\s*messenger[^\n]*/gi,
    /contact us(?:\s+on)?\s*messenger[^\n]*/gi,
    /(?:tap|click)\s+(?:the\s+)?button[^\n]*/gi,
    /send (?:us\s+)?a message(?:\s+on messenger)?[^\n]*/gi,
  ];
  for (const pattern of stripPatterns) {
    out = out.replace(pattern, "");
  }
  return out.replace(/\n{3,}/g, "\n\n").replace(/  +/g, " ").trim() || text.trim();
}

function isAiHandoffReply(reply) {
  return Boolean(reply && reply.includes(HANDOFF_MARKER));
}

function isSmtpConfigured() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return false;
  const pass = SMTP_PASS.trim();
  if (pass.length < 10) return false;
  if (/REPLACE|your_|changeme|example/i.test(pass)) return false;
  return true;
}

function isResendConfigured() {
  return Boolean(RESEND_API_KEY && RESEND_API_KEY.trim().startsWith("re_"));
}

function isEmailConfigured() {
  return isResendConfigured() || isSmtpConfigured();
}

function getEmailProvider() {
  if (isResendConfigured()) return "resend";
  if (isSmtpConfigured()) return "smtp";
  return null;
}

function normalizeHandoffSession(session) {
  if (!session) return null;
  if (!session.mode) {
    session.mode = "admin_active";
  }
  return session;
}

/** Blocks AI only after an admin has replied from Business Suite. */
function getAdminTakeover(senderId) {
  const session = normalizeHandoffSession(handoffSessions.get(scopeKey(senderId)));
  if (!session || session.mode !== "admin_active") return null;
  if (Date.now() > session.expiresAt) return null;
  return session;
}

function getHandoffSession(senderId) {
  return normalizeHandoffSession(handoffSessions.get(scopeKey(senderId)));
}

function requestHumanAgent(senderId, userText, platform = "messenger") {
  clearDeliveryAgentOfferPending(senderId);
  const existing = getHandoffSession(senderId);
  const now = Date.now();
  handoffSessions.set(scopeKey(senderId), {
    mode: "agent_requested",
    handedOffAt: existing?.handedOffAt || now,
    expiresAt: 0,
    lastMessage: String(userText || "").trim(),
    platform: existing?.platform || platform,
  });
}

function activateAdminTakeover(customerId, adminText, platform = "messenger") {
  const existing = getHandoffSession(customerId);
  const now = Date.now();
  handoffSessions.set(scopeKey(customerId), {
    mode: "admin_active",
    handedOffAt: existing?.handedOffAt || now,
    expiresAt: now + HANDOFF_ADMIN_IDLE_MS,
    lastMessage: String(adminText || existing?.lastMessage || "Admin replied").trim(),
    platform: existing?.platform || platform,
    lastAdminReplyAt: now,
  });
}

function findHandoffStorageKey(senderId, tenantId) {
  if (tenantId) return `${tenantId}:${senderId}`;
  for (const key of handoffSessions.keys()) {
    const parsed = parseScopedKey(key);
    if (parsed.senderId === String(senderId)) return key;
  }
  return scopeKey(senderId);
}

function resolveHandoff(senderId, tenantId) {
  clearDeliveryAgentOfferPending(senderId);
  return handoffSessions.delete(findHandoffStorageKey(senderId, tenantId));
}

function isSupportedWebhookObject(object) {
  return object === "page" || object === "instagram";
}

function webhookPlatform(body) {
  return body?.object === "instagram" ? "instagram" : "messenger";
}

function platformLabel(platform) {
  return platform === "instagram" ? "Instagram DM" : "Facebook Messenger";
}

function rememberBotMessageId(mid) {
  if (!mid) return;
  botSentMessageIds.add(mid);
  if (botSentMessageIds.size > BOT_MID_MAX) {
    const oldest = botSentMessageIds.values().next().value;
    botSentMessageIds.delete(oldest);
  }
}

function normalizeCommandText(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, "");
}

/** True when an admin sent a resume command (e.g. #bot) from Business Suite. */
function isAdminResumeCommand(text) {
  const raw = (text || "").trim();
  if (!raw) return false;
  if (/#bot\b/i.test(raw) || /\bbot\s*#/i.test(raw)) return true;
  const normalized = normalizeCommandText(text);
  return ADMIN_RESUME_COMMANDS.some((cmd) => {
    const target = normalizeCommandText(cmd);
    return normalized === target || normalized.includes(target);
  });
}

function getOutboundSenderIds() {
  const ids = new Set(outboundSenderIds);
  if (pageId) ids.add(String(pageId));
  if (PAGE_ID_ENV) ids.add(String(PAGE_ID_ENV));
  if (INSTAGRAM_ACCOUNT_ID) ids.add(String(INSTAGRAM_ACCOUNT_ID));
  return ids;
}

function truthyEcho(value) {
  return value === true || value === "true" || value === 1;
}

function isMessageEchoEvent(event) {
  return truthyEcho(event.message?.is_echo);
}

function getMessageAppId(event) {
  const id = event.message?.app_id;
  return id != null && id !== "" ? String(id) : "";
}

function formatWebhookDebugDetail(e) {
  const parts = [e.kind];
  if (e.object) parts.push(`object=${e.object}`);
  if (e.platform) parts.push(e.platform);
  if (e.entryCount != null) parts.push(`entries=${e.entryCount}`);
  if (e.eventCount != null) parts.push(`parsed=${e.eventCount}`);
  if (e.supported === false) parts.push("unsupported object");
  if (e.channel) parts.push(e.channel);
  if (e.reason) parts.push(`reason=${e.reason}`);
  if (e.echo != null) parts.push(`echo=${e.echo}`);
  if (e.appId) parts.push(`app_id=${e.appId}`);
  if (e.humanEcho != null) parts.push(`human=${e.humanEcho}`);
  if (e.customerId) parts.push(`customer=${e.customerId}`);
  if (e.sender) parts.push(`sender=${e.sender}`);
  if (e.text) parts.push(`text=${e.text}`);
  if (e.field) parts.push(`field=${e.field}`);
  if (e.detail) parts.push(String(e.detail).slice(0, 120));
  return parts.join(" · ");
}

function recordWebhookDebug(entry) {
  webhookDebugLog.push({ at: new Date().toISOString(), ...entry });
  if (webhookDebugLog.length > WEBHOOK_DEBUG_MAX) {
    webhookDebugLog.shift();
  }
}

function rememberOutboundSenderFromEvent(event) {
  if (!isMessageEchoEvent(event) || !event.sender?.id) return;
  const senderId = String(event.sender.id);
  outboundSenderIds.add(senderId);
  if (!pageId || pageId === senderId) {
    if (pageId !== senderId) {
      pageId = senderId;
      console.log(`Page ID learned from message echo: ${pageId}`);
    }
  }
}

function resolveEchoCustomerId(event, entryId = "", platform = "messenger") {
  const sender = event.sender?.id ? String(event.sender.id) : "";
  const recipient = event.recipient?.id ? String(event.recipient.id) : "";
  const outbound = getOutboundSenderIds();
  if (entryId) outbound.add(String(entryId));

  if (recipient && !outbound.has(recipient)) return recipient;
  if (sender && !outbound.has(sender)) return sender;
  return recipient || sender;
}

function isPageInboxAppId(appId) {
  if (!appId) return false;
  const id = String(appId);
  if (id === META_PAGE_INBOX_APP_ID) return true;
  if (id.startsWith("26390203743090")) return true;
  return false;
}

function isBotOwnEcho(event, text = "") {
  const msg = event.message;
  if (!msg) return false;
  const appId = getMessageAppId(event);
  if (metaAppId && appId && appId === metaAppId) return true;
  if (msg.mid && botSentMessageIds.has(msg.mid)) return true;
  if (text && isBotGeneratedOutboundText(text)) return true;
  return false;
}

function isHumanAdminEcho(event, text = "") {
  if (!isMessageEchoEvent(event)) {
    const senderId = event.sender?.id ? String(event.sender.id) : "";
    return Boolean(senderId && getOutboundSenderIds().has(senderId) && !isBotOwnEcho(event, text));
  }
  if (isBotOwnEcho(event, text)) return false;
  const appId = getMessageAppId(event);
  if (isPageInboxAppId(appId)) return true;
  if (metaAppId && appId && appId !== metaAppId) return true;
  return false;
}

function isOutboundFromPage(event, entryId = "", platform = "messenger") {
  if (isMessageEchoEvent(event)) return true;
  const senderId = event.sender?.id ? String(event.sender.id) : "";
  if (!senderId) return false;
  if (getOutboundSenderIds().has(senderId)) return true;
  if (platform === "instagram" && entryId && senderId === String(entryId)) return true;
  return false;
}

function isOutboundWebhookCandidate(event, entryId = "", platform = "messenger") {
  if (isMessageEchoEvent(event)) return true;
  return isOutboundFromPage(event, entryId, platform);
}

function isKnownBotOutboundText(text) {
  const t = (text || "").trim();
  if (!t) return false;
  const known = [HANDOFF_REPLY, BOT_RESUME_REPLY, AFTER_HOURS_HANDOFF_REPLY].map((s) =>
    String(s).trim()
  );
  if (known.includes(t)) return true;
  if (/^got it — i am connecting you with our team/i.test(t)) return true;
  if (/^our chat assistant is back on/i.test(t)) return true;
  if (/^sorry — there is no customer support agent available/i.test(t)) return true;
  if (/^noted — our team will follow up on your delivery/i.test(t)) return true;
  return false;
}

/** Bot API / template replies that must not trigger admin takeover on message_echoes. */
function isBotGeneratedOutboundText(text) {
  const t = (text || "").trim();
  if (!t) return false;
  if (isKnownBotOutboundText(t)) return true;
  if (/Quote summary\s*—\s*please confirm:/i.test(t)) return true;
  if (/Reply YES to get your printable formal quote link/i.test(t)) return true;
  if (/^Here'?s your formal quote \(save or print\):/i.test(t)) return true;
  if (/^How would you like to proceed\?/i.test(t)) return true;
  if (/^Great — pickup at our shop:/i.test(t)) return true;
  if (/^Delivery via Maxim — please send all three/i.test(t)) return true;
  if (/^Welcome to Beantol/i.test(t)) return true;
  if (/^Yes — we can deliver to \w+/i.test(t)) return true;
  if (/^Yes — we can arrange Maxim delivery/i.test(t)) return true;
  if (/^Yes — we can get your order to/i.test(t)) return true;
  if (/^Yes — we deliver within the Cebu area via Maxim/i.test(t)) return true;
  if (/^Yes — we can ship outside Cebu\./i.test(t)) return true;
  if (/^Thank you for trusting Beantol!/i.test(t)) return true;
  if (/^Thank you for your payment\./i.test(t)) return true;
  if (/^Thank you — I'?ve noted your payment message\./i.test(t)) return true;
  if (/^Good decision! At our \d+ kg minimum for wholesale/i.test(t)) return true;
  if (/^Sorry — that item is not available for order right now\./i.test(t)) return true;
  if (/^Sorry — I couldn't generate that quote just now\./i.test(t)) return true;
  if (/^No problem — what would you like a quote for\?/i.test(t)) return true;
  return false;
}

/** Pause bot when a human admin replies from Business Suite (no extra customer message). */
function pauseBotForAdminTakeover(customerId, adminText, platform = "messenger") {
  if (adminText && isAdminResumeCommand(adminText)) return;
  if (adminText && isBotGeneratedOutboundText(adminText)) {
    console.log(
      `Page outbound ignored for ${customerId} — matches a known bot message (not admin takeover).`
    );
    return;
  }
  activateAdminTakeover(customerId, adminText, platform);
  console.log(
    `Bot paused for ${customerId} (${platformLabel(platform)}) — admin message detected. Auto-replies off for ${HANDOFF_ADMIN_IDLE_MINUTES}m idle or until Resume AI / ${ADMIN_RESUME_COMMANDS[0]}.`
  );
}

const RESUME_SEND_DELAY_MS = Number(process.env.RESUME_SEND_DELAY_MS || 1200);

async function resumeBotForCustomer(customerId, adminText) {
  const hadHandoff = Boolean(getHandoffSession(customerId));
  resolveHandoff(customerId);
  console.log(
    `Resume command "${adminText}" for ${customerId} — handoff cleared (was paused: ${hadHandoff}).`
  );

  if (RESUME_SEND_DELAY_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, RESUME_SEND_DELAY_MS));
  }

  try {
    await sendMessageWithFallback(customerId, getBotResumeReply());
    console.log(`Resume confirmation sent to ${customerId}.`);
  } catch (err) {
    console.error(`Resume confirmation failed for ${customerId}:`, err.message);
  }
}

async function handleHandoverEvent(event, platform = "messenger") {
  const customerId = event.sender?.id ? String(event.sender.id) : "";
  if (!customerId) return;

  if (event.take_thread_control) {
    const prev = event.take_thread_control.previous_owner_app_id;
    console.log(
      `take_thread_control for ${customerId} — previous_owner_app_id=${prev} (pausing bot).`
    );
    recordWebhookDebug({
      kind: "take_thread_control",
      platform,
      customerId,
      previousOwner: prev,
    });
    pauseBotForAdminTakeover(
      customerId,
      "Human took thread control (Business Suite)",
      platform
    );
    return;
  }

  if (event.pass_thread_control) {
    console.log(`pass_thread_control for ${customerId}:`, JSON.stringify(event.pass_thread_control));
    recordWebhookDebug({
      kind: "pass_thread_control",
      platform,
      customerId,
      targetAppId: event.pass_thread_control.target_app_id,
    });
  }
}

async function handlePageOutbound(event, platform = "messenger", entryId = "") {
  const text = event.message?.text || "";
  const appId = getMessageAppId(event);
  const customerId = resolveEchoCustomerId(event, entryId, platform);
  const mid = event.message?.mid;
  const humanEcho = isHumanAdminEcho(event, text);
  const botEcho = isBotOwnEcho(event, text);

  recordWebhookDebug({
    kind: "page_outbound",
    platform,
    entryId,
    echo: isMessageEchoEvent(event),
    appId: appId || "(none)",
    metaAppId: metaAppId || "(unknown)",
    inboxAppId: META_PAGE_INBOX_APP_ID,
    sender: event.sender?.id,
    recipient: event.recipient?.id,
    customerId,
    humanEcho,
    botEcho,
    text: text.slice(0, 160),
  });

  if (!isOutboundFromPage(event, entryId, platform)) return;

  if (!customerId || getOutboundSenderIds().has(String(customerId))) {
    console.log(
      `Page outbound skipped — no customer PSID (resolved=${customerId || "none"}).`
    );
    return;
  }

  if (botEcho) return;

  if (!humanEcho) {
    console.log(
      `Page outbound ignored for ${customerId} — not classified as human admin (app_id=${appId || "none"}).`
    );
    return;
  }

  console.log(
    `Page outbound → customer ${customerId}: echo=${isMessageEchoEvent(event)} app_id=${appId || "none"} human=true text=${JSON.stringify(text)} platform=${platform}`
  );

  if (isAdminResumeCommand(text)) {
    await resumeBotForCustomer(customerId, text);
    return;
  }

  pauseBotForAdminTakeover(customerId, text.trim() || "[admin message]", platform);
}

async function expireStaleAdminTakeovers() {
  const expired = [];
  for (const [scopedKey, rawSession] of handoffSessions.entries()) {
    const session = normalizeHandoffSession(rawSession);
    if (!session || session.mode !== "admin_active") continue;
    if (Date.now() <= session.expiresAt) continue;
    expired.push(scopedKey);
  }
  for (const scopedKey of expired) {
    const { tenantId, senderId } = parseScopedKey(scopedKey);
    const tenant = getTenantById(tenantId);
    console.log(
      `Admin takeover idle timeout for ${senderId} [${tenantId}] (${HANDOFF_ADMIN_IDLE_MINUTES}m) — auto-resuming AI.`
    );
    if (tenant) {
      await runWithTenant(tenant, () =>
        resumeBotForCustomer(senderId, "(auto-resume after admin idle)")
      );
    } else {
      await resumeBotForCustomer(senderId, "(auto-resume after admin idle)");
    }
  }
}

let mailTransporter = null;

async function sendAlertEmail({ subject, text, to }) {
  const recipient = to || HANDOFF_NOTIFY_EMAIL;
  const provider = getEmailProvider();
  if (!provider) {
    throw new Error(
      "Email not configured. Set RESEND_API_KEY on Render (recommended) or SMTP_* for local dev."
    );
  }

  if (provider === "resend") {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [recipient],
        subject,
        text,
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.message || data.error || `Resend HTTP ${response.status}`);
    }
    return { provider: "resend", id: data.id };
  }

  const transporter = getMailTransporter();
  if (!transporter) {
    throw new Error("SMTP transporter unavailable.");
  }

  const info = await transporter.sendMail({
    from: SMTP_FROM,
    to: recipient,
    subject,
    text,
  });
  return { provider: "smtp", id: info.messageId };
}

function recentUserMessages(senderId, limit = 5) {
  return getChatHistory(senderId)
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .slice(-limit);
}

function lastAssistantMessage(senderId) {
  const history = getChatHistory(senderId);
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") {
      return history[i].content || "";
    }
  }
  return "";
}

function getConversationTextsForQuote(senderId, limit = 16) {
  return getChatHistory(senderId)
    .slice(-limit)
    .map((message) => message.content)
    .filter(Boolean);
}

function queueLeadCapture(payload) {
  if (!isLeadCaptureConfigured()) return;

  (async () => {
    const profileName = await resolveCustomerDisplayName(
      payload.senderId,
      payload.platform
    );
    const name = payload.name || profileName || "";
    const result = await recordLead({ ...payload, name });
    if (!result?.ok || !result.notify) return;
    await notifyLeadByEmail(result.lead, result.isNew);
  })().catch((err) => {
    console.warn("Lead capture failed:", err.message);
  });
}

function captureLeadFromMessage(senderId, userText, platform, options = {}) {
  const signal = analyzeLeadSignal(userText, {
    ...options,
    historyTexts: recentUserMessages(senderId),
  });
  if (!signal) return;

  queueLeadCapture({
    senderId,
    platform,
    name: options.name || extractName(userText) || "",
    phone: signal.phone || options.phone || "",
    interest: signal.interest || "",
    stage: signal.stage,
    lastMessage: userText,
    trigger: signal.trigger,
  });
}

function queueOrderCapture(payload) {
  if (!isOrderCaptureConfigured()) return;

  (async () => {
    const profileName = await resolveCustomerDisplayName(
      payload.senderId,
      payload.platform
    );
    const name = payload.name || profileName || "";
    const result = await recordOrder({ ...payload, name });
    if (!result?.ok || !result.notify) return;
    await notifyOrderByEmail(result.order, result.isNew);
  })().catch((err) => {
    console.warn("Order capture failed:", err.message);
  });
}

function captureOrderFromMessage(senderId, userText, platform, options = {}) {
  const historyTexts = getConversationTextsForQuote(senderId, 16);
  const addToOrder =
    ADD_TO_ORDER_PATTERN.test(userText) &&
    Boolean(analyzeLeadSignal(userText, { historyTexts: recentUserMessages(senderId, 8) })?.interest);
  const isOrderIntent =
    options.isOrderIntent ||
    ORDER_INTENT_PATTERN.test(userText) ||
    addToOrder;
  const signal = analyzeOrderSignal(userText, {
    ...options,
    historyTexts: recentUserMessages(senderId, 8),
    isOrderIntent: options.isPaymentProofImage || isOrderIntent,
    isPaymentProofImage: Boolean(options.isPaymentProofImage),
  });
  if (!signal && !options.postQuoteCapture) return;

  queueOrderCapture({
    senderId,
    platform,
    name: signal?.name || options.name || "",
    phone: options.phone || signal?.phone || "",
    bean: signal?.bean || "",
    size: signal?.size || "",
    fulfillment: options.fulfillment || signal?.fulfillment || "",
    address: options.address || signal?.address || "",
    paymentStatus: signal?.paymentStatus || "unpaid",
    orderStatus: options.orderStatus || signal?.orderStatus || "inquiry",
    lastMessage: userText,
    userText,
    historyTexts,
    assistantReply: options.assistantReply || "",
    trigger: options.trigger || signal?.trigger || "order",
  });
}

function buildQuoteShareUrl(quote) {
  if (!quote?.quoteId || !quote?.shareToken) return "";
  const base = PUBLIC_BASE_URL || "";
  if (!base) return "";
  return `${base}/quote/${encodeURIComponent(quote.quoteId)}?t=${encodeURIComponent(quote.shareToken)}`;
}

async function notifyOrderByEmail(order, isNew) {
  if (!isEmailConfigured() || !order) return false;

  const channel = order.platform === "instagram" ? "Instagram DM" : "Facebook Messenger";
  const action = isNew ? "New order" : "Order updated";
  const adminPanelUrl =
    PUBLIC_BASE_URL && ADMIN_SECRET
      ? `${PUBLIC_BASE_URL}/admin/orders?token=${encodeURIComponent(ADMIN_SECRET)}`
      : "";

  try {
    await sendAlertEmail({
      to: ORDER_NOTIFY_EMAIL,
      subject: `Beantol — ${action} ${order.orderId} (${order.orderStatus})`,
      text: [
        `${action} on ${channel}.`,
        "",
        `Order ID: ${order.orderId}`,
        `Order status: ${order.orderStatus}`,
        `Payment: ${order.paymentStatus}`,
        `Bean: ${order.bean || "—"}`,
        `Size: ${order.size || "—"}`,
        order.lineItems ? `Line items: ${order.lineItems}` : null,
        order.subtotal ? `Subtotal: ₱${Number(order.subtotal).toLocaleString("en-PH")}` : null,
        `Fulfillment: ${order.fulfillment || "—"}`,
        `Platform: ${channel}`,
        `Sender ID: ${order.senderId}`,
        order.name ? `Name: ${order.name}` : null,
        order.phone ? `Phone: ${order.phone}` : null,
        order.address ? `Address: ${order.address}` : null,
        "",
        `Last message: ${order.lastMessage}`,
        "",
        adminPanelUrl ? `View orders: ${adminPanelUrl}` : null,
        "Open Meta Business Suite to reply in chat.",
      ]
        .filter(Boolean)
        .join("\n"),
    });
    console.log(`Order alert email sent for ${order.orderId}.`);
    return true;
  } catch (err) {
    console.error("Order alert email failed:", err.message);
    return false;
  }
}

async function notifyPaymentProofByEmail(senderId, userText, platform = "messenger") {
  if (!isEmailConfigured()) return false;

  const channel = platform === "instagram" ? "Instagram DM" : "Facebook Messenger";
  const adminPanelUrl =
    PUBLIC_BASE_URL && ADMIN_SECRET
      ? `${PUBLIC_BASE_URL}/admin/orders?token=${encodeURIComponent(ADMIN_SECRET)}`
      : "";

  try {
    await sendAlertEmail({
      to: ORDER_NOTIFY_EMAIL,
      subject: "Beantol — Customer says they sent payment proof (image)",
      text: [
        `Customer says they sent payment proof (image attached) on ${channel}.`,
        "",
        `Sender ID: ${senderId}`,
        `Message context: ${String(userText || "").slice(0, 300)}`,
        "",
        "Please review in chat and confirm payment in the Orders sheet.",
        adminPanelUrl ? `View orders: ${adminPanelUrl}` : null,
        "Open Meta Business Suite to view the image.",
      ]
        .filter(Boolean)
        .join("\n"),
    });
    console.log(`Payment proof alert email sent for ${senderId}.`);
    return true;
  } catch (err) {
    console.error("Payment proof alert email failed:", err.message);
    return false;
  }
}

async function notifyLeadByEmail(lead, isNew) {
  if (!isEmailConfigured() || !lead) return false;

  const channel = lead.platform === "instagram" ? "Instagram DM" : "Facebook Messenger";
  const action = isNew ? "New lead" : "Lead updated";
  const adminPanelUrl =
    PUBLIC_BASE_URL && ADMIN_SECRET
      ? `${PUBLIC_BASE_URL}/admin/leads?token=${encodeURIComponent(ADMIN_SECRET)}`
      : "";

  try {
    await sendAlertEmail({
      to: LEAD_NOTIFY_EMAIL,
      subject: `Beantol — ${action} (${lead.stage})`,
      text: [
        `${action} on ${channel}.`,
        "",
        `Stage: ${lead.stage}`,
        `Trigger: ${lead.trigger || "—"}`,
        `Platform: ${channel}`,
        `Sender ID: ${lead.senderId}`,
        lead.name ? `Name: ${lead.name}` : null,
        lead.phone ? `Phone: ${lead.phone}` : null,
        lead.interest ? `Interest: ${lead.interest}` : null,
        "",
        `Last message: ${lead.lastMessage}`,
        "",
        adminPanelUrl ? `View leads: ${adminPanelUrl}` : null,
        "Open Meta Business Suite to reply in chat.",
      ]
        .filter(Boolean)
        .join("\n"),
    });
    console.log(`Lead alert email sent for ${lead.senderId} (${lead.stage}).`);
    return true;
  } catch (err) {
    console.error("Lead alert email failed:", err.message);
    return false;
  }
}

async function notifyAppointmentByEmail(appointment) {
  if (!isEmailConfigured() || !appointment) return false;

  const channel =
    appointment.platform === "instagram" ? "Instagram DM" : "Facebook Messenger";
  const adminUrl =
    PUBLIC_BASE_URL && ADMIN_SECRET
      ? `${PUBLIC_BASE_URL}/admin/appointments/view?token=${encodeURIComponent(ADMIN_SECRET)}`
      : "";

  try {
    await sendAlertEmail({
      to: LEAD_NOTIFY_EMAIL,
      subject: `Beantol — Appointment request ${appointment.appointmentId}`,
      text: [
        `New appointment request on ${channel}.`,
        "",
        `ID: ${appointment.appointmentId}`,
        `Type: ${appointment.type}`,
        `Preferred: ${formatPreferredWhen(appointment.preferredDate, appointment.preferredTime)}`,
        appointment.name ? `Name: ${appointment.name}` : null,
        appointment.phone ? `Phone: ${appointment.phone}` : null,
        `Sender ID: ${appointment.senderId}`,
        "",
        adminUrl ? `View: ${adminUrl}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    });
    console.log(`Appointment alert email sent for ${appointment.appointmentId}.`);
    return true;
  } catch (err) {
    console.error("Appointment alert email failed:", err.message);
    return false;
  }
}

async function notifyAgentRequested(
  senderId,
  userText,
  source,
  platform = "messenger",
  welcomeState = null
) {
  requestHumanAgent(senderId, userText, platform);
  console.log(
    `Human agent requested for ${senderId} (${source}, ${platformLabel(platform)}). AI still replies until an admin messages from Business Suite.`
  );
  await deliverCustomerReply(senderId, userText, platform, getHandoffReply(), welcomeState);
  notifyHandoffByEmail(senderId, userText, platform).catch((err) => {
    console.error("Handoff email failed:", err.message);
  });
}

/** Customer-requested handoff only — blocked outside live support hours. */
async function attemptCustomerHandoff(
  senderId,
  userText,
  source,
  platform = "messenger",
  welcomeState = null
) {
  if (!isWithinLiveSupportHours()) {
    console.log(
      `Customer handoff blocked for ${senderId} (${source}) — outside support hours (${SUPPORT_HOURS_START}:00–${SUPPORT_HOURS_END}:00 ${SUPPORT_TIMEZONE}).`
    );
    await deliverCustomerReply(
      senderId,
      userText,
      platform,
      AFTER_HOURS_HANDOFF_REPLY,
      welcomeState
    );
    return false;
  }
  await notifyAgentRequested(senderId, userText, source, platform, welcomeState);
  return true;
}

function getMailTransporter() {
  if (!isSmtpConfigured()) return null;
  if (!mailTransporter) {
    mailTransporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
    });
  }
  return mailTransporter;
}

async function notifyHandoffByEmail(senderId, userText, platform = "messenger") {
  if (!isEmailConfigured()) {
    console.warn(
      "Handoff email skipped — set RESEND_API_KEY on Render (recommended) or SMTP_* locally."
    );
    return;
  }

  const channel = platformLabel(platform);
  const handedOffAt = new Date().toISOString();
  const tenant = getActiveTenant();
  const tenantId = tenant?.id || "";
  const brand = businessName(tenant);
  const resumeUrl = buildResumeUrl(senderId, null, true, tenantId || null);
  const adminPanelUrl =
    PUBLIC_BASE_URL && ADMIN_SECRET
      ? `${PUBLIC_BASE_URL}/admin?token=${encodeURIComponent(ADMIN_SECRET)}`
      : "";

  const result = await sendAlertEmail({
    subject: `${brand} — customer wants a human (${channel})`,
    to: getNotifyEmail("handoff", tenant) || HANDOFF_NOTIFY_EMAIL,
    text: [
      `A customer asked to speak with a real person on ${channel}.`,
      "",
      `Shop: ${brand}${tenantId ? ` (${tenantId})` : ""}`,
      `Time: ${handedOffAt}`,
      `Channel: ${channel}`,
      `Sender ID: ${senderId}`,
      `Their message: ${userText}`,
      "",
      "AI still answers follow-up questions until you reply in Business Suite. Once you send a message, the bot pauses for this chat.",
      `Bot auto-resumes after ${HANDOFF_ADMIN_IDLE_MINUTES} minutes of admin idle, or use Resume AI:`,
      resumeUrl ? `Resume AI + notify customer: ${resumeUrl}` : "(Set PUBLIC_BASE_URL on Render for one-click resume links)",
      adminPanelUrl ? `All paused chats: ${adminPanelUrl}` : "",
      "",
      "Note: #bot in Business Suite often does not reach the server. Use the resume link above instead.",
    ]
      .filter(Boolean)
      .join("\n"),
  });

  console.log(
    `Handoff email sent to ${getNotifyEmail("handoff", tenant) || HANDOFF_NOTIFY_EMAIL} via ${result.provider}`
  );
}

function shouldSendDeliveryAlert(senderId) {
  const expiresAt = deliveryAlertCooldowns.get(scopeKey(senderId));
  if (expiresAt && Date.now() < expiresAt) return false;
  return true;
}

function markDeliveryAlertSent(senderId) {
  deliveryAlertCooldowns.set(scopeKey(senderId), Date.now() + DELIVERY_ALERT_COOLDOWN_MS);
}

async function notifyDeliveryByEmail(
  senderId,
  userText,
  source,
  platform = "messenger"
) {
  if (!shouldSendDeliveryAlert(senderId)) {
    console.log(
      `Delivery alert skipped for ${senderId} (cooldown — already emailed recently).`
    );
    return false;
  }

  if (!isEmailConfigured()) {
    console.warn(
      "Delivery alert email skipped — set RESEND_API_KEY on Render (recommended) or SMTP_* locally."
    );
    return false;
  }

  const channel = platformLabel(platform);
  const now = new Date().toISOString();
  try {
    const result = await sendAlertEmail({
      subject: `Beantol — Maxim delivery inquiry (${channel})`,
      text: [
        `A customer asked about delivery on ${channel}.`,
        "",
        `Time: ${now}`,
        `Channel: ${channel}`,
        `Trigger: ${source}`,
        `Sender ID: ${senderId}`,
        `Their message: ${userText}`,
        "",
        "The bot is still auto-replying and collecting address, name, and phone in the chat.",
        "Reply in Meta Business Suite when you take over — that will pause the bot for this customer.",
      ].join("\n"),
    });
    markDeliveryAlertSent(senderId);
    console.log(
      `Delivery alert email sent to ${HANDOFF_NOTIFY_EMAIL} for ${senderId} (${source}) via ${result.provider}.`
    );
  } catch (err) {
    console.error("Delivery alert email failed:", err.message);
    return false;
  }

  return true;
}

function requireAdmin(req, res) {
  if (!ADMIN_SECRET) {
    res.status(503).json({ error: "ADMIN_SECRET is not configured on the server." });
    return false;
  }

  const token = req.query.token || req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (token !== ADMIN_SECRET) {
    res.status(401).json({ error: "Unauthorized." });
    return false;
  }

  return true;
}

function resolveAdminTenant(req) {
  const tenantId = req.query.tenant ? String(req.query.tenant) : "";
  if (tenantId) {
    const tenant = getTenantById(tenantId);
    if (!tenant) return { error: `Unknown tenant: ${tenantId}` };
    return { tenant };
  }
  return { tenant: getDefaultTenant() };
}

async function runAdminWithTenant(req, fn) {
  const resolved = resolveAdminTenant(req);
  if (resolved.error) throw new Error(resolved.error);
  return runWithTenant(resolved.tenant, fn);
}

function getPublicBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  if (!req) return "";
  const host = req.get("host");
  if (!host) return "";
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  return `${proto}://${host}`;
}

function buildResumeUrl(senderId, req, sendResume = true, tenantId = null) {
  const base = getPublicBaseUrl(req);
  if (!base || !ADMIN_SECRET) return "";
  const params = new URLSearchParams({ token: ADMIN_SECRET });
  if (sendResume) params.set("sendResume", "1");
  if (tenantId) params.set("tenant", tenantId);
  return `${base}/admin/handoffs/${encodeURIComponent(senderId)}/resolve?${params}`;
}

function listActiveHandoffs() {
  const now = Date.now();
  const handoffs = [];

  for (const [scopedKey, rawSession] of handoffSessions.entries()) {
    const session = normalizeHandoffSession(rawSession);
    if (!session) continue;
    if (session.mode === "admin_active" && now > session.expiresAt) {
      handoffSessions.delete(scopedKey);
      continue;
    }
    const { tenantId, senderId } = parseScopedKey(scopedKey);
    handoffs.push({
      senderId,
      tenantId,
      scopedKey,
      mode: session.mode,
      platform: session.platform || "messenger",
      handedOffAt: new Date(session.handedOffAt).toISOString(),
      expiresAt:
        session.mode === "admin_active" && session.expiresAt
          ? new Date(session.expiresAt).toISOString()
          : "",
      lastMessage: session.lastMessage,
      aiPaused: session.mode === "admin_active",
    });
  }

  return handoffs;
}

function handoffStatusLabel(h) {
  return h.mode === "admin_active"
    ? `Admin chatting (AI paused${h.expiresAt ? ` · resumes ~${h.expiresAt.slice(11, 16)} UTC` : ""})`
    : "Awaiting you (AI still on)";
}

function renderHandoffsTableHtml(handoffs, req) {
  if (!handoffs.length) return "";
  const rows = handoffs
    .map((h) => {
      const resumeUrl = buildResumeUrl(h.senderId, req, true, h.tenantId);
      const channel = h.platform === "instagram" ? "Instagram" : "Messenger";
      return `<tr>
        <td>${escapeHtml(h.tenantId || "—")}</td>
        <td>${escapeHtml(channel)}</td>
        <td><code>${escapeHtml(h.senderId)}</code></td>
        <td>${escapeHtml(handoffStatusLabel(h))}</td>
        <td>${escapeHtml(h.lastMessage)}</td>
        <td><a class="button btn-sm" href="${resumeUrl}">Resume AI</a></td>
      </tr>`;
    })
    .join("");
  return `<table><tr><th>Tenant</th><th>Channel</th><th>Customer ID</th><th>Status</th><th>Last note</th><th></th></tr>${rows}</table>`;
}

function renderHandoffsByPlatformHtml(handoffs, req) {
  const messenger = handoffs.filter((h) => h.platform !== "instagram");
  const instagram = handoffs.filter((h) => h.platform === "instagram");
  let html = `<h2>Messenger</h2>`;
  html += messenger.length
    ? renderHandoffsTableHtml(messenger, req)
    : `<p class="muted">No active Messenger handoffs.</p>`;
  html += `<h2 style="margin-top:28px">Instagram</h2>`;
  html += instagram.length
    ? renderHandoffsTableHtml(instagram, req)
    : `<p class="muted">No active Instagram handoffs.</p>`;
  return html;
}

async function graphGet(path, accessToken = PAGE_ACCESS_TOKEN) {
  const url = `https://graph.facebook.com/v19.0/${path}${path.includes("?") ? "&" : "?"}access_token=${accessToken}`;
  const response = await fetch(url);
  const data = await response.json();
  return { ok: response.ok, data };
}

async function fetchPageInstagramStatus() {
  if (!PAGE_ACCESS_TOKEN) {
    return { error: "PAGE_ACCESS_TOKEN not set on server." };
  }

  const pageIdToTry = PAGE_ID_ENV || pageId;
  const fieldQuery =
    "fields=instagram_business_account{id,username,name},connected_instagram_account{id,username,name},name,id";

  const attempts = [];
  if (pageIdToTry) {
    attempts.push({
      label: `page ${pageIdToTry}`,
      path: `${encodeURIComponent(pageIdToTry)}?${fieldQuery}`,
    });
  }
  attempts.push({ label: "me", path: `me?${fieldQuery}` });

  for (const attempt of attempts) {
    try {
      const { ok, data } = await graphGet(attempt.path);
      if (!ok) {
        if (data.error?.code === 100) continue;
        return { error: data.error?.message || JSON.stringify(data) };
      }
      const ig =
        data.instagram_business_account || data.connected_instagram_account || null;
      return {
        page: { id: data.id, name: data.name },
        instagram: ig,
        instagramLinked: Boolean(ig?.id),
        checkedVia: attempt.label,
      };
    } catch (err) {
      continue;
    }
  }

  if (INSTAGRAM_ACCOUNT_ID || INSTAGRAM_USERNAME) {
    return {
      page: pageIdToTry ? { id: pageIdToTry } : null,
      instagram: {
        id: INSTAGRAM_ACCOUNT_ID || undefined,
        username: INSTAGRAM_USERNAME || undefined,
      },
      instagramLinked: true,
      checkedVia: "env (INSTAGRAM_ACCOUNT_ID / INSTAGRAM_USERNAME)",
      apiCheckUnavailable: true,
      hint:
        "Meta API lookup blocked (needs pages_read_engagement). Using env vars. IG DMs can still work if webhook is subscribed.",
    };
  }

  return {
    page: pageIdToTry ? { id: pageIdToTry } : null,
    instagram: null,
    instagramLinked: null,
    apiCheckUnavailable: true,
    hint:
      "Cannot verify via Meta API without pages_read_engagement. Check Business Suite → Linked accounts. Optional on Render: PAGE_ID, INSTAGRAM_USERNAME. IG DMs still work if webhook + instagram_manage_messages are set up.",
  };
}

// --- Health check (useful after deploy) ---
app.get("/", (req, res) => {
  res.send("Beantol bot is running (Facebook Messenger + Instagram DMs).");
});

function adminToken(req) {
  return req.query.token || req.body?.token || "";
}

function adminFlash(req) {
  if (req.query.saved === "1") return "Changes saved.";
  if (req.query.error) return `Error: ${req.query.error}`;
  return "";
}

// --- Admin dashboard (bookmark on phone/PC) ---
app.get("/admin", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const token = adminToken(req);
  const handoffs = listActiveHandoffs();
  const meta = await fetchPageInstagramStatus();
  let webhookSubHtml = "";
  try {
    const subStatus = await getMessagingSubscriptionStatus();
    const fields = [...extractSubscribedFieldsFromStatus(subStatus)].sort().join(", ") || "unknown";
    const echoesOn = hasMessageEchoesSubscription(subStatus);
    webhookSubHtml = echoesOn
      ? `<p class="muted"><strong>Webhook:</strong> message_echoes <span style="color:#0a7">on</span> (${escapeHtml(fields)}) — admin replies should arrive with <code>app_id=${META_PAGE_INBOX_APP_ID}</code>. <a href="/admin/webhook-log?token=${encodeURIComponent(token)}">Webhook debug log →</a></p>`
      : `<div class="alert-warn"><strong>Webhook:</strong> <code>message_echoes</code> is <strong>not</strong> subscribed via API (${escapeHtml(fields)}). Enable it in <a href="https://developers.facebook.com/" target="_blank" rel="noopener">Meta Developer</a> → Webhooks → your Page, then <a href="/admin/subscribe-webhooks?token=${encodeURIComponent(token)}">re-subscribe</a>. <a href="/admin/webhook-log?token=${encodeURIComponent(token)}">Debug log →</a></div>`;
  } catch (_) {
    webhookSubHtml = `<p class="muted"><strong>Webhook:</strong> could not check subscription — set <code>PAGE_ID</code> on Render.</p>`;
  }

  let newLeads = 0;
  let activeOrders = 0;
  let recentQuotes = 0;
  let lowStockAlert = "";

  if (isLeadCaptureConfigured()) {
    try {
      const leadData = await listLeads(100);
      newLeads = (leadData.leads || []).filter(
        (l) => (l.teamStatus || "New") === "New"
      ).length;
    } catch (_) {
      /* overview still loads */
    }
  }
  if (isOrderCaptureConfigured()) {
    try {
      const orderData = await listOrders(100);
      activeOrders = (orderData.orders || []).filter(
        (o) => !["completed", "cancelled"].includes(String(o.orderStatus).toLowerCase())
      ).length;
    } catch (_) {
      /* overview still loads */
    }
  }
  if (isQuoteCaptureConfigured()) {
    try {
      const quoteData = await listQuotes(20);
      recentQuotes = quoteData.count || 0;
    } catch (_) {
      /* overview still loads */
    }
  }
  if (isInventorySheetConfigured()) {
    try {
      const inv = await listInventory();
      const low = (inv.lowStock || []).filter(
        (name) => !(inv.unavailable || []).includes(name)
      );
      if (low.length) {
        lowStockAlert = `<div class="alert-warn"><strong>Low stock:</strong> ${escapeHtml(low.join(", "))} — <a href="/admin/inventory/view?token=${encodeURIComponent(token)}">Inventory</a></div>`;
      }
    } catch (_) {
      /* overview still loads */
    }
  }

  let metaHtml;
  if (meta.error) {
    metaHtml = `<p class="muted"><strong>Page / Instagram:</strong> ${escapeHtml(meta.error)}</p>`;
  } else if (meta.instagramLinked === true) {
    const ig = meta.instagram || {};
    const igLabel = ig.username ? `@${ig.username}` : ig.name || ig.id || "linked";
    metaHtml = `<p class="muted"><strong>Page:</strong> ${escapeHtml(meta.page?.name || meta.page?.id || "—")} · <strong>Instagram:</strong> ${escapeHtml(igLabel)}</p>`;
  } else if (meta.instagramLinked === false) {
    metaHtml = `<p class="muted"><strong>Instagram:</strong> <em>not linked</em> to this Page token.</p>`;
  } else {
    metaHtml = `<p class="muted"><strong>Instagram:</strong> ${escapeHtml(meta.hint || "check Business Suite")}</p>`;
  }

  const pausedCount = handoffs.filter((h) => h.aiPaused).length;
  const awaitingCount = handoffs.filter((h) => h.mode === "agent_requested").length;

  const handoffTable = renderHandoffsTableHtml(handoffs, req);

  const stats = statCards({
    "AI paused (admin)": pausedCount,
    "Awaiting agent": awaitingCount,
    "New leads": isLeadCaptureConfigured() ? newLeads : "—",
    "Active orders": isOrderCaptureConfigured() ? activeOrders : "—",
    "Recent quotes": isQuoteCaptureConfigured() ? recentQuotes : "—",
  });

  const body = `${metaHtml}
${webhookSubHtml}
${lowStockAlert}
${stats}
<h2>Handoffs</h2>
<p class="muted">AI keeps helping after a human request until <strong>you</strong> reply in Business Suite — then it pauses for ${HANDOFF_ADMIN_IDLE_MINUTES} minutes. Use the <strong>Handoffs</strong> tab for Messenger vs Instagram. <strong>Resume AI</strong> turns the bot back on early.</p>
${handoffTable || "<p>No active handoffs.</p>"}`;

  res.type("html").send(
    renderPage({
      title: "Ops overview",
      active: "overview",
      token,
      body,
      flash: adminFlash(req),
      bookmark: true,
      req,
    })
  );
});

app.get("/admin/handoffs/view", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const token = adminToken(req);
  const handoffs = listActiveHandoffs();
  const pausedCount = handoffs.filter((h) => h.aiPaused).length;
  const awaitingCount = handoffs.filter((h) => h.mode === "agent_requested").length;

  const body = `${statCards({
    "AI paused (admin)": pausedCount,
    "Awaiting agent": awaitingCount,
    "Messenger": handoffs.filter((h) => h.platform !== "instagram").length,
    "Instagram": handoffs.filter((h) => h.platform === "instagram").length,
  })}
<p class="muted">Reply in <a href="https://business.facebook.com/latest/inbox" target="_blank" rel="noopener">Meta Business Suite inbox</a> to pause the bot. <strong>Resume AI</strong> sends the “assistant is back” message and clears the handoff for that customer.</p>
<p class="muted"><strong>Instagram Requests:</strong> DMs from accounts that don’t follow Beantol often land in <em>Requests</em> — Meta may not notify the bot until you tap <strong>Accept</strong> in Business Suite. After accepting, the customer should message again (or you reply once manually).</p>
${renderHandoffsByPlatformHtml(handoffs, req)}`;

  res.type("html").send(
    renderPage({
      title: "Handoffs — Messenger & Instagram",
      active: "handoffs",
      token,
      body,
      flash: adminFlash(req),
    })
  );
});

app.get("/admin/instagram-setup/view", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const token = adminToken(req);
  const u = (path) => adminUrl(path, token);
  const meta = await fetchPageInstagramStatus();
  let subFields = "unknown";
  let echoesOn = false;
  try {
    const subStatus = await getMessagingSubscriptionStatus();
    subFields = [...extractSubscribedFieldsFromStatus(subStatus)].sort().join(", ") || "none";
    echoesOn = hasMessageEchoesSubscription(subStatus);
  } catch (_) {
    /* show checklist anyway */
  }

  const igLabel =
    meta.instagramLinked === true
      ? meta.instagram?.username
        ? `@${meta.instagram.username}`
        : meta.instagram?.name || meta.instagram?.id || "linked"
      : meta.instagramLinked === false
        ? "not linked to Page token"
        : "check Business Suite";

  const webhookLine = webhookStats.lastPostAt
    ? `Last POST <strong>${escapeHtml(webhookStats.lastPostAt)}</strong> · object=<code>${escapeHtml(String(webhookStats.lastObject || "—"))}</code> · total=${webhookStats.totalPosts}`
    : `<strong class="alert-warn">No webhook POSTs since server started</strong> — Meta is not calling your Render URL yet.`;

  const body = `<p class="muted">If <a href="${u("/admin/webhook-log")}">Webhook log</a> stays empty when someone IG DMs Beantol, the problem is Meta setup or Message Requests — not the AI.</p>
${statCards({
    "Webhook POSTs (session)": webhookStats.totalPosts,
    "Page subscribed fields": subFields.split(",").length,
    "message_echoes (Page API)": echoesOn ? "yes" : "no",
    "Instagram link": igLabel,
  })}
<p class="muted">${webhookLine}</p>

<h2>Checklist</h2>
<ol style="line-height:1.8">
<li><strong>Accept the DM</strong> — Business Suite → Instagram → <em>Requests</em> → Accept (non-followers often never hit the bot until accepted).</li>
<li><strong>Meta Developer → Webhooks</strong> — Callback URL must be <code>https://beantol-bot.onrender.com/webhook</code> (same verify token as Render <code>VERIFY_TOKEN</code>).</li>
<li><strong>Subscribe Instagram account</strong> — Under Webhooks, add your <strong>Instagram</strong> account (not only the Facebook Page) and enable <strong>messages</strong>.</li>
<li><strong>App mode Live</strong> — In Development mode, only app testers receive webhooks. For real customers, app must be <strong>Live</strong> with <strong>instagram_manage_messages</strong> approved in App Review.</li>
<li><strong>Re-subscribe Page</strong> — <a href="${u("/admin/subscribe-webhooks")}" target="_blank" rel="noopener">Open subscribe-webhooks</a> (JSON should show success).</li>
<li><strong>Test again</strong> — Customer sends “hi” → refresh <a href="${u("/admin/webhook-log")}">Webhook log</a>. You should see <code>webhook_post object=instagram</code> and <code>inbound_message platform=instagram</code>.</li>
</ol>

<h2>What you should see when it works</h2>
<table><tr><th>Step</th><th>Webhook log</th></tr>
<tr><td>Customer IG DM</td><td><code>webhook_post · object=instagram · parsed=1</code></td></tr>
<tr><td>Bot processes</td><td><code>inbound_message · instagram · sender=… · text=hi</code></td></tr>
<tr><td>Bot replies</td><td><code>page_outbound · human=false · app_id=&lt;bot app&gt;</code></td></tr>
</table>

<p class="muted"><a href="${u("/admin/meta-status")}" target="_blank" rel="noopener">Meta / Instagram status (JSON)</a> · <a href="https://developers.facebook.com/" target="_blank" rel="noopener">Meta Developer</a></p>`;

  res.type("html").send(
    renderPage({
      title: "Instagram setup",
      active: "instagram",
      token,
      body,
    })
  );
});

app.get("/admin/tools/view", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const token = adminToken(req);
  const u = (path) => adminUrl(path, token);

  const body = `<p class="muted">API tools open in a new tab. Use the tabs above for day-to-day ops.</p>
<div class="grid-2">
${renderToolCard("Meta Business Suite inbox", "Reply to customers as the Page (Messenger + Instagram).", "https://business.facebook.com/latest/inbox", true)}
${renderToolCard("Re-subscribe webhooks", "Register Page webhook fields (messages, message_echoes, etc.) with Meta.", u("/admin/subscribe-webhooks"), true)}
${renderToolCard("Webhook debug log", "See recent echoes — human admin replies show human=true.", u("/admin/webhook-log"))}
${renderToolCard("Test email", "Send a test alert to HANDOFF_NOTIFY_EMAIL.", u("/admin/test-email"), true)}
${renderToolCard("Meta / Instagram status", "Check whether Instagram is linked to your Page token.", u("/admin/meta-status"), true)}
${renderToolCard("Shop closures", "Set special closure dates (holidays, events) in Google Sheet — bot picks them up automatically.", u("/admin/closures/view"))}
${renderToolCard("Sync knowledge (Google Doc)", "Pull latest Q&A from Google Docs into the bot.", u("/admin/sync-knowledge"), true)}
${renderToolCard("Reindex knowledge", "Rebuild search index from local + synced sources.", u("/admin/reindex-knowledge"), true)}
${renderToolCard("Knowledge status", "See indexed chunks and last sync time.", u("/admin/knowledge-status"), true)}
${renderToolCard("Handoffs JSON", "List active handoffs (API).", u("/admin/handoffs"), true)}
</div>`;

  res.type("html").send(
    renderPage({
      title: "Admin tools",
      active: "tools",
      token,
      body,
    })
  );
});

app.get("/admin/analytics/view", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const token = adminToken(req);

  try {
    const [leadData, orderData, quoteData, eventData, invData] = await Promise.all([
      isLeadCaptureConfigured() ? listLeads(200) : { leads: [] },
      isOrderCaptureConfigured() ? listOrders(200) : { orders: [] },
      isQuoteCaptureConfigured() ? listQuotes(200) : { quotes: [] },
      isEventsLogConfigured() ? listEvents(1000) : { events: [] },
      isInventorySheetConfigured() ? listInventory() : { items: [] },
    ]);

    const stats = computeAnalytics({
      leads: leadData.leads || [],
      orders: orderData.orders || [],
      quotes: quoteData.quotes || [],
      events: eventData.events || [],
      inventory: invData.items || [],
      handoffCount: listActiveHandoffs().length,
    });

    res.type("html").send(
      renderPage({
        title: "Analytics",
        active: "analytics",
        token,
        body: renderAnalyticsHtml(stats),
        flash: adminFlash(req),
      })
    );
  } catch (err) {
    res.status(500).type("html").send(
      renderPage({
        title: "Analytics",
        active: "analytics",
        token,
        body: `<p>Could not load analytics: ${escapeHtml(err.message)}</p>`,
      })
    );
  }
});

app.get("/admin/analytics", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const [leadData, orderData, quoteData, eventData, invData] = await Promise.all([
      isLeadCaptureConfigured() ? listLeads(200) : { leads: [] },
      isOrderCaptureConfigured() ? listOrders(200) : { orders: [] },
      isQuoteCaptureConfigured() ? listQuotes(200) : { quotes: [] },
      isEventsLogConfigured() ? listEvents(1000) : { events: [] },
      isInventorySheetConfigured() ? listInventory() : { items: [] },
    ]);
    const stats = computeAnalytics({
      leads: leadData.leads || [],
      orders: orderData.orders || [],
      quotes: quoteData.quotes || [],
      events: eventData.events || [],
      inventory: invData.items || [],
      handoffCount: listActiveHandoffs().length,
    });
    res.json({ ok: true, ...stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/sales/view", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const token = adminToken(req);
  if (!isLeadCaptureConfigured()) {
    return res.status(400).type("html").send(
      renderPage({
        title: "Sales pipeline",
        active: "sales",
        token,
        body: "<p>Lead capture not configured.</p>",
      })
    );
  }
  try {
    const data = await listLeads(200);
    const pipeline = listPipelineLeads(data.leads || []);
    res.type("html").send(
      renderPage({
        title: "Sales pipeline",
        active: "sales",
        token,
        body: renderSalesPipelineHtml(pipeline, token),
        flash: adminFlash(req),
      })
    );
  } catch (err) {
    res.status(500).type("html").send(
      renderPage({
        title: "Sales pipeline",
        active: "sales",
        token,
        body: `<p>Could not load pipeline: ${escapeHtml(err.message)}</p>`,
      })
    );
  }
});

app.get("/admin/sales/check-stale", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const token = adminToken(req);
  if (!isEmailConfigured()) {
    return res.redirect(
      `/admin/sales/view?token=${encodeURIComponent(token)}&error=${encodeURIComponent("Email not configured")}`
    );
  }
  try {
    const data = await listLeads(200);
    const { stale } = listPipelineLeads(data.leads || []);
    if (!stale.length) {
      return res.redirect(
        `/admin/sales/view?token=${encodeURIComponent(token)}&saved=1`
      );
    }
    await sendAlertEmail({
      to: LEAD_NOTIFY_EMAIL,
      subject: `Beantol — ${stale.length} lead(s) need follow-up`,
      text: [
        "These leads have not progressed in 3+ days:",
        "",
        formatStaleLeadsEmail(stale),
        "",
        PUBLIC_BASE_URL && ADMIN_SECRET
          ? `Sales pipeline: ${PUBLIC_BASE_URL}/admin/sales/view?token=${encodeURIComponent(ADMIN_SECRET)}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    });
    res.redirect(`/admin/sales/view?token=${encodeURIComponent(token)}&saved=1`);
  } catch (err) {
    res.redirect(
      `/admin/sales/view?token=${encodeURIComponent(token)}&error=${encodeURIComponent(err.message)}`
    );
  }
});

app.get("/admin/appointments/view", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const token = adminToken(req);
  if (!isAppointmentCaptureConfigured()) {
    return res.status(400).type("html").send(
      renderPage({
        title: "Appointments",
        active: "appointments",
        token,
        body: "<p>Appointments use the same Google Sheet — <strong>Appointments</strong> tab is created on first booking.</p>",
      })
    );
  }
  try {
    const data = await listAppointments(50);
    const rows = (data.appointments || [])
      .map((ap) => {
        const action = `/admin/appointments/${encodeURIComponent(ap.appointmentId)}/update?token=${encodeURIComponent(token)}`;
        return `<tr>
          <td><code>${escapeHtml(ap.appointmentId)}</code></td>
          <td>${escapeHtml((ap.created || "").slice(0, 16))}</td>
          <td>${escapeHtml(ap.name || "—")}</td>
          <td>${escapeHtml(ap.type || "—")}</td>
          <td>${escapeHtml(ap.preferredDate || "—")} ${escapeHtml(ap.preferredTime || "")}</td>
          <td>${escapeHtml(ap.phone || "—")}</td>
          <td>
            <form class="inline-form" method="post" action="${action}">
              <select name="status">${optionTags(APPOINTMENT_STATUSES, ap.status || "requested")}</select>
              <input name="notes" placeholder="Notes" value="${escapeHtml(ap.notes || "")}">
              <button class="btn btn-sm" type="submit">Save</button>
            </form>
          </td>
        </tr>`;
      })
      .join("");
    const body = `<p class="muted">Shop visits, cupping, and callbacks booked via chat. Mon–Fri shop hours — confirm with customer in Messenger.</p>
${rows ? `<table><tr><th>ID</th><th>Created</th><th>Name</th><th>Type</th><th>When</th><th>Phone</th><th>Status</th></tr>${rows}</table>` : "<p>No appointments yet. Customer can say \"book a shop visit\" in chat.</p>"}`;
    res.type("html").send(
      renderPage({
        title: "Appointments",
        active: "appointments",
        token,
        body,
        flash: adminFlash(req),
      })
    );
  } catch (err) {
    res.status(500).type("html").send(
      renderPage({
        title: "Appointments",
        active: "appointments",
        token,
        body: `<p>Could not load appointments: ${escapeHtml(err.message)}</p>`,
      })
    );
  }
});

app.post("/admin/appointments/:appointmentId/update", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const token = adminToken(req);
  try {
    const result = await updateAppointmentStatus(
      req.params.appointmentId,
      req.body.status,
      req.body.notes
    );
    if (!result?.ok) {
      return res.redirect(
        `/admin/appointments/view?token=${encodeURIComponent(token)}&error=${encodeURIComponent(result?.reason || "Update failed")}`
      );
    }
    res.redirect(`/admin/appointments/view?token=${encodeURIComponent(token)}&saved=1`);
  } catch (err) {
    res.redirect(
      `/admin/appointments/view?token=${encodeURIComponent(token)}&error=${encodeURIComponent(err.message)}`
    );
  }
});

app.get("/admin/leads/view", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const token = adminToken(req);
  if (!isLeadCaptureConfigured()) {
    return res.status(400).type("html").send(
      renderPage({
        title: "Leads",
        active: "leads",
        token,
        body: "<p>Lead capture not configured. Set GOOGLE_LEADS_SHEET_ID on Render.</p>",
      })
    );
  }

  try {
    const statusFilter = req.query.status || "";
    const showArchived = req.query.archived === "1";
    const limit = Math.min(Number(req.query.limit) || 100, 200);
    const data = await listLeads(limit);
    let leads = data.leads || [];
    if (!showArchived) {
      leads = leads.filter((l) => !ARCHIVED_LEAD_STATUSES.has(l.teamStatus || "New"));
    }
    if (statusFilter) {
      leads = leads.filter((l) => (l.teamStatus || "New") === statusFilter);
    }

    const filterForm = `<form class="filters" method="get">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<label>Team status <select name="status"><option value="">All</option>${optionTags(TEAM_STATUSES, statusFilter)}</select></label>
${archiveCheckbox("archived", showArchived, "Show Won / Lost")}
<button class="btn btn-sm" type="submit">Filter</button>
<a class="muted" href="/admin/leads?token=${encodeURIComponent(token)}">JSON API</a>
</form>`;

    const rows = leads
      .map((lead) => {
        const action = `/admin/leads/${encodeURIComponent(lead.senderId)}/update?token=${encodeURIComponent(token)}`;
        return `<tr>
          <td>${escapeHtml((lead.updated || lead.created || "").slice(0, 16))}</td>
          <td>${escapeHtml(lead.name || "—")}</td>
          <td>${escapeHtml(lead.stage || "—")}</td>
          <td>${escapeHtml(lead.interest || "—")}</td>
          <td>${escapeHtml(lead.phone || "—")}</td>
          <td>
            <form class="inline-form" method="post" action="${action}">
              <select name="teamStatus">${optionTags(TEAM_STATUSES, lead.teamStatus || "New")}</select>
              <input name="assignedTo" placeholder="Assigned" value="${escapeHtml(lead.assignedTo || "")}">
              <details class="row-edit"><summary>Notes</summary>
                <textarea name="notes">${escapeHtml(lead.notes || "")}</textarea>
                <input name="nextAction" placeholder="Next action" value="${escapeHtml(lead.nextAction || "")}">
              </details>
              <button class="btn btn-sm" type="submit">Save</button>
            </form>
          </td>
        </tr>`;
      })
      .join("");

    const body = `${filterForm}
<p class="muted">Showing ${leads.length} lead(s)${showArchived ? "" : " (hiding Won / Lost)"}. Updates sync to Google Sheet.</p>
${rows ? `<table><tr><th>Updated</th><th>Name</th><th>Bot stage</th><th>Interest</th><th>Phone</th><th>Team fields</th></tr>${rows}</table>` : "<p>No leads match this filter.</p>"}`;

    res.type("html").send(
      renderPage({ title: "Leads", active: "leads", token, body, flash: adminFlash(req) })
    );
  } catch (err) {
    res.status(500).type("html").send(
      renderPage({
        title: "Leads",
        active: "leads",
        token,
        body: `<p>Could not load leads: ${escapeHtml(err.message)}</p>`,
      })
    );
  }
});

app.post("/admin/leads/:senderId/update", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const token = adminToken(req);
  try {
    const result = await updateLeadTeamFields(req.params.senderId, {
      teamStatus: req.body.teamStatus,
      assignedTo: req.body.assignedTo,
      notes: req.body.notes,
      nextAction: req.body.nextAction,
    });
    if (!result?.ok) {
      return res.redirect(
        `/admin/leads/view?token=${encodeURIComponent(token)}&error=${encodeURIComponent(result?.reason || "Update failed")}`
      );
    }
    res.redirect(`/admin/leads/view?token=${encodeURIComponent(token)}&saved=1`);
  } catch (err) {
    res.redirect(
      `/admin/leads/view?token=${encodeURIComponent(token)}&error=${encodeURIComponent(err.message)}`
    );
  }
});

app.get("/admin/orders/view", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const token = adminToken(req);
  if (!isOrderCaptureConfigured()) {
    return res.status(400).type("html").send(
      renderPage({
        title: "Orders",
        active: "orders",
        token,
        body: "<p>Order capture not configured.</p>",
      })
    );
  }

  try {
    const statusFilter = (req.query.status || "").toLowerCase();
    const showArchived = req.query.archived === "1";
    const limit = Math.min(Number(req.query.limit) || 100, 200);
    const data = await listOrders(limit);
    let orders = data.orders || [];
    if (!showArchived) {
      orders = orders.filter(
        (o) => !ARCHIVED_ORDER_STATUSES.has(String(o.orderStatus || "").toLowerCase())
      );
    }
    if (statusFilter) {
      orders = orders.filter(
        (o) => String(o.orderStatus || "").toLowerCase() === statusFilter
      );
    }

    const filterForm = `<form class="filters" method="get">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<label>Order status <select name="status"><option value="">All</option>${optionTags(ADMIN_ORDER_STATUSES, statusFilter)}</select></label>
${archiveCheckbox("archived", showArchived, "Show completed / cancelled")}
<button class="btn btn-sm" type="submit">Filter</button>
<a class="muted" href="/admin/orders?token=${encodeURIComponent(token)}">JSON API</a>
</form>`;

    const rows = orders
      .map((order) => {
        const action = `/admin/orders/${encodeURIComponent(order.orderId)}/update?token=${encodeURIComponent(token)}`;
        const productCell = order.lineItems
          ? `<span style="font-size:13px">${escapeHtml(order.lineItems.replace(/ · /g, " · "))}</span>${order.subtotal ? `<br><strong>${escapeHtml(formatPeso(order.subtotal))}</strong>` : ""}`
          : escapeHtml([order.bean, order.size].filter(Boolean).join(" ") || "—");
        return `<tr>
          <td><code>${escapeHtml(order.orderId)}</code></td>
          <td>${escapeHtml(order.name || "—")}</td>
          <td>${productCell}</td>
          <td>${escapeHtml(order.phone || "—")}</td>
          <td>
            <form class="inline-form" method="post" action="${action}">
              <select name="orderStatus">${optionTags(ADMIN_ORDER_STATUSES, order.orderStatus || "inquiry")}</select>
              <select name="paymentStatus"><option value="unpaid"${order.paymentStatus === "unpaid" ? " selected" : ""}>unpaid</option><option value="paid"${order.paymentStatus === "paid" ? " selected" : ""}>paid</option></select>
              <textarea name="notes" placeholder="Notes">${escapeHtml(order.notes || "")}</textarea>
              <button class="btn btn-sm" type="submit">Save</button>
            </form>
          </td>
        </tr>`;
      })
      .join("");

    const body = `${filterForm}
<p class="muted">Showing ${orders.length} order(s)${showArchived ? "" : " (hiding completed / cancelled)"}.</p>
${rows ? `<table><tr><th>Order ID</th><th>Name</th><th>Product</th><th>Phone</th><th>Status & notes</th></tr>${rows}</table>` : "<p>No orders match this filter.</p>"}`;

    res.type("html").send(
      renderPage({ title: "Orders", active: "orders", token, body, flash: adminFlash(req) })
    );
  } catch (err) {
    res.status(500).type("html").send(
      renderPage({
        title: "Orders",
        active: "orders",
        token,
        body: `<p>Could not load orders: ${escapeHtml(err.message)}</p>`,
      })
    );
  }
});

app.post("/admin/orders/:orderId/update", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const token = adminToken(req);
  try {
    const result = await updateOrderFields(req.params.orderId, {
      orderStatus: req.body.orderStatus,
      paymentStatus: req.body.paymentStatus,
      notes: req.body.notes,
    });
    if (!result?.ok) {
      return res.redirect(
        `/admin/orders/view?token=${encodeURIComponent(token)}&error=${encodeURIComponent(result?.reason || "Update failed")}`
      );
    }
    res.redirect(`/admin/orders/view?token=${encodeURIComponent(token)}&saved=1`);
  } catch (err) {
    res.redirect(
      `/admin/orders/view?token=${encodeURIComponent(token)}&error=${encodeURIComponent(err.message)}`
    );
  }
});

app.get("/admin/quotes/view", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const token = adminToken(req);
  if (!isQuoteCaptureConfigured()) {
    return res.status(400).type("html").send(
      renderPage({
        title: "Quotes",
        active: "quotes",
        token,
        body: "<p>Quote capture uses the same Google Sheet. Add a <strong>Quotes</strong> tab — it is created on first quote.</p>",
      })
    );
  }

  try {
    const data = await listQuotes(50);
    const rows = (data.quotes || [])
      .map((q) => {
        const url = buildQuoteShareUrl(q);
        return `<tr>
          <td><code>${escapeHtml(q.quoteId)}</code></td>
          <td>${escapeHtml((q.created || "").slice(0, 16))}</td>
          <td>${escapeHtml(q.name || "—")}</td>
          <td>${escapeHtml(q.lineItems || "—")}</td>
          <td>${escapeHtml(formatPeso(q.subtotal))}</td>
          <td>${escapeHtml(q.status || "—")}</td>
          <td>${url ? `<a href="${escapeHtml(url)}" target="_blank">View</a>` : "—"}</td>
        </tr>`;
      })
      .join("");

    const body = `<p class="muted">Formal quotes are auto-created when customers ask about prices. Share links open a printable page.</p>
<a class="muted" href="/admin/quotes?token=${encodeURIComponent(token)}">JSON API</a>
${rows ? `<table><tr><th>Quote ID</th><th>Created</th><th>Name</th><th>Items</th><th>Total</th><th>Status</th><th>Link</th></tr>${rows}</table>` : "<p>No quotes yet — ask the bot about a product price to generate one.</p>"}`;

    res.type("html").send(
      renderPage({ title: "Quotes", active: "quotes", token, body, flash: adminFlash(req) })
    );
  } catch (err) {
    res.status(500).type("html").send(
      renderPage({
        title: "Quotes",
        active: "quotes",
        token,
        body: `<p>Could not load quotes: ${escapeHtml(err.message)}</p>`,
      })
    );
  }
});

app.get("/admin/inventory/view", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const token = adminToken(req);
  let sheetItems = [];
  let loadError = "";
  let invMeta = {};
  let source = "env";
  let labels = [];
  let unknown = [];

  if (isInventorySheetConfigured()) {
    try {
      const inv = await runAdminWithTenant(req, () =>
        req.query.refresh === "1" ? refreshInventoryCache() : listInventory()
      );
      sheetItems = inv.items || [];
      invMeta = {
        tab: inv.tab,
        sheetId: inv.sheetId,
        tenantId: inv.tenantId,
        rawRowCount: inv.rawRowCount,
        parseError: inv.parseError,
      };
      labels = inv.unavailable || [];
      source = "sheet";
      if (inv.parseError) loadError = inv.parseError;
    } catch (err) {
      loadError = err.message;
      sheetItems = [];
    }
  } else {
    ({ labels, unknown, source } = parseUnavailableProductLabels());
  }

  let body;
  if (isInventorySheetConfigured()) {
    const tenantHint = invMeta.tenantId
      ? ` · tenant <strong>${escapeHtml(invMeta.tenantId)}</strong>`
      : "";
    if (loadError) {
      body = `<div class="alert-warn"><strong>Inventory load failed:</strong> ${escapeHtml(loadError)}</div>`;
    }
    if (sheetItems.length) {
      const rows = sheetItems
        .map((item) => {
          const rowClass =
            item.status === "out_of_stock"
              ? "status-out"
              : item.status === "low"
                ? "status-low"
                : "";
          const tenantQ = invMeta.tenantId
            ? `&tenant=${encodeURIComponent(invMeta.tenantId)}`
            : "";
          const action = `/admin/inventory/${encodeURIComponent(item.productId)}/update?token=${encodeURIComponent(token)}${tenantQ}`;
          const warn =
            item.status === "low" || (item.qty !== "" && Number(item.qty) <= getLowStockThreshold())
              ? ' <span class="muted">⚠ low</span>'
              : "";
          return `<tr class="${rowClass}">
          <td>${escapeHtml(item.name)}${warn}</td>
          <td>${escapeHtml(item.status)}</td>
          <td>
            <form class="inline-form" method="post" action="${action}">
              <input class="qty-input" name="qty" type="number" min="0" step="1" placeholder="Qty" value="${escapeHtml(item.qty === "" ? "" : String(item.qty))}">
              <select name="status">${optionTags([...VALID_STATUSES], item.status)}</select>
              <input name="notes" placeholder="Notes" value="${escapeHtml(item.notes || "")}">
              <button class="btn btn-sm" type="submit">Save</button>
            </form>
          </td>
        </tr>`;
        })
        .join("");
      body =
        (body || "") +
        `<p class="muted">Live stock from Google Sheet <strong>${escapeHtml(invMeta.tab || "Inventory")}</strong> tab${tenantHint}. <strong>Qty ≤ ${getLowStockThreshold()}</strong> auto-sets <em>low</em>; <strong>Qty 0</strong> sets <em>out_of_stock</em>. Bot warns customers on low stock.</p>
<table><tr><th>Product</th><th>Status</th><th>Qty & update</th></tr>${rows}</table>`;
    } else if (!loadError) {
      body =
        (body || "") +
        `<p class="alert-warn">Sheet is configured but no inventory rows loaded (raw rows: ${invMeta.rawRowCount ?? "?"}). Try <a href="/admin/inventory/view?token=${encodeURIComponent(token)}&refresh=1${invMeta.tenantId ? `&tenant=${encodeURIComponent(invMeta.tenantId)}` : ""}">refresh</a> or check the Inventory tab in Google Sheets.</p>`;
    }
  } else {
    body = `<p class="muted">Sheet inventory not configured. Using <code>UNAVAILABLE_PRODUCTS</code> on Render.</p>
<p><strong>Out of stock:</strong> ${labels.length ? escapeHtml(labels.join(", ")) : "(none)"}</p>
${unknown.length ? `<p><strong>Unknown tokens:</strong> ${escapeHtml(unknown.join(", "))}</p>` : ""}
<p class="muted">To enable live inventory: add an <strong>Inventory</strong> tab to your Sheet (auto-seeded on first load). Same <code>GOOGLE_LEADS_SHEET_ID</code>.</p>`;
  }

  body += `<p class="muted" style="margin-top:16px">Source: <strong>${escapeHtml(source || "env")}</strong> · <a href="/admin/inventory?token=${encodeURIComponent(token)}${invMeta.tenantId ? `&tenant=${encodeURIComponent(invMeta.tenantId)}` : ""}">JSON API</a>${isInventorySheetConfigured() ? ` · <a href="/admin/inventory/view?token=${encodeURIComponent(token)}&refresh=1${invMeta.tenantId ? `&tenant=${encodeURIComponent(invMeta.tenantId)}` : ""}">Force refresh</a>` : ""}${isInventorySheetConfigured() && invMeta.tenantId && getCatalogProducts({ id: invMeta.tenantId }).length ? ` · <a href="/admin/inventory/reseed?token=${encodeURIComponent(token)}&tenant=${encodeURIComponent(invMeta.tenantId)}" onclick="return confirm('Replace all Inventory rows with this tenant\\'s menu products?')">Reseed from catalog</a>` : ""}</p>`;

  res.type("html").send(
    renderPage({ title: "Inventory", active: "inventory", token, body, flash: adminFlash(req) })
  );
});

app.get("/admin/inventory/reseed", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const token = adminToken(req);
  const tenantQ = req.query.tenant ? `&tenant=${encodeURIComponent(req.query.tenant)}` : "";
  try {
    const result = await runAdminWithTenant(req, () => reseedInventoryFromCatalog());
    if (result?.skipped) {
      return res.redirect(
        `/admin/inventory/view?token=${encodeURIComponent(token)}${tenantQ}&error=${encodeURIComponent(result.reason || "Reseed skipped")}`
      );
    }
    res.redirect(`/admin/inventory/view?token=${encodeURIComponent(token)}${tenantQ}&saved=1`);
  } catch (err) {
    res.redirect(
      `/admin/inventory/view?token=${encodeURIComponent(token)}${tenantQ}&error=${encodeURIComponent(err.message)}`
    );
  }
});

app.post("/admin/inventory/:productId/update", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const token = adminToken(req);
  const tenantQ = req.query.tenant ? `&tenant=${encodeURIComponent(req.query.tenant)}` : "";
  try {
    const result = await runAdminWithTenant(req, () =>
      updateProductFields(req.params.productId, {
        status: req.body.status,
        qty: req.body.qty,
        notes: req.body.notes,
      })
    );
    if (!result?.ok) {
      return res.redirect(
        `/admin/inventory/view?token=${encodeURIComponent(token)}${tenantQ}&error=${encodeURIComponent(result?.reason || "Update failed")}`
      );
    }
    await runAdminWithTenant(req, () => refreshInventoryCache());
    res.redirect(`/admin/inventory/view?token=${encodeURIComponent(token)}${tenantQ}&saved=1`);
  } catch (err) {
    res.redirect(
      `/admin/inventory/view?token=${encodeURIComponent(token)}${tenantQ}&error=${encodeURIComponent(err.message)}`
    );
  }
});

// --- Admin: shop closures ---
app.get("/admin/closures/view", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const token = req.query.token || "";
  const { loadClosures, formatClosureDate } = require("./lib/shop-closures");
  try {
    const closures = await loadClosures(true);
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: process.env.SUPPORT_TIMEZONE || "Asia/Manila",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());

    const rows = closures
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((c) => {
        const past = c.date < today;
        return `<tr class="${past ? "muted" : ""}">
          <td>${escapeHtml(c.date)}</td>
          <td>${escapeHtml(formatClosureDate(c.date))}</td>
          <td>${escapeHtml(c.reason || "—")}</td>
          <td>${escapeHtml(c.notes || "—")}</td>
        </tr>`;
      })
      .join("");

    const { getLeadsSheetId, getClosuresSheetTab } = require("./lib/tenant-google");
    const sheetId = getLeadsSheetId();
    const tab = getClosuresSheetTab();
    const sheetUrl = sheetId
      ? `https://docs.google.com/spreadsheets/d/${sheetId}/edit#gid=0`
      : null;

    const body = `
<p class="muted">Special shop closures (holidays, events, etc.). The bot reads this sheet every 30 minutes and blocks appointment bookings on these dates. Past dates shown greyed out.</p>
<p>
  ${sheetUrl ? `<a class="btn" href="${escapeHtml(sheetUrl)}" target="_blank" rel="noopener">Open Google Sheet (${escapeHtml(tab)} tab)</a>` : ""}
  <a class="btn btn-sm" href="/admin/closures/view?token=${encodeURIComponent(token)}">Refresh</a>
</p>
<h3>How to add a closure</h3>
<ol>
  <li>Open the Google Sheet → <strong>${escapeHtml(tab)}</strong> tab (created automatically on first bot startup).</li>
  <li>Add a row: <code>Date</code> (YYYY-MM-DD) | <code>Reason</code> (e.g. "National Holiday — Eid al-Adha") | <code>Notes</code> (optional extra detail).</li>
  <li>The bot picks it up within 30 minutes — no redeploy needed.</li>
</ol>
${rows
  ? `<table><tr><th>Date (ISO)</th><th>Friendly date</th><th>Reason</th><th>Notes</th></tr>${rows}</table>`
  : "<p class='muted'>No closures found in the sheet. Add rows to the Closures tab to block specific dates.</p>"
}`;

    res.type("html").send(renderPage({ title: "Shop Closures", active: "closures", token, body, flash: adminFlash(req) }));
  } catch (err) {
    res.type("html").send(
      renderPage({ title: "Shop Closures", active: "closures", token, body: `<p>Could not load closures: ${escapeHtml(err.message)}</p>` })
    );
  }
});

// --- Public formal quote page (share link from bot) ---
app.get("/quote/:quoteId", async (req, res) => {
  const shareToken = req.query.t || "";
  if (!shareToken) {
    return res.status(404).type("html").send("<p>Quote not found.</p>");
  }
  try {
    const quote = await getQuoteById(req.params.quoteId, shareToken);
    if (!quote) return res.status(404).type("html").send("<p>Quote not found or link expired.</p>");
    const baseUrl = `${getPublicBaseUrl(req)}/quote/${encodeURIComponent(quote.quoteId)}?t=${encodeURIComponent(quote.shareToken)}`;
    res.type("html").send(renderQuoteHtml(quote, baseUrl));
  } catch (err) {
    res.status(500).type("html").send(`<p>Error loading quote: ${escapeHtml(err.message)}</p>`);
  }
});

// --- Admin: list conversations waiting for a human ---
app.get("/admin/handoffs", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const handoffs = listActiveHandoffs();
  res.json({ count: handoffs.length, handoffs });
});

app.get("/admin/inventory", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  let sheetItems = [];
  let loadError = null;
  let inv = null;

  try {
    inv = await runAdminWithTenant(req, () =>
      req.query.refresh === "1" ? refreshInventoryCache() : listInventory()
    );
    sheetItems = inv.items || [];
    if (inv.parseError) loadError = inv.parseError;
  } catch (err) {
    loadError = err.message;
  }

  const labels = inv?.unavailable?.length
    ? inv.unavailable
    : isInventorySheetConfigured() && !sheetItems.length
      ? parseEnvUnavailableProductLabels().labels
      : parseUnavailableProductLabels().labels;
  const unknown = parseEnvUnavailableProductLabels().unknown;
  const source =
    isInventorySheetConfigured() && (sheetItems.length || inv?.unavailable?.length)
      ? "sheet"
      : isInventorySheetConfigured() && sheetItems.length === 0 && labels.length
        ? "env_fallback"
        : isInventorySheetConfigured()
          ? "sheet"
          : "env";

  const tenant = resolveAdminTenant(req).tenant;
  const catalogProducts = getCatalogProducts(tenant);

  res.json({
    source,
    unavailable: labels,
    unknownTokens: unknown,
    sheetConfigured: isInventorySheetConfigured(),
    items: sheetItems,
    tenantId: inv?.tenantId || tenant?.id || null,
    spreadsheetId: inv?.sheetId || null,
    tab: inv?.tab || null,
    rawRowCount: inv?.rawRowCount ?? null,
    dataRowCount: inv?.dataRowCount ?? null,
    loadError,
    catalog: catalogProducts.map((p) => ({
      id: p.id,
      label: p.label,
      keys: p.keys,
      alternative: p.alternative,
    })),
    hint: isInventorySheetConfigured()
      ? "Live inventory from Google Sheet Inventory tab. Use /admin/inventory/view to update. Add ?refresh=1 to bypass cache. Wrong products? Use /admin/inventory/reseed?tenant=… to replace rows from tenant catalog."
      : "Set UNAVAILABLE_PRODUCTS on Render, or add Inventory tab to Sheet for live updates.",
  });
});

app.get("/admin/quotes", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!isQuoteCaptureConfigured()) {
    return res.status(400).json({ error: "Quote capture not configured." });
  }
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const data = await listQuotes(limit);
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/knowledge-status", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const tenantId = req.query.tenant;
  const tenant = tenantId ? getTenantById(tenantId) : null;
  res.json({
    ...(tenant ? rag.getIndexStatus(tenant) : rag.getIndexStatus()),
    multiTenant: listTenants().map((t) => ({
      id: t.id,
      name: t.name,
      pageId: t.meta.pageId || null,
      googleSyncConfigured: isGoogleSyncConfigured(t),
    })),
    googleSyncConfigured: isAnyGoogleSyncConfigured(),
    syncOnStartup: shouldSyncGoogleDocsOnStartup(),
    leadCaptureConfigured: isLeadCaptureConfigured(),
    orderCaptureConfigured: isOrderCaptureConfigured(),
    quoteCaptureConfigured: isQuoteCaptureConfigured(),
    inventorySheetConfigured: isInventorySheetConfigured(),
    eventsLogConfigured: isEventsLogConfigured(),
    appointmentCaptureConfigured: isAppointmentCaptureConfigured(),
    hint: "Edit Google Docs per tenant. Sync: /admin/sync-knowledge (all) or ?tenant=ID. Legacy env mode uses one implicit tenant.",
  });
});

app.get("/admin/tenants", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const reg = getTenantRegistry();
  res.json({
    ok: true,
    legacyMode: reg.legacyMode,
    count: reg.tenants.length,
    tenants: reg.tenants.map((t) => ({
      id: t.id,
      name: t.name,
      pageId: t.meta.pageId || null,
      hasPageToken: tenantHasPageToken(t),
      instagramAccountId: t.meta.instagramAccountId || null,
      knowledgeDocIds: Boolean(t.google.knowledgeDocIds),
      leadsSheetId: Boolean(t.google.leadsSheetId),
      features: t.features,
      rulesProfile: t.rules?.profile || null,
    })),
    availableRulesProfiles: require("./lib/tenant-system-rules").listAvailableProfiles(),
    hint: "Add tenants via config/tenants.json or TENANTS_JSON on Render. Per-tenant AI rules: rules.profile (beantol|cafe|custom) + knowledge/tenant-rules/. See knowledge/tenant-rules/README.md",
  });
});

app.get("/admin/leads", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!isLeadCaptureConfigured()) {
    return res.status(400).json({
      error: "Lead capture not configured.",
      hint: "Set GOOGLE_LEADS_SHEET_ID on Render and share the Sheet with your service account (Editor). Enable Google Sheets API in Cloud Console.",
    });
  }
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const data = await listLeads(limit);
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/orders", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!isOrderCaptureConfigured()) {
    return res.status(400).json({
      error: "Order capture not configured.",
      hint: "Set GOOGLE_LEADS_SHEET_ID and add an Orders tab in the Sheet. Enable Google Sheets API.",
    });
  }
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const data = await listOrders(limit);
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/reindex-knowledge", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!openai) {
    return res.status(503).json({ error: "OPENAI_API_KEY required to build embeddings index." });
  }
  try {
    const tenantId = req.query.tenant;
    const tenant = tenantId ? getTenantById(tenantId) : null;
    if (tenantId && !tenant) {
      return res.status(404).json({ error: `Unknown tenant: ${tenantId}` });
    }
    const result = tenant
      ? await rag.rebuildIndex(openai, tenant)
      : await rag.rebuildAllIndexes(openai);
    res.json({
      ok: true,
      tenantId: tenant?.id || "all",
      chunkCount: result.chunkCount,
      builtAt: result.builtAt,
      model: result.model,
      results: Array.isArray(result) ? result : undefined,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/sync-knowledge", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!isAnyGoogleSyncConfigured()) {
    return res.status(400).json({
      error: "Google sync not configured.",
      hint: "Set GOOGLE_SERVICE_ACCOUNT_JSON and knowledgeDocIds per tenant. See docs/MULTI-TENANT.md",
    });
  }
  if (!openai) {
    return res.status(503).json({ error: "OPENAI_API_KEY required to re-index after sync." });
  }
  try {
    const tenantId = req.query.tenant;
    const tenant = tenantId ? getTenantById(tenantId) : null;
    if (tenantId && !tenant) {
      return res.status(404).json({ error: `Unknown tenant: ${tenantId}` });
    }
    const sync = tenant ? await syncGoogleDocs(tenant) : await syncAllGoogleDocs();
    const index = tenant
      ? await rag.rebuildIndex(openai, tenant)
      : await rag.rebuildAllIndexes(openai);
    res.json({
      ok: true,
      tenantId: tenant?.id || "all",
      synced: sync.synced || sync,
      chunkCount: index.chunkCount,
      builtAt: index.builtAt,
      results: Array.isArray(index) ? index : undefined,
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
      googleError: err.googleError || err.response?.data?.error || null,
      status: err.status || err.response?.status || null,
      tenantId: req.query.tenant || "all",
    });
  }
});

app.get("/admin/meta-status", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const meta = await fetchPageInstagramStatus();
  if (meta.error) {
    return res.status(meta.error.includes("not set") ? 503 : 500).json({ error: meta.error });
  }
  res.json({
    ...meta,
    hint:
      meta.hint ||
      (meta.instagramLinked
        ? "Instagram is linked to this Page token. Webhook must subscribe to this Instagram account for DMs."
        : meta.instagramLinked === false
          ? "No Instagram linked to this Page — link IG in Business Suite, then regenerate PAGE_ACCESS_TOKEN if needed."
          : "API check inconclusive — verify in Business Suite."),
  });
});

app.get("/admin/webhook-log", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const token = adminToken(req);
  const accept = req.headers.accept || "";
  const payload = {
    count: webhookDebugLog.length,
    metaAppId: metaAppId || null,
    pageInboxAppId: META_PAGE_INBOX_APP_ID,
    pageId: pageId || PAGE_ID_ENV || null,
    webhookStats: { ...webhookStats },
    events: [...webhookDebugLog].reverse(),
    hint:
      "Every Meta POST should show webhook_post. If empty after an IG DM, Meta is not reaching your server — see Instagram setup tab.",
  };
  if (req.query.format !== "json" && accept.includes("text/html") && !accept.includes("application/json")) {
    const rows = payload.events
      .map((e) => {
        return `<tr><td>${escapeHtml(e.at)}</td><td>${escapeHtml(formatWebhookDebugDetail(e))}</td></tr>`;
      })
      .join("");
    const statsLine = webhookStats.lastPostAt
      ? `<p class="muted"><strong>Last webhook POST:</strong> ${escapeHtml(webhookStats.lastPostAt)} · object=<code>${escapeHtml(String(webhookStats.lastObject || "—"))}</code> · parsed events=${webhookStats.lastEventCount} · total POSTs=${webhookStats.totalPosts}</p>`
      : `<div class="alert-warn"><strong>No webhook POSTs received</strong> since this server started. Meta is not hitting <code>/webhook</code> — check callback URL and Instagram subscription (<a href="${adminUrl("/admin/instagram-setup/view", token)}">Instagram setup</a>).</div>`;
    return res.type("html").send(
      renderPage({
        title: "Webhook debug log",
        active: "webhooks",
        token,
        body: `${statsLine}
<p class="muted">Newest first. <a href="${adminUrl("/admin/webhook-log", token)}&format=json">JSON</a></p>
<p class="muted">Bot app id: <code>${escapeHtml(String(payload.metaAppId || "unknown"))}</code> · Page Inbox: <code>${escapeHtml(payload.pageInboxAppId)}</code></p>
${rows ? `<table><tr><th>Time (UTC)</th><th>Event</th></tr>${rows}</table>` : "<p>No events in buffer yet.</p>"}
<p class="muted">Expected for Instagram DM: <code>webhook_post object=instagram</code> then <code>inbound_message platform=instagram</code>. If you only see Messenger posts, IG webhook is not subscribed.</p>`,
      })
    );
  }
  res.json(payload);
});

app.get("/admin/subscribe-webhooks", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const result = await ensureMessagingSubscriptions();
  const status = await getMessagingSubscriptionStatus().catch((e) => ({
    error: e.message,
  }));
  const fields = [...extractSubscribedFieldsFromStatus(status)].sort();
  res.json({
    subscribeResult: result,
    currentSubscriptions: status,
    subscribedFields: fields,
    messageEchoesEnabled: fields.includes("message_echoes"),
    hint:
      result.hint ||
      (fields.includes("message_echoes")
        ? "message_echoes is on — admin replies from Business Suite should pause the bot."
        : "Enable message_echoes in Meta Developer → Webhooks (Page + Instagram), then call this endpoint again."),
  });
});

// --- Admin: send a test email (Resend or SMTP) ---
app.get("/admin/openai-test", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  if (!openai) {
    return res.status(503).json({
      ok: false,
      error: "OPENAI_API_KEY is missing or empty on this server.",
    });
  }

  try {
    const { completion, transport } = await requestChatCompletion(OPENAI_API_KEY, {
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: "Reply with exactly: OpenAI OK" },
        { role: "user", content: "ping" },
      ],
      maxTokens: 50,
    });
    res.json({
      ok: true,
      model: OPENAI_MODEL,
      transport,
      reply: completion.choices[0]?.message?.content?.trim() || "",
    });
  } catch (err) {
    res.status(502).json({
      ok: false,
      model: OPENAI_MODEL,
      error: err.message,
      status: err.status || err.code || null,
    });
  }
});

app.get("/admin/google-sheets-test", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!isInventorySheetConfigured()) {
    return res.status(503).json({
      ok: false,
      error: "Google Sheets not configured (GOOGLE_SERVICE_ACCOUNT_JSON + leads sheet id).",
    });
  }
  try {
    const inv = await runAdminWithTenant(req, () => refreshInventoryCache());
    res.json({
      ok: true,
      transport: "https",
      tenantId: inv.tenantId || null,
      spreadsheetId: inv.sheetId || null,
      tab: inv.tab || null,
      itemCount: inv.items?.length || 0,
      unavailable: inv.unavailable || [],
      rawRowCount: inv.rawRowCount ?? null,
      parseError: inv.parseError || null,
    });
  } catch (err) {
    res.status(502).json({
      ok: false,
      transport: "https",
      error: err.message,
    });
  }
});

app.get("/admin/test-email", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  if (!isEmailConfigured()) {
    return res.status(503).json({
      error:
        "Email not configured. On Render, set RESEND_API_KEY (recommended). For local dev, SMTP_* also works.",
    });
  }

  try {
    const result = await sendAlertEmail({
      subject: "Beantol Messenger — test email",
      text: `If you received this, email is working via ${getEmailProvider()}.`,
    });
    res.json({
      ok: true,
      sentTo: HANDOFF_NOTIFY_EMAIL,
      provider: result.provider,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, provider: getEmailProvider() });
  }
});

async function resolveHandoffHandler(req, res) {
  if (!requireAdmin(req, res)) return;

  const { senderId } = req.params;
  const tenantId = req.query.tenant ? String(req.query.tenant) : undefined;
  const tenant = tenantId ? getTenantById(tenantId) : null;

  const doResolve = async () => {
    const session = getHandoffSession(senderId);
    if (!session) return false;
    if (req.query.sendResume === "1") {
      await resumeBotForCustomer(senderId, "(admin dashboard resume)");
      return true;
    }
    resolveHandoff(senderId, tenantId);
    console.log(`Handoff resolved for ${senderId}${tenantId ? ` [${tenantId}]` : ""} by admin API.`);
    return true;
  };

  let removed;
  if (tenant) {
    removed = await runWithTenant(tenant, doResolve);
  } else {
    removed = await doResolve();
  }

  if (!removed) {
    return res.status(404).json({ error: "No active handoff for this sender." });
  }

  const payload = {
    ok: true,
    senderId,
    tenantId: tenantId || null,
    message: "Handoff cleared. Bot will auto-reply again.",
    resumeMessageSent: req.query.sendResume === "1",
  };

  if (req.method === "GET" && !req.headers.accept?.includes("application/json")) {
    const backUrl = `/admin?token=${encodeURIComponent(req.query.token || "")}`;
    return res.type("html").send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Handoff cleared</title></head><body style="font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 16px">
<h1>Handoff cleared</h1>
<p>The AI assistant is active again for customer <code>${senderId}</code>.</p>
<p>${req.query.sendResume === "1" ? "The customer should receive the “assistant is back” message shortly." : "Add <code>&sendResume=1</code> to the URL to send the assistant message."}</p>
<p><a href="${backUrl}">Back to admin dashboard</a></p>
</body></html>`);
  }

  res.json(payload);
}

// --- Admin: clear handoff (POST or GET — open GET link in browser) ---
app.post("/admin/handoffs/:senderId/resolve", resolveHandoffHandler);
app.get("/admin/handoffs/:senderId/resolve", resolveHandoffHandler);

// --- Step 5: Facebook verifies your webhook with a GET request ---
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified successfully.");
    return res.status(200).send(challenge);
  }

  console.log("Webhook verification failed.");
  return res.sendStatus(403);
});

// --- Meta webhook: Facebook Page + Instagram DMs ---
app.post("/webhook", (req, res) => {
  const body = req.body || {};
  const parsedEvents = collectMessagingEvents(body);
  webhookStats.totalPosts += 1;
  webhookStats.lastPostAt = new Date().toISOString();
  webhookStats.lastObject = body.object || null;
  webhookStats.lastEventCount = parsedEvents.length;

  recordWebhookDebug({
    kind: "webhook_post",
    object: body.object || "(missing)",
    entryCount: body.entry?.length ?? 0,
    eventCount: parsedEvents.length,
    supported: isSupportedWebhookObject(body.object),
  });

  console.log(
    `Webhook POST received object="${body.object || "missing"}" entries=${body.entry?.length ?? 0} parsed=${parsedEvents.length}`
  );

  if (!isSupportedWebhookObject(body.object)) {
    console.log(
      `Webhook ignored — unsupported object="${body?.object || "missing"}" (expected page or instagram). Full keys: ${Object.keys(body).join(", ")}`
    );
    if (body.entry?.length) {
      console.log("Webhook raw (truncated):", JSON.stringify(body).slice(0, 800));
    }
    return res.sendStatus(404);
  }

  // Respond immediately so Meta does not timeout
  res.sendStatus(200);

  logWebhookReceipt(body);

  processWebhookEvents(body).catch((err) => {
    console.error("Webhook processing error:", err.message);
  });
});

function logWebhookReceipt(body) {
  const events = collectMessagingEvents(body);
  console.log(
    `Webhook received object=${body.object} entries=${body.entry?.length || 0} events=${events.length}`
  );
  if (events.length === 0 && (body.entry?.length || 0) > 0) {
    console.log(
      "Webhook had entries but no messaging events — raw payload:",
      JSON.stringify(body).slice(0, 1200)
    );
    recordWebhookDebug({
      kind: "no_messaging_events",
      object: body.object,
      entryCount: body.entry?.length || 0,
      raw: JSON.stringify(body).slice(0, 400),
    });
  }
}

function getInboundMessageText(event) {
  if (event.postback?.payload) return String(event.postback.payload).trim();
  if (event.postback?.title) return String(event.postback.title).trim();
  const msg = event.message;
  if (!msg) return "";
  if (msg.is_deleted) return "";
  if (msg.text) return String(msg.text).trim();
  if (msg.quick_reply?.payload) return String(msg.quick_reply.payload).trim();

  if (Array.isArray(msg.attachments) && msg.attachments.length) {
    const types = msg.attachments.map((a) => a.type).filter(Boolean);
    if (types.includes("image")) return "[Customer sent an image]";
    if (types.includes("video")) return "[Customer sent a video]";
    if (types.includes("audio")) return "[Customer sent audio]";
    if (types.includes("file")) return "[Customer sent a file]";
    if (types.includes("share")) return "[Customer shared a post]";
    if (types.includes("story_mention")) return "[Customer mentioned you in their story]";
    if (types.includes("ig_reel")) return "[Customer shared a reel]";
    return `[Customer sent ${types[0] || "an attachment"}]`;
  }

  if (msg.reply_to?.story) return "[Customer replied to your story]";

  if (msg.is_unsupported) {
    return "[Customer sent unsupported media — please type your question in text]";
  }

  return "";
}

function describeSkippedWebhook(event, platform, channel, reason) {
  const msg = event.message || {};
  recordWebhookDebug({
    kind: "skipped",
    platform,
    channel,
    reason,
    sender: event.sender?.id,
    recipient: event.recipient?.id,
    echo: isMessageEchoEvent(event),
    isSelf: Boolean(msg.is_self),
    isUnsupported: Boolean(msg.is_unsupported),
    attachmentTypes: Array.isArray(msg.attachments)
      ? msg.attachments.map((a) => a.type).join(",")
      : "",
  });
}

function collectMessagingEvents(body) {
  const platform = webhookPlatform(body);
  const items = [];
  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      items.push({ event, channel: "messaging", platform, entryId: entry.id });
    }
    for (const event of entry.standby || []) {
      items.push({ event, channel: "standby", platform, entryId: entry.id });
    }
    for (const event of entry.messaging_handovers || []) {
      items.push({
        event,
        channel: "messaging_handovers",
        platform,
        entryId: entry.id,
      });
    }
    for (const change of entry.changes || []) {
      const value = change.value;
      if (!value) continue;
      if (change.field !== "messages" && change.field !== "messaging") {
        recordWebhookDebug({
          kind: "unhandled_change",
          object: body.object,
          field: change.field,
          entryId: entry.id,
        });
        continue;
      }
      if (Array.isArray(value.messaging)) {
        for (const event of value.messaging) {
          items.push({
            event,
            channel: "changes.messaging",
            platform,
            entryId: entry.id,
          });
        }
      } else if (Array.isArray(value.messages)) {
        for (const msg of value.messages) {
          const from = msg.from || value.sender?.id;
          if (!from) continue;
          items.push({
            event: {
              sender: { id: String(from) },
              recipient: { id: String(entry.id) },
              timestamp: msg.timestamp,
              message: {
                mid: msg.id || msg.mid,
                text:
                  typeof msg.text === "object" && msg.text?.body
                    ? msg.text.body
                    : typeof msg.text === "string"
                      ? msg.text
                      : undefined,
                attachments: msg.attachments,
              },
            },
            channel: "changes.messages_array",
            platform,
            entryId: entry.id,
          });
        }
      } else if (value.sender?.id && (value.message || value.postback)) {
        items.push({
          event: value,
          channel: "changes.messages",
          platform,
          entryId: entry.id,
        });
      }
    }
  }
  return items;
}

async function ensurePageIdLoaded() {
  if (pageId) return;
  await loadPageId();
}

async function processWebhookEvents(body) {
  await ensurePageIdLoaded();
  await expireStaleAdminTakeovers();

  for (const { event, channel, platform, entryId } of collectMessagingEvents(body)) {
    const tenant = resolveTenantForWebhook({ entryId, platform, event });
    if (!tenant) {
      console.warn(`Webhook ${platform}/${channel}: no tenant matched entry=${entryId}`);
      continue;
    }

    if (channel === "messaging_handovers") {
      try {
        await runWithTenant(tenant, () => handleHandoverEvent(event, platform));
      } catch (err) {
        console.error(`Handover event error (${platform}):`, err.message);
      }
      continue;
    }

    const text = messageHasImageAttachment(event)
      ? inboundTextForImageMessage(event)
      : getInboundMessageText(event);
    const hasMessage = Boolean(event.message || event.postback);

    if (!hasMessage) {
      console.log(
        `Webhook ${platform}/${channel}: skipped — no message/postback (entry=${entryId})`
      );
      continue;
    }

    rememberOutboundSenderFromEvent(event);

    if (isMessageEchoEvent(event)) {
      console.log(
        `Webhook ECHO ${platform}/${channel}: app_id=${getMessageAppId(event) || "none"} botApp=${metaAppId || "?"} inboxApp=${META_PAGE_INBOX_APP_ID} sender=${event.sender?.id} recipient=${event.recipient?.id} human=${isHumanAdminEcho(event, text)} text=${JSON.stringify(text).slice(0, 80)}`
      );
    } else if (
      DEBUG_WEBHOOK ||
      /#bot/i.test(text) ||
      platform === "instagram" ||
      isOutboundWebhookCandidate(event, entryId, platform)
    ) {
      console.log(
        `Webhook ${platform}/${channel}: echo=false self=${Boolean(event.message?.is_self)} sender=${event.sender?.id} recipient=${event.recipient?.id} entry=${entryId} text=${JSON.stringify(text)}`
      );
    }

    if (isOutboundFromPage(event, entryId, platform)) {
      await runWithTenant(tenant, () => handlePageOutbound(event, platform, entryId));
      continue;
    }

    if (event.message?.is_self === true) {
      describeSkippedWebhook(event, platform, channel, "is_self test ping");
      console.log(
        `Webhook ${platform}/${channel}: skipped is_self (Meta self-test ping to your IG account)`
      );
      continue;
    }

    if (!text) {
      describeSkippedWebhook(event, platform, channel, "empty text / no handler");
      console.log(
        `Webhook ${platform}/${channel}: skipped — empty text (attachment or unsupported media?)`
      );
      continue;
    }

    if (!event.sender?.id) {
      console.log(`Webhook ${platform}/${channel}: skipped — missing sender.id`);
      continue;
    }

    try {
      await runWithTenant(tenant, async () => {
        if (entryId && !tenant.meta.pageId) {
          registerTenantPageId(tenant.id, entryId);
        }
        enqueueInboundMessage(event.sender.id, text, platform, { event }, handleMessage);
      });
    } catch (err) {
      console.error(`Error handling ${platform} message [${tenant.id}]:`, err.message);
    }
  }
}

async function deliverCustomerReply(senderId, userText, platform, reply, welcomeState = null) {
  let message = String(reply || "").trim();
  if (!message) return;
  if (welcomeState && !welcomeState.done) {
    message = applyWelcomeToReply(message, senderId, welcomeState);
  }
  message = sanitizeBotReply(message);
  if (!message) return;
  await sendMessageWithFallback(senderId, message);
  if (openai) appendChatHistory(senderId, userText, message);
}

function applyInboundReplyToContext(senderId, userText, platform, messageContext = {}) {
  const replyToContext = resolveInboundReplyTo(senderId, messageContext.event);
  if (!replyToContext) {
    return {
      replyToContext: null,
      lastAssistantReply: lastAssistantMessage(senderId),
    };
  }

  console.log(
    `Reply-to-bot for ${senderId}: mid=${replyToContext.mid} tags=${replyToContext.tags.join(",") || "none"}`
  );

  if (!isPostQuoteFlowActive(senderId)) {
    const resumed = resumePostQuoteFromRepliedMessage(
      senderId,
      replyToContext.content,
      platform
    );
    if (resumed.resumed) {
      console.log(`Post-quote session resumed from reply-to (${resumed.step}).`);
    }
  }

  if (hasReplyTag(replyToContext, "delivery_details_confirm")) {
    markDeliveryAgentOfferPending(senderId);
  }

  return {
    replyToContext,
    lastAssistantReply: replyToContext.content,
  };
}

async function handleStructuredFlows(senderId, userText, platform, welcomeState = null) {
  const profileName = await resolveCustomerDisplayName(senderId, platform);
  const phone = extractPhone(userText);
  const name = extractName(userText) || profileName || "";

  if (isAppointmentCaptureEnabledForTenant()) {
    const appt = await processAppointmentFlow(senderId, userText, {
      platform,
      name,
      phone,
    });
    if (appt.handled) {
      captureLeadFromMessage(senderId, userText, platform);
      if (appt.appointment) {
        await notifyAppointmentByEmail(appt.appointment);
      }
      await deliverCustomerReply(senderId, userText, platform, appt.reply, welcomeState);
      return true;
    }
  }

  if (isRecommendationsEnabled()) {
    const rec = processRecommendationFlow(senderId, userText);
    if (rec.handled) {
      queueLeadCapture({
        senderId,
        platform,
        name,
        phone,
        interest: rec.interest || "bean recommendation",
        stage: "browsing",
        lastMessage: userText,
        trigger: "product recommender",
      });
      await deliverCustomerReply(senderId, userText, platform, rec.reply, welcomeState);
      return true;
    }
  }

  return false;
}

function filterSystemMessagesForOpenAi(systemMessages) {
  return (systemMessages || []).filter(
    (m) => m?.role === "system" && typeof m.content === "string" && m.content.trim()
  );
}

function buildOpenAiChatMessages(systemMessages, history, userText) {
  const safeHistory = sanitizeMessagesForOpenAi(history).slice(-16);
  const userContent = String(userText || "").trim() || "(empty message)";
  return [
    ...filterSystemMessagesForOpenAi(systemMessages),
    ...safeHistory,
    { role: "user", content: userContent },
  ];
}

function buildMinimalFallbackChatMessages(tenant, userText) {
  const parts = [getSystemRulesForTenant(tenant)];
  if (isRecommendationsEnabled(tenant) || isTenantFeatureEnabled("quotes", tenant)) {
    try {
      parts.push(getInventorySystemNote());
    } catch (err) {
      console.warn("Inventory note skipped on fallback:", err.message);
    }
  }
  return [
    { role: "system", content: parts.filter(Boolean).join("\n\n").slice(0, 24000) },
    { role: "user", content: String(userText || "").trim() || "hello" },
  ];
}

function isTransientOpenAiError(err) {
  return isTransientError(err);
}

async function requestOpenAiChatCompletion(messages) {
  const { completion } = await requestChatCompletion(OPENAI_API_KEY, {
    model: OPENAI_MODEL,
    messages,
    maxTokens: 500,
    timeoutMs: OPENAI_TIMEOUT_MS,
  });
  return completion;
}

async function handleMessage(senderId, userText, platform = "messenger", messageContext = {}) {
  console.log(`Message from ${senderId} (${platformLabel(platform)}): ${userText}`);

  recordWebhookDebug({
    kind: "inbound_message",
    platform,
    sender: senderId,
    text: String(userText).slice(0, 160),
  });

  queueLogEvent({
    platform,
    senderId,
    event: "message",
    detail: userText,
  });

  const adminTakeover = getAdminTakeover(senderId);
  if (adminTakeover) {
    console.log(
      `Skipping auto-reply for ${senderId} — admin takeover active (idle resume ${new Date(adminTakeover.expiresAt).toISOString()}).`
    );
    return;
  }

  // Warm chat history from Google Sheet on first message from this sender this server lifetime.
  await prewarmHistory(senderId).catch(() => {});

  const profileName = await resolveCustomerDisplayName(senderId, platform);
  const tenant = getActiveTenant();
  const welcomeState = createWelcomeState(senderId, userText, messageContext.event, {
    name: profileName,
    businessName: businessName(tenant),
    recommendations: tenant?.features?.recommendations,
    quotes: tenant?.features?.quotes,
    cebuDeliveryZones: tenant?.features?.cebuDeliveryZones,
    appointments: tenant?.features?.appointments,
    isWeekend: isShopClosedToday(tenant),
    shopOpenNow: isShopOpenNow(tenant),
    shopHours: getShopHours(tenant),
    agentAvailable: isWithinLiveSupportHours(),
    platform,
  });

  if (welcomeState.isGetStarted) {
    queueLeadCapture({
      senderId,
      platform,
      name: profileName || "",
      interest: "new chat",
      stage: "browsing",
      lastMessage: userText,
      trigger: "get started",
    });
    await deliverCustomerReply(
      senderId,
      userText,
      platform,
      welcomeOnlyReply(senderId, welcomeState),
      welcomeState
    );
    return;
  }

  const { replyToContext, lastAssistantReply } = applyInboundReplyToContext(
    senderId,
    userText,
    platform,
    messageContext
  );

  if (isInventorySheetConfigured()) {
    await ensureInventoryLoaded().catch((err) => {
      console.warn("Inventory preload:", err.message);
    });
    const { getCachedInventoryItems, getCachedUnavailableProductIds } = require("./lib/inventory-sheet");
    if (!getCachedInventoryItems().length) {
      await refreshInventoryCache().catch((err) => {
        console.warn("Inventory force refresh:", err.message);
      });
    }
  }

  const outOfStockProductReply = buildOutOfStockProductReply(userText);
  if (outOfStockProductReply) {
    captureLeadFromMessage(senderId, userText, platform, {
      interest: matchCatalogFromText(userText)?.label || "out of stock inquiry",
      stage: "browsing",
    });
    await deliverCustomerReply(senderId, userText, platform, outOfStockProductReply, welcomeState);
    return;
  }

  const inStockTasteReply = buildInStockTasteRecommendationReply(userText);
  if (inStockTasteReply) {
    captureLeadFromMessage(senderId, userText, platform, {
      interest: "nutty chocolatey beans",
      stage: "browsing",
    });
    await deliverCustomerReply(senderId, userText, platform, inStockTasteReply, welcomeState);
    return;
  }

  if (
    isAgentOfferAcceptanceTurn(userText, lastAssistantReply, replyToContext) &&
    getHandoffSession(senderId)?.mode !== "agent_requested"
  ) {
    captureLeadFromMessage(senderId, userText, platform, { isHandoff: true });
    await attemptCustomerHandoff(
      senderId,
      userText,
      replyToContext ? "reply-to agent offer" : "YES after agent offer",
      platform,
      welcomeState
    );
    return;
  }

  if (
    replyToContext &&
    hasReplyTag(replyToContext, "delivery_details_confirm") &&
    (wantsAgentAfterDeliveryOffer(userText) ||
      (isConfirmYes(userText) && String(userText).trim().length <= 24)) &&
    !isQuoteConfirmYesTurn(userText, senderId, lastAssistantReply) &&
    !isPostQuotePickupConfirmTurn(senderId, userText)
  ) {
    clearDeliveryAgentOfferPending(senderId);
    captureLeadFromMessage(senderId, userText, platform, {
      isDeliveryInquiry: true,
      deliveryTrigger: "delivery rep requested (reply-to)",
    });
    const confirmMsg =
      "Noted — our team will follow up on your delivery. I can still help here with other questions.";
    await notifyDeliveryByEmail(senderId, userText, "delivery rep requested (reply-to)", platform);
    await deliverCustomerReply(senderId, userText, platform, confirmMsg, welcomeState);
    return;
  }

  if (isQuoteCaptureConfigured()) {
    const quotePreEarly = await processQuoteConfirmPreAi(
      senderId,
      userText,
      platform,
      PUBLIC_BASE_URL,
      recentUserMessages(senderId, 4),
      { lastAssistantReply }
    );
    if (quotePreEarly.handled) {
      clearDeliveryAgentOfferPending(senderId);
      await deliverCustomerReply(senderId, userText, platform, quotePreEarly.reply, welcomeState);
      return;
    }
  }

  if (wantsHumanHandoff(userText, senderId)) {
    const existingHandoff = getHandoffSession(senderId);
    if (existingHandoff?.mode === "agent_requested") {
      console.log(
        `Follow-up after agent request for ${senderId} — AI continues (team already notified).`
      );
    } else {
      if (isPostQuoteFlowActive(senderId)) {
        clearPostQuoteSession(senderId);
      }
      captureLeadFromMessage(senderId, userText, platform, { isHandoff: true });
      await attemptCustomerHandoff(senderId, userText, "phrase match", platform, welcomeState);
      return;
    }
  }

  const postQuoteFlow = processPostQuoteFlowPreAi(senderId, userText, {
    agentAvailable: isWithinLiveSupportHours(),
    isWeekend: isShopClosedToday(tenant),
  });
  if (postQuoteFlow.handled) {
    if (postQuoteFlow.captureOrder) {
      captureOrderFromMessage(senderId, userText, platform, {
        postQuoteCapture: true,
        isOrderIntent: true,
        ...postQuoteFlow.captureOrder,
        trigger: "post-quote fulfillment",
      });
    }
    if (postQuoteFlow.notifyDelivery) {
      await notifyDeliveryByEmail(senderId, userText, "post-quote delivery details", platform);
    }
    await deliverCustomerReply(senderId, userText, platform, postQuoteFlow.reply, welcomeState);
    return;
  }

  updateReplyLanguagePreference(senderId, userText);

  const hasImageAttachment = messageHasImageAttachment(messageContext.event);
  const chatHistory = getChatHistory(senderId);
  const recentForContext = recentUserMessages(senderId, 6);

  if (shouldSuppressAfterPaymentProof(senderId, userText) && !isPostQuoteFlowActive(senderId)) {
    return;
  }

  const paymentResolution = resolvePaymentProofSubmission(userText, {
    hasImageAttachment,
    senderId,
    recentUserTexts: recentForContext,
    chatHistory,
    paymentWaitExpired: Boolean(messageContext.paymentWaitExpired),
  });

  if (paymentResolution.action === "wait_for_image") {
    return;
  }

  if (paymentResolution.action === "ack") {
    const pendingQuote = getQuoteConfirmSession(senderId)?.quote;
    const reply = buildPaymentProofAckReply({
      agentAvailable: isWithinLiveSupportHours(),
      isWeekend: isShopClosedToday(tenant),
      quoteSummary: pendingQuote?.summary || "",
      quoteSubtotal: pendingQuote?.subtotal ?? null,
      hasImage: paymentResolution.hasImage !== false,
      formatPeso,
    });
    markPaymentProofHandled(senderId);
    captureOrderFromMessage(senderId, userText, platform, {
      isOrderIntent: true,
      isPaymentProofImage: true,
    });
    notifyPaymentProofByEmail(senderId, userText, platform).catch((err) => {
      console.warn("Payment proof email failed:", err.message);
    });
    await deliverCustomerReply(senderId, userText, platform, reply, welcomeState);
    return;
  }

  const equipmentSales = resolveEquipmentSalesTurn(userText);
  if (equipmentSales.handled) {
    await deliverCustomerReply(senderId, userText, platform, equipmentSales.reply, welcomeState);
    return;
  }

  if (isCebuDeliveryZonesEnabled()) {
    if (
      isOutsideCebuAgentOfferPending(senderId) &&
      wantsAgentAfterDeliveryOffer(userText) &&
      !isQuoteConfirmYesTurn(userText, senderId, lastAssistantReply) &&
      !isPostQuotePickupConfirmTurn(senderId, userText)
    ) {
      clearOutsideCebuAgentOfferPending(senderId);
      captureLeadFromMessage(senderId, userText, platform, {
        isDeliveryInquiry: true,
        deliveryTrigger: "outside cebu — live agent requested",
        isHandoff: true,
      });
      await attemptCustomerHandoff(
        senderId,
        userText,
        "outside cebu agent offer",
        platform,
        welcomeState
      );
      return;
    }

    const outsideCebu = resolveOutsideCebuDeliveryTurn(senderId, userText, {
      agentAvailable: isWithinLiveSupportHours(),
    });
    if (outsideCebu.handled) {
      captureLeadFromMessage(senderId, userText, platform, {
        isDeliveryInquiry: true,
        deliveryTrigger: outsideCebu.isRepeat
          ? "outside cebu delivery — follow-up"
          : "outside cebu delivery inquiry",
      });
      if (!outsideCebu.offerAgent) {
        await notifyDeliveryByEmail(
          senderId,
          userText,
          "outside cebu delivery inquiry",
          platform
        );
      }
      await deliverCustomerReply(senderId, userText, platform, outsideCebu.reply, welcomeState);
      return;
    }

    const cebuAreaDelivery = resolveCebuAreaDeliveryTurn(userText, {
      isWeekend: isShopClosedToday(tenant),
      agentAvailable: isWithinLiveSupportHours(),
    });
    if (cebuAreaDelivery.handled) {
      captureLeadFromMessage(senderId, userText, platform, {
        isDeliveryInquiry: true,
        deliveryTrigger: "cebu area delivery inquiry",
      });
      await deliverCustomerReply(senderId, userText, platform, cebuAreaDelivery.reply, welcomeState);
      return;
    }
  }

  if (
    isShopClosedToday(tenant) &&
    !isPostQuoteFlowActive(senderId) &&
    isCebuDeliveryZonesEnabled(tenant)
  ) {
    const looksLikeDeliveryDetails = looksLikeDeliveryDetailsSubmission(userText);
    const pickupIntent = isWeekendPickupContext(userText);
    const deliveryIntent = isWeekendDeliveryContext(userText, { looksLikeDeliveryDetails });
    if (pickupIntent || deliveryIntent) {
      const reply = pickupIntent
        ? buildWeekendPickupReply(isWithinLiveSupportHours(), tenant)
        : buildWeekendDeliveryReply(isWithinLiveSupportHours(), tenant);
      captureLeadFromMessage(senderId, userText, platform, {
        isDeliveryInquiry: deliveryIntent,
        deliveryTrigger: pickupIntent ? "weekend pickup inquiry" : "weekend delivery inquiry",
      });
      await deliverCustomerReply(senderId, userText, platform, reply, welcomeState);
      return;
    }
  }

  if (
    isDeliveryAgentOfferPending(senderId) &&
    wantsAgentAfterDeliveryOffer(userText) &&
    !isQuoteConfirmYesTurn(userText, senderId, lastAssistantReply) &&
    !isPostQuotePickupConfirmTurn(senderId, userText)
  ) {
    clearDeliveryAgentOfferPending(senderId);
    captureLeadFromMessage(senderId, userText, platform, {
      isDeliveryInquiry: true,
      deliveryTrigger: "delivery rep requested",
    });
    const confirmMsg =
      "Noted — our team will follow up on your delivery. I can still help here with other questions.";
    await notifyDeliveryByEmail(senderId, userText, "delivery rep requested", platform);
    await deliverCustomerReply(senderId, userText, platform, confirmMsg, welcomeState);
    return;
  }

  if (await handleStructuredFlows(senderId, userText, platform, welcomeState)) {
    return;
  }

  let reply;

  if (!openai) {
    reply =
      "Bot is running but OpenAI is not configured yet. Please add OPENAI_API_KEY.";
  } else {
    try {
      const history = sanitizeMessagesForOpenAi(getChatHistory(senderId));
      const knowledgeContext = await rag.retrieveKnowledgeContext(
        openai,
        userText,
        getActiveTenant()
      );
      const closuresNote = await buildClosuresSystemNote().catch(() => "");
      const systemMessages = [
        { role: "system", content: getSystemRulesForTenant(tenant) },
        { role: "system", content: getSupportHoursSystemNote() },
        { role: "system", content: getShopStatusSystemNote(tenant) },
        { role: "system", content: getReplyLanguageInstruction(senderId) },
      ];
      if (closuresNote) {
        systemMessages.push({ role: "system", content: closuresNote });
      }
      if (isRecommendationsEnabled(tenant) || isTenantFeatureEnabled("quotes", tenant)) {
        systemMessages.push({ role: "system", content: getInventorySystemNote() });
        const tasteHint = buildTasteRecommendationInventoryHint(userText);
        if (tasteHint) {
          systemMessages.push({ role: "system", content: tasteHint });
        }
        const oosHint = buildOutOfStockProductSystemHint(userText);
        if (oosHint) {
          systemMessages.push({ role: "system", content: oosHint });
        }
      }
      if (isRecommendationsEnabled(tenant)) {
        systemMessages.push({ role: "system", content: buildRecommendationSystemNote() });
      }
      if (isShopClosedToday(tenant) && isCebuDeliveryZonesEnabled(tenant)) {
        systemMessages.push({
          role: "system",
          content: getWeekendSystemNote(isWithinLiveSupportHours(), tenant),
        });
      }
      if (isCebuDeliveryZonesEnabled(tenant)) {
        if (
          isOutsideCebuDeliveryInquiry(userText) ||
          isOutsideCebuDeliveryInquiry(recentUserMessages(senderId, 4).join("\n"))
        ) {
          systemMessages.push({
            role: "system",
            content: getOutsideCebuSystemNote(),
          });
        }
        if (
          isCebuAreaDeliveryInquiry(userText) ||
          isCebuAreaDeliveryInquiry(recentUserMessages(senderId, 4).join("\n"))
        ) {
          systemMessages.push({
            role: "system",
            content: getCebuDeliverySystemNote(),
          });
        }
      }
      if (isEquipmentSalesInquiry(userText)) {
        systemMessages.push({
          role: "system",
          content: getEquipmentSalesSystemNote(),
        });
      }
      if (hasImageAttachment && paymentResolution.action === "none") {
        systemMessages.push({
          role: "system",
          content:
            "CUSTOMER IMAGE: Customer sent an image you cannot view. Do NOT assume it is payment proof unless they explicitly said so in the same message (e.g. 'here's my payment'). If unclear, say you cannot view images and ask what they sent — do NOT ask them to confirm payment proof in a pushy way. Do NOT re-pitch products.",
        });
      }
      if (isLeadCaptureConfigured()) {
        try {
          const found = await findLeadRow(senderId);
          const salesNote = buildSalesContextNote(found?.lead);
          if (salesNote) {
            systemMessages.push({ role: "system", content: salesNote });
          }
        } catch (_) {
          /* sales context optional */
        }
      }
      if (knowledgeContext) {
        systemMessages.push({ role: "system", content: knowledgeContext });
      }
      const sizeNote = buildPendingSizeConfirmationNote(senderId, userText);
      if (sizeNote) {
        systemMessages.push({ role: "system", content: sizeNote });
      }
      const correctionNote = buildOrderCorrectionNote(userText);
      if (correctionNote) {
        systemMessages.push({ role: "system", content: correctionNote });
      }
      const filterSizeNote = buildFilterRoastOnlySizeNote(senderId, userText);
      if (filterSizeNote) {
        systemMessages.push({ role: "system", content: filterSizeNote });
      }
      const recentForPricing = recentUserMessages(senderId, 4);
      const sessionQuote = getQuoteConfirmSession(senderId)?.quote;
      const nonWholesaleNote = buildNonWholesaleBulkSystemNote(
        userText,
        recentForPricing,
        sessionQuote
      );
      if (nonWholesaleNote) {
        systemMessages.push({ role: "system", content: nonWholesaleNote });
      }
      const wholesalePricingNote = buildWholesalePricingSystemNote(
        userText,
        recentForPricing,
        sessionQuote
      );
      if (wholesalePricingNote) {
        systemMessages.push({ role: "system", content: wholesalePricingNote });
      }
      const pendingAgent = getHandoffSession(senderId);
      if (pendingAgent?.mode === "agent_requested") {
        systemMessages.push({
          role: "system",
          content:
            "HANDOFF STATUS: This customer asked for a human agent and the team was emailed. No admin has taken over yet — keep answering their questions helpfully. Do NOT output [[HANDOFF]] again unless they explicitly say they cannot wait for a person.",
        });
      }
      const completion = await requestOpenAiChatCompletion(
        buildOpenAiChatMessages(systemMessages, history, userText)
      );
      reply =
        completion.choices[0]?.message?.content?.trim() ||
        "Sorry, I could not generate a reply. Please try again.";
      try {
        reply = enforceOutOfStockProductPolicy(userText, reply);
      } catch (policyErr) {
        console.warn("Out-of-stock policy check:", policyErr.message);
      }
    } catch (err) {
      console.error(
        "Chat completion failed:",
        err.message,
        err.status || err.code || "",
        err.stack?.split("\n")[0] || ""
      );
      recordWebhookDebug({
        kind: "chat_completion_error",
        detail: `${err.message} status=${err.status || err.code || "n/a"}`,
      });
      try {
        const completion = await requestOpenAiChatCompletion(
          buildMinimalFallbackChatMessages(tenant, userText)
        );
        const fallbackReply = completion.choices[0]?.message?.content?.trim();
        if (fallbackReply) {
          reply = fallbackReply;
          recordWebhookDebug({ kind: "chat_completion_retry_ok" });
        } else {
          reply =
            "Sorry, I am having trouble right now. Please try again in a moment.";
        }
      } catch (retryErr) {
        console.error(
          "Chat completion retry failed:",
          retryErr.message,
          retryErr.status || retryErr.code || "",
          retryErr.stack?.split("\n")[0] || ""
        );
        recordWebhookDebug({
          kind: "chat_completion_retry_error",
          detail: `${retryErr.message} status=${retryErr.status || retryErr.code || "n/a"}`,
        });
        reply =
          "Sorry, I am having trouble right now. Please try again in a moment.";
      }
    }
  }

  if (isAiHandoffReply(reply) && !isReplyLanguagePreferenceRequest(userText)) {
    const isDeliveryContext =
      isDeliveryInquiry(userText) ||
      isDeliveryAgentOfferPending(senderId) ||
      wantsAgentAfterDeliveryOffer(userText);
    if (isDeliveryContext) {
      reply = reply.replace(HANDOFF_MARKER, "").trim();
      if (!reply) {
        reply =
          "Noted — our team will follow up on your delivery. I can still help here with other questions.";
      }
    } else if (
      isConfirmYes(userText) &&
      (getQuoteConfirmSession(senderId)?.step === "confirm" ||
        assistantAlreadyAskedConfirm(lastAssistantReply)) &&
      !isAgentOfferAcceptanceTurn(userText, lastAssistantReply, replyToContext)
    ) {
      reply = reply.replace(HANDOFF_MARKER, "").trim();
      if (!reply) {
        reply =
          "Thanks for confirming — if you did not receive your formal quote link yet, please send YES again or tell me the bean and size.";
      }
    } else if (getHandoffSession(senderId)?.mode === "agent_requested") {
      reply = reply.replace(HANDOFF_MARKER, "").trim();
      if (!reply) {
        reply =
          "Our team has been notified and will reply here soon. Meanwhile, what else can I help you with?";
      }
    } else {
      clearDeliveryAgentOfferPending(senderId);
      captureLeadFromMessage(senderId, userText, platform, { isHandoff: true });
      if (
        !(await attemptCustomerHandoff(
          senderId,
          userText,
          "AI [[HANDOFF]] marker",
          platform,
          welcomeState
        ))
      ) {
        return;
      }
      return;
    }
  }

  if (aiReplyIsDeliveryDetailsConfirmation(reply)) {
    markDeliveryAgentOfferPending(senderId);
    console.log(`Delivery step-2 sent for ${senderId} — YES will email team (no handoff).`);
  }

  const deliveryTrigger = isDeliveryInquiry(userText)
    ? "customer message"
    : looksLikeDeliveryDetailsSubmission(userText)
      ? "delivery details submitted"
      : aiReplyIsDeliveryFlow(reply)
        ? "bot delivery reply"
        : aiReplyIsDeliveryDetailsConfirmation(reply)
          ? "delivery details confirmed"
          : null;

  if (deliveryTrigger) {
    console.log(`Delivery alert for ${senderId} (${deliveryTrigger}, ${platform}).`);
    await notifyDeliveryByEmail(senderId, userText, deliveryTrigger, platform);
  }

  const isDeliveryDetails = looksLikeDeliveryDetailsSubmission(userText);
  const isOrderIntent = ORDER_INTENT_PATTERN.test(userText);

  captureLeadFromMessage(senderId, userText, platform, {
    isDeliveryInquiry: isDeliveryInquiry(userText),
    isDeliveryDetails,
    deliveryTrigger,
  });

  try {
    const recentQuoteTexts = recentUserMessages(senderId, 4);
    const quoteSignal = analyzeLeadSignal(userText, {
      historyTexts: recentQuoteTexts,
    });
    if (quoteSignal && isQuoteCaptureConfigured()) {
      const { bean, size } = parseBeanAndSize(quoteSignal.interest, userText, recentQuoteTexts);
      const profileName = await resolveCustomerDisplayName(senderId, platform);
      const bulkKg = /\b(\d+(?:\.\d+)?)\s*kg\b/i.test(userText)
        ? parseFloat(userText.match(/\b(\d+(?:\.\d+)?)\s*kg\b/i)[1])
        : 0;
      const belowMoqKg = requestedBelowMoqBulkKg(
        userText,
        recentQuoteTexts,
        getQuoteConfirmSession(senderId)?.quote
      );
      const quotePost = processQuoteConfirmPostAi(senderId, userText, platform, reply, {
        signal: quoteSignal,
        name: extractName(userText) || profileName || "",
        phone: quoteSignal.phone || "",
        interest: quoteSignal.interest || "",
        bean,
        size,
        wholesale: !belowMoqKg && (quoteSignal.stage === "wholesale" || bulkKg >= 6),
        publicBaseUrl: PUBLIC_BASE_URL,
        recentTexts: recentQuoteTexts,
      });
      if (quotePost.handled && quotePost.appendConfirm) {
        clearDeliveryAgentOfferPending(senderId);
        reply = `${reply}\n\n${quotePost.reply}`;
      }
    }
  } catch (err) {
    console.warn("Quote confirm failed:", err.message);
  }

  captureOrderFromMessage(senderId, userText, platform, {
    isDeliveryDetails,
    isOrderIntent:
      ORDER_INTENT_PATTERN.test(userText) ||
      (ADD_TO_ORDER_PATTERN.test(userText) &&
        Boolean(
          analyzeLeadSignal(userText, { historyTexts: recentUserMessages(senderId, 8) })
            ?.interest
        )),
    assistantReply: reply,
  });

  try {
    await deliverCustomerReply(senderId, userText, platform, reply, welcomeState);
  } catch (err) {
    console.error(`Send failed for ${senderId} (${platformLabel(platform)}):`, err.message);
    throw err;
  }
}

async function sendMessage(recipientId, text, options = {}) {
  const token = getPageAccessToken(getActiveTenant());
  if (!token) {
    throw new Error("Page access token not configured for this tenant.");
  }
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${token}`;
  const payload = {
    recipient: { id: recipientId },
    message: { text },
  };

  if (options.tag) {
    payload.messaging_type = "MESSAGE_TAG";
    payload.tag = options.tag;
  } else {
    payload.messaging_type = options.messagingType || "RESPONSE";
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (!response.ok) {
    const errMsg = data.error?.message || "Failed to send message";
    const errCode = data.error?.code;
    console.error(
      `Meta Send API error (HTTP ${response.status}) to ${recipientId}:`,
      JSON.stringify(data)
    );
    if (errCode === 10 || /outside.*window/i.test(errMsg)) {
      console.warn(
        `Send hint: customer may be outside the 24h messaging window — they need to message again first.`
      );
    }
    if (/message request|not authorized|cannot message/i.test(errMsg)) {
      console.warn(
        `Send hint (Instagram): accept the DM in Business Suite → Instagram → Requests, then ask them to message again or reply manually once.`
      );
    }
    throw new Error(errMsg);
  }

  rememberBotMessageId(data.message_id);
  recordOutboundMessage(recipientId, data.message_id, text);
  console.log(`Reply sent to ${recipientId}`);
  return data;
}

/** After a human replied, Meta may require a message tag for the next automated send. */
async function sendMessageWithFallback(recipientId, text) {
  const attempts = [
    { label: "RESPONSE", opts: { messagingType: "RESPONSE" } },
    { label: "HUMAN_AGENT", opts: { tag: "HUMAN_AGENT" } },
    { label: "ACCOUNT_UPDATE", opts: { tag: "ACCOUNT_UPDATE" } },
  ];

  let lastError;
  for (const { label, opts } of attempts) {
    try {
      return await sendMessage(recipientId, text, opts);
    } catch (err) {
      lastError = err;
      console.warn(`Send ${label} failed for ${recipientId}:`, err.message);
    }
  }

  throw lastError || new Error("All send attempts failed");
}

// --- Startup checks ---
function checkConfig() {
  loadTenantRegistry();
  const missing = [];
  if (!VERIFY_TOKEN) missing.push("VERIFY_TOKEN");
  const tenants = listTenants();
  const anyToken = tenants.some((t) => tenantHasPageToken(t)) || PAGE_ACCESS_TOKEN;
  if (!anyToken) missing.push("PAGE_ACCESS_TOKEN (or tenant meta.pageAccessToken)");
  if (!OPENAI_API_KEY) missing.push("OPENAI_API_KEY (bot will send a placeholder reply)");
  if (!ADMIN_SECRET) missing.push("ADMIN_SECRET (admin handoff endpoints disabled)");
  if (!isEmailConfigured()) {
    missing.push(
      "RESEND_API_KEY (recommended on Render) or SMTP_HOST / SMTP_USER / SMTP_PASS"
    );
  }
  if (!PUBLIC_BASE_URL) {
    missing.push("PUBLIC_BASE_URL (one-click resume links in email/admin, e.g. https://beantol-bot.onrender.com)");
  }

  if (missing.length) {
    console.warn("Missing env vars:", missing.join(", "));
  }

  const { labels, unknown, source } = parseUnavailableProductLabels();
  if (labels.length) {
    console.log(`Out of stock (${source || "env"}): ${labels.join(", ")}`);
  } else {
    console.log(
      `Inventory: all catalog products treated as available (${source || "env"}).`
    );
  }
  if (unknown.length) {
    console.warn("Unknown UNAVAILABLE_PRODUCTS tokens:", unknown.join(", "));
  }
}

async function verifyEmailOnStartup() {
  const provider = getEmailProvider();
  if (!provider) return;

  if (provider === "resend") {
    console.log(
      `Email via Resend — alerts go to ${HANDOFF_NOTIFY_EMAIL} (from ${EMAIL_FROM})`
    );
    return;
  }

  const transporter = getMailTransporter();
  if (!transporter) return;
  try {
    await transporter.verify();
    console.log(
      `Email via SMTP — alerts go to ${HANDOFF_NOTIFY_EMAIL} (may fail on Render due to blocked ports)`
    );
  } catch (err) {
    console.error(
      `SMTP verify failed (${err.message}). Use RESEND_API_KEY on Render instead.`
    );
  }
}

async function loadMetaAppId() {
  if (metaAppId || !PAGE_ACCESS_TOKEN) return;
  try {
    const response = await fetch(
      `https://graph.facebook.com/v19.0/debug_token?input_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}&access_token=${PAGE_ACCESS_TOKEN}`
    );
    const data = await response.json();
    if (data.data?.app_id) {
      metaAppId = String(data.data.app_id);
      console.log(`Meta app ID loaded from token: ${metaAppId}`);
    }
  } catch (err) {
    console.log("Meta app ID lookup skipped:", err.message);
  }
}

async function loadPageId() {
  if (PAGE_ID_ENV) {
    pageId = String(PAGE_ID_ENV);
    if (isLikelyInstagramAccountId(pageId)) {
      console.warn(
        `PAGE_ID env looks like Instagram ID (${pageId}), not Facebook Page ID. Use Page → About → Page ID (e.g. 124972487369170).`
      );
    } else {
      console.log(`Page ID from PAGE_ID env: ${pageId}`);
    }
    return;
  }
  if (!PAGE_ACCESS_TOKEN) return;
  try {
    const response = await fetch(
      `https://graph.facebook.com/v19.0/me?fields=id&access_token=${PAGE_ACCESS_TOKEN}`
    );
    const data = await response.json();
    if (data.id) {
      pageId = String(data.id);
      console.log(`Page ID loaded from API: ${pageId}`);
      return;
    }
    console.log(
      "Page ID API lookup not available (permission not required). Set PAGE_ID on Render for IG webhook subscribe."
    );
    if (DEBUG_WEBHOOK) {
      console.log("loadPageId response:", JSON.stringify(data));
    }
  } catch (err) {
    console.log("Page ID API lookup skipped:", err.message);
  }
}

const DEFAULT_SUBSCRIBED_FIELD_SETS = [
  "messages,messaging_postbacks,message_echoes,messaging_handovers",
  "messages,messaging_postbacks,message_echoes",
  "messages,messaging_postbacks",
  "messages",
];

function getSubscribedFieldAttempts() {
  if (process.env.WEBHOOK_SUBSCRIBED_FIELDS) {
    return [process.env.WEBHOOK_SUBSCRIBED_FIELDS.trim()];
  }
  return DEFAULT_SUBSCRIBED_FIELD_SETS;
}

function isLikelyInstagramAccountId(id) {
  const s = String(id || "");
  return s.startsWith("178414") || s.startsWith("17841");
}

function validatePageIdForApi(pageIdValue) {
  if (!pageIdValue) return { valid: false, reason: "missing" };
  if (isLikelyInstagramAccountId(pageIdValue)) {
    return {
      valid: false,
      reason:
        "PAGE_ID looks like an Instagram account ID (178414...). Use your Facebook Page ID from Page → About (you previously had success with 124972487369170).",
    };
  }
  return { valid: true };
}

async function subscribePageApps(pageId, subscribedFields) {
  const response = await fetch(
    `https://graph.facebook.com/v19.0/${encodeURIComponent(pageId)}/subscribed_apps?subscribed_fields=${encodeURIComponent(subscribedFields)}&access_token=${PAGE_ACCESS_TOKEN}`,
    { method: "POST" }
  );
  const data = await response.json();
  return { ok: response.ok && data.success === true, data, subscribedFields };
}

/** Meta often requires this for Instagram DMs to hit your webhook (not only Business Suite). */
async function ensureMessagingSubscriptions() {
  const pid = PAGE_ID_ENV || pageId;
  if (!pid || !PAGE_ACCESS_TOKEN) {
    console.log(
      "Messaging subscription skipped — set PAGE_ID on Render, redeploy, then /admin/subscribe-webhooks?token=..."
    );
    return { skipped: true, reason: "PAGE_ID or PAGE_ACCESS_TOKEN missing" };
  }

  const pageCheck = validatePageIdForApi(pid);
  if (!pageCheck.valid) {
    console.warn(`PAGE_ID invalid for subscribed_apps: ${pageCheck.reason}`);
    return { ok: false, pageId: pid, skipped: true, reason: pageCheck.reason };
  }

  const attempts = [];
  for (const fields of getSubscribedFieldAttempts()) {
    if (!fields) continue;
    try {
      const result = await subscribePageApps(pid, fields);
      attempts.push(result);
      if (result.ok) {
        console.log(
          `Page ${pid} subscribed_apps OK (${fields}) — required for IG + Messenger webhooks.`
        );
        return { ok: true, pageId: pid, subscribedFields: fields, data: result.data, attempts };
      }
      const err = result.data?.error;
      console.warn(
        `Page subscribed_apps failed for fields=${fields}:`,
        JSON.stringify(result.data)
      );
      if (err?.code === 100 && String(err.message || "").includes("message_echoes")) {
        console.warn(
          "Remove message_echoes from WEBHOOK_SUBSCRIBED_FIELDS on Render — enable echoes in Meta webhook UI instead."
        );
      }
    } catch (err) {
      attempts.push({ ok: false, subscribedFields: fields, error: err.message });
      console.warn(`Page subscribed_apps error for fields=${fields}:`, err.message);
    }
  }

  const last = attempts[attempts.length - 1];
  return {
    ok: false,
    pageId: pid,
    attempts,
    data: last?.data,
    hint:
      "Meta error (#1) is often temporary — retry /admin/subscribe-webhooks in a few minutes. If you already saw success:true once, subscription may be active. Regenerate PAGE_ACCESS_TOKEN if it keeps failing. Do not set WEBHOOK_SUBSCRIBED_FIELDS=message_echoes on Render.",
  };
}

async function getMessagingSubscriptionStatus() {
  const pid = PAGE_ID_ENV || pageId;
  if (!pid || !PAGE_ACCESS_TOKEN) {
    return { error: "PAGE_ID or PAGE_ACCESS_TOKEN missing" };
  }
  const response = await fetch(
    `https://graph.facebook.com/v19.0/${encodeURIComponent(pid)}/subscribed_apps?access_token=${PAGE_ACCESS_TOKEN}`
  );
  const data = await response.json();
  return { pageId: pid, data };
}

function extractSubscribedFieldsFromStatus(status) {
  const fields = new Set();
  const apps = status?.data?.data;
  if (!Array.isArray(apps)) return fields;
  for (const app of apps) {
    const raw = app.subscribed_fields;
    const list = Array.isArray(raw)
      ? raw
      : String(raw || "")
          .split(",")
          .map((s) => s.trim());
    for (const f of list) {
      const trimmed = String(f).trim();
      if (trimmed) fields.add(trimmed);
    }
  }
  return fields;
}

function hasMessageEchoesSubscription(status) {
  return extractSubscribedFieldsFromStatus(status).has("message_echoes");
}

(async function startServer() {
  checkConfig();
  verifyEmailOnStartup().catch(() => {});
  try {
    await bootstrapKnowledge();
  } catch (err) {
    console.warn("Knowledge bootstrap:", err.message);
  }
  if (isInventorySheetConfigured()) {
    refreshInventoryCache().catch((err) => {
      console.warn("Inventory sheet load:", err.message);
    });
  }
  Promise.all([loadPageId().catch(() => {}), loadMetaAppId().catch(() => {})]).then(() =>
    ensureMessagingSubscriptions()
  );

  app.listen(PORT, () => {
    console.log(`Beantol bot listening on port ${PORT}`);
    console.log(`Webhook URL path: /webhook (Facebook Page + Instagram)`);
    console.log(
      `RAG: ${rag.isReady() ? "index loaded" : "source-file fallback until indexed"}${
        isAnyGoogleSyncConfigured()
          ? shouldSyncGoogleDocsOnStartup()
            ? " | Google Doc sync on startup: ON"
            : " | Google Doc sync on startup: OFF (RAG_SYNC_ON_STARTUP=false)"
          : ""
      } | Tenants: ${listTenants().length}`
    );
    console.log(
      `Leads: ${isLeadCaptureConfigured() ? "Google Sheet capture ON" : "not configured (set GOOGLE_LEADS_SHEET_ID)"}`
    );
    console.log(
      `Orders: ${isOrderCaptureConfigured() ? "Google Sheet Orders tab ON" : "not configured"}`
    );
    console.log(
      `Quotes: ${isQuoteCaptureConfigured() ? "Google Sheet Quotes tab ON" : "not configured"}`
    );
    console.log(
      `Inventory: ${isInventorySheetConfigured() ? "Google Sheet Inventory tab ON" : "UNAVAILABLE_PRODUCTS env fallback"}`
    );
    console.log(
      `Analytics events: ${isEventsLogConfigured() ? "Google Sheet Events tab ON" : "disabled"}`
    );
    console.log(
      `Appointments: ${isAppointmentCaptureConfigured() ? "Google Sheet Appointments tab ON" : "not configured"}`
    );
    console.log("Phase 4: product recommender, sales pipeline, appointment booking ON");
  });
})();
