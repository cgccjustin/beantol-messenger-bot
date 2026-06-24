# Multi-tenant setup

One deployment can serve **multiple Facebook/Instagram shops**. Each tenant gets its own Page token, Google Doc, Google Sheet, and isolated chat sessions.

## Modes

### Legacy mode (default — Beantol today)

If you **do not** set `config/tenants.json` or `TENANTS_JSON`, the bot builds **one implicit tenant** from your existing Render env vars (`PAGE_ACCESS_TOKEN`, `GOOGLE_KNOWLEDGE_DOC_IDS`, etc.).

**Nothing breaks.** Beantol keeps working exactly as before.

### Multi-tenant mode

Add tenants via:

1. **`config/tenants.json`** (local — gitignored; copy from `config/tenants.example.json`), or  
2. **`TENANTS_JSON`** on Render (full JSON string)

Each tenant needs:

| Field | Purpose |
|-------|---------|
| `id` | Short slug (`beantol`, `cafe-xyz`) |
| `meta.pageId` | Facebook Page numeric ID (webhook routing) |
| `meta.pageAccessToken` | Page token for sending messages |
| `google.knowledgeDocIds` | Same format as `GOOGLE_KNOWLEDGE_DOC_IDS` |
| `google.leadsSheetId` | CRM Google Sheet |
| `notify.handoffEmail` | Alert inbox |

## One Meta webhook for all tenants

All Pages point to the **same** webhook URL and `VERIFY_TOKEN`. The bot routes each message by `entry.id` (Page ID) to the correct tenant.

Steps per new shop:

1. Add tenant block to `tenants.json` / `TENANTS_JSON`  
2. Create Google Doc + Sheet; share with service account  
3. Subscribe that Page to your existing Meta app webhook  
4. Redeploy (or restart) → sync knowledge  

## Admin URLs

| URL | Action |
|-----|--------|
| `/admin/tenants?token=…` | List configured tenants |
| `/admin/sync-knowledge?token=…` | Sync **all** tenants' Google Docs |
| `/admin/sync-knowledge?tenant=cafe-xyz&token=…` | Sync one tenant |
| `/admin/knowledge-status?token=…` | Index status for all tenants |

Handoff resolve with multiple tenants: add `?tenant=beantol` when needed.

## Knowledge file layout

| Mode | Sources | Index |
|------|---------|-------|
| Legacy tenant | `knowledge/sources/` | `knowledge/index.json` |
| Named tenants | `knowledge/tenants/{id}/sources/` | `knowledge/tenants/{id}/index.json` |

## What's shared vs per-tenant

| Per tenant | Shared (one deployment) |
|------------|-------------------------|
| Page token, Doc, Sheet | `VERIFY_TOKEN`, webhook URL |
| RAG index, chat sessions | OpenAI API key, service account |
| Handoffs, wizards | Shared code flows |
| AI behavior rules | Per tenant: `rules.profile` + `knowledge/tenant-rules/` (Beantol uses `system-rules.js`) |
| Email notify addresses | Resend / SMTP config |

## Plug-and-play checklist for a new café client

See **`docs/KAPE-KRISTIANO-SETUP.md`** or **`docs/OFFBEAT-BREW-SETUP.md`** for full step-by-step (Beantol stays live on Render until you set `TENANTS_JSON`).

1. Copy `config/tenants.example.json` → add new tenant (set `enabled: true` only when ready)  
2. Write their FAQ/prices in a new Google Doc  
3. Create a Google Sheet (Leads, Orders, etc.)  
4. Get their Page ID + generate Page access token in Meta  
5. Deploy with updated `TENANTS_JSON`  
6. `GET /admin/sync-knowledge?token=…`  
7. Test from a personal Facebook account  

Customize per shop: `rules.profile` (`beantol` | `cafe` | `custom`), `tenants/{id}.md` overrides, `features.*`, branding. See `knowledge/tenant-rules/README.md`.

## Rollback

Your stable single-tenant bookmark: git tag **`last-working-bot`**.

To revert multi-tenant work: `git reset --hard last-working-bot` and redeploy.
