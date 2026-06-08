# Kape Kristiano setup guide

Add **Kape Kristiano** as a second shop on the same Render bot **without breaking Beantol**.

---

## Important: do NOT deploy to Render yet

| Phase | Render state | Beantol customers |
|-------|--------------|-------------------|
| **Now (Phase 1–3)** | Legacy mode — no `TENANTS_JSON` | ✅ Keep working as today |
| **Phase 4 only** | Set `TENANTS_JSON` + redeploy | Must test Beantol immediately after |

Until you set `TENANTS_JSON` on Render, production stays on legacy env vars. You can commit repo changes safely.

**Rollback bookmark:** git tag `last-working-bot` (currently at stable multi-tenant + handoff fixes).

---

## What was added in the repo

| Item | Purpose |
|------|---------|
| `config/tenants.example.json` | Template with **beantol** + **kape-kristiano** (`enabled: false`) |
| `knowledge/templates/kape-kristiano-knowledge-base.md` | Paste into their Google Doc |
| `lib/tenant-messages.js` | Per-tenant shop address, handoff/resume text, notify email |
| `scripts/validate-tenants.js` | Check config before deploy |
| Per-tenant pickup address in post-quote flow | Uses `shop.address` / `shop.hours` from tenant config |

**Still shared (Beantol catalog in code):** formal quotes, product recommender, `lib/catalog.js`. Kape Kristiano has `quotes: false` and `recommendations: false` in the template until per-tenant catalogs exist.

---

## Phase 1 — Copy config locally (you, ~15 min)

### Step 1.1 — Create local tenants file

```powershell
cd c:\Users\Catalyst\Desktop\beantol-messenger-bot
copy config\tenants.example.json config\tenants.json
```

`config/tenants.json` is **gitignored** — secrets stay off GitHub.

### Step 1.2 — Fill Beantol block from current Render env

Open Render → your service → **Environment**. Copy into the `beantol` tenant:

| Render env var | tenants.json field |
|----------------|-------------------|
| `PAGE_ID` | `beantol.meta.pageId` |
| `PAGE_ACCESS_TOKEN` | `beantol.meta.pageAccessToken` |
| `INSTAGRAM_ACCOUNT_ID` | `beantol.meta.instagramAccountId` |
| `GOOGLE_KNOWLEDGE_DOC_IDS` | `beantol.google.knowledgeDocIds` |
| `GOOGLE_LEADS_SHEET_ID` | `beantol.google.leadsSheetId` |
| `HANDOFF_NOTIFY_EMAIL` | `beantol.notify.handoffEmail` |
| `SHOP_ADDRESS` (if set) | `beantol.shop.address` |
| `SHOP_HOURS` (if set) | `beantol.shop.hours` |

Leave `beantol.enabled: true`.

### Step 1.3 — Leave Kape Kristiano disabled for now

```json
"enabled": false
```

Validate structure:

```powershell
npm run validate-tenants
```

---

## Phase 2 — Kape Kristiano assets (you + KK, ~1–2 hours)

### Step 2.1 — Google Doc (knowledge)

1. Create a new Google Doc for Kape Kristiano.
2. Copy content from `knowledge/templates/kape-kristiano-knowledge-base.md`.
3. Fill in their menu, prices, hours, address, delivery policy.
4. Share the Doc with your **Google service account** email (Editor).
5. Copy Doc ID from URL: `.../document/d/DOC_ID/edit`.

### Step 2.2 — Google Sheet (CRM)

1. Duplicate your Beantol Sheet structure (Leads, Orders, Quotes, Inventory, Events tabs) **or** create fresh.
2. Share with service account (Editor).
3. Copy Sheet ID from URL.

### Step 2.3 — Meta (Facebook Page)

1. Meta Developer → your app → add **Kape Kristiano’s Facebook Page** (if not already).
2. Generate a **Page access token** for their Page.
3. Get **Page numeric ID** (Page → About → Page ID).
4. Subscribe their Page to your **existing** webhook:
   - URL: `https://beantol-bot.onrender.com/webhook`
   - Same `VERIFY_TOKEN`
   - Fields: `messages`, `messaging_postbacks`, `message_echoes`

