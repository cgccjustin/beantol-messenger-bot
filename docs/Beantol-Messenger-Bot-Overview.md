# Beantol Messenger AI Bot
## Complete Project Overview & Feature Guide

**Prepared for:** Beantol Coffee Roasters  
**Platform:** Facebook Messenger + Instagram DMs  
**Stack:** Node.js, OpenAI, Meta Graph API, Google Workspace, Render  
**Version:** 1.0 (June 2026)

---

## 1. Executive Summary

The Beantol Messenger AI Bot is a **24/7 AI sales and customer support assistant** that lives inside your Facebook Page and Instagram inbox. It answers product questions, helps customers choose beans, generates quotes, books shop visits, captures leads and orders, and escalates to human staff when needed — all without making customers leave Messenger or Instagram.

This document explains **what the bot does**, **how it works**, **where to change things**, and **what was built** — useful for internal review or for showing other shop owners what a similar system could do for their business.

---

## 2. What Problem It Solves

| Before | With the bot |
|--------|----------------|
| Staff must reply manually to every DM | AI handles FAQs, pricing, recommendations instantly |
| Product knowledge scattered in chats | Central knowledge base (Google Doc) synced to AI |
| Orders and inquiries lost in messages | Leads, orders, quotes saved to Google Sheets |
| No after-hours coverage | AI replies anytime; live agents 9 AM–9 PM |
| Hard to track who needs follow-up | Admin dashboard + email alerts + sales pipeline |

---

## 3. Channels Supported

| Channel | Status | Notes |
|---------|--------|-------|
| **Facebook Messenger** | Live | Primary channel; webhook + Page token |
| **Instagram DMs** | Live | Same bot, same admin dashboard |
| WhatsApp | Not built | Possible future addition |
| Website chat widget | Not built | Possible future addition |

Customers message the Beantol Page or Instagram account normally. Staff reply from **Meta Business Suite** when taking over a conversation.

---

## 4. How It Works (High Level)

```
Customer sends message (Messenger or Instagram)
        │
        ▼
Meta Webhook → Beantol Bot Server (Render cloud)
        │
        ├── Check: Is admin already replying? → Pause bot
        ├── Check: Structured flows (quote, delivery, appointment, etc.)
        ├── Search Google Doc knowledge (RAG) for relevant facts
        ├── Load: behavior rules, inventory, chat history
        │
        ▼
OpenAI generates a friendly reply
        │
        ├── Send reply to customer
        ├── Save lead/order/quote/appointment if applicable
        └── Email team if handoff or delivery alert needed
```

### Message processing order (simplified)

When a customer sends a message, the server checks in roughly this order:

1. Admin takeover — skip if staff is actively chatting  
2. Get Started / first-time welcome  
3. Reply-to context (swipe-reply YES on a specific bot message)  
4. Agent handoff acceptance  
5. Quote confirmation flow  
6. Post-quote follow-up  
7. Payment proof handling  
8. Outside-Cebu delivery rules  
9. Cebu area delivery (Maxim vs Naga vs province)  
10. Weekend pickup vs delivery rules  
11. Delivery rep YES acceptance  
12. Phrase-based human handoff  
13. Appointment booking wizard  
14. Product recommendation wizard  
15. **AI reply** (RAG + rules + inventory + history)  
16. Post-AI quote generation if pricing was discussed  

This layered design means **critical business rules run before the AI**, so the bot stays consistent even when the AI would otherwise improvise.

---

## 5. Feature List (What the Bot Does)

### 5.1 AI Customer Support

- Answers questions about hours, location, products, pricing, payment, brewing, storage, team contacts  
- Replies in **English** (even if customer writes in Cebuano/Tagalog/Bislish)  
- Uses **conversation memory** (recent chat history) for context  
- Uses **RAG** (Retrieval-Augmented Generation) — searches your Google Doc for relevant facts instead of guessing  
- Never invents prices or products when knowledge is missing — offers contact or handoff instead  

### 5.2 AI Sales Assistant

- Consultative selling: asks brew method, taste preference, volume  
- Recommends 1–2 beans with short explanations  
- Quotes correct retail sizes (250g / 500g / 1kg) and wholesale rules (6 kg MOQ for Prime, Santos, Cerrado only)  
- Handles wholesale math (whole kg only, no fractional wholesale)  
- Respects out-of-stock list — suggests alternatives  
- Gentle follow-up for customers who received a quote but haven't ordered  

### 5.3 Product Recommendations (Guided Flow)

Customer can say things like *"recommend a bean"* and get a **step-by-step picker**:

1. Brew method (espresso, pour-over, milk drinks, etc.)  
2. Taste preference  
3. Bot suggests 1–2 matching beans with prices  

