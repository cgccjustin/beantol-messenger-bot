# Beantol bot knowledge base

Business facts for RAG (pricing, FAQ, products). **Behavior rules** (handoff, delivery steps, formatting) stay in `system-rules.js`.

## Folders

| Folder | Purpose |
|--------|---------|
| `sources/` | **Indexed content** — synced `*.txt` from Google Docs (created on Render at runtime). Local dev: optional `*.md` files. |
| `templates/` | **Not indexed** — backup copy for pasting into Google Docs (`beantol-knowledge-base.md`). |

When Google Docs sync is configured, the bot indexes **only** `sources/*.txt` (not repo `.md` files), so you do not get duplicate knowledge.

## Edit content

### Option A — Google Docs (recommended for team)

1. Edit your Beantol Google Doc (template backup in `templates/beantol-knowledge-base.md`).
2. Ensure Render has `GOOGLE_SERVICE_ACCOUNT_JSON` and `GOOGLE_KNOWLEDGE_DOC_IDS`.
3. After edits: save the Doc, then either:
   - **Wait for next Render restart** — Google sync runs automatically on startup, or
   - **Manual sync:** `GET /admin/sync-knowledge?token=ADMIN_SECRET`

Setup (one time): [Google Cloud Console](https://console.cloud.google.com/) → Drive API → service account → share Doc with service account email as **Viewer**. Doc ID from URL: `https://docs.google.com/document/d/DOC_ID/edit`

### Option B — Files in this repo (local dev without Google)

Add `*.md` files under `knowledge/sources/`, then:

```bash
npm run index-knowledge
```

## How the bot uses this

1. Each customer message → search knowledge index for relevant chunks (RAG).
2. Chunks + behavior rules + inventory + support hours → OpenAI reply.

On startup with Google configured: sync Docs → re-index automatically (unless `RAG_SYNC_ON_STARTUP=false`).

## Commands

| Command | Purpose |
|---------|---------|
| `npm run index-knowledge` | Rebuild embeddings from `knowledge/sources/` |
| `npm run sync-google-docs` | Pull Google Docs → `knowledge/sources/` |
| `npm run sync-knowledge` | Sync Google Docs + re-index |

## Admin URLs (production)

- `GET /admin/knowledge-status?token=...` — index status, `syncOnStartup` flag
- `GET /admin/sync-knowledge?token=...` — Google sync + re-index
- `GET /admin/reindex-knowledge?token=...` — re-index local sources only
