#!/usr/bin/env node
require("dotenv").config();
const OpenAI = require("openai");
const rag = require("../lib/rag");

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY required to build embeddings index.");
    process.exit(1);
  }
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const result = await rag.rebuildIndex(openai);
  console.log(
    JSON.stringify(
      {
        ok: true,
        chunkCount: result.chunkCount,
        builtAt: result.builtAt,
        indexPath: rag.INDEX_PATH,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