### 5.4 Quotation System

- When customer asks about prices, bot can generate a **formal quote** with ID (`QT-…`)  
- Shareable printable page: `/quote/QT-…`  
- Saved to **Google Sheets → Quotes tab**  
- Admin can view all quotes in dashboard  

### 5.5 Delivery Workflows

**Cebu City / Mandaue / Talisay / Lapu-Lapu (Maxim):**

- Bot explains Maxim delivery (customer pays rider fee separately)  
- Collects address, name, mobile  
- Requires payment first + proof in chat  
- Emails team a **delivery alert** (does NOT pause the bot)  

**Remote Cebu Province (e.g. Naga, Carcar):**

- Pickup at shop, customer's own logistics, or J&T / courier  
- Shipping fee paid by customer  

**Outside Cebu / nationwide:**

- J&T or preferred courier only (never Maxim)  
- Team follows up on shipping cost and timing  
- Optional live agent handoff if customer confirms  

### 5.6 Human Handoff (Live Agent)

- Customer phrases like "talk to a human", "real person", "need agent" trigger handoff  
- Bot sends handoff message + **email alert** to team  
- **AI keeps answering** follow-ups until staff replies in Business Suite  
- When staff replies → bot **pauses** for that customer (no talking over each other)  
- Auto-resumes after admin idle (default 15 minutes) or manual **Resume AI** in dashboard  
- Live agents available **9 AM–9 PM Philippine time** daily  

### 5.7 Appointment Booking

- Customer can book a **shop visit** via chat  
- Natural language dates: "today 5pm", "tomorrow", "this coming Thursday"  
- Defaults to shop visit (not phone callback)  
- Friendly confirmation message  
- Saved to **Google Sheets → Appointments tab**  

### 5.8 Lead, Order & Event Capture

| Data | Where stored | Admin view |
|------|--------------|------------|
| Leads | Google Sheet | `/admin/leads` |
| Orders | Google Sheet | `/admin/orders` |
| Quotes | Google Sheet | `/admin/quotes` |
| Appointments | Google Sheet | `/admin/appointments` |
| Events log | Google Sheet | Analytics |

Team columns on leads: status, assigned to, notes.

### 5.9 Live Inventory

- **Google Sheet → Inventory tab** (preferred)  
- Toggle products in/out of stock from admin — **no redeploy needed**  
- Fallback: `UNAVAILABLE_PRODUCTS` environment variable on Render  
- Bot won't recommend or quote unavailable beans  

### 5.10 Admin Operations Dashboard

Bookmark: `https://YOUR-BOT-URL/admin?token=ADMIN_SECRET`

| Tab | Purpose |
|-----|---------|
| Overview | Handoffs, quick tools, sync knowledge |
| Analytics | Messages, leads, orders, interests |
| Sales | Stale quoted leads needing follow-up |
| Leads | CRM-style lead list |
| Appointments | Booked visits |
| Orders | Order inquiries |
| Quotes | Formal quotes |
| Inventory | Stock in/out |

**Admin tools also include:**

- Sync knowledge from Google Doc  
- Test email alerts  
- View Meta / Instagram link status  
- Resume AI for paused conversations  

### 5.11 Email Notifications

Via **Resend** (production) or Gmail SMTP (local dev):

- Human handoff alerts  
- Delivery inquiry alerts  
- Stale lead / sales pipeline notifications  

### 5.12 Reply-to Message Support

- If customer **swipes to reply YES** on a specific bot message (e.g. agent offer, quote confirm), the bot maps YES to **that message's intent** — not a generic "yes" elsewhere in the chat  

### 5.13 Welcome Messages

- **Get Started** button → immediate welcome  
- First message in a new chat → short welcome + answer (not a wall of text)  
- Substantive first messages (e.g. "deliver to Naga") → answer first, welcome stays brief  

### 5.14 Shop Hours & Weekend Logic

- Shop: **Mon–Fri 9 AM–6 PM**; closed weekends  
- Live chat agents: **daily 9 AM–9 PM**  
- Weekend: no same-day pickup or Maxim dispatch promises; processing starts Monday  
- Zone-specific weekend replies (pickup vs delivery)  

### 5.15 Payment Flow

- GCash and UnionBank details from knowledge base  
- Bot asks for **proof of payment** in chat for delivery orders  
- Payment proof detection in dedicated flow  

---

## 6. Source of Truth — Where to Change What

The bot uses **multiple sources**. Use the right one for each type of change.

### 6.1 Business Facts → Google Doc (production)

**Edit when changing:** hours, address, prices, product descriptions, FAQ, payment details, team contacts, policies.

**Workflow:**

