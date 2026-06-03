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

// Customize this with your real Beantol business info
const SYSTEM_PROMPT = `You are the friendly customer support assistant for Beantol on Facebook Messenger.
Answer questions about Beantol clearly and briefly (2-4 sentences unless more detail is needed).
If you do not know something, politely ask the customer to leave their contact info or type "human" for a person.
Be warm, professional, and helpful.`;

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
