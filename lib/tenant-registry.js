const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "..", "config", "tenants.json");

/** @type {{ tenants: object[], byId: Map<string, object>, byPageId: Map<string, object>, byInstagramId: Map<string, object>, defaultTenant: object|null, legacyMode: boolean } | null} */
let registry = null;

function readTenantsFile() {
  if (process.env.TENANTS_JSON?.trim()) {
    return JSON.parse(process.env.TENANTS_JSON);
  }
  if (fs.existsSync(CONFIG_PATH)) {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  }
  return null;
}

function buildLegacyTenantFromEnv() {
  const id = process.env.TENANT_ID?.trim() || "beantol";
  return {
    id,
    name: process.env.TENANT_NAME?.trim() || "Beantol Coffee Roasters",
    enabled: true,
    legacy: true,
    meta: {
      pageId: process.env.PAGE_ID?.trim() || "",
      pageAccessToken: process.env.PAGE_ACCESS_TOKEN?.trim() || "",
      instagramAccountId: process.env.INSTAGRAM_ACCOUNT_ID?.trim() || "",
      instagramUsername: process.env.INSTAGRAM_USERNAME?.trim() || "",
    },
    google: {
      knowledgeDocIds: process.env.GOOGLE_KNOWLEDGE_DOC_IDS?.trim() || "",
      leadsSheetId: process.env.GOOGLE_LEADS_SHEET_ID?.trim() || "",
      leadsSheetTab: process.env.GOOGLE_LEADS_SHEET_TAB?.trim() || "Leads",
      ordersSheetTab: process.env.GOOGLE_ORDERS_SHEET_TAB?.trim() || "Orders",
      quotesSheetTab: process.env.GOOGLE_QUOTES_SHEET_TAB?.trim() || "Quotes",
      appointmentsSheetTab: process.env.GOOGLE_APPOINTMENTS_SHEET_TAB?.trim() || "Appointments",
      inventorySheetTab: process.env.GOOGLE_INVENTORY_SHEET_TAB?.trim() || "Inventory",
      eventsSheetTab: process.env.GOOGLE_EVENTS_SHEET_TAB?.trim() || "Events",
      closuresSheetTab: process.env.GOOGLE_CLOSURES_SHEET_TAB?.trim() || "Closures",
      chatHistorySheetTab: process.env.GOOGLE_CHAT_HISTORY_SHEET_TAB?.trim() || "ChatHistory",
    },
    notify: {
      handoffEmail: process.env.HANDOFF_NOTIFY_EMAIL?.trim() || "",
      leadEmail: process.env.LEAD_NOTIFY_EMAIL?.trim() || "",
      orderEmail: process.env.ORDER_NOTIFY_EMAIL?.trim() || "",
    },
    shop: {
      address: process.env.SHOP_ADDRESS?.trim() || "",
      hours: process.env.SHOP_HOURS?.trim() || "",
    },
    branding: {
      businessName: process.env.TENANT_NAME?.trim() || "Beantol Coffee Roasters",
      handoffReply: process.env.HANDOFF_REPLY?.trim() || "",
      botResumeReply: process.env.BOT_RESUME_REPLY?.trim() || "",
      handoffCatchUpApology: process.env.HANDOFF_CATCHUP_APOLOGY?.trim() || "",
    },
    features: {
      appointments: process.env.APPOINTMENT_CAPTURE_ENABLED !== "false",
      quotes: process.env.QUOTE_CAPTURE_ENABLED !== "false",
      recommendations: true,
      cebuDeliveryZones: true,
      leadCapture: process.env.LEAD_CAPTURE_ENABLED !== "false",
      orderCapture: process.env.ORDER_CAPTURE_ENABLED !== "false",
    },
    rules: {
      profile: process.env.TENANT_RULES_PROFILE?.trim() || "beantol",
      extra: process.env.TENANT_RULES_EXTRA?.trim() || "",
    },
  };
}

function normalizeTenant(raw) {
  const id = String(raw.id || "").trim();
  if (!id) throw new Error("Each tenant requires an id.");

  return {
    id,
    name: String(raw.name || id).trim(),
    enabled: raw.enabled !== false,
    legacy: Boolean(raw.legacy),
    meta: {
      pageId: String(raw.meta?.pageId || "").trim(),
      pageAccessToken: String(raw.meta?.pageAccessToken || "").trim(),
      instagramAccountId: String(raw.meta?.instagramAccountId || "").trim(),
      instagramUsername: String(raw.meta?.instagramUsername || "").trim(),
    },
    google: {
      knowledgeDocIds: String(raw.google?.knowledgeDocIds || "").trim(),
      leadsSheetId: String(raw.google?.leadsSheetId || "").trim(),
      leadsSheetTab: String(raw.google?.leadsSheetTab || "Leads").trim(),
      ordersSheetTab: String(raw.google?.ordersSheetTab || "Orders").trim(),
      quotesSheetTab: String(raw.google?.quotesSheetTab || "Quotes").trim(),
      appointmentsSheetTab: String(raw.google?.appointmentsSheetTab || "Appointments").trim(),
      inventorySheetTab: String(raw.google?.inventorySheetTab || "Inventory").trim(),
      eventsSheetTab: String(raw.google?.eventsSheetTab || "Events").trim(),
      closuresSheetTab: String(raw.google?.closuresSheetTab || "Closures").trim(),
      chatHistorySheetTab: String(raw.google?.chatHistorySheetTab || "ChatHistory").trim(),
    },
    notify: {
      handoffEmail: String(raw.notify?.handoffEmail || "").trim(),
      leadEmail: String(raw.notify?.leadEmail || raw.notify?.handoffEmail || "").trim(),
      orderEmail: String(raw.notify?.orderEmail || raw.notify?.leadEmail || "").trim(),
    },
    shop: {
      address: String(raw.shop?.address || "").trim(),
      hours: String(raw.shop?.hours || "").trim(),
      openDays: Array.isArray(raw.shop?.openDays)
        ? raw.shop.openDays.map(Number).filter((n) => n >= 0 && n <= 6)
        : undefined,
      openHour:
        raw.shop?.openHour != null && raw.shop.openHour !== ""
          ? Number(raw.shop.openHour)
          : undefined,
      closeHour:
        raw.shop?.closeHour != null && raw.shop.closeHour !== ""
          ? Number(raw.shop.closeHour)
          : undefined,
    },
    branding: {
      businessName: String(raw.branding?.businessName || raw.name || id).trim(),
      handoffReply: String(raw.branding?.handoffReply || "").trim(),
      botResumeReply: String(raw.branding?.botResumeReply || "").trim(),
      handoffCatchUpApology: String(raw.branding?.handoffCatchUpApology || "").trim(),
      gcashQrUrl: String(raw.branding?.gcashQrUrl || "").trim(),
    },
    features: {
      appointments: raw.features?.appointments !== false,
      quotes: raw.features?.quotes !== false,
      recommendations: raw.features?.recommendations !== false,
      cebuDeliveryZones: raw.features?.cebuDeliveryZones !== false,
      leadCapture: raw.features?.leadCapture !== false,
      orderCapture: raw.features?.orderCapture !== false,
    },
    rules: {
      profile: String(raw.rules?.profile || (id === "beantol" ? "beantol" : "cafe")).trim(),
      extra: String(raw.rules?.extra || "").trim(),
    },
  };
}