1. Edit **Beantol Google Doc** in Google Drive  
2. Save  
3. Sync: `GET /admin/sync-knowledge?token=ADMIN_SECRET`  
   - Or wait for Render restart (auto-sync on startup)  
4. **No git deploy needed** for Doc-only changes  

**Repo backup:** `knowledge/templates/beantol-knowledge-base.md` — paste reference only; editing it alone does not update production.

### 6.2 Bot Behavior → Code (git deploy)

**Edit when changing:** how the bot acts, not just what it knows.

| Change | File(s) |
|--------|---------|
| Handoff rules, tone, sales script | `system-rules.js` |
| Delivery zone logic | `lib/cebu-area-delivery.js`, `lib/outside-cebu-delivery.js` |
| Welcome messages | `lib/welcome.js` |
| Quotes & post-quote flow | `lib/quotes.js`, `lib/post-quote-flow.js` |
| Appointments | `lib/appointments.js` |
| Recommendations wizard | `lib/recommendations.js` |
| Shop hours / weekends | `lib/shop-hours.js` |
| Reply-to context | `lib/message-reply-context.js` |
| Main message pipeline | `server.js` |

Requires **commit + push + Render redeploy**.

### 6.3 Stock / Availability → Google Sheet or Render env

- **Preferred:** Google Sheet Inventory tab  
- **Fallback:** `UNAVAILABLE_PRODUCTS` on Render  

### 6.4 Customer Records → Google Sheets

Leads, orders, quotes, appointments — configured via Sheet IDs on Render. These are **records**, not AI knowledge.

### Quick decision guide

| You want to… | Do this |
|--------------|---------|
| Add FAQ answer | Google Doc → sync |
| Change a price | Google Doc → sync |
| New promo text | Google Doc → sync |
| Fixed reply for "deliver to Naga" | Code → deploy |
| Mark bean out of stock | Inventory Sheet |
| Change appointment steps | Code → deploy |

**If code and Google Doc disagree on behavior, code wins for automated flows.**

---

## 7. Technology Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js 18+ |
| Web server | Express |
| AI | OpenAI API (gpt-4o-mini default) |
| Embeddings | OpenAI text-embedding-3-small (RAG) |
| Messaging | Meta Graph API (Messenger + Instagram) |
| Knowledge sync | Google Drive API (Docs export) |
| Data storage | Google Sheets (leads, orders, quotes, inventory, events) |
| Email | Resend (production) / Nodemailer + Gmail (local) |
| Hosting | Render (cloud Web Service) |
| Source control | GitHub |

### Key project folders

```
beantol-messenger-bot/
├── server.js              # Main webhook, message pipeline, admin routes
├── system-rules.js        # AI behavior rules (not in Google Doc)
├── lib/                   # Feature modules (delivery, quotes, appointments, etc.)
├── knowledge/
│   ├── templates/         # Backup doc for Google Doc (not auto-indexed)
│   └── sources/           # Synced .txt from Google (indexed at runtime)
├── scripts/               # Index knowledge, sync Google Docs
└── docs/                  # Documentation (this file)
```

---

## 8. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        CUSTOMER                                  │
│              Facebook Messenger  /  Instagram DM                 │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                     META WEBHOOK (/webhook)                      │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                   BEANTOL BOT (Render)                           │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────────┐ │
│  │ Flow engine │  │ RAG search   │  │ OpenAI chat completion  │ │
│  │ (delivery,  │  │ (Google Doc  │  │ + system rules          │ │
│  │  quotes,    │  │  chunks)     │  │ + inventory + history   │ │
│  │  handoff…)  │  └──────────────┘  └─────────────────────────┘ │
│  └─────────────┘                                                 │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────────┐ │
│  │ Admin UI    │  │ Email alerts │  │ Google Sheets API       │ │
│  │ /admin      │  │ (Resend)     │  │ leads/orders/quotes…    │ │
│  └─────────────┘  └──────────────┘  └─────────────────────────┘ │
└────────────────────────────┬────────────────────────────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         ▼                   ▼                   ▼
   Google Doc          Google Sheets         OpenAI API
   (knowledge)         (CRM data)           (AI + embeddings)
```

---

## 9. Knowledge Base (RAG) Explained

**RAG** = Retrieval-Augmented Generation. Instead of stuffing the entire business manual into every API call, the bot:

1. **Indexes** your Google Doc into searchable chunks (embeddings)  
2. On each message, **finds the 6 most relevant chunks**  
3. Sends those chunks + behavior rules to OpenAI  
4. AI writes a natural reply using those facts  

**Benefits:**

- Team edits Google Doc without touching code  
- Answers stay grounded in your official content  
- Smaller, cheaper API calls than sending everything every time  

**Sync commands:**

- Production: `/admin/sync-knowledge?token=…`  
- Local: `npm run sync-knowledge`  

---

## 10. Human Handoff Flow (Detail)

```
Customer: "Can I talk to a real person?"
        │
        ▼
