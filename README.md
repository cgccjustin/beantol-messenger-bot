# Beantol Messenger AI Bot

AI customer support for the Beantol Facebook Page on Messenger, with human handoff and email alerts.

## Quick checklist

- [ ] `npm install`
- [ ] `.env` filled in (see below)
- [ ] Gmail App Password in `SMTP_PASS`
- [ ] Server running (local or Render)
- [ ] Meta webhook pointing at your server `/webhook`
- [ ] Test message + test “talk to a human”

---

## 1. Install dependencies

```bash
npm install
```

## 2. Configure `.env`

Copy `.env.example` to `.env` if needed. Required for the bot:

| Variable | Purpose |
|----------|---------|
| `VERIFY_TOKEN` | Same secret you enter in Meta webhook settings |
| `PAGE_ACCESS_TOKEN` | Beantol Page token from Meta Developer → Messenger |
| `OPENAI_API_KEY` | From [OpenAI API keys](https://platform.openai.com/api-keys) |

For **human handoff** and **delivery alerts** (email):

| Variable | Purpose |
|----------|---------|
| `ADMIN_SECRET` | Protects `/admin/*` endpoints |
| `HANDOFF_NOTIFY_EMAIL` | Who receives alerts (e.g. cgccjustin@gmail.com) |
| `RESEND_API_KEY` | **Use on Render** — from [resend.com](https://resend.com) API Keys (`re_...`) |
| `EMAIL_FROM` | `onboarding@resend.dev` on free tier (no custom domain) |

Optional: `HANDOFF_TIMEOUT_HOURS`, `DELIVERY_ALERT_COOLDOWN_MINUTES`, `OPENAI_MODEL`, `PORT`.

### Email on Render (recommended: Resend)

Render often **blocks Gmail SMTP** (`Connection timeout`). Use **Resend** instead (HTTPS, works on Render):

1. Sign up at [resend.com](https://resend.com) with **cgccjustin@gmail.com** (or your alert inbox).
2. **API Keys** → Create → copy key (`re_...`).
3. On Render **Environment** add:
   - `RESEND_API_KEY` = your key
   - `EMAIL_FROM` = `onboarding@resend.dev`
   - `HANDOFF_NOTIFY_EMAIL` = your Gmail (must match Resend signup email on free tier)
4. Redeploy → Logs should show `Email via Resend`.
5. Test: `GET /admin/test-email?token=YOUR_ADMIN_SECRET`

### Gmail SMTP (local dev only)

`SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, etc. work on your PC; on Render they usually timeout.

---

## 3. Run locally

```bash
npm start
```

Open `http://localhost:3000` — you should see “Beantol Messenger bot is running.”

For Meta to reach your laptop, use a tunnel (e.g. [ngrok](https://ngrok.com)):

```bash
ngrok http 3000
```

Use the HTTPS URL + `/webhook` in Meta (see step 4).

---

## 4. Meta webhook (Facebook)

1. [Meta for Developers](https://developers.facebook.com/) → your app → **Messenger** → **Settings**.
2. **Webhooks** → **Add Callback URL**:
   - **Callback URL**: `https://YOUR-SERVER/webhook` (Render URL or ngrok)
   - **Verify Token**: same as `VERIFY_TOKEN` in `.env`
3. Subscribe to your **Page** and enable **messages** and **message_echoes** (echoes let the bot pause when an admin replies from Business Suite).
4. Under **Access Tokens**, generate a token for the Beantol Page → `PAGE_ACCESS_TOKEN`.

### Instagram DMs (optional)

Uses the **same** Render URL, `VERIFY_TOKEN`, and `PAGE_ACCESS_TOKEN` as Messenger.

1. **Link Instagram to your Facebook Page**
   - Instagram app → Professional account (Business or Creator)
   - Meta Business Suite → Settings → Linked accounts → connect Instagram to the Beantol Page

2. **Meta Developer app permissions** (in addition to Messenger):
   - `instagram_manage_messages` (required)
   - `pages_messaging` (Page token — you likely have this already)

3. **App Review** — if the app is **Live**, `instagram_manage_messages` must be **approved** for production IG DMs (not just added in the dashboard).

4. **Subscribe the webhook to Instagram**
   - [Meta for Developers](https://developers.facebook.com/) → your app → **Messenger** → **Instagram settings** (or **Webhooks**)
   - Same callback URL: `https://YOUR-SERVER/webhook`
   - Same verify token as `VERIFY_TOKEN`
   - Under **Webhook fields**, subscribe your **Instagram account** (not only the Page):
     - `messages`
     - `messaging_postbacks` (optional)
     - `message_echoes` (optional — admin reply detection, may be less reliable on IG)

5. **Deploy latest `server.js`** — the bot accepts Meta webhooks with `object: "page"` (Messenger) and `object: "instagram"` (Instagram DMs).

6. **Test** — DM the Beantol Instagram account from another IG account. Check Render logs for `instagram/messaging`.

**Reply to customers:** Meta Business Suite → **Instagram** inbox (or unified inbox). **Resume AI** links work the same; admin dashboard shows **Instagram** vs **Messenger** per paused chat.

---

## 5. Deploy on Render (recommended)

1. Push this project to GitHub (do **not** commit `.env`).
2. [render.com](https://render.com) → **New** → **Web Service** → connect the repo.
3. Settings:
   - **Build command**: `npm install`
   - **Start command**: `npm start`
   - **Health check path**: `/`
4. **Environment** → add every variable from your `.env` (same names and values).
5. Deploy → copy your service URL, e.g. `https://beantol-bot.onrender.com`.
6. Set Meta webhook to `https://beantol-bot.onrender.com/webhook`.

Render sets `PORT` automatically; you do not need to set it.

---

## 6. How human handoff works

1. Customer asks for a person (e.g. “talk to a human”, “real person”, “may tao ba?”).
2. Bot sends one handoff message, then **stops auto-replying** for that user.
3. Email goes to `HANDOFF_NOTIFY_EMAIL` with sender ID and their message.
4. You reply manually in **Meta Business Suite** or the Messenger app.
5. When done, **turn the bot back on** for that chat (see below).

**Turn the bot back on (recommended):** open the admin dashboard in your browser (bookmark it):

```text
https://YOUR-RENDER-URL.onrender.com/admin?token=YOUR_ADMIN_SECRET
```

Tap **Resume AI** for that customer — clears handoff and sends the “assistant is back” message to them.

Set `PUBLIC_BASE_URL=https://YOUR-RENDER-URL.onrender.com` on Render so handoff emails include the same one-click link.

**`#bot` in Business Suite** often does **not** reach the server (Meta does not send it to the webhook), so `count` stays at 1. Use the dashboard or email link instead — not `#bot`.

Optional: send `#bot` in chat only if Render logs show `Page outbound … resume=true` after deploy.

**Admin takes over without customer asking for a human:** when someone on your team replies from Business Suite, the bot detects that Page message (if **message_echoes** is subscribed) and **pauses auto-replies** for that customer — so the bot and admin do not “fight” on later messages.

**Delivery questions:** the bot explains Maxim delivery, that the **delivery fee is paid by the customer**, and asks for complete address, contact name, and phone number. It **does not hand off** — it keeps replying in chat and emails you a **delivery alert** (bot still active). The bot pauses only when **you** reply from Business Suite.

If you still see a **“Call” / “Message”** button under replies, that is often from **Meta Page settings** (automated responses / action button), not from this bot — the bot sends plain text only.

Handoff state is stored in memory — a server **restart** clears pauses. After restart, the bot may auto-reply until the customer asks for a human again.

---

## 7. Admin: list / clear handoffs

**Recommended:** send `#bot` from Business Suite in that conversation (see section 6).

**Alternative (browser / curl):** replace `YOUR_SERVER` and `YOUR_ADMIN_SECRET` with your values.

**Test email (SMTP / delivery alerts):**

```http
GET https://YOUR_SERVER/admin/test-email?token=YOUR_ADMIN_SECRET
```

If this fails, fix `SMTP_*` on Render. Check spam folder if it returns `ok: true`.

**List conversations waiting for a human:**

```http
GET https://YOUR_SERVER/admin/handoffs?token=YOUR_ADMIN_SECRET
```

**Mark handled (bot can auto-reply again):**

```http
POST https://YOUR_SERVER/admin/handoffs/SENDER_ID/resolve?token=YOUR_ADMIN_SECRET
```

`SENDER_ID` is in the email alert or the list response. You can also use curl:

```bash
curl "https://YOUR_SERVER/admin/handoffs?token=YOUR_ADMIN_SECRET"
curl -X POST "https://YOUR_SERVER/admin/handoffs/123456789/resolve?token=YOUR_ADMIN_SECRET"
```

---

## 8. Update Q&A (no new App Review)

**Production (recommended):** Edit your **Google Doc**, save, then either wait for the next Render restart (auto-sync on startup) or run:

`GET https://beantol-bot.onrender.com/admin/sync-knowledge?token=ADMIN_SECRET`

No GitHub deploy needed for Doc-only changes.

**Local / repo backup:** Template in `knowledge/templates/beantol-knowledge-base.md`. Dev-only `.md` files go in `knowledge/sources/` (not indexed when Google sync is configured).

```bash
npm run sync-knowledge   # Google Docs + re-index
npm run index-knowledge  # local sources only
```

Behavior rules (handoff, delivery steps, formatting) stay in **`system-rules.js`**.

See **`knowledge/README.md`** for Google Docs setup.

Push to GitHub only when **code** changes. Text-only Doc updates do **not** need Meta App Review again.

---

## 9. Test

1. Message your Facebook Page from a personal account.
2. Ask something simple (“What are your hours?”) — bot should reply in English.
3. Say “Can I talk to a real person?” — handoff message, no further bot replies, email to cgccjustin@gmail.com.
4. Reply as the Page from Business Suite.
5. Call resolve endpoint with that user’s sender ID when finished.

---

## Security

- Never commit `.env` or share tokens.
- Rotate `PAGE_ACCESS_TOKEN` and `OPENAI_API_KEY` if they were ever exposed.
- Keep `ADMIN_SECRET` private.
