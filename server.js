/**
 * Beantol Messenger AI Bot
 * Receives messages from Facebook Messenger, replies using OpenAI.
 */

require("dotenv").config();
const express = require("express");
const nodemailer = require("nodemailer");
const OpenAI = require("openai");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const HANDOFF_TIMEOUT_HOURS = Number(process.env.HANDOFF_TIMEOUT_HOURS || 24);
const HANDOFF_NOTIFY_EMAIL =
  process.env.HANDOFF_NOTIFY_EMAIL || "cgccjustin@gmail.com";
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
  "Got it — I am connecting you with our team. A Beantol team member will reply to you personally here on Messenger as soon as they can. Please stay on this chat.";

const BOT_RESUME_REPLY =
  process.env.BOT_RESUME_REPLY ||
  "Our chat assistant is back on — you can ask about coffee, prices, orders, or delivery anytime.";

const ADMIN_RESUME_COMMANDS = (process.env.ADMIN_RESUME_COMMANDS || "#bot")
  .split(",")
  .map((cmd) => cmd.trim().toLowerCase())
  .filter(Boolean);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const DEBUG_WEBHOOK = process.env.DEBUG_WEBHOOK === "true";
const PAGE_ID_ENV = process.env.PAGE_ID;

/** @type {Map<string, { handedOffAt: number, expiresAt: number, lastMessage: string }>} */
const handoffSessions = new Map();

/** @type {Map<string, 'en' | 'tl' | 'ceb'>} */
const replyLanguagePrefs = new Map();

/** @type {Map<string, number>} senderId -> alert cooldown expiresAt */
const deliveryAlertCooldowns = new Map();

/** After delivery step-2 reply, bare YES / agent phrases trigger handoff */
const deliveryAgentOfferPending = new Map();
const DELIVERY_AGENT_OFFER_TTL_MS = 48 * 60 * 60 * 1000;

const CHAT_HISTORY_MAX_MESSAGES = Number(
  process.env.CHAT_HISTORY_MAX_MESSAGES || 20
);
const CHAT_HISTORY_TTL_MS =
  Number(process.env.CHAT_HISTORY_TTL_HOURS || 24) * 60 * 60 * 1000;

/** @type {Map<string, { messages: { role: "user" | "assistant"; content: string }[]; updatedAt: number }>} */
const chatHistories = new Map();

function getChatHistory(senderId) {
  const entry = chatHistories.get(senderId);
  if (!entry) return [];
  if (Date.now() - entry.updatedAt > CHAT_HISTORY_TTL_MS) {
    chatHistories.delete(senderId);
    return [];
  }
  return entry.messages;
}

function appendChatHistory(senderId, userText, assistantReply) {
  let entry = chatHistories.get(senderId);
  if (!entry) {
    entry = { messages: [], updatedAt: Date.now() };
  }
  entry.messages.push({ role: "user", content: userText });
  entry.messages.push({ role: "assistant", content: assistantReply });
  if (entry.messages.length > CHAT_HISTORY_MAX_MESSAGES) {
    entry.messages = entry.messages.slice(-CHAT_HISTORY_MAX_MESSAGES);
  }
  entry.updatedAt = Date.now();
  chatHistories.set(senderId, entry);
}

/** Facebook Page ID — used to detect admin messages when is_echo is missing */
let pageId = null;

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
  if (pref) replyLanguagePrefs.set(senderId, pref);
}