Bot sends handoff message + emails team
Dashboard shows "Awaiting agent"
        │
        ├── Customer asks follow-up → AI still replies
        │
        ▼
Staff replies in Meta Business Suite
        │
        ▼
Bot PAUSES for this customer
        │
        ├── Staff finishes → wait 15 min idle OR tap "Resume AI"
        │
        ▼
Bot sends "assistant is back" message
Chat history preserved — AI remembers context
```

**Note:** Delivery inquiries do **not** trigger handoff pause — bot stays active and emails the team instead.

---

## 11. Costs & Infrastructure (Approximate)

| Service | Typical use | Notes |
|---------|-------------|-------|
| Render | Web service hosting | Free tier or ~$7+/mo for always-on |
| OpenAI | Per-message API usage | gpt-4o-mini is low cost per chat |
| Resend | Email alerts | Free tier for low volume |
| Google Cloud | Docs + Sheets API | Free tier usually sufficient |
| Meta | Messenger/Instagram | No per-message fee from Meta |

Exact cost depends on message volume. A small shop with moderate DM traffic often stays within free/low tiers except Render if always-on is required.

---

## 12. What's Built vs Future

### Done (shipped)

- AI chatbot with RAG + Google Docs sync  
- Messenger + Instagram  
- Human handoff + email alerts  
- Delivery workflows (Maxim, province, outside Cebu)  
- Quotes, orders, leads, appointments  
- Live inventory from Google Sheet  
- Admin dashboard + analytics  
- Product recommendations wizard  
- Appointment booking with natural dates  
- Reply-to message context  
- Conversation memory  
- Multi-language detection (reply in English)  

### Not started (possible for other shops)

- WhatsApp channel  
- Website chat widget  
- Full CRM integration  
- Business intelligence / advanced reporting  
- Visual workflow builder  

---

## 13. Maintenance Checklist

### Weekly / as needed

- [ ] Check admin dashboard for awaiting handoffs  
- [ ] Review stale leads in Sales tab  
- [ ] Update inventory if beans go out of stock  

### When business info changes

- [ ] Edit Google Doc (prices, hours, new products)  
- [ ] Run knowledge sync  
- [ ] Test with a sample customer question  

### When behavior should change

- [ ] Edit code (`system-rules.js` or relevant `lib/` file)  
- [ ] Commit + deploy to Render  
- [ ] Test the specific flow in Messenger  

---

## 14. Pitch: Why Other Shops Should Consider This

A Messenger/Instagram AI bot like Beantol's can help any product-based business that gets repeated DMs:

**Retail / F&B / roastery / boutique:**

- Same questions every day (hours, prices, delivery)  
- Staff time saved for high-value conversations  
- Never miss a lead because someone DM'd at 11 PM  

**What you get:**

- Professional 24/7 first response  
- Consistent pricing and policy answers  
- Structured capture of orders and inquiries  
- Human takeover when it matters  
- Team-editable knowledge base (Google Doc)  
- Admin dashboard without building a full app  

**What it takes to build one:**

- Meta Developer app + Page/IG connection  
- OpenAI API account  
- Cloud host (e.g. Render)  
- Google Workspace for docs/sheets (optional but recommended)  
- Custom development for your products, delivery rules, and brand voice  

The Beantol bot is a **reference implementation** — the same architecture adapts to bakeries, flower shops, clinics, salons, or any business with a FAQ-heavy inbox.

---

## 15. Important URLs (Beantol Production)

Replace tokens with your actual values:

| Purpose | URL |
|---------|-----|
| Health check | `https://beantol-bot.onrender.com/` |
| Admin dashboard | `https://beantol-bot.onrender.com/admin?token=ADMIN_SECRET` |
| Sync knowledge | `https://beantol-bot.onrender.com/admin/sync-knowledge?token=ADMIN_SECRET` |
| Knowledge status | `https://beantol-bot.onrender.com/admin/knowledge-status?token=ADMIN_SECRET` |
| Test email | `https://beantol-bot.onrender.com/admin/test-email?token=ADMIN_SECRET` |

---

## 16. Security Reminders

- Never commit `.env` or share API tokens publicly  
- Keep `ADMIN_SECRET` private — it protects all admin endpoints  
- Rotate Meta Page token and OpenAI key if ever exposed  
- Google service account should have **Viewer** on Doc, **Editor** on Sheets only as needed  

---

*Document generated from the Beantol Messenger Bot codebase. For technical setup, see README.md and knowledge/README.md in the project repository.*

**Beantol Coffee Roasters** · Cebu City · beantol-bot.onrender.com
