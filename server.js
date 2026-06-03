/**
 * Beantol Messenger AI Bot
 * Receives messages from Facebook Messenger, replies using OpenAI.
 */

require("dotenv").config();
const express = require("express");
const OpenAI = require("openai");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

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
- Delivery via Maxim
- Message us here on Messenger for pickup orders

POPULAR PRODUCTS (prices in Philippine Pesos):
- Beantol Prime — ₱1,450
- Brazil Cerrado — ₱1,550
- Brazil Santos — ₱1,500
- Ethiopia Sidama — ₱1,700

RULES:
- Keep replies short (2–4 sentences) unless the customer asks for more detail.
- Tone: friendly, warm, professional. Taglish is OK when it feels natural.
- LANGUAGE: Reply in the same language the customer uses. If they write in Tagalog, reply in Tagalog. If they write in Cebuano/Bisaya, reply in Cebuano. If they mix (Taglish/Bislish), you may mix too. Default to English only when the customer writes in English.
- If the customer asks "Naa mo?" or "Open pa?" answer naturally in Cebuano/Tagalog as appropriate.
- If the customer types "HUMAN" or needs a person, say a team member will reply personally soon.
- If you do not know something (custom orders, stock today, wholesale pricing), say you are not sure and ask them to type HUMAN or leave their name and number.
- Do not invent products, prices, or policies not listed above.`;

const openai = OPENAI_API_KEY
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : null;

// --- Health check (useful after deploy) ---
app.get("/", (req, res) => {
  res.send("Beantol Messenger bot is running.");
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
      if (event.message && event.message.text && !event.message.is_echo) {
        handleMessage(event.sender.id, event.message.text).catch((err) => {
          console.error("Error handling message:", err.message);
        });
      }
    }
  }
});

async function handleMessage(senderId, userText) {
  console.log(`Message from ${senderId}: ${userText}`);

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

  await sendMessage(senderId, reply);
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

  console.log(`Reply sent to ${recipientId}`);
}

// --- Startup checks ---
function checkConfig() {
  const missing = [];
  if (!VERIFY_TOKEN) missing.push("VERIFY_TOKEN");
  if (!PAGE_ACCESS_TOKEN) missing.push("PAGE_ACCESS_TOKEN");
  if (!OPENAI_API_KEY) missing.push("OPENAI_API_KEY (bot will send a placeholder reply)");

  if (missing.length) {
    console.warn("Missing env vars:", missing.join(", "));
  }
}

checkConfig();

app.listen(PORT, () => {
  console.log(`Beantol bot listening on port ${PORT}`);
  console.log(`Webhook URL path: /webhook`);
});
