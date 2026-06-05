const fs = require("fs");
const path = require("path");
const { chunkText } = require("./chunk-text");

function isGoogleDocsKnowledgeMode() {
  return (
    Boolean(process.env.GOOGLE_KNOWLEDGE_DOC_IDS?.trim()) &&
    (Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) ||
      Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS))
  );
}

const ROOT = path.join(__dirname, "..");
const SOURCES_DIR = path.join(ROOT, "knowledge", "sources");
const INDEX_PATH = path.join(ROOT, "knowledge", "index.json");

const EMBEDDING_MODEL =
  process.env.RAG_EMBEDDING_MODEL || "text-embedding-3-small";
const TOP_K = Number(process.env.RAG_TOP_K || 6);
const RAG_ENABLED = process.env.RAG_ENABLED !== "false";

let indexData = null;

function isEnabled() {
  return RAG_ENABLED;
}

function isReady() {
  return Boolean(indexData?.chunks?.length);
}

function loadIndex() {
  indexData = null;
  if (!fs.existsSync(INDEX_PATH)) {
    console.warn("RAG: index.json not found — using source-file fallback until indexed.");
    return false;
  }
  try {
    indexData = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
    console.log(
      `RAG: loaded ${indexData.chunks?.length || 0} chunks (built ${indexData.builtAt || "unknown"})`
    );
    return true;
  } catch (err) {
    console.warn("RAG: failed to load index.json:", err.message);
    return false;
  }
}

function listSourceFiles() {
  if (!fs.existsSync(SOURCES_DIR)) return [];
  let names = fs
    .readdirSync(SOURCES_DIR)
    .filter((f) => /\.(md|txt)$/i.test(f))
    .sort();

  // Production Google Doc workflow: index synced .txt only (avoids duplicate .md in repo).
  if (isGoogleDocsKnowledgeMode()) {
    const syncedTxt = names.filter((f) => /\.txt$/i.test(f));
    if (syncedTxt.length) names = syncedTxt;
  }

  return names.map((f) => path.join(SOURCES_DIR, f));
}

function readSourcesCombined() {
  const files = listSourceFiles();
  if (!files.length) return "";
  return files
    .map((filePath) => {
      const name = path.basename(filePath);
      const body = fs.readFileSync(filePath, "utf8").trim();
      return body ? `# Source: ${name}\n\n${body}` : "";
    })
    .filter(Boolean)
    .join("\n\n---\n\n");
}

function getStaticKnowledgeFallback(maxChars = 14000) {
  const combined = readSourcesCombined();
  if (!combined) return "";
  if (combined.length <= maxChars) return combined;
  return `${combined.slice(0, maxChars)}\n\n[Knowledge truncated — run index-knowledge for full RAG retrieval.]`;
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function embedTexts(openai, texts) {
  if (!openai || !texts.length) return [];
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });
  return response.data.map((row) => row.embedding);
}

async function embedQuery(openai, text) {
  const [vector] = await embedTexts(openai, [text]);
  return vector;
}

function collectChunksFromSources() {
  const files = listSourceFiles();
  const all = [];
  let id = 0;
  for (const filePath of files) {
    const source = path.basename(filePath);
    const text = fs.readFileSync(filePath, "utf8");
    const parts = chunkText(text);
    for (const part of parts) {
      all.push({
        id: `${source}#${id++}`,
        source,
        text: part,
      });
    }
  }
  return all;
}

async function rebuildIndex(openai) {
  if (!openai) {
    throw new Error("OpenAI client required to build embeddings index.");
  }

  const chunks = collectChunksFromSources();
  if (!chunks.length) {
    throw new Error(`No knowledge files in ${SOURCES_DIR}`);
  }

  console.log(`RAG: embedding ${chunks.length} chunks...`);
  const batchSize = 32;
  const withEmbeddings = [];

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const vectors = await embedTexts(
      openai,
      batch.map((c) => c.text)
    );
    batch.forEach((chunk, j) => {
      withEmbeddings.push({ ...chunk, embedding: vectors[j] });
    });
  }

  indexData = {
    version: 1,
    builtAt: new Date().toISOString(),
    model: EMBEDDING_MODEL,
    chunkCount: withEmbeddings.length,
    chunks: withEmbeddings,
  };

  fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
  fs.writeFileSync(INDEX_PATH, JSON.stringify(indexData));
  console.log(`RAG: wrote ${INDEX_PATH} (${withEmbeddings.length} chunks)`);
  return indexData;
}

async function retrieveKnowledgeContext(openai, query) {
  if (!isEnabled()) {
    const fallback = getStaticKnowledgeFallback();
    return fallback
      ? `KNOWLEDGE (full source fallback):\n${fallback}`
      : "";
  }

  if (!isReady()) {
    const fallback = getStaticKnowledgeFallback();
    if (fallback) {
      return `KNOWLEDGE (source files — run index-knowledge or sync for RAG search):\n${fallback}`;
    }
    return "";
  }

  if (!openai) {
    return getStaticKnowledgeFallback()
      ? `KNOWLEDGE:\n${getStaticKnowledgeFallback()}`
      : "";
  }

  try {
    const queryVec = await embedQuery(openai, query);
    const ranked = indexData.chunks
      .map((chunk) => ({
        ...chunk,
        score: cosineSimilarity(queryVec, chunk.embedding),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_K);

    if (!ranked.length) return "";

    const body = ranked
      .map(
        (c, i) =>
          `[${i + 1}] (${c.source}, relevance ${c.score.toFixed(3)})\n${c.text}`
      )
      .join("\n\n");

    return (
      "KNOWLEDGE CONTEXT (retrieved from Beantol business documents — use for facts, prices, FAQ; " +
      "behavior rules in system instructions override if conflict):\n\n" +
      body
    );
  } catch (err) {
    console.error("RAG retrieve error:", err.message);
    const fallback = getStaticKnowledgeFallback();
    return fallback ? `KNOWLEDGE (RAG error — fallback):\n${fallback}` : "";
  }
}

function getIndexStatus() {
  return {
    enabled: isEnabled(),
    ready: isReady(),
    indexPath: INDEX_PATH,
    chunkCount: indexData?.chunks?.length || 0,
    builtAt: indexData?.builtAt || null,
    embeddingModel: indexData?.model || EMBEDDING_MODEL,
    sourceFiles: listSourceFiles().map((p) => path.basename(p)),
    topK: TOP_K,
  };
}

module.exports = {
  INDEX_PATH,
  SOURCES_DIR,
  isEnabled,
  isReady,
  loadIndex,
  rebuildIndex,
  retrieveKnowledgeContext,
  getStaticKnowledgeFallback,
  getIndexStatus,
  listSourceFiles,
};
