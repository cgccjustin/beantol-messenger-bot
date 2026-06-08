const fs = require("fs");
const path = require("path");
const { SYSTEM_RULES } = require("../system-rules");
const { getActiveTenant } = require("./tenant-context");
const { businessName } = require("./tenant-messages");
const {
  isCebuDeliveryZonesEnabled,
  isRecommendationsEnabled,
  isTenantFeatureEnabled,
} = require("./tenant-features");

const RULES_ROOT = path.join(__dirname, "..", "knowledge", "tenant-rules");

/** @type {Map<string, string>} */
const fileCache = new Map();

function readRulesFile(relativePath) {
  const key = relativePath.replace(/\\/g, "/");
  if (fileCache.has(key)) return fileCache.get(key);

  const fullPath = path.join(RULES_ROOT, relativePath);
  if (!fs.existsSync(fullPath)) {
    fileCache.set(key, "");
    return "";
  }
  const text = fs.readFileSync(fullPath, "utf8").trim();
  fileCache.set(key, text);
  return text;
}

function substituteTokens(text, tenant) {
  const name = businessName(tenant);
  return String(text || "")
    .replace(/\{\{BUSINESS_NAME\}\}/g, name)
    .replace(/\{\{TENANT_ID\}\}/g, tenant?.id || "");
}

function buildFeatureRulesNote(tenant) {
  const lines = [];
  if (!isCebuDeliveryZonesEnabled(tenant)) {
    lines.push(
      "FEATURE: Cebu/Maxim delivery zone scripts are OFF for this shop — delivery answers come only from KNOWLEDGE CONTEXT."
    );
  }
  if (!isRecommendationsEnabled(tenant)) {
    lines.push(
      "FEATURE: Bean recommender wizard is OFF — suggest menu items from KNOWLEDGE CONTEXT only."
    );
  }
  if (!isTenantFeatureEnabled("quotes", tenant)) {
    lines.push("FEATURE: Formal printable quote links are OFF for this shop.");
  }
  if (!isTenantFeatureEnabled("appointments", tenant)) {
    lines.push("FEATURE: Appointment booking wizard is OFF — answer reservation questions from KNOWLEDGE CONTEXT only.");
  }
  return lines.length ? `FEATURE FLAGS:\n${lines.join("\n")}` : "";
}

function resolveProfile(tenant) {
  const explicit = tenant?.rules?.profile?.trim();
  if (explicit) return explicit.toLowerCase();
  if (tenant?.id === "beantol") return "beantol";
  return "cafe";
}

/**
 * System rules for OpenAI — per tenant profile + optional overrides.
 * Beantol uses full system-rules.js (unchanged). Other tenants use shared + profile + tenant file.
 */
function getSystemRulesForTenant(tenant) {
  const t = tenant || getActiveTenant();
  const profile = resolveProfile(t);

  if (profile === "beantol") {
    return SYSTEM_RULES;
  }

  const parts = [];

  const shared = readRulesFile("_shared.md");
  if (shared) parts.push(substituteTokens(shared, t));

  if (profile === "custom") {
    const custom = readRulesFile(`tenants/${t.id}.md`);
    if (custom) {
      parts.push(substituteTokens(custom, t));
    }
  } else {
    const profileRules = readRulesFile(`profiles/${profile}.md`);
    if (profileRules) {
      parts.push(substituteTokens(profileRules, t));
    } else {
      parts.push(
        substituteTokens(
          `You are ${businessName(t)}'s assistant. Follow KNOWLEDGE CONTEXT for all business facts.`,
          t
        )
      );
    }
    const tenantOverrides = readRulesFile(`tenants/${t.id}.md`);
    if (tenantOverrides) {
      parts.push(substituteTokens(tenantOverrides, t));
    }
  }

  const extra = t?.rules?.extra?.trim();
  if (extra) parts.push(substituteTokens(extra, t));

  const featureNote = buildFeatureRulesNote(t);
  if (featureNote) parts.push(featureNote);

  return parts.filter(Boolean).join("\n\n");
}

function listAvailableProfiles() {
  const dir = path.join(RULES_ROOT, "profiles");
  if (!fs.existsSync(dir)) return ["beantol", "cafe"];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
}

function clearRulesCache() {
  fileCache.clear();
}

module.exports = {
  getSystemRulesForTenant,
  listAvailableProfiles,
  clearRulesCache,
  resolveProfile,
};
