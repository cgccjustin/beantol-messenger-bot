#!/usr/bin/env node
require("dotenv").config();
const OpenAI = require("openai");
const { loadTenantRegistry, listTenants } = require("../lib/tenant-registry");
const rag = require("../lib/rag");

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY required to build embeddings index.");
    process.exit(1);
  }
  loadTenantRegistry();
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const tenantId = process.argv[2];
  const tenant = tenantId ? listTenants().find((t) => t.id === tenantId) : null;
  if (tenantId && !tenant) {
    console.error(`Unknown tenant: ${tenantId}`);
    process.exit(1);
  }
  const result = tenant ? await rag.rebuildIndex(openai, tenant) : await rag.rebuildAllIndexes(openai);
  console.log(JSON.stringify({ ok: true, result }, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
