const TEAM_STATUSES = ["New", "Contacted", "Follow-up", "Won", "Lost"];

const ORDER_STATUSES = [
  "inquiry",
  "pending",
  "awaiting_payment",
  "confirmed",
  "dispatched",
  "completed",
  "cancelled",
];

const PAYMENT_STATUSES = ["unpaid", "paid"];

const ARCHIVED_LEAD_STATUSES = ["Won", "Lost"];
const ARCHIVED_ORDER_STATUSES = ["completed", "cancelled"];

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function adminStyles() {
  return `
body{font-family:system-ui,sans-serif;max-width:1100px;margin:24px auto;padding:0 16px;line-height:1.4}
nav.ops{margin:16px 0;padding:12px;background:#f8f9fa;border-radius:8px;display:flex;flex-wrap:wrap;gap:6px}
nav.ops a{padding:7px 12px;border-radius:6px;text-decoration:none;color:#2d6a4f;border:1px solid #2d6a4f;font-size:13px}
nav.ops a.active{background:#2d6a4f;color:#fff}
nav.ops a.tools-tab{color:#555;border-color:#999;font-size:12px}
nav.ops a.tools-tab.active{background:#555;color:#fff;border-color:#555}
.bookmark-hint{padding:10px 14px;background:#e3f2fd;border:1px solid #90caf9;border-radius:6px;margin:0 0 16px;font-size:13px;word-break:break-all}
.tool-card{padding:14px;background:#f8f9fa;border:1px solid #ddd;border-radius:8px}
.tool-card h3{margin:0 0 6px;font-size:15px}
.tool-card p{margin:0 0 10px;font-size:13px;color:#666}
.cards{display:flex;flex-wrap:wrap;gap:12px;margin:16px 0}
.card{flex:1;min-width:140px;padding:14px;background:#f0f7f4;border-radius:8px;border:1px solid #c8e6d4}
.card strong{display:block;font-size:1.4rem;color:#2d6a4f}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{border:1px solid #ddd;padding:8px;text-align:left;vertical-align:top}
th{background:#f5f5f5}
a.button,.btn{display:inline-block;padding:8px 14px;background:#2d6a4f;color:#fff;text-decoration:none;border-radius:6px;border:none;font-size:14px;cursor:pointer}
.btn-sm{padding:4px 10px;font-size:12px}
.muted{color:#666;font-size:14px}
.flash{padding:10px 14px;background:#e8f5e9;border:1px solid #a5d6a7;border-radius:6px;margin:12px 0}
.filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:12px 0}
.filters select,.filters input{padding:6px 10px;border:1px solid #ccc;border-radius:4px}
.inline-form{display:flex;flex-wrap:wrap;gap:6px;align-items:flex-start}
.inline-form select,.inline-form input,.inline-form textarea{font-size:13px;padding:4px 6px;border:1px solid #ccc;border-radius:4px}
.inline-form textarea{width:140px;min-height:48px}
details.row-edit summary{cursor:pointer;color:#2d6a4f;font-size:13px}
.status-out{background:#ffebee}
.status-low{background:#fff8e1}
.alert-warn{padding:10px 14px;background:#fff8e1;border:1px solid #ffe082;border-radius:6px;margin:12px 0}
.grid-2{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin:16px 0}
.qty-input{width:64px}
`;
}

