const FOLLOWUP_DAYS = Number(process.env.SALES_FOLLOWUP_DAYS || 3);
const PIPELINE_STAGES = new Set(["quoted", "ordering", "wholesale", "browsing"]);

function daysSince(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 999;
  return (Date.now() - d.getTime()) / (24 * 60 * 60 * 1000);
}

function isStaleLead(lead) {
  if (!lead) return false;
  if (["Won", "Lost"].includes(lead.teamStatus)) return false;
  if (!PIPELINE_STAGES.has(lead.stage)) return false;
  const ref = lead.updated || lead.created;
  return daysSince(ref) >= FOLLOWUP_DAYS;
}

function listPipelineLeads(leads = []) {
  const active = leads.filter(
    (l) => !["Won", "Lost"].includes(l.teamStatus || "New") && PIPELINE_STAGES.has(l.stage)
  );
  const stale = active.filter(isStaleLead);
  const hot = active.filter((l) => !isStaleLead(l));
  return { active, stale, hot };
}

function buildSalesContextNote(lead) {
  if (!lead) return "";

  const parts = [
    `SALES PIPELINE: Known lead stage="${lead.stage}" team="${lead.teamStatus || "New"}" interest="${lead.interest || "—"}".`,
  ];

  if (isStaleLead(lead)) {
    parts.push(
      `This customer was quoted or showed buying intent ${Math.floor(daysSince(lead.updated || lead.created))} days ago without closing. ` +
        "Gently follow up — ask if they still want the bean/size discussed, offer pickup or delivery, do NOT pressure. One soft close question."
    );
  } else if (lead.stage === "quoted") {
    parts.push(
      "They recently asked about price — help them choose size and next step (pickup/delivery) when natural."
    );
  } else if (lead.stage === "ordering") {
    parts.push("Active order intent — summarize bean/size and guide payment or delivery details.");
  } else if (lead.stage === "wholesale") {
    parts.push("Wholesale/café inquiry — mention 6kg MOQ and cupping with Zeke (09084094733) if relevant.");
  }

  return parts.join(" ");
}

function formatStaleLeadsEmail(stale) {
  if (!stale.length) return "No stale leads needing follow-up.";
  return stale
    .map(
      (l) =>
        `- ${l.name || "Customer"} (${l.stage}) — ${l.interest || "—"} — last ${(l.updated || l.created || "").slice(0, 10)} — ${l.phone || "no phone"}`
    )
    .join("\n");
}

function renderSalesPipelineHtml({ active, stale, hot }, token = "") {
  const { escapeHtml } = require("./admin-ui");

  const row = (l, css = "") =>
    `<tr class="${css}"><td>${escapeHtml((l.updated || l.created || "").slice(0, 10))}</td><td>${escapeHtml(l.name || "—")}</td><td>${escapeHtml(l.stage || "—")}</td><td>${escapeHtml(l.teamStatus || "New")}</td><td>${escapeHtml(l.interest || "—")}</td><td>${escapeHtml(l.phone || "—")}</td><td>${escapeHtml(l.nextAction || "—")}</td></tr>`;

  const staleRows = stale.map((l) => row(l, "status-low")).join("");
  const hotRows = hot.map((l) => row(l)).join("");

  return `<p class="muted">Leads in quoted / ordering / wholesale. <strong>Stale</strong> = no update in ${FOLLOWUP_DAYS}+ days. Follow up in Messenger or set Next action in Leads tab.</p>
<p><a class="btn btn-sm" href="#" onclick="location.reload();return false;">Refresh</a>
<a class="btn btn-sm" href="/admin/sales/check-stale?token=${encodeURIComponent(token)}">Email stale list</a></p>
<h3>Needs follow-up (${stale.length})</h3>
${staleRows ? `<table><tr><th>Updated</th><th>Name</th><th>Stage</th><th>Team</th><th>Interest</th><th>Phone</th><th>Next action</th></tr>${staleRows}</table>` : "<p class='muted'>No stale leads — nice work.</p>"}
<h3>Active pipeline (${hot.length})</h3>
${hotRows ? `<table><tr><th>Updated</th><th>Name</th><th>Stage</th><th>Team</th><th>Interest</th><th>Phone</th><th>Next action</th></tr>${hotRows}</table>` : "<p class='muted'>No other active pipeline leads.</p>"}
<p class="muted">Total pipeline: ${active.length} leads</p>`;
}

module.exports = {
  FOLLOWUP_DAYS,
  isStaleLead,
  listPipelineLeads,
  buildSalesContextNote,
  formatStaleLeadsEmail,
  renderSalesPipelineHtml,
};