### Step 2.4 — Fill kape-kristiano block in tenants.json

| Field | Value |
|-------|--------|
| `meta.pageId` | KK Page ID |
| `meta.pageAccessToken` | KK Page token |
| `google.knowledgeDocIds` | `DOC_ID:kape-kristiano-knowledge` |
| `google.leadsSheetId` | KK Sheet ID |
| `shop.address` | Their pickup address |
| `shop.hours` | Their hours |
| `notify.*` | Alert email(s) |

Keep `"enabled": false` until Phase 4.

---

## Phase 3 — Test locally (optional but recommended)

### Step 3.1 — Run with tenants.json

```powershell
npm start
```

Logs should show:

```text
Tenants: loaded 2 tenant(s) (multi-tenant config)
  - beantol: Beantol Coffee Roasters
  - kape-kristiano: Kape Kristiano
```

### Step 3.2 — Sync knowledge

With server running locally (or after deploy):

```text
http://localhost:3000/admin/sync-knowledge?tenant=kape-kristiano&token=YOUR_ADMIN_SECRET
```

### Step 3.3 — Webhook tunnel (optional)

Use ngrok/cloudflare tunnel to test KK Page DMs against local server. **Do not** change Render webhook URL until Phase 4 unless you pause production testing.

---

## Phase 4 — Go live on Render (only when ready)

### Step 4.1 — Pre-flight checklist

- [ ] `beantol` block has **real** values (copied from current Render env)
- [ ] `kape-kristiano` block filled; set `"enabled": true`
- [ ] KK Google Doc + Sheet shared with service account
- [ ] KK Page subscribed to webhook
- [ ] `npm run validate-tenants` passes with no errors

### Step 4.2 — Minify JSON for Render

PowerShell:

```powershell
(Get-Content config\tenants.json -Raw | ConvertFrom-Json | ConvertTo-Json -Compress -Depth 20) | Set-Clipboard
```

Paste into Render → **Environment** → new variable:

```text
TENANTS_JSON={"tenants":[...]}
```

**Do not remove** shared vars: `VERIFY_TOKEN`, `OPENAI_API_KEY`, `ADMIN_SECRET`, `RESEND_API_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `PUBLIC_BASE_URL`.

Old `PAGE_ACCESS_TOKEN` / `GOOGLE_*` can stay as backup; they are ignored once `TENANTS_JSON` is set.

### Step 4.3 — Deploy

Manual deploy on Render. Watch logs for both tenants loaded.

### Step 4.4 — Sync + smoke test

1. `GET /admin/tenants?token=…` — both tenants listed  
2. `GET /admin/sync-knowledge?token=…` — sync all  
3. DM **Beantol** Page — must still work (regression)  
4. DM **Kape Kristiano** Page — bot replies with their info  
5. Check KK lead row lands in **their** Sheet  

### Step 4.5 — If something breaks

1. Remove `TENANTS_JSON` from Render → redeploy → back to legacy Beantol-only mode, **or**  
2. Redeploy git tag `last-working-bot`

---

## Phase 5 — After both shops work

When satisfied, optionally update `last-working-bot` to the new stable commit.

---

## Admin URLs (multi-tenant)

| Action | URL |
|--------|-----|
| List tenants | `/admin/tenants?token=…` |
| Sync all | `/admin/sync-knowledge?token=…` |
| Sync KK only | `/admin/sync-knowledge?tenant=kape-kristiano&token=…` |
| Resume AI (KK chat) | `/admin/handoffs/PSID/resolve?tenant=kape-kristiano&sendResume=1&token=…` |

Handoffs table in admin now shows a **Tenant** column and resume links include `?tenant=`.

---

## Quick reference — Kape Kristiano feature flags (template)

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

Turn features on later when KK needs them and when per-tenant catalog support exists for quotes/recommendations.
