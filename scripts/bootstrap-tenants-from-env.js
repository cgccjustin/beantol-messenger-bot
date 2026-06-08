#!/usr/bin/env node
/**
 * Phase 1 helper: create config/tenants.json from tenants.example.json + .env
 * Does not print secret values — only a filled/missing checklist.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const examplePath = path.join(root, "config", "tenants.example.json");
const outPath = path.join(root, "config", "tenants.json");

function env(key) {
  return (process.env[key] || "").trim();
}

function mask(value) {
  const v = String(value || "").trim();
  if (!v) return "(empty)";
  if (v.length <= 8) return "****";
  return `${v.slice(0, 4)}…${v.slice(-4)} (${v.length} chars)`;
}

function main() {
  if (!fs.existsSync(examplePath)) {
    console.error("Missing config/tenants.example.json");
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(examplePath, "utf8"));
  const beantol = config.tenants.find((t) => t.id === "beantol");
  if (!beantol) {
    console.error("No beantol tenant in example config.");
    process.exit(1);
  }

  const email = env("HANDOFF_NOTIFY_EMAIL") || env("LEAD_NOTIFY_EMAIL") || env("ORDER_NOTIFY_EMAIL");

  beantol.meta.pageId = env("PAGE_ID") || beantol.meta.pageId;
  beantol.meta.pageAccessToken = env("PAGE_ACCESS_TOKEN") || beantol.meta.pageAccessToken;
  beantol.meta.instagramAccountId = env("INSTAGRAM_ACCOUNT_ID") || beantol.meta.instagramAccountId;
  beantol.meta.instagramUsername = env("INSTAGRAM_USERNAME") || beantol.meta.instagramUsername;

  beantol.google.knowledgeDocIds = env("GOOGLE_KNOWLEDGE_DOC_IDS") || beantol.google.knowledgeDocIds;
  beantol.google.leadsSheetId = env("GOOGLE_LEADS_SHEET_ID") || beantol.google.leadsSheetId;
  beantol.google.leadsSheetTab = env("GOOGLE_LEADS_SHEET_TAB") || beantol.google.leadsSheetTab;
  beantol.google.ordersSheetTab = env("GOOGLE_ORDERS_SHEET_TAB") || beantol.google.ordersSheetTab;
  beantol.google.quotesSheetTab = env("GOOGLE_QUOTES_SHEET_TAB") || beantol.google.quotesSheetTab;
  beantol.google.appointmentsSheetTab =
    env("GOOGLE_APPOINTMENTS_SHEET_TAB") || beantol.google.appointmentsSheetTab;
  beantol.google.inventorySheetTab =
    env("GOOGLE_INVENTORY_SHEET_TAB") || beantol.google.inventorySheetTab;
  beantol.google.eventsSheetTab = env("GOOGLE_EVENTS_SHEET_TAB") || beantol.google.eventsSheetTab;

  if (email) {
    beantol.notify.handoffEmail = email;
    beantol.notify.leadEmail = env("LEAD_NOTIFY_EMAIL") || email;
    beantol.notify.orderEmail = env("ORDER_NOTIFY_EMAIL") || env("LEAD_NOTIFY_EMAIL") || email;
  }

  if (env("SHOP_ADDRESS")) beantol.shop.address = env("SHOP_ADDRESS");
  if (env("SHOP_HOURS")) beantol.shop.hours = env("SHOP_HOURS");
  if (env("TENANT_NAME")) beantol.branding.businessName = env("TENANT_NAME");

  beantol.enabled = true;

  const kk = config.tenants.find((t) => t.id === "kape-kristiano");
  if (kk) kk.enabled = false;

  fs.writeFileSync(outPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const checks = [
    ["beantol.meta.pageId", beantol.meta.pageId, /^YOUR_/],
    ["beantol.meta.pageAccessToken", beantol.meta.pageAccessToken, /^YOUR_/],
    ["beantol.google.knowledgeDocIds", beantol.google.knowledgeDocIds, /^YOUR_/],
    ["beantol.google.leadsSheetId", beantol.google.leadsSheetId, /^YOUR_/],
    ["beantol.notify.handoffEmail", beantol.notify.handoffEmail, /^your-alerts/],
  ];

  console.log("Created config/tenants.json\n");
  console.log("Beantol fields:");
  for (const [label, value, placeholderPattern] of checks) {
    const ok = value && !placeholderPattern.test(String(value));
    console.log(`  ${ok ? "✓" : "○"} ${label}: ${ok ? mask(value) : "(needs value from Render)"}`);
  }

  const missing = checks.filter(([, value, pattern]) => !value || pattern.test(String(value)));
  console.log("\nkape-kristiano: disabled (unchanged)\n");

  if (missing.length) {
    console.log("Next — add missing values to .env OR edit config/tenants.json directly:");
    console.log("  Render dashboard → Environment → copy into local .env or tenants.json:\n");
    for (const [label] of missing) {
      const envKey =
        label === "beantol.meta.pageId"
          ? "PAGE_ID"
          : label === "beantol.meta.pageAccessToken"
            ? "PAGE_ACCESS_TOKEN"
            : label === "beantol.google.knowledgeDocIds"
              ? "GOOGLE_KNOWLEDGE_DOC_IDS"
              : label === "beantol.google.leadsSheetId"
                ? "GOOGLE_LEADS_SHEET_ID"
                : "HANDOFF_NOTIFY_EMAIL";
      console.log(`    ${envKey}`);
    }
    console.log("\nThen re-run: npm run bootstrap-tenants");
    process.exit(0);
  }

  console.log("All Beantol required fields present. Run: npm run validate-tenants");
}

main();