function getReplyLanguageInstruction(senderId) {
  const pref = replyLanguagePrefs.get(senderId) || "en";
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

// Beantol Coffee Roasters — business knowledge for the AI
const SYSTEM_PROMPT = `You are the friendly customer support assistant for Beantol Coffee Roasters on Facebook Messenger.

ABOUT US:
We are a local coffee roastery in Cebu City. We serve coffee shops across Cebu with quality Arabica beans — single origin, blends, espresso-focused beans, and curated pour-over coffee beans.

LOCATION:
Holy Family Village 2, Governor Cuenco Avenue, Banilad, Cebu City (beside the guardhouse).

HOURS:
Monday to Friday, 9:00 AM to 6:00 PM. Closed Saturdays and Sundays.

HOW TO ORDER:
- Visit our shop
- Message us here on Messenger for pickup orders

DELIVERY (Maxim — two steps; do NOT use [[HANDOFF]] until step 2 agent offer is accepted):

STEP 1 — Customer asks about delivery / Maxim / wants padala:
- Briefly confirm delivery via Maxim and that the customer pays the Maxim delivery fee (separate from coffee).
- Ask for all three in one friendly message: (1) complete delivery address, (2) contact name, (3) mobile/contact number.
- Keep step 1 short (2–4 sentences). Do NOT use [[HANDOFF]] yet.

STEP 2 — Customer sends delivery details (address + name + phone, or enough to fill the three fields from context):
- Reply in this order (use their first name in the thanks line when you have it; otherwise "Thanks for the details!"):
  1) "Thanks for the details, {Name}!" (or "Thanks for the details!" if name unclear)
  2) Confirm what you captured — bullet or lines for Name, Address, Contact number (repeat exactly what they sent; if something is missing, politely note what is still needed before arranging delivery)
  3) "I'll arrange your delivery with Maxim for you once your order is confirmed. The Maxim delivery fee is paid by you through the rider (separate from your coffee order)."
  4) Politely: payment for the coffee order must be settled first before we dispatch for delivery — ask them to send proof of payment in this chat after paying (offer GCash/UnionBank from PAYMENT FAQ if they have not paid yet).
  5) Offer a human: "If you'd like to connect with our customer representative to finalize your order, reply YES — or tell me you'd like to chat with an agent, a team member, or a real live person."
- Step 2 may be longer (up to ~8 short sentences). Still plain text, no buttons.

STEP 3 — After step 2, if they reply YES (or oo / yes po), or clearly want an agent / representative / real person / live person / staff to help:
- Respond with exactly [[HANDOFF]] and nothing else (server connects them to the team).

- Do NOT use [[HANDOFF]] for step 1 or step 2 alone — only when they accept the representative offer in step 3.
- Never say "call me", "call us", "message us on Messenger", or suggest buttons/CTAs. Plain text only in this thread.
- Do not invent delivery fees, zones, or timelines.

PRICING (Philippine Pesos — do NOT dump the entire catalog unless they ask for a full menu):
- Espresso roast and filter roast are different products — same origin name can have different prices.
- Sizes: espresso has 250g, 500g, 1kg. Filter roast listed below is 250g (confirm 100g at shop if asked).
- When asked "prices" generally with NO specific bean named: ask which bean and whether espresso or filter / pour-over. Do not list every bean.
- When they name a SPECIFIC bean and ask price / how much / tagpila for that bean: reply immediately with ALL retail sizes for that bean in one message (espresso: 250g, 500g, and 1kg with ₱ amounts; filter: 250g price). Do NOT ask which size (250g/500g/1kg) first.
- WHOLESALE UPSELL: After retail prices for Beantol Prime, Brazil Santos, or Brazil Cerrado, add one short line that wholesale per-kg pricing is available for orders 6 kg and above (MOQ), with the wholesale ₱/kg from the table. Also mention wholesale when they ask about bulk, café supply, or large quantity. Do not upsell wholesale for Ethiopia Guji, Ethiopia Sidama, or filter roast (not available).

ESPRESSO ROAST (available beans only):
| Bean | 250g | 500g | 1kg | Wholesale per kg (MOQ 6kg) |
| Beantol Prime (Brazil, Ethiopia) | 420 | 780 | 1,450 | 1,350 |
| Brazil Santos | 450 | 800 | 1,500 | 1,400 |
| Brazil Cerrado | 500 | 900 | 1,550 | 1,450 |
| Ethiopia Guji | 850 | 1,350 | 1,850 | not available |
| Ethiopia Sidama | 800 | 1,300 | 1,700 | not available |

FILTER ROAST — 250g only (available beans only):
| Mt. Apo | 700 |
| Guji | 800 |
| Kenya | 900 |
| Mt. Apo (Ellaga) | 900 |

NOT AVAILABLE (do not quote or offer): Beantol Prism, Beantol Pulse, Colombia Popayan, Ethiopia Kochere, Peru Finca Los Santos.

ESPRESSO BEAN DETAILS (Single Origin Series — give details only for the bean they ask about, not every bean):
- Beantol Prime | Espresso roast | Origin: Brazil & Ethiopia blend | Flavor notes: sweet chocolate, nutty, pistachio | Tagline: best of both worlds | Arabica | Elevation: not listed on label.
- Brazil Cerrado | Espresso roast | Brazil | Arabica | Variety: Catuai | Process: natural | Producer: various cooperatives | Elevation: 1500 m | Flavor notes: sweet, chocolate, hazelnut.
- Brazil Santos | Espresso roast | Brazil | Arabica | Variety: Bourbon, Mundo Novo | Process: natural | Producer: various cooperatives | Elevation: 800–1200 m | Flavor notes: sweet, chocolate, nutty, creamy body.
- Ethiopia Guji | Espresso roast | Ethiopia | Arabica | Variety: heirloom | Process: washed | Producer: various cooperatives | Elevation: 1800–2000 m | Flavor notes: floral, citrus, tea-like, clean finish.
- Ethiopia Sidama | Espresso roast | Ethiopia | Arabica | Variety: heirloom | Process: natural | Producer: various cooperatives | Elevation: 1550–2200 m | Flavor notes: blueberry jam, red grape, floral.

FILTER ROAST BEAN DETAILS: No full spec sheet in chat for Mt. Apo, Guji, Kenya, or Mt. Apo (Ellaga) — give 250g price from PRICING and suggest visiting the shop or asking a team member for origin/elevation/tasting notes.

FAQ (use these answers; add or edit lines below when Beantol updates info):
Q: Are you open today? / What are your hours? / Open on Saturday or Sunday?
A: Monday to Friday, 9:00 AM to 6:00 PM. We are closed on Saturdays and Sundays.

Q: Where are you located? / Address? / Map?
A: Holy Family Village 2, Governor Cuenco Avenue, Banilad, Cebu City (beside the guardhouse).

Q: How can I order? / Pickup?
A: Visit the shop Monday–Friday 9 AM–6 PM, or message here on Messenger for pickup. For delivery, we use Maxim (customer pays delivery fee). We are closed weekends.

Q: Do you deliver? / Maxim?
A: Yes, via Maxim. Delivery fee is paid by the customer. Follow DELIVERY step 1, then step 2 when they send details, then step 3 if they want a representative.

Q: How much is [product]? / Price list? / Tagpila? / How much for Beantol Prime?
A: If they name one bean: give all retail sizes at once (e.g. Prime espresso — 250g ₱420, 500g ₱780, 1kg ₱1,450). If roast type unclear for a name that exists in both lists (e.g. Guji), ask espresso vs filter once, then give all sizes for that roast. If they ask generally with no bean: ask which bean and roast type. Never ask "which size?" when the bean is already clear. For Prime, Santos, or Cerrado, add the wholesale 6kg+ line when giving prices.

Q: Espresso vs filter? / Pour-over prices?
A: Explain these are separate roast styles with different prices. Filter roast beans are listed at 250g in PRICING; espresso has 250g, 500g, and 1kg.

Q: What do you recommend? / Best for espresso? / Pour-over?
A: Espresso machine → suggest from ESPRESSO ROAST list. Pour-over/filter → suggest from FILTER ROAST list. Ask what they brew if unsure. Do not list all prices unless they ask for many items.

Q: Tell me about [bean] / flavor notes / elevation / origin / process?
A: Use conversation context: if they already discussed a bean and ask a follow-up without naming it again ("flavor notes?", "how about elevation?", "origin?"), answer for THAT same bean — do not ask which bean again. If they name an espresso bean in ESPRESSO BEAN DETAILS, share only that bean's info in a short reply (e.g. "Flavor notes for Beantol Prime: sweet chocolate, nutty, pistachio."). Add all retail prices only if they also ask price. Do NOT list all five beans. Filter beans without full specs: give 250g price and suggest shop Mon–Fri for more detail.

Q: Payment methods? / GCash? / Card? / Bank? / Account number?
A: Customers can pay via GCash or UnionBank. Card payments are not available yet.
- GCash: 09176555008 (registered name: Justin Siao)
- UnionBank account name: Reyna Mae Baldemor Epe | account number: 100660070137
Share these when they ask how to pay. Remind them to send proof of payment in this chat after transferring.

Q: Contact person? / Phone number? / Who do I call? / Number to reach?
A: Justin Siao — 09176555008. Share when they ask for a contact person or phone number for Beantol.

Q: Do you grind beans? / What grind sizes? / Pre-ground?
A: Typically we do not grind beans, because different extraction methods (espresso, pour-over, drip, etc.) need different grind sizes. Beans are best calibrated to the customer's machine or brewing method. If they insist on a generic grind for drip coffee, it can be arranged subject to negotiation at purchase — mention that in chat.

Q: Wholesale / bulk / 6kg / supply for café?
A: Wholesale (MOQ 6 kg minimum) per kg — espresso roast only: Beantol Prime ₱1,350; Brazil Santos ₱1,400; Brazil Cerrado ₱1,450. No wholesale on Ethiopia Guji, Ethiopia Sidama, or filter roast beans. Ask business name, contact, bean, and total kg needed.

Q: Is [bean] in stock today?
A: Say you cannot confirm live stock in chat — they may visit the shop Monday–Friday 9 AM–6 PM or ask for a team member for today's availability.

Q: Samples / tasting?
A: Say visiting the shop Monday–Friday during hours is best for exploring beans. We are closed weekends. Do not promise free samples unless listed above.

Q: How to store coffee? / Shelf life?
A: Brief tip: keep beans in an airtight bag, cool and dry, away from sun; use within a few weeks of roast for best flavor. We roast fresh at Beantol.

Q: Kinsay crush ni Honey? / Who is Honey's crush?
A: si Jesus! (Keep it short and playful — this is a light joke, not a serious support answer.)

RULES:
- CONVERSATION CONTEXT: You receive recent messages in this Messenger thread. Remember which bean, roast type, and topic you were discussing. Follow-ups without a bean name still refer to that bean unless the customer clearly switches to another product.
- PRICING: Never paste the entire PRICING section. For a named bean, give all sizes at once; only ask clarifying questions when the bean or espresso vs filter is genuinely unclear. Mention wholesale (6kg+, MOQ) for Prime, Santos, or Cerrado when quoting their retail prices or when bulk comes up.
- BEAN DETAILS: Never paste the entire ESPRESSO BEAN DETAILS section — only the bean in context (named now or discussed earlier in the thread).
- Keep replies short (2–4 sentences) unless the customer asks for more detail.
- Tone: friendly, warm, professional.
- LANGUAGE (strict): Your reply language is chosen by the server instruction on each message — follow it exactly. Default is English only. Never mirror the language the customer used unless the server says they requested Bisaya/Cebuano or Tagalog replies. Examples: "Naa mo?" / "Open pa?" → English. "Puede ka mag bisaya?" / "Bisaya lang" → Cebuano/Bisaya (NOT handoff).
- LANGUAGE CHANGE IS NOT HANDOFF: Switching language is not handoff. Examples: "puede ka mag bisaya" → Bisaya; "English balik bi" / "balik english" / "English please" → English again. Never use [[HANDOFF]] for language switches.
- HUMAN HANDOFF: When they want a real person, agent, staff, or customer representative — or reply YES (or oo / yes po) after you offered a representative following delivery details — respond with exactly [[HANDOFF]] and nothing else. The server sends the handoff message and pauses the bot.
- If you do not know something (custom orders, stock today), say you are not sure and ask them to leave details in chat or ask for a team member. Do not suggest calling or Messenger buttons. Use [[HANDOFF]] for delivery only in DELIVERY step 3, not for initial delivery questions.
- Do not invent products, prices, or policies not listed above.`;

const openai = OPENAI_API_KEY
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : null;

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
  deliveryAgentOfferPending.set(senderId, Date.now());
}