function adminUrl(path, token) {
  const t = encodeURIComponent(token || "");
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}token=${t}`;
}

function tenantQuery(tenantId) {
  const id = String(tenantId || "").trim();
  return id ? `&tenant=${encodeURIComponent(id)}` : "";
}

function renderNav(active, token, tenantId = "") {
  const t = encodeURIComponent(token || "");
  const q = tenantQuery(tenantId);
  const mainTabs = [
    { id: "overview", label: "Overview", href: `/admin?token=${t}${q}` },
    { id: "handoffs", label: "Handoffs", href: `/admin/handoffs/view?token=${t}${q}` },
    { id: "webhooks", label: "Webhook log", href: `/admin/webhook-log?token=${t}${q}` },
    { id: "instagram", label: "Instagram", href: `/admin/instagram-setup/view?token=${t}${q}` },
    { id: "analytics", label: "Analytics", href: `/admin/analytics/view?token=${t}${q}` },
    { id: "sales", label: "Sales", href: `/admin/sales/view?token=${t}${q}` },
    { id: "leads", label: "Leads", href: `/admin/leads/view?token=${t}${q}` },
    { id: "appointments", label: "Appointments", href: `/admin/appointments/view?token=${t}${q}` },
    { id: "orders", label: "Orders", href: `/admin/orders/view?token=${t}${q}` },
    { id: "quotes", label: "Quotes", href: `/admin/quotes/view?token=${t}${q}` },
    { id: "inventory", label: "Inventory", href: `/admin/inventory/view?token=${t}${q}` },
    { id: "closures", label: "Closures", href: `/admin/closures/view?token=${t}${q}` },
    { id: "tools", label: "Tools", href: `/admin/tools/view?token=${t}${q}`, tools: true },
  ];
  const links = mainTabs
    .map((tab) => {
      const cls = [
        active === tab.id ? "active" : "",
        tab.tools ? "tools-tab" : "",
      ]
        .filter(Boolean)
        .join(" ");
      return `<a href="${tab.href}" class="${cls}">${tab.label}</a>`;
    })
    .join("");
  return `<nav class="ops">${links}</nav>`;
}

function renderBookmarkHint(token, req) {
  const base = req
    ? `${req.protocol}://${req.get("host")}`
    : "";
  const path = adminUrl("/admin", token);
  const full = base ? `${base}${path}` : path;
  return `<div class="bookmark-hint"><strong>Bookmark this admin hub:</strong> <a href="${escapeHtml(path)}">${escapeHtml(full)}</a></div>`;
}

function renderToolCard(title, description, href, external = false) {
  const ext = external ? ' target="_blank" rel="noopener"' : "";
  return `<div class="tool-card"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p><a class="button btn-sm" href="${href}"${ext}>Open</a></div>`;
}

function renderTenantSwitcher(token, activeTenantId, tenants) {
  const list = (tenants || []).filter((t) => t?.enabled !== false && t?.google?.leadsSheetId);
  if (list.length <= 1) return "";
  const base = `/admin/inventory/view?token=${encodeURIComponent(token || "")}`;
  const options = list
    .map(
      (t) =>
        `<option value="${escapeHtml(t.id)}"${t.id === activeTenantId ? " selected" : ""}>${escapeHtml(t.name || t.id)}</option>`
    )
    .join("");
  return `<form class="filters" style="margin-bottom:12px"><label><strong>Shop CRM:</strong> <select onchange="location.href='${base}&tenant='+encodeURIComponent(this.value)">${options}</select></label></form>`;
}

function renderPage({ title, active, token, body, flash = "", bookmark = false, req = null, tenantId = "" }) {
  const resolvedTenant =
    String(tenantId || "").trim() ||
    (req?.query?.tenant ? String(req.query.tenant).trim() : "");
  const flashHtml = flash ? `<div class="flash">${escapeHtml(flash)}</div>` : "";
  const bookmarkHtml = bookmark ? renderBookmarkHint(token, req) : "";
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — Beantol admin</title>
<style>${adminStyles()}</style></head><body>
<h1>${escapeHtml(title)}</h1>
${bookmarkHtml}
${renderNav(active, token, resolvedTenant)}
${flashHtml}
${body}
<p style="margin-top:24px"><a class="button" href="#" onclick="location.reload();return false;">Refresh</a></p>
</body></html>`;
}

function optionTags(values, selected) {
  return values
    .map(
      (v) =>
        `<option value="${escapeHtml(v)}"${String(selected) === String(v) ? " selected" : ""}>${escapeHtml(v)}</option>`
    )
    .join("");
}

function statCards(stats) {
  const items = Object.entries(stats)
    .map(
      ([label, value]) =>
        `<div class="card"><span class="muted">${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`
    )
    .join("");
  return `<div class="cards">${items}</div>`;
}

function archiveCheckbox(name, checked, label = "Show archived") {
  return `<label><input type="checkbox" name="${name}" value="1"${checked ? " checked" : ""}> ${label}</label>`;
}

module.exports = {
  TEAM_STATUSES,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  ARCHIVED_LEAD_STATUSES,
  ARCHIVED_ORDER_STATUSES,
  escapeHtml,
  adminUrl,
  renderPage,
  renderNav,
  renderTenantSwitcher,
  tenantQuery,
  renderToolCard,
  optionTags,
  statCards,
  archiveCheckbox,
};
