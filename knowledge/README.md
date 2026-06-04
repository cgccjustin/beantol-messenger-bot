# Beantol bot knowledge base

Business facts for RAG (pricing, FAQ, products, team). **Behavior rules** (handoff, delivery steps, formatting) stay in `system-rules.js`.

## Edit content

### Option A — Google Docs (recommended for team)

1. Create Google Doc(s) with your Beantol info (use headings like `## Pricing`, `## FAQ`).
2. [Google Cloud Console](https://console.cloud.google.com/) → create project → enable **Google Drive API**.
3. Create a **service account** → download JSON key.
4. **Share each Doc** with the service account email (`client_email` in JSON) as **Viewer**.
5. Copy the Doc ID from the URL: `https://docs.google.com/document/d/DOC_ID/edit`
6. On Render, set:
   - `GOOGLE_SERVICE_ACCOUNT_JSON` = entire JSON file as one line
   - `GOOGLE_KNOWLEDGE_DOC_IDS` = `DOC_ID:beantol-knowledge` (comma-separated for multiple docs)
7. Sync: open `/admin/sync-knowledge?token=ADMIN_SECRET` or run `npm run sync-knowledge` locally.

Synced text is saved to `knowledge/sources/*.txt` and re-indexed.

### Option B — Files in this repo

Edit `knowledge/sources/*.md` directly, then:

```bash
npm run index-knowledge
git add knowledge/
git push
```

## How the bot uses this

1. Each customer message → search knowledge index for relevant chunks (RAG).
2. Chunks + behavior rules + inventory + support hours → OpenAI reply.

If `index.json` is missing, the bot still works using full source files as fallback until you run `index-knowledge`.

## Commands

| Command | Purpose |
|---------|---------|
| `npm run index-knowledge` | Rebuild embeddings from `knowledge/sources/` |
| `npm run sync-google-docs` | Pull Google Docs → `knowledge/sources/` |
| `npm run sync-knowledge` | Sync Google Docs + re-index |

## Admin URLs (production)

- `GET /admin/knowledge-status?token=...` — index status
- `GET /admin/sync-knowledge?token=...` — Google sync + re-index
- `GET /admin/reindex-knowledge?token=...` — re-index local sources only