function buildRegistry() {
  const fileData = readTenantsFile();
  let tenants = [];
  let legacyMode = false;

  if (fileData?.tenants?.length) {
    tenants = fileData.tenants.map(normalizeTenant).filter((t) => t.enabled);
  } else {
    tenants = [normalizeTenant(buildLegacyTenantFromEnv())];
    legacyMode = true;
  }

  if (!tenants.length) {
    throw new Error("No enabled tenants configured.");
  }

  const byId = new Map();
  const byPageId = new Map();
  const byInstagramId = new Map();

  for (const tenant of tenants) {
    if (byId.has(tenant.id)) {
      throw new Error(`Duplicate tenant id: ${tenant.id}`);
    }
    byId.set(tenant.id, tenant);

    if (tenant.meta.pageId) {
      byPageId.set(tenant.meta.pageId, tenant);
    }
    if (tenant.meta.pageAccessToken && tenant.meta.pageId) {
      // page id may be filled at runtime via debug_token
    }
    if (tenant.meta.instagramAccountId) {
      byInstagramId.set(tenant.meta.instagramAccountId, tenant);
    }
  }

  return {
    tenants,
    byId,
    byPageId,
    byInstagramId,
    defaultTenant: tenants[0],
    legacyMode,
  };
}

function loadTenantRegistry() {
  registry = buildRegistry();
  console.log(
    `Tenants: loaded ${registry.tenants.length} tenant(s)` +
      (registry.legacyMode ? " (legacy env mode)" : " (multi-tenant config)")
  );
  for (const t of registry.tenants) {
    console.log(`  - ${t.id}: ${t.name}`);
  }
  return registry;
}

function getTenantRegistry() {
  if (!registry) loadTenantRegistry();
  return registry;
}

function listTenants() {
  return getTenantRegistry().tenants;
}

function getTenantById(id) {
  if (!id) return getTenantRegistry().defaultTenant;
  return getTenantRegistry().byId.get(String(id)) || null;
}

function getDefaultTenant() {
  return getTenantRegistry().defaultTenant;
}

function resolveTenantForWebhook({ entryId, platform, event }) {
  const reg = getTenantRegistry();
  const entry = entryId ? String(entryId) : "";

  if (entry && reg.byPageId.has(entry)) return reg.byPageId.get(entry);
  if (entry && reg.byInstagramId.has(entry)) return reg.byInstagramId.get(entry);

  const recipient = event?.recipient?.id ? String(event.recipient.id) : "";
  const sender = event?.sender?.id ? String(event.sender.id) : "";

  if (recipient && reg.byPageId.has(recipient)) return reg.byPageId.get(recipient);
  if (recipient && reg.byInstagramId.has(recipient)) return reg.byInstagramId.get(recipient);
  if (sender && reg.byPageId.has(sender)) return reg.byPageId.get(sender);
  if (sender && reg.byInstagramId.has(sender)) return reg.byInstagramId.get(sender);

  if (reg.tenants.length === 1) return reg.tenants[0];
  return reg.defaultTenant;
}

function registerTenantPageId(tenantId, pageId) {
  const reg = getTenantRegistry();
  const tenant = reg.byId.get(tenantId);
  if (!tenant || !pageId) return;
  tenant.meta.pageId = String(pageId);
  reg.byPageId.set(String(pageId), tenant);
}

function getPageAccessToken(tenant) {
  const t = tenant || getDefaultTenant();
  return t?.meta?.pageAccessToken || process.env.PAGE_ACCESS_TOKEN || "";
}

function tenantHasPageToken(tenant) {
  return Boolean(getPageAccessToken(tenant));
}

module.exports = {
  loadTenantRegistry,
  getTenantRegistry,
  listTenants,
  getTenantById,
  getDefaultTenant,
  resolveTenantForWebhook,
  registerTenantPageId,
  getPageAccessToken,
  tenantHasPageToken,
  buildLegacyTenantFromEnv,
};
