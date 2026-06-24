# OFFBEAT BREW — Google Sheet structure

Use **one new Google Spreadsheet** for Offbeat Brew CRM (do not share Beantol’s or Kape Kristiano’s sheet).

The bot **auto-creates tab headers** on first use. You can start with an empty spreadsheet — just create the file and share it with the service account.

## Quick setup (recommended)

1. Go to [Google Sheets](https://sheets.google.com) → **Blank spreadsheet**.
2. Name it: `OFFBEAT BREW — Bot CRM`.
3. **Share** → add your Google **service account** email (from `GOOGLE_SERVICE_ACCOUNT_JSON`, field `client_email`) as **Editor**.
4. Copy the Sheet ID from the URL:  
   `https://docs.google.com/spreadsheets/d/SHEET_ID_HERE/edit`
5. Paste that ID into `tenants.json` → `offbeat-brew.google.leadsSheetId`.

## Tabs the bot uses

| Tab name | Purpose | Auto-seeded? |
|----------|---------|--------------|
| **Leads** | Customer inquiries, interest, team follow-up | Yes — headers on first lead |
| **Orders** | Order records from chat | Yes |
| **Quotes** | Formal quotes (OFF for Offbeat by default) | Yes if feature enabled |
| **Appointments** | Booking requests (OFF by default) | Yes if feature enabled |
| **Inventory** | Stock flags (optional for café) | Yes — seeds this tenant's menu products (Offbeat drinks for offbeat-brew) |
| **Events** | Analytics / event log | Yes if events logging enabled |
| **Closures** | Holiday / special closure dates | Yes when used |
| **ChatHistory** | Optional persistent chat backup | Yes if enabled |

You do **not** need to create tabs manually — the bot adds them when needed.

## Leads tab columns (reference)

Created, Updated, Platform, Sender ID, Name, Phone, Interest, Bot stage, Last message, Trigger, Team status, Assigned to, Notes, Next action

## Orders tab columns (reference)

Order ID, Created, Updated, Platform, Sender ID, Name, Phone, Bean, Size, Fulfillment, Address, Payment status, … (bot fills on capture)

## Duplicate from Beantol (optional)

If you prefer a pre-built sheet:

1. Open Beantol’s Google Sheet → **File → Make a copy**.
2. Rename copy to `OFFBEAT BREW — Bot CRM`.
3. Clear data rows (keep tab names if present).
4. Share copy with service account (Editor).
5. Use the **new** Sheet ID in tenant config.

## Admin after go-live

- Leads: `/admin/leads?token=…` (filter by tenant in multi-tenant admin)
- Orders: `/admin/orders?token=…`
- Inventory: `/admin/inventory/view?token=…&tenant=offbeat-brew`
- Wrong Beantol rows on Inventory tab? Run once: `/admin/inventory/reseed?token=…&tenant=offbeat-brew`
