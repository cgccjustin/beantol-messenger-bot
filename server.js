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
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;

const HANDOFF_REPLY =
  "Got it — I am connecting you with our team. A Beantol team member will reply to you personally here on Messenger as soon as they can. Please stay on this chat.";

/** @type {Map<string, { handedOffAt: number, expiresAt: number, lastMessage: string }>} */
const handoffSessions = new Map();

/** @type {Map<string, 'en' | 'tl' | 'ceb'>} */
const replyLanguagePrefs = new Map();

/** @type {Map<string, number>} senderId -> alert cooldown expiresAt */
const deliveryAlertCooldowns = new Map();

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
Open daily, 9:00 AM to 6:00 PM.

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

POPULAR PRODUCTS (prices in Philippine Pesos):
- Beantol Prime — ₱1,450
- Brazil Cerrado — ₱1,550
- Brazil Santos — ₱1,500
- Ethiopia Sidama — ₱1,700

RULES:
- Keep replies short (2–4 sentences) unless the customer asks for more detail.
- Tone: friendly, warm, professional.
- LANGUAGE (strict): Your reply language is chosen by the server instruction on each message — follow it exactly. Default is English only. Never mirror the language the customer used unless the server says they requested Bisaya/Cebuano or Tagalog replies. Examples: "Naa mo?" / "Open pa?" → English. "Puede ka mag bisaya?" / "Bisaya lang" → Cebuano/Bisaya (NOT handoff).
- LANGUAGE CHANGE IS NOT HANDOFF: Switching language is not handoff. Examples: "puede ka mag bisaya" → Bisaya; "English balik bi" / "balik english" / "English please" → English again. Never use [[HANDOFF]] for language switches.
- HUMAN HANDOFF: Only if they want a real person, agent, or staff — not the bot. Then respond with exactly [[HANDOFF]] and nothing else. The server sends the handoff message and pauses the bot.
- If you do not know something (custom orders, stock today, wholesale pricing), say you are not sure and ask them to leave details in chat. Do not suggest calling or Messenger buttons. Use [[HANDOFF]] only when they explicitly want a real person/agent — not for delivery.
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

/** Pause bot when a human admin replies from Business Suite (no extra customer message). */
function pauseBotForAdminTakeover(customerId) {
  if (getActiveHandoff(customerId)) return;
  startHandoff(customerId, "Admin replied from Business Suite");
  console.log(
    `Bot paused for ${customerId} — admin message detected. Auto-replies off for ${HANDOFF_TIMEOUT_HOURS}h or until resolve.`
  );
}

function handlePageMessageEcho(event) {
  const customerId = event.recipient?.id;
  const mid = event.message?.mid;
  if (!customerId || !mid) return;
  if (botSentMessageIds.has(mid)) return;
  pauseBotForAdminTakeover(customerId);
}

let mailTransporter = null;

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
    });
  }
  return mailTransporter;
}

async function notifyHandoffByEmail(senderId, userText) {
  const transporter = getMailTransporter();
  if (!transporter) {
    console.warn("Handoff email skipped — set SMTP_HOST, SMTP_USER, and SMTP_PASS in .env");
    return;
  }

  const handedOffAt = new Date().toISOString();
  const resolveHint = ADMIN_SECRET
    ? `Mark handled (resume bot): POST /admin/handoffs/${senderId}/resolve?token=YOUR_ADMIN_SECRET`
    : "Mark handled via POST /admin/handoffs/:senderId/resolve when ADMIN_SECRET is set.";

  await transporter.sendMail({
    from: SMTP_FROM,
    to: HANDOFF_NOTIFY_EMAIL,
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

  console.log(`Handoff email sent to ${HANDOFF_NOTIFY_EMAIL}`);
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

  const transporter = getMailTransporter();
  if (!transporter) {
    console.warn(
      "Delivery alert email skipped — SMTP not configured on server (check Render Environment: SMTP_HOST, SMTP_USER, SMTP_PASS)."
    );
    return false;
  }

  const now = new Date().toISOString();
  try {
    await transporter.sendMail({
      from: SMTP_FROM,
      to: HANDOFF_NOTIFY_EMAIL,
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
  } catch (err) {
    console.error("Delivery alert email failed:", err.message);
    return false;
  }

  markDeliveryAlertSent(senderId);
  console.log(
    `Delivery alert email sent to ${HANDOFF_NOTIFY_EMAIL} for ${senderId} (${source}).`
  );
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

// --- Admin: send a test email (verify SMTP on Render) ---
app.get("/admin/test-email", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const transporter = getMailTransporter();
  if (!transporter) {
    return res.status(503).json({
      error: "SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS on Render.",
    });
  }

  try {
    await transporter.sendMail({
      from: SMTP_FROM,
      to: HANDOFF_NOTIFY_EMAIL,
      subject: "Beantol Messenger — test email",
      text: "If you received this, SMTP is working on your server.",
    });
    res.json({ ok: true, sentTo: HANDOFF_NOTIFY_EMAIL });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Admin: mark a conversation handled (bot can auto-reply again) ---
app.post("/admin/handoffs/:senderId/resolve", (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { senderId } = req.params;
  const removed = resolveHandoff(senderId);

  if (!removed) {
    return res.status(404).json({ error: "No active handoff for this sender." });
  }

  console.log(`Handoff resolved for ${senderId} by admin.`);
  res.json({ ok: true, senderId, message: "Handoff cleared. Bot will auto-reply again." });
});

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

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      if (!event.message?.text) continue;

      if (event.message.is_echo) {
        handlePageMessageEcho(event);
        continue;
      }

      handleMessage(event.sender.id, event.message.text).catch((err) => {
        console.error("Error handling message:", err.message);
      });
    }
  }
});

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

async function sendMessage(recipientId, text) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("Facebook Send API error:", JSON.stringify(data));
    throw new Error(data.error?.message || "Failed to send message");
  }

  rememberBotMessageId(data.message_id);
  console.log(`Reply sent to ${recipientId}`);
}

// --- Startup checks ---
function checkConfig() {
  const missing = [];
  if (!VERIFY_TOKEN) missing.push("VERIFY_TOKEN");
  if (!PAGE_ACCESS_TOKEN) missing.push("PAGE_ACCESS_TOKEN");
  if (!OPENAI_API_KEY) missing.push("OPENAI_API_KEY (bot will send a placeholder reply)");
  if (!ADMIN_SECRET) missing.push("ADMIN_SECRET (admin handoff endpoints disabled)");
  if (!isSmtpConfigured()) {
    missing.push("SMTP_HOST / SMTP_USER / SMTP_PASS (handoff emails disabled or placeholder)");
  }

  if (missing.length) {
    console.warn("Missing env vars:", missing.join(", "));
  }
}

async function verifySmtpOnStartup() {
  const transporter = getMailTransporter();
  if (!transporter) return;
  try {
    await transporter.verify();
    console.log(
      `SMTP ready — alerts go to ${HANDOFF_NOTIFY_EMAIL} (handoff + delivery)`
    );
  } catch (err) {
    console.error("SMTP verify failed (handoff emails will not send):", err.message);
  }
}

checkConfig();
verifySmtpOnStartup().catch(() => {});

app.listen(PORT, () => {
  console.log(`Beantol bot listening on port ${PORT}`);
  console.log(`Webhook URL path: /webhook`);
});
