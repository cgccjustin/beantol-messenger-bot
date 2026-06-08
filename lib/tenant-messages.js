const { getActiveTenant } = require("./tenant-context");

const DEFAULT_SHOP_ADDRESS =
  "Holy Family Village 2, Governor Cuenco Avenue, Banilad, Cebu City (beside the guardhouse).";
const DEFAULT_SHOP_HOURS =
  "Monday–Friday, 9:00 AM–6:00 PM (shop closed on weekends).";

const DEFAULT_HANDOFF_REPLY =
  "Got it — I am connecting you with our team. A Beantol team member will reply to you personally here in this chat as soon as they can. Please stay on this thread.";

const DEFAULT_BOT_RESUME_REPLY =
  "Our chat assistant is back on — you can ask about coffee, prices, orders, or delivery anytime.";

const DEFAULT_HANDOFF_CATCHUP_APOLOGY =
  "Sorry — it looks like your last message may have been missed while our team was assisting you. Here's my best answer:";

function tenantOrActive(tenant) {
  return tenant || getActiveTenant();
}

function businessName(tenant) {
  const t = tenantOrActive(tenant);
  return t?.branding?.businessName || t?.name || "our team";
}

function getShopAddress(tenant) {
  const t = tenantOrActive(tenant);
  return (
    t?.shop?.address?.trim() ||
    process.env.SHOP_ADDRESS?.trim() ||
    DEFAULT_SHOP_ADDRESS
  );
}

function getShopHours(tenant) {
  const t = tenantOrActive(tenant);
  return (
    t?.shop?.hours?.trim() ||
    process.env.SHOP_HOURS?.trim() ||
    DEFAULT_SHOP_HOURS
  );
}

function getHandoffReply(tenant) {
  const t = tenantOrActive(tenant);
  const custom = t?.branding?.handoffReply?.trim();
  if (custom) return custom;
  if (process.env.HANDOFF_REPLY?.trim()) return process.env.HANDOFF_REPLY.trim();
  const name = businessName(t);
  if (name && name !== "our team" && !DEFAULT_HANDOFF_REPLY.includes(name)) {
    return DEFAULT_HANDOFF_REPLY.replace("A Beantol team member", `A ${name} team member`);
  }
  return DEFAULT_HANDOFF_REPLY;
}

function getBotResumeReply(tenant) {
  const t = tenantOrActive(tenant);
  const custom = t?.branding?.botResumeReply?.trim();
  if (custom) return custom;
  if (process.env.BOT_RESUME_REPLY?.trim()) return process.env.BOT_RESUME_REPLY.trim();
  return DEFAULT_BOT_RESUME_REPLY;
}

function getHandoffCatchUpApology(tenant) {
  const t = tenantOrActive(tenant);
  const custom = t?.branding?.handoffCatchUpApology?.trim();
  if (custom) return custom;
  if (process.env.HANDOFF_CATCHUP_APOLOGY?.trim()) {
    return process.env.HANDOFF_CATCHUP_APOLOGY.trim();
  }
  return DEFAULT_HANDOFF_CATCHUP_APOLOGY;
}

function getNotifyEmail(kind, tenant) {
  const t = tenantOrActive(tenant);
  const fromTenant =
    kind === "order"
      ? t?.notify?.orderEmail
      : kind === "lead"
        ? t?.notify?.leadEmail
        : t?.notify?.handoffEmail;
  if (fromTenant?.trim()) return fromTenant.trim();
  if (kind === "order" && process.env.ORDER_NOTIFY_EMAIL?.trim()) {
    return process.env.ORDER_NOTIFY_EMAIL.trim();
  }
  if (kind === "lead" && process.env.LEAD_NOTIFY_EMAIL?.trim()) {
    return process.env.LEAD_NOTIFY_EMAIL.trim();
  }
  return process.env.HANDOFF_NOTIFY_EMAIL?.trim() || "";
}

module.exports = {
  getShopAddress,
  getShopHours,
  getHandoffReply,
  getBotResumeReply,
  getHandoffCatchUpApology,
  getNotifyEmail,
  businessName,
};
