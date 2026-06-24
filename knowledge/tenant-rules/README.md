# Per-tenant system rules

AI **behavior** rules (tone, sales style, delivery logic) live here — separate from Google Doc **business facts** (menu, prices, FAQ).

## How it works

| Tenant config | Rules loaded |
|---------------|--------------|
| `rules.profile: "beantol"` | Full `system-rules.js` (roastery sales, Maxim, quotes, inventory) |
| `rules.profile: "cafe"` | `_shared.md` + `profiles/cafe.md` + `tenants/{id}.md` + feature flags |
| `rules.profile: "custom"` | `_shared.md` + `tenants/{id}.md` only |
| (omitted) | `beantol` id → beantol profile; else → `cafe` profile |

## Customize a shop

1. Set in `config/tenants.json`:
   ```json
   "rules": {
     "profile": "cafe",
     "extra": "Optional one-off lines appended to rules."
   }
   ```
2. Edit or create `tenants/{tenant-id}.md` for shop-specific behavior.
3. Redeploy (rules are files in the repo — no Google sync needed).

## Add a new profile (e.g. `bakery`)

Create `profiles/bakery.md` and set `"rules": { "profile": "bakery" }` on the tenant.

## Files

- `_shared.md` — handoff hours, formatting, language (all non-Beantol tenants)
- `profiles/cafe.md` — café / restaurant assistant
- `profiles/beantol.md` — not used (Beantol uses `system-rules.js` directly)
- `tenants/kape-kristiano.md` — Kape Kristiano overrides
- `tenants/offbeat-brew.md` — OFFBEAT BREW overrides