function clearDeliveryAgentOfferPending(senderId) {
  deliveryAgentOfferPending.delete(senderId);
}

function isDeliveryAgentOfferPending(senderId) {
  const at = deliveryAgentOfferPending.get(senderId);
  if (!at) return false;
  if (Date.now() - at > DELIVERY_AGENT_OFFER_TTL_MS) {
    deliveryAgentOfferPending.delete(senderId);
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
  if (
    senderId &&
    isDeliveryAgentOfferPending(senderId) &&
    wantsAgentAfterDeliveryOffer(normalized)
  ) {
    return true;
  }
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

function getActiveHandoff(senderId) {
  const session = handoffSessions.get(senderId);
  if (!session) return null;

  if (Date.now() > session.expiresAt) {
    handoffSessions.delete(senderId);
    return null;
  }

  return session;
}

function startHandoff(senderId, userText) {
  clearDeliveryAgentOfferPending(senderId);
  const now = Date.now();
  handoffSessions.set(senderId, {
    handedOffAt: now,
    expiresAt: now + HANDOFF_TIMEOUT_HOURS * 60 * 60 * 1000,
    lastMessage: userText.trim(),
  });
}

function resolveHandoff(senderId) {
  clearDeliveryAgentOfferPending(senderId);
  return handoffSessions.delete(senderId);
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

function rememberPageIdFromEvent(event) {
  if (event.message?.is_echo !== true || !event.sender?.id) return;
  const senderPageId = String(event.sender.id);
  if (pageId !== senderPageId) {
    pageId = senderPageId;
    console.log(`Page ID learned from message echo: ${pageId}`);
  }
}

function isOutboundFromPage(event) {
  if (event.message?.is_echo === true) return true;
  if (pageId && event.sender?.id && String(event.sender.id) === String(pageId)) {
    return true;
  }
  return false;
}

/** Pause bot when a human admin replies from Business Suite (no extra customer message). */
function pauseBotForAdminTakeover(customerId, adminText) {
  if (adminText && isAdminResumeCommand(adminText)) return;
  if (getActiveHandoff(customerId)) return;
  startHandoff(customerId, "Admin replied from Business Suite");
  console.log(
    `Bot paused for ${customerId} — admin message detected. Auto-replies off for ${HANDOFF_TIMEOUT_HOURS}h or until admin sends ${ADMIN_RESUME_COMMANDS[0]}.`
  );
}

const RESUME_SEND_DELAY_MS = Number(process.env.RESUME_SEND_DELAY_MS || 1200);

async function resumeBotForCustomer(customerId, adminText) {
  const hadHandoff = Boolean(getActiveHandoff(customerId));
  resolveHandoff(customerId);
  console.log(
    `Resume command "${adminText}" for ${customerId} — handoff cleared (was paused: ${hadHandoff}).`
  );

  if (RESUME_SEND_DELAY_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, RESUME_SEND_DELAY_MS));
  }

  try {
    await sendMessageWithFallback(customerId, BOT_RESUME_REPLY);
    console.log(`Resume confirmation sent to ${customerId}.`);
  } catch (err) {
    console.error(`Resume confirmation failed for ${customerId}:`, err.message);
  }
}

async function handlePageOutbound(event) {
  if (!isOutboundFromPage(event)) return;

  const customerId = event.recipient?.id;
  const mid = event.message?.mid;
  const text = event.message?.text || "";
  if (!customerId || !mid) {
    console.log("Page outbound missing customerId or mid:", JSON.stringify(event).slice(0, 400));
    return;
  }
  if (String(customerId) === String(pageId)) {
    console.log("Page outbound skipped — recipient is page, not customer.");
    return;
  }
  if (botSentMessageIds.has(mid)) return;

  console.log(
    `Page outbound → customer ${customerId}: echo=${Boolean(event.message?.is_echo)} text=${JSON.stringify(text)} resume=${isAdminResumeCommand(text)}`
  );

  if (isAdminResumeCommand(text)) {
    await resumeBotForCustomer(customerId, text);
    return;
  }

  if (!text.trim()) return;

  pauseBotForAdminTakeover(customerId, text);
}

let mailTransporter = null;

async function sendAlertEmail({ subject, text }) {
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
        to: [HANDOFF_NOTIFY_EMAIL],
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
    to: HANDOFF_NOTIFY_EMAIL,
    subject,
    text,
  });
  return { provider: "smtp", id: info.messageId };
}

