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

/** @type {Map<string, { handedOffAt: number, expiresAt: number, lastMessage: string }>} */
const handoffSessions = new Map();

/** @type {Map<string, 'en' | 'tl' | 'ceb'>} */
const replyLanguagePrefs = new Map();

/** @type {Map<string, number>} senderId -> alert cooldown expiresAt */
const deliveryAlertCooldowns = new Map();

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

DELIVERY:
- Delivery is arranged via Maxim (third-party rider app).
- The delivery fee is shouldered by the customer (not included in the coffee price unless you state otherwise).
- When a customer asks about delivery, wants delivery, or orders for delivery: briefly confirm Maxim delivery and that the customer pays the delivery fee, then ask for (1) complete delivery address, (2) contact name, and (3) mobile/contact number. Keep it friendly and in one short reply.
- Do NOT use [[HANDOFF]] for delivery questions — keep helping in chat and collect details here.
- Never say "call me", "call us", "message us on Messenger", or suggest buttons/CTAs. Plain text only in this thread.
- Do not invent delivery fees, zones, or timelines.

PRICING (Philippine Pesos — do NOT list every product/size unless they ask for a full menu):
- Espresso roast and filter roast are different products — same origin name can have different prices.
- Sizes: espresso has 250g, 500g, 1kg. Filter roast listed below is 250g (confirm 100g at shop if asked).
- When asked "prices" generally: ask what bean they want and size (250g/500g/1kg), or espresso vs filter / pour-over. Give only the relevant line(s), not the full catalog.

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
A: Yes, via Maxim. Delivery fee is paid by the customer. Ask them for complete address, contact name, and mobile number in chat.

Q: How much is [product]? / Price list? / Tagpila?
A: Do NOT dump the full price table. Ask which bean and size (250g, 500g, or 1kg) and whether they want espresso roast or filter roast if unclear. Then give only matching price(s) from PRICING above. Example: "Brazil Cerrado 1kg espresso is ₱1,550." For wholesale (6kg+), give per-kg wholesale only for Prime, Santos, or Cerrado.

Q: Espresso vs filter? / Pour-over prices?
A: Explain these are separate roast styles with different prices. Filter roast beans are listed at 250g in PRICING; espresso has 250g, 500g, and 1kg.

Q: What do you recommend? / Best for espresso? / Pour-over?
A: Espresso machine → suggest from ESPRESSO ROAST list. Pour-over/filter → suggest from FILTER ROAST list. Ask what they brew if unsure. Do not list all prices unless they ask for many items.

