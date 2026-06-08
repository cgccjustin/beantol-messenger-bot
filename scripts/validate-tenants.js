#!/usr/bin/env node
/**
 * Validate config/tenants.json structure before deploying TENANTS_JSON to Render.
 * Usage: npm run validate-tenants
 */
const fs = require("fs");
const path = require("path");

const configPath = path.join(__dirname, "..", "config", "tenants.json");
const examplePath = path.join(__dirname, "..", "config", "tenants.example.json");

function loadConfig() {
  if (fs.existsSync(configPath)) {
    return { source: "config/tenants.json", data: JSON.parse(fs.readFileSync(configPath, "utf8")) };
  }
  if (fs.existsSync(examplePath)) {
    console.warn("config/tenants.json not found — validating tenants.example.json only.\n");
    return { source: "config/tenants.example.json", data: JSON.parse(fs.readFileSync(examplePath, "utf8")) };
  }
  throw new Error("No tenants.json or tenants.example.json found.");
}

function isPlaceholder(value) {
  const v = String(value || "").trim();
  return !v || /^YOUR_/i.test(v) || v === "your-alerts@example.com";
}

function validateTenant(t, errors, warnings, strict) {
  if (!t.id) errors.push("Tenant missing id");
  if (!t.name) warnings.push(`Tenant ${t.id || "?"}: missing name`);
  if (t.enabled !== false && t.enabled !== true) warnings.push(`Tenant ${t.id}: enabled should be true or false`);

  if (t.enabled && strict) {
    if (isPlaceholder(t.meta?.pageAccessToken)) {
      errors.push(`Tenant ${t.id}: enabled but meta.pageAccessToken is missing or placeholder`);
    }
    if (isPlaceholder(t.google?.knowledgeDocIds)) {
      warnings.push(`Tenant ${t.id}: enabled but google.knowledgeDocIds looks like a placeholder`);
    }
    if (isPlaceholder(t.google?.leadsSheetId)) {
      warnings.push(`Tenant ${t.id}: enabled but google.leadsSheetId looks like a placeholder`);
    }
  }
}

function main() {
  const { source, data } = loadConfig();
  const tenants = data?.tenants;
  const errors = [];
  const warnings = [];

  if (!Array.isArray(tenants) || !tenants.length) {
    console.error("FAIL: tenants array is missing or empty.");
    process.exit(1);
  }

  const ids = new Set();
  const strict = source.includes("tenants.json");
  for (const t of tenants) {
    if (ids.has(t.id)) errors.push(`Duplicate tenant id: ${t.id}`);
    ids.add(t.id);
    validateTenant(t, errors, warnings, strict);
  }

  const enabled = tenants.filter((t) => t.enabled !== false);
  const beantol = tenants.find((t) => t.id === "beantol");
  const kk = tenants.find((t) => t.id === "kape-kristiano");

  console.log(`Validated: ${source}`);
  console.log(`Tenants: ${tenants.length} total, ${enabled.length} enabled\n`);

  for (const t of tenants) {
    console.log(`  • ${t.id} — ${t.name} — ${t.enabled === false ? "DISABLED" : "ENABLED"}`);
  }

  if (warnings.length) {
    console.log("\nWarnings:");
    warnings.forEach((w) => console.log(`  ⚠ ${w}`));
  }

  if (errors.length) {
    console.log("\nErrors:");
    errors.forEach((e) => console.log(`  ✗ ${e}`));
    process.exit(1);
  }

  if (!beantol) warnings.push("No beantol tenant — migration from legacy mode needs beantol block with current Render env values.");
  if (kk && kk.enabled === false) {
    console.log("\n✓ kape-kristiano is disabled — safe to commit repo changes; Render legacy mode unchanged until deploy.");
  }

  console.log("\nOK — structure looks valid.");
  if (source.includes("example")) {
    console.log("Next: copy config/tenants.example.json → config/tenants.json and fill real values.");
  }
}

main();