async function triggerHandoff(senderId, userText, source) {
  startHandoff(senderId, userText);
  console.log(
    `Human handoff started for ${senderId} (${source}). Auto-replies paused for ${HANDOFF_TIMEOUT_HOURS}h or until admin resolves.`
  );
  await sendMessage(senderId, HANDOFF_REPLY);
  notifyHandoffByEmail(senderId, userText).catch((err) => {
    console.error("Handoff email failed:", err.message);
  });
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

async function notifyHandoffByEmail(senderId, userText) {
  if (!isEmailConfigured()) {
    console.warn(
      "Handoff email skipped — set RESEND_API_KEY on Render (recommended) or SMTP_* locally."
    );
    return;
  }

  const handedOffAt = new Date().toISOString();
  const resumeUrl = buildResumeUrl(senderId, null, true);
  const adminPanelUrl =
    PUBLIC_BASE_URL && ADMIN_SECRET
      ? `${PUBLIC_BASE_URL}/admin?token=${encodeURIComponent(ADMIN_SECRET)}`
      : "";

  const result = await sendAlertEmail({
    subject: "Beantol Messenger — customer wants a human",
    text: [
      "A customer asked to speak with a real person on Messenger.",
      "",
      `Time: ${handedOffAt}`,
      `Sender ID: ${senderId}`,
      `Their message: ${userText}`,
      "",
      "Bot auto-replies are paused. Reply in Meta Business Suite, then resume the bot:",
      resumeUrl ? `Resume AI + notify customer: ${resumeUrl}` : "(Set PUBLIC_BASE_URL on Render for one-click resume links)",
      adminPanelUrl ? `All paused chats: ${adminPanelUrl}` : "",
      "",
      "Note: #bot in Business Suite often does not reach the server. Use the resume link above instead.",
    ]
      .filter(Boolean)
      .join("\n"),
  });

  console.log(
    `Handoff email sent to ${HANDOFF_NOTIFY_EMAIL} via ${result.provider}`
  );
}

function shouldSendDeliveryAlert(senderId) {
  const expiresAt = deliveryAlertCooldowns.get(senderId);
  if (expiresAt && Date.now() < expiresAt) return false;
  return true;
}

function markDeliveryAlertSent(senderId) {
  deliveryAlertCooldowns.set(senderId, Date.now() + DELIVERY_ALERT_COOLDOWN_MS);
}

async function notifyDeliveryByEmail(senderId, userText, source) {
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

  const now = new Date().toISOString();
  try {
    const result = await sendAlertEmail({
      subject: "Beantol Messenger — Maxim delivery inquiry (bot still replying)",
      text: [
        "A customer asked about delivery on Messenger.",
        "",
        `Time: ${now}`,
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

function getPublicBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  if (!req) return "";
  const host = req.get("host");
  if (!host) return "";
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  return `${proto}://${host}`;
}

function buildResumeUrl(senderId, req, sendResume = true) {
  const base = getPublicBaseUrl(req);
  if (!base || !ADMIN_SECRET) return "";
  const params = new URLSearchParams({ token: ADMIN_SECRET });
  if (sendResume) params.set("sendResume", "1");
  return `${base}/admin/handoffs/${encodeURIComponent(senderId)}/resolve?${params}`;
}

function listActiveHandoffs() {
  const now = Date.now();
  const handoffs = [];

  for (const [senderId, session] of handoffSessions.entries()) {
    if (now > session.expiresAt) {
      handoffSessions.delete(senderId);
      continue;
    }
    handoffs.push({
      senderId,
      handedOffAt: new Date(session.handedOffAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
      lastMessage: session.lastMessage,
    });
  }

  return handoffs;
}

// --- Health check (useful after deploy) ---
app.get("/", (req, res) => {
  res.send("Beantol Messenger bot is running.");
});

// --- Admin: simple dashboard (bookmark on phone/PC) ---
app.get("/admin", (req, res) => {
  if (!requireAdmin(req, res)) return;

  const handoffs = listActiveHandoffs();
  const rows = handoffs
    .map((h) => {
      const resumeUrl = buildResumeUrl(h.senderId, req, true);
      return `<tr>
        <td><code>${h.senderId}</code></td>
        <td>${escapeHtml(h.lastMessage)}</td>
        <td><a href="${resumeUrl}">Resume AI</a></td>
      </tr>`;
    })
    .join("");

  res.type("html").send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Beantol bot admin</title>
<style>
body{font-family:system-ui,sans-serif;max-width:720px;margin:24px auto;padding:0 16px}
table{width:100%;border-collapse:collapse}th,td{border:1px solid #ddd;padding:8px;text-align:left}
th{background:#f5f5f5}a.button{display:inline-block;margin-top:16px;padding:10px 16px;background:#2d6a4f;color:#fff;text-decoration:none;border-radius:6px}
.muted{color:#666;font-size:14px}
</style></head><body>
<h1>Beantol — paused chats</h1>
<p class="muted">Paused count: <strong>${handoffs.length}</strong>. Tap <strong>Resume AI</strong> to clear handoff and send the customer the “assistant is back” message.</p>
<p class="muted"><strong>#bot</strong> in Business Suite usually does <em>not</em> reach this server — use this page or the email link instead.</p>
${handoffs.length ? `<table><tr><th>Customer ID</th><th>Last note</th><th></th></tr>${rows}</table>` : "<p>No active handoffs.</p>"}
<a class="button" href="/admin?token=${encodeURIComponent(req.query.token || "")}">Refresh</a>
</body></html>`);
});

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- Admin: list conversations waiting for a human ---
app.get("/admin/handoffs", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const handoffs = listActiveHandoffs();
  res.json({ count: handoffs.length, handoffs });
});

// --- Admin: send a test email (Resend or SMTP) ---
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
  const removed = resolveHandoff(senderId);

  if (!removed) {
    return res.status(404).json({ error: "No active handoff for this sender." });
  }

  console.log(`Handoff resolved for ${senderId} by admin API.`);

  if (req.query.sendResume === "1") {
    try {
      await sendMessageWithFallback(senderId, BOT_RESUME_REPLY);
    } catch (err) {
      console.error(`Resolve sendResume failed for ${senderId}:`, err.message);
    }
  }

  const payload = {
    ok: true,
    senderId,
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

// --- Facebook sends incoming messages here ---
app.post("/webhook", (req, res) => {
  const body = req.body;

  if (body.object !== "page") {
    return res.sendStatus(404);
  }

  // Respond immediately so Facebook does not timeout
  res.sendStatus(200);

  processWebhookEvents(body).catch((err) => {
    console.error("Webhook processing error:", err.message);
  });
});

function collectMessagingEvents(body) {
  const items = [];
  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      items.push({ event, channel: "messaging" });
    }
    for (const event of entry.standby || []) {
      items.push({ event, channel: "standby" });
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

  for (const { event, channel } of collectMessagingEvents(body)) {
    if (!event.message) continue;

    rememberPageIdFromEvent(event);

    const text = event.message.text || "";
    if (DEBUG_WEBHOOK || /#bot/i.test(text)) {
      console.log(
        `Webhook ${channel}: echo=${event.message.is_echo} sender=${event.sender?.id} recipient=${event.recipient?.id} pageId=${pageId} text=${JSON.stringify(text)}`
      );
    }

    if (isOutboundFromPage(event)) {
      await handlePageOutbound(event);
      continue;
    }

    if (!text) continue;

    try {
      await handleMessage(event.sender.id, event.message.text);
    } catch (err) {
      console.error("Error handling message:", err.message);
    }
  }
}

async function handleMessage(senderId, userText) {
  console.log(`Message from ${senderId}: ${userText}`);

  const activeHandoff = getActiveHandoff(senderId);
  if (activeHandoff) {
    console.log(`Skipping auto-reply for ${senderId} — waiting for human (expires ${new Date(activeHandoff.expiresAt).toISOString()}).`);
    return;
  }

  updateReplyLanguagePreference(senderId, userText);

  if (wantsHumanHandoff(userText, senderId)) {
    await triggerHandoff(senderId, userText, "phrase match");
    return;
  }

  let reply;

  if (!openai) {
    reply =
      "Bot is running but OpenAI is not configured yet. Please add OPENAI_API_KEY.";
  } else {
    try {
      const history = getChatHistory(senderId);
      const completion = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "system", content: getReplyLanguageInstruction(senderId) },
          ...history,
          { role: "user", content: userText },
        ],
        max_tokens: 500,
      });
      reply =
        completion.choices[0]?.message?.content?.trim() ||
        "Sorry, I could not generate a reply. Please try again.";
    } catch (err) {
      console.error("OpenAI error:", err.message);
      reply =
        "Sorry, I am having trouble right now. Please try again in a moment.";
    }
  }

  if (isAiHandoffReply(reply) && !isReplyLanguagePreferenceRequest(userText)) {
    const blockHandoff =
      isDeliveryInquiry(userText) &&
      !wantsAgentAfterDeliveryOffer(userText) &&
      !isDeliveryAgentOfferPending(senderId);
    if (!blockHandoff) {
      clearDeliveryAgentOfferPending(senderId);
      await triggerHandoff(senderId, userText, "AI [[HANDOFF]] marker");
      return;
    }
  }

  if (aiReplyIsDeliveryDetailsConfirmation(reply)) {
    markDeliveryAgentOfferPending(senderId);
    console.log(`Delivery step-2 sent for ${senderId} — YES / agent reply will handoff.`);
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
    console.log(`Delivery alert for ${senderId} (${deliveryTrigger}).`);
    await notifyDeliveryByEmail(senderId, userText, deliveryTrigger);
  }

  if (openai) {
    appendChatHistory(senderId, userText, reply);
  }

  await sendMessage(senderId, sanitizeBotReply(reply));
}

async function sendMessage(recipientId, text, options = {}) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
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
    console.error("Facebook Send API error:", JSON.stringify(data));
    throw new Error(data.error?.message || "Failed to send message");
  }

  rememberBotMessageId(data.message_id);
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
  const missing = [];
  if (!VERIFY_TOKEN) missing.push("VERIFY_TOKEN");
  if (!PAGE_ACCESS_TOKEN) missing.push("PAGE_ACCESS_TOKEN");
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

async function loadPageId() {
  if (PAGE_ID_ENV) {
    pageId = String(PAGE_ID_ENV);
    console.log(`Page ID from PAGE_ID env: ${pageId}`);
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
      "Page ID API lookup not available (permission not required). Optional: set PAGE_ID on Render. Echo webhooks still detect admin messages when Meta sends them."
    );
    if (DEBUG_WEBHOOK) {
      console.log("loadPageId response:", JSON.stringify(data));
    }
  } catch (err) {
    console.log("Page ID API lookup skipped:", err.message);
  }
}

checkConfig();
verifyEmailOnStartup().catch(() => {});
loadPageId().catch(() => {});

app.listen(PORT, () => {
  console.log(`Beantol bot listening on port ${PORT}`);
  console.log(`Webhook URL path: /webhook`);
});
