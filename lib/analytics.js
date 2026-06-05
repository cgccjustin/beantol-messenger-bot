const ARCHIVED_LEAD_STATUSES = new Set(["Won", "Lost"]);
const ARCHIVED_ORDER_STATUSES = new Set(["completed", "cancelled"]);

function parseIsoDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isWithinDays(iso, days) {
  const d = parseIsoDate(iso);
  if (!d) return false;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return d.getTime() >= cutoff;
}

function countByField(items, field, emptyLabel = "(blank)") {
  const counts = {};
  for (const item of items) {
    const key = String(item[field] || "").trim() || emptyLabel;
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

function topN(entries, n = 5) {
  return entries.slice(0, n);
}

function pct(numerator, denominator) {
  if (!denominator) return "0%";
  return `${Math.round((numerator / denominator) * 100)}%`;
}

function computeAnalytics({
  leads = [],
  orders = [],
  quotes = [],
  events = [],
  inventory = [],
  handoffCount = 0,
}) {
  const leads7d = leads.filter((l) => isWithinDays(l.created || l.updated, 7));
  const orders7d = orders.filter((o) => isWithinDays(o.created || o.updated, 7));
  const quotes7d = quotes.filter((q) => isWithinDays(q.created || q.updated, 7));
  const messages7d = events.filter(
    (e) => e.event === "message" && isWithinDays(e.timestamp, 7)
  );
  const messagesToday = events.filter((e) => {
    if (e.event !== "message") return false;
    const d = parseIsoDate(e.timestamp);
    if (!d) return false;
    const now = new Date();
    return (
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    );
  });

  const leadByTeam = countByField(leads, "teamStatus", "New");
  const leadByStage = countByField(leads, "stage");
  const orderByStatus = countByField(orders, "orderStatus", "inquiry");
  const platformMsgs = countByField(messages7d, "platform");

  const won = leads.filter((l) => l.teamStatus === "Won").length;
  const lost = leads.filter((l) => l.teamStatus === "Lost").length;
  const closed = won + lost;

  const paidOrders = orders.filter((o) => o.paymentStatus === "paid").length;
  const quoteValue7d = quotes7d.reduce((sum, q) => sum + (Number(q.subtotal) || 0), 0);

  const lowStock = inventory.filter(
    (i) => i.status === "low" || i.status === "out_of_stock"
  );
  const outOfStock = inventory.filter((i) => i.status === "out_of_stock");

  const topInterests = topN(
    countByField(
      leads.filter((l) => l.interest),
      "interest"
    ),
    8
  );

  const recentMessages = events
    .filter((e) => e.event === "message")
    .slice(0, 10);

  return {
    summary: {
      messagesToday: messagesToday.length,
      messages7d: messages7d.length,
      leads7d: leads7d.length,
      orders7d: orders7d.length,
      quotes7d: quotes7d.length,
      activeLeads: leads.filter((l) => !ARCHIVED_LEAD_STATUSES.has(l.teamStatus || "New")).length,
      activeOrders: orders.filter(
        (o) => !ARCHIVED_ORDER_STATUSES.has(String(o.orderStatus).toLowerCase())
      ).length,
      handoffCount,
      lowStockCount: lowStock.length,
      outOfStockCount: outOfStock.length,
      winRate: pct(won, closed),
      paidOrders,
      quoteValue7d,
    },
    leadByTeam,
    leadByStage,
    orderByStatus,
    platformMsgs,
    topInterests,
    lowStock,
    recentMessages,
    totals: {
      leads: leads.length,
      orders: orders.length,
      quotes: quotes.length,
      events: events.length,
    },
  };
}

function renderAnalyticsHtml(stats) {
  const { escapeHtml } = require("./admin-ui");
  const { formatPeso } = require("./pricing");

  const s = stats.summary;
  const summaryCards = Object.entries({
    "Messages today": s.messagesToday,
    "Messages (7d)": s.messages7d,
    "New leads (7d)": s.leads7d,
    "Orders (7d)": s.orders7d,
    "Quotes (7d)": s.quotes7d,
    "Active leads": s.activeLeads,
    "Active orders": s.activeOrders,
    "Win rate": s.winRate,
    "Paid orders": s.paidOrders,
    "Quoted (7d)": formatPeso(s.quoteValue7d),
  })
    .map(
      ([label, value]) =>
        `<div class="card"><span class="muted">${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`
    )
    .join("");

  const tableFromPairs = (title, pairs) => {
    if (!pairs.length) return `<h3>${escapeHtml(title)}</h3><p class="muted">No data yet.</p>`;
    const rows = pairs
      .map(
        ([name, count]) =>
          `<tr><td>${escapeHtml(name)}</td><td>${escapeHtml(String(count))}</td></tr>`
      )
      .join("");
    return `<h3>${escapeHtml(title)}</h3><table><tr><th>Item</th><th>Count</th></tr>${rows}</table>`;
  };

  let lowStockHtml = "";
  if (stats.lowStock.length) {
    const rows = stats.lowStock
      .map(
        (i) =>
          `<tr class="${i.status === "out_of_stock" ? "status-out" : "status-low"}"><td>${escapeHtml(i.name)}</td><td>${escapeHtml(i.status)}</td><td>${escapeHtml(String(i.qty ?? "—"))}</td></tr>`
      )
      .join("");
    lowStockHtml = `<h3>Stock alerts</h3><table><tr><th>Product</th><th>Status</th><th>Qty</th></tr>${rows}</table>`;
  }

  let recentHtml = "";
  if (stats.recentMessages.length) {
    const rows = stats.recentMessages
      .map(
        (e) =>
          `<tr><td>${escapeHtml((e.timestamp || "").slice(0, 16))}</td><td>${escapeHtml(e.platform)}</td><td>${escapeHtml(e.detail || "—")}</td></tr>`
      )
      .join("");
    recentHtml = `<h3>Recent customer messages</h3><table><tr><th>Time</th><th>Channel</th><th>Message</th></tr>${rows}</table>`;
  }

  return `<p class="muted">Stats from Google Sheet (Leads, Orders, Quotes, Events, Inventory). Message counts need the <strong>Events</strong> tab (auto-created).</p>
<div class="cards">${summaryCards}</div>
<div class="grid-2">
${tableFromPairs("Leads by team status", stats.leadByTeam)}
${tableFromPairs("Leads by bot stage", stats.leadByStage)}
</div>
<div class="grid-2">
${tableFromPairs("Orders by status", stats.orderByStatus)}
${tableFromPairs("Messages by channel (7d)", stats.platformMsgs)}
</div>
${tableFromPairs("Top customer interests", stats.topInterests)}
${lowStockHtml}
${recentHtml}
<p class="muted">Totals in sheet: ${stats.totals.leads} leads · ${stats.totals.orders} orders · ${stats.totals.quotes} quotes · ${stats.totals.events} logged events</p>`;
}

module.exports = {
  ARCHIVED_LEAD_STATUSES,
  ARCHIVED_ORDER_STATUSES,
  computeAnalytics,
  renderAnalyticsHtml,
};