Q: Tell me about [bean] / flavor notes / elevation / origin / process?
A: If they name an espresso bean in ESPRESSO BEAN DETAILS, share only that bean's info (roast, origin, variety, process, elevation if known, flavor notes) in a short reply. Add price only if they also ask price or size. Do NOT list all five beans. If they ask about a discontinued or filter bean without details here, say you only have full specs for espresso roast beans listed above; for filter roast or others, visit the shop Mon–Fri or ask for a team member.

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
- PRICING: Never paste the entire PRICING section. Answer the specific bean + size + roast type they asked about (or ask one clarifying question first).
- BEAN DETAILS: Never paste the entire ESPRESSO BEAN DETAILS section — only the one bean they asked about.
- Keep replies short (2–4 sentences) unless the customer asks for more detail.
- Tone: friendly, warm, professional.
- LANGUAGE (strict): Your reply language is chosen by the server instruction on each message — follow it exactly. Default is English only. Never mirror the language the customer used unless the server says they requested Bisaya/Cebuano or Tagalog replies. Examples: "Naa mo?" / "Open pa?" → English. "Puede ka mag bisaya?" / "Bisaya lang" → Cebuano/Bisaya (NOT handoff).
- LANGUAGE CHANGE IS NOT HANDOFF: Switching language is not handoff. Examples: "puede ka mag bisaya" → Bisaya; "English balik bi" / "balik english" / "English please" → English again. Never use [[HANDOFF]] for language switches.
- HUMAN HANDOFF: Only if they want a real person, agent, or staff — not the bot. Then respond with exactly [[HANDOFF]] and nothing else. The server sends the handoff message and pauses the bot.
- If you do not know something (custom orders, stock today), say you are not sure and ask them to leave details in chat or ask for a team member. Do not suggest calling or Messenger buttons. Use [[HANDOFF]] only when they explicitly want a real person/agent — not for delivery.
- Do not invent products, prices, or policies not listed above.`;

const openai = OPENAI_API_KEY
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : null;

const HANDOFF_MARKER = "[[HANDOFF]]";

const HANDOFF_PATTERNS = [
  /\bhuman\b/i,
  /\breal person\b/i,
  /\blive person\b/i,
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

function wantsHumanHandoff(text) {
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
  const now = Date.now();
  handoffSessions.set(senderId, {
    handedOffAt: now,
    expiresAt: now + HANDOFF_TIMEOUT_HOURS * 60 * 60 * 1000,
    lastMessage: userText.trim(),
  });
}

function resolveHandoff(senderId) {
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
  const normalized = normalizeCommandText(text);
  if (!normalized) return false;
  return ADMIN_RESUME_COMMANDS.some((cmd) => {
    const target = normalizeCommandText(cmd);
    return normalized === target || normalized.includes(target);
  });
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
  const resolveHint = ADMIN_SECRET
    ? `Mark handled (resume bot): POST /admin/handoffs/${senderId}/resolve?token=YOUR_ADMIN_SECRET`
    : "Mark handled via POST /admin/handoffs/:senderId/resolve when ADMIN_SECRET is set.";

  const result = await sendAlertEmail({
    subject: "Beantol Messenger — customer wants a human",
    text: [
      "A customer asked to speak with a real person on Messenger.",
      "",
      `Time: ${handedOffAt}`,
      `Sender ID: ${senderId}`,
      `Their message: ${userText}`,
      "",
      "Bot auto-replies are paused for this customer. Reply in Meta Business Suite / Messenger.",
      "",
      resolveHint,
    ].join("\n"),
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

// --- Health check (useful after deploy) ---
app.get("/", (req, res) => {
  res.send("Beantol Messenger bot is running.");
});

// --- Admin: list conversations waiting for a human ---
app.get("/admin/handoffs", (req, res) => {
  if (!requireAdmin(req, res)) return;

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

  res.json({
    ok: true,
    senderId,
    message: "Handoff cleared. Bot will auto-reply again.",
    resumeMessageSent: req.query.sendResume === "1",
  });
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

async function processWebhookEvents(body) {
  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      if (!event.message) continue;

      if (isOutboundFromPage(event)) {
        await handlePageOutbound(event);
        continue;
      }

      if (!event.message.text) continue;

      try {
        await handleMessage(event.sender.id, event.message.text);
      } catch (err) {
        console.error("Error handling message:", err.message);
      }
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

  if (wantsHumanHandoff(userText)) {
    await triggerHandoff(senderId, userText, "phrase match");
    return;
  }

  let reply;

  if (!openai) {
    reply =
      "Bot is running but OpenAI is not configured yet. Please add OPENAI_API_KEY.";
  } else {
    try {
      const completion = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "system", content: getReplyLanguageInstruction(senderId) },
          { role: "user", content: userText },
        ],
        max_tokens: 300,
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

  if (
    isAiHandoffReply(reply) &&
    !isReplyLanguagePreferenceRequest(userText) &&
    !isDeliveryInquiry(userText) &&
    !aiReplyIsDeliveryFlow(reply)
  ) {
    await triggerHandoff(senderId, userText, "AI [[HANDOFF]] marker");
    return;
  }

  const deliveryTrigger = isDeliveryInquiry(userText)
    ? "customer message"
    : aiReplyIsDeliveryFlow(reply)
      ? "bot delivery reply"
      : null;

  if (deliveryTrigger) {
    console.log(`Delivery inquiry detected for ${senderId} (${deliveryTrigger}).`);
    await notifyDeliveryByEmail(senderId, userText, deliveryTrigger);
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
  if (!PAGE_ACCESS_TOKEN) return;
  try {
    const response = await fetch(
      `https://graph.facebook.com/v19.0/me?fields=id&access_token=${PAGE_ACCESS_TOKEN}`
    );
    const data = await response.json();
    if (data.id) {
      pageId = String(data.id);
      console.log(`Page ID loaded for outbound detection: ${pageId}`);
    } else {
      console.warn("Could not load Page ID:", JSON.stringify(data));
    }
  } catch (err) {
    console.warn("loadPageId failed:", err.message);
  }
}

checkConfig();
verifyEmailOnStartup().catch(() => {});
loadPageId().catch(() => {});

app.listen(PORT, () => {
  console.log(`Beantol bot listening on port ${PORT}`);
  console.log(`Webhook URL path: /webhook`);
});
