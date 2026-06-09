const { getActiveTenant } = require("./tenant-context");

function activeTenant(tenant) {
  return tenant || getActiveTenant();
}

function getKnowledgeDocIds(tenant) {
  const t = activeTenant(tenant);
  return t?.google?.knowledgeDocIds?.trim() || process.env.GOOGLE_KNOWLEDGE_DOC_IDS?.trim() || "";
}

function getLeadsSheetId(tenant) {
  const t = activeTenant(tenant);
  return t?.google?.leadsSheetId?.trim() || process.env.GOOGLE_LEADS_SHEET_ID?.trim() || "";
}

function getLeadsSheetTab(tenant) {
  const t = activeTenant(tenant);
  return t?.google?.leadsSheetTab?.trim() || process.env.GOOGLE_LEADS_SHEET_TAB?.trim() || "Leads";
}

function getOrdersSheetTab(tenant) {
  const t = activeTenant(tenant);
  return t?.google?.ordersSheetTab?.trim() || process.env.GOOGLE_ORDERS_SHEET_TAB?.trim() || "Orders";
}

function getQuotesSheetTab(tenant) {
  const t = activeTenant(tenant);
  return t?.google?.quotesSheetTab?.trim() || process.env.GOOGLE_QUOTES_SHEET_TAB?.trim() || "Quotes";
}

function getAppointmentsSheetTab(tenant) {
  const t = activeTenant(tenant);
  return (
    t?.google?.appointmentsSheetTab?.trim() ||
    process.env.GOOGLE_APPOINTMENTS_SHEET_TAB?.trim() ||
    "Appointments"
  );
}

function getInventorySheetTab(tenant) {
  const t = activeTenant(tenant);
  return (
    t?.google?.inventorySheetTab?.trim() ||
    process.env.GOOGLE_INVENTORY_SHEET_TAB?.trim() ||
    "Inventory"
  );
}

function getEventsSheetTab(tenant) {
  const t = activeTenant(tenant);
  return t?.google?.eventsSheetTab?.trim() || process.env.GOOGLE_EVENTS_SHEET_TAB?.trim() || "Events";
}

function getClosuresSheetTab(tenant) {
  const t = activeTenant(tenant);
  return (
    t?.google?.closuresSheetTab?.trim() ||
    process.env.GOOGLE_CLOSURES_SHEET_TAB?.trim() ||
    "Closures"
  );
}

function getChatHistorySheetTab(tenant) {
  const t = activeTenant(tenant);
  return (
    t?.google?.chatHistorySheetTab?.trim() ||
    process.env.GOOGLE_CHAT_HISTORY_SHEET_TAB?.trim() ||
    "ChatHistory"
  );
}

function isLeadCaptureEnabledForTenant(tenant) {
  const t = activeTenant(tenant);
  if (t?.features?.leadCapture === false) return false;
  if (process.env.LEAD_CAPTURE_ENABLED === "false") return false;
  return Boolean(getLeadsSheetId(t));
}

function isOrderCaptureEnabledForTenant(tenant) {
  const t = activeTenant(tenant);
  if (t?.features?.orderCapture === false) return false;
  if (process.env.ORDER_CAPTURE_ENABLED === "false") return false;
  return Boolean(getLeadsSheetId(t));
}

function isQuoteCaptureEnabledForTenant(tenant) {
  const t = activeTenant(tenant);
  if (t?.features?.quotes === false) return false;
  if (process.env.QUOTE_CAPTURE_ENABLED === "false") return false;
  return Boolean(getLeadsSheetId(t));
}

function isAppointmentCaptureEnabledForTenant(tenant) {
  const t = activeTenant(tenant);
  if (t?.features?.appointments === false) return false;
  if (process.env.APPOINTMENT_CAPTURE_ENABLED === "false") return false;
  return Boolean(getLeadsSheetId(t));
}

module.exports = {
  getKnowledgeDocIds,
  getLeadsSheetId,
  getLeadsSheetTab,
  getOrdersSheetTab,
  getQuotesSheetTab,
  getAppointmentsSheetTab,
  getInventorySheetTab,
  getEventsSheetTab,
  getClosuresSheetTab,
  getChatHistorySheetTab,
  isLeadCaptureEnabledForTenant,
  isOrderCaptureEnabledForTenant,
  isQuoteCaptureEnabledForTenant,
  isAppointmentCaptureEnabledForTenant,
};
