# Beantol Bot documentation

Shareable project docs for internal review and pitching similar bots to other shops.

| File | Description |
|------|-------------|
| `Beantol-Messenger-Bot-Overview.pdf` | Full feature guide (~15 pages) |
| `Beantol-Messenger-Bot-Overview.md` | Editable source for the overview |
| `Beantol-Bot-Flyer.pdf` | One-page sales flyer |
| `Beantol-Bot-Flyer.html` | Flyer layout source |

## Regenerate PDFs (optional)

Requires `puppeteer` installed (`npm install puppeteer`).

```bash
node docs/generate-pdf.js
node docs/generate-flyer-pdf.js
```

After editing content, update the `.html` or `.md` files first, then run the matching script.
