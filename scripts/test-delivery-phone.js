process.env.TENANTS_JSON = require("fs").readFileSync("config/tenants.json", "utf8");
const { getTenantById, loadTenantRegistry } = require("../lib/tenant-registry");
const { setActiveTenant } = require("../lib/tenant-context");
const flow = require("../lib/cafe-order-flow");

loadTenantRegistry();
const tenant = getTenantById("offbeat-brew");
const senderId = "test-delivery-phone";

flow.clearCafeOrderSession(senderId);

flow.tryStartCafeOrderFlow(senderId, "2 offbeat white delivery", tenant, { recentUserTexts: [] });
flow.processCafeOrderFlowPreAi(senderId, "2", tenant, { recentUserTexts: ["2 offbeat white delivery"] });
flow.processCafeOrderFlowPreAi(senderId, "delivery", tenant, {
  recentUserTexts: ["2 offbeat white delivery", "2"],
});

const msg = "Mahayahay\nJustin\n09176555007";
const lastAssistantReply =
  "Delivery via Maxim or Grab (Iligan area). Please send in one message:\n\n1) Complete delivery address\n2) Contact name\n3) Mobile number";

flow.clearCafeOrderSession(senderId);
const resumed = flow.tryResumeCafeOrderFlow(senderId, msg, tenant, {
  lastAssistantReply,
  recentUserTexts: ["2 offbeat white", "2", "delivery"],
});
console.log("resumed", resumed);
if (resumed.resumed) {
  const r = flow.processCafeOrderFlowPreAi(senderId, msg, tenant, {
    recentUserTexts: ["2 offbeat white", "2", "delivery"],
  });
  console.log(r.reply);
  console.log("phone:", /09176555007/.test(r.reply || ""));
}
