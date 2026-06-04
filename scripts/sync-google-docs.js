#!/usr/bin/env node
require("dotenv").config();
const { syncGoogleDocs } = require("../lib/google-docs-sync");

async function main() {
  const result = await syncGoogleDocs();
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
