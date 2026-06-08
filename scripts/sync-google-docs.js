#!/usr/bin/env node
require("dotenv").config();
const { loadTenantRegistry, listTenants } = require("../lib/tenant-registry");
const { syncAllGoogleDocs, syncGoogleDocs } = require("../lib/google-docs-sync");

async function main() {
  loadTenantRegistry();
  const tenantId = process.argv[2];
  const tenant = tenantId ? listTenants().find((t) => t.id === tenantId) : null;
  if (tenantId && !tenant) {
    console.error(`Unknown tenant: ${tenantId}`);
    process.exit(1);
  }
  const result = tenant ? await syncGoogleDocs(tenant) : await syncAllGoogleDocs();
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
