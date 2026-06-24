# OFFBEAT BREW setup guide

Add **OFFBEAT BREW** as a third tenant on the same Render bot (alongside Beantol and Kape Kristiano).

**Tenant id:** `offbeat-brew`  
**AI rules profile:** `cafe` (menu-based café assistant — not roastery/wholesale)

---

## Before you start — gather these

| Item | Where to get it |
|------|-----------------|
| Facebook Page **numeric ID** | Page → About → Page ID |
| Page **access token** | Meta Developer → your app → Page token |
| Menu, prices, hours, address | Your shop info (fill knowledge template) |
| Alert email | Where handoff/lead emails go |
| Instagram ID (optional) | Meta Business Suite |

---

## Phase 1 — Google Doc (knowledge base)

### Step 1.1 — Create the Doc

1. [Google Docs](https://docs.google.com) → **Blank document**.
2. Title: `OFFBEAT BREW — Knowledge Base`.
3. Open repo file **`knowledge/templates/offbeat-brew-knowledge-base.md`**.
4. Copy all content → paste into the Doc.
5. Replace every `[FILL IN]` / bracket section with real menu, prices, hours, address, payment, delivery rules.

### Step 1.2 — Share with service account

1. Doc → **Share**.
2. Add the service account email from Render env `GOOGLE_SERVICE_ACCOUNT_JSON` → field **`client_email`** (looks like `something@project.iam.gserviceaccount.com`).
3. Role: **Editor**.
4. Copy **Doc ID** from URL:  
   `https://docs.google.com/document/d/DOC_ID/edit`

You will use: `DOC_ID:offbeat-brew-knowledge` in tenant config.

---

## Phase 2 — Google Sheet (CRM)

Follow **`knowledge/templates/offbeat-brew-google-sheet-tabs.md`**.

**Short version:**

1. New blank Google Sheet → name `OFFBEAT BREW — Bot CRM`.
2. Share with same service account (**Editor**).
3. Copy **Sheet ID** from URL.

Tabs are created automatically by the bot on first lead/order.

---

## Phase 3 — Meta (Facebook Page)

1. Meta Developer → your existing Beantol app.
2. Add **OFFBEAT BREW’s Facebook Page** to the app (if not already).
3. Generate a **Page access token** with `pages_messaging` permission.
4. Subscribe the Page to your **existing** webhook:
   - URL: `https://beantol-bot.onrender.com/webhook`
   - Same `VERIFY_TOKEN` as Beantol
   - Fields: `messages`, `messaging_postbacks`, `message_echoes` (and Instagram fields if IG DMs needed)

Or after deploy:  
`/admin/subscribe-webhooks?token=YOUR_ADMIN_SECRET`  
(with Page token set for Offbeat in tenant config)

---

## Phase 4 — Add tenant to config

### Step 4.1 — Edit local `config/tenants.json`

Copy the **offbeat-brew** block from `config/tenants.example.json` into your real `config/tenants.json` (or add fields to existing file).

Fill in:

| Field | Example |
|-------|---------|
| `id` | `offbeat-brew` |
| `name` | `OFFBEAT BREW` |
| `enabled` | `false` until Phase 6 |
| `meta.pageId` | Offbeat Facebook Page ID |
| `meta.pageAccessToken` | Offbeat Page token |
| `google.knowledgeDocIds` | `YOUR_DOC_ID:offbeat-brew-knowledge` |
| `google.leadsSheetId` | Offbeat Sheet ID |
| `shop.address` | Full pickup address |
| `shop.hours` | Shop hours string |
| `notify.handoffEmail` | Alert inbox |
| `rules.profile` | `cafe` |

Default features (café mode — same as Kape Kristiano):

```json
"features": {
  "appointments": false,
  "quotes": false,
  "recommendations": false,
  "cebuDeliveryZones": false,
  "leadCapture": true,
  "orderCapture": true
}
```

Turn features on later when needed.

### Step 4.2 — Validate

```powershell
cd c:\Users\Catalyst\Desktop\beantol-messenger-bot
npm run validate-tenants
```

---

## Phase 5 — Test locally (optional)

```powershell
npm start
```

Logs should list three tenants (Offbeat disabled until enabled).

Sync Offbeat knowledge only:

```text
http://localhost:3000/admin/sync-knowledge?tenant=offbeat-brew&token=YOUR_ADMIN_SECRET
```

Check index:

```text
http://localhost:3000/admin/knowledge-status?token=YOUR_ADMIN_SECRET
```

---

## Phase 6 — Go live on Render

### Step 6.1 — Pre-flight

- [ ] Offbeat Google Doc filled + shared with service account
- [ ] Offbeat Google Sheet shared with service account
- [ ] `offbeat-brew` block filled in `config/tenants.json`
- [ ] Set `"enabled": true` for `offbeat-brew`
- [ ] Beantol + Kape Kristiano blocks still correct and `enabled: true`
- [ ] `npm run validate-tenants` passes

### Step 6.2 — Update `TENANTS_JSON` on Render

Minify JSON (PowerShell):

```powershell
(Get-Content config\tenants.json -Raw | ConvertFrom-Json | ConvertTo-Json -Compress -Depth 20) | Set-Clipboard
```

Render → Environment → edit **`TENANTS_JSON`** → paste → Save.

Keep shared vars: `VERIFY_TOKEN`, `OPENAI_API_KEY`, `ADMIN_SECRET`, `RESEND_API_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `PUBLIC_BASE_URL`.

### Step 6.3 — Deploy

Manual deploy on Render. Logs should show:

```text
Tenants: loaded 3 tenant(s)
  - beantol: ...
  - kape-kristiano: ...
  - offbeat-brew: OFFBEAT BREW
```

### Step 6.4 — Sync knowledge

```text
GET /admin/sync-knowledge?token=YOUR_ADMIN_SECRET
```

Or Offbeat only:

```text
GET /admin/sync-knowledge?tenant=offbeat-brew&token=YOUR_ADMIN_SECRET
```

### Step 6.5 — Smoke test

| Test | Expected |
|------|----------|
| `/admin/tenants?token=…` | 3 tenants, offbeat-brew listed |
| DM **Beantol** Page | Still works (regression) |
| DM **Kape Kristiano** Page | Still works |
| DM **OFFBEAT BREW** Page | Replies with Offbeat menu/info from Google Doc |
| Ask Offbeat for a menu item price | Matches your Doc |
| New lead from Offbeat chat | Row in **Offbeat** Sheet (not Beantol’s) |

### Step 6.6 — Handoff / resume (multi-tenant)

Resume AI for an Offbeat customer:

```text
/admin/handoffs/SENDER_PSID/resolve?tenant=offbeat-brew&sendResume=1&token=…
```

---

## Admin URLs for Offbeat

| Action | URL |
|--------|-----|
| List tenants | `/admin/tenants?token=…` |
| Sync Offbeat Doc only | `/admin/sync-knowledge?tenant=offbeat-brew&token=…` |
| Inventory (if used) | `/admin/inventory/view?token=…&tenant=offbeat-brew` |
| Knowledge status | `/admin/knowledge-status?token=…` |

---

## Customize AI behavior (repo files)

| File | Purpose |
|------|---------|
| `knowledge/tenant-rules/tenants/offbeat-brew.md` | Extra bot rules (delivery, tone, don’t-say list) |
| `knowledge/templates/offbeat-brew-knowledge-base.md` | Source to paste into Google Doc |
| `config/tenants.json` → `rules.extra` | One-off rules without editing markdown |

After editing tenant-rules files: **commit + deploy** (not Google sync).

---

## Rollback

If something breaks after adding Offbeat:

1. Set `"enabled": false` for `offbeat-brew` in `TENANTS_JSON` → redeploy, **or**
2. Restore previous `TENANTS_JSON` from Render history, **or**
3. Local: `git reset --hard last-working-bot` and redeploy (drops all commits after bookmark).

Current stable bookmark: git tag **`last-working-bot`**.

---

## What’s shared vs Offbeat-only

| Offbeat-only | Shared across all tenants |
|--------------|---------------------------|
| Page token, Doc, Sheet | Webhook URL, VERIFY_TOKEN |
| RAG index path `knowledge/tenants/offbeat-brew/` | OpenAI key, service account |
| Chat sessions scoped by tenant | Admin secret, email provider |
| `shop.address`, `shop.hours`, notify emails | Codebase |

---

## Need help filling the knowledge Doc?

Send your menu (with prices), address, hours, delivery/payment rules, and FAQ — then update the Google Doc from the template. The bot only knows what’s in that Doc + tenant rules files.
