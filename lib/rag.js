const fs = require("fs");
const path = require("path");
const { chunkText } = require("./chunk-text");
const { getActiveTenant, getDefaultTenant } = require("./tenant-context");
const { getKnowledgeDocIds } = require("./tenant-google");
const { listTenants } = require("./tenant-registry");
const { hasGoogleCredentials } = require("./google-auth");

const ROOT = path.join(__dirname, "..");
const SOURCES_DIR = path.join(ROOT, "knowledge", "sources");
const INDEX_PATH = path.join(ROOT, "knowledge", "index.json");

const EMBEDDING_MODEL =
  process.env.RAG_EMBEDDING_MODEL || "text-embedding-3-small";
const TOP_K = Number(process.env.RAG_TOP_K || 6);
const RAG_ENABLED = process.env.RAG_ENABLED !== "false";

/** @type {Map<string, object>} tenantId -> indexData */
const tenantIndexes = new Map();

function resolveTenant(tenant) {
  return tenant || getActiveTenant() || getDefaultTenant();
}

function usesLegacyPaths(tenant) {
  return Boolean(tenant?.legacy);
}

function pathsForTenant(tenant) {
  const t = resolveTenant(tenant);
  if (usesLegacyPaths(t)) {
    return { sourcesDir: SOURCES_DIR, indexPath: INDEX_PATH, tenantId: t.id };
  }
  const base = path.join(ROOT, "knowledge", "tenants", t.id);
  return {
    sourcesDir: path.join(base, "sources"),
    indexPath: path.join(base, "index.json"),
    tenantId: t.id,
  };
}

function isGoogleDocsKnowledgeModeForTenant(tenant) {
  return Boolean(getKnowledgeDocIds(tenant)?.trim() && hasGoogleCredentials());
}

function isEnabled() {
  return RAG_ENABLED;
}

function getTenantIndex(tenant) {
  const t = resolveTenant(tenant);
  return tenantIndexes.get(t.id) || null;
}

function isReady(tenant) {
  const data = getTenantIndex(tenant);
  return Boolean(data?.chunks?.length);
}

function loadIndexForTenant(tenant) {
  const t = resolveTenant(tenant);
  const { indexPath } = pathsForTenant(t);
  if (!fs.existsSync(indexPath)) {
    tenantIndexes.delete(t.id);
    return false;
  }
  try {
    const indexData = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    tenantIndexes.set(t.id, indexData);
    console.log(
      `RAG [${t.id}]: loaded ${indexData.chunks?.length || 0} chunks (built ${indexData.builtAt || "unknown"})`
    );
    return true;
  } catch (err) {
    console.warn(`RAG [${t.id}]: failed to load index:`, err.message);
    tenantIndexes.delete(t.id);
    return false;
  }
}

function loadIndex(tenant) {
  if (tenant) return loadIndexForTenant(tenant);
  let any = false;
  for (const t of listTenants()) {
    if (loadIndexForTenant(t)) any = true;
  }
  return any;
}

function listSourceFiles(tenant) {
  const { sourcesDir } = pathsForTenant(tenant);
  if (!fs.existsSync(sourcesDir)) return [];
  let names = fs
    .readdirSync(sourcesDir)
    .filter((f) => /\.(md|txt)$/i.test(f))
    .sort();

  if (isGoogleDocsKnowledgeModeForTenant(tenant)) {
    const syncedTxt = names.filter((f) => /\.txt$/i.test(f));
    if (syncedTxt.length) names = syncedTxt;
  }

  return names.map((f) => path.join(sourcesDir, f));
}

function readSourcesCombined(tenant) {
  const files = listSourceFiles(tenant);
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

function getStaticKnowledgeFallback(maxChars = 14000, tenant) {
  const combined = readSourcesCombined(tenant);
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

function collectChunksFromSources(tenant) {
  const files = listSourceFiles(tenant);
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

async function rebuildIndex(openai, tenant) {
  if (!openai) {
    throw new Error("OpenAI client required to build embeddings index.");
  }

  const t = resolveTenant(tenant);
  const { sourcesDir, indexPath } = pathsForTenant(t);
  const chunks = collectChunksFromSources(t);
  if (!chunks.length) {
    throw new Error(`No knowledge files in ${sourcesDir}`);
  }

  console.log(`RAG [${t.id}]: embedding ${chunks.length} chunks...`);
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

  const indexData = {
    version: 1,
    tenantId: t.id,
    builtAt: new Date().toISOString(),
    model: EMBEDDING_MODEL,
    chunkCount: withEmbeddings.length,
    chunks: withEmbeddings,
  };

  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify(indexData));
  tenantIndexes.set(t.id, indexData);
  console.log(`RAG [${t.id}]: wrote ${indexPath} (${withEmbeddings.length} chunks)`);
  return indexData;
}

async function rebuildAllIndexes(openai) {
  const results = [];
  for (const tenant of listTenants()) {
    try {
      results.push({ tenantId: tenant.id, ...(await rebuildIndex(openai, tenant)) });
    } catch (err) {
      console.warn(`RAG [${tenant.id}]: rebuild skipped — ${err.message}`);
      results.push({ tenantId: tenant.id, error: err.message });
    }
  }
  return results;
}

const WHO_IS_QUERY =
  /\b(?:who\s+is|who'?s|who\s+are|sino\s+si|sino\s+ang|tell\s+me\s+about)\s+([a-z][a-z\s'.-]{1,50})/i;

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Boost FAQ / fun-fact chunks when the customer asks about a person by name. */
function findPersonNameChunks(chunks, query) {
  const match = String(query || "").match(WHO_IS_QUERY);
  if (!match) return [];

  const namePhrase = match[1].trim().toLowerCase().replace(/[?.!]+$/, "");
  const tokens = namePhrase.split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];

  const scored = chunks
    .map((chunk) => {
      const text = chunk.text || "";
      const lower = text.toLowerCase();
      let score = 0;

      for (const token of tokens) {
        if (token.length < 2) continue;
        const re = new RegExp(`\\b${escapeRegex(token)}\\b`, "i");
        if (re.test(text)) score += 4;
        if (new RegExp(`\\bwho\\s+is\\s+[^\\n]*\\b${escapeRegex(token)}\\b`, "i").test(text)) {
          score += 12;
        }
      }

      if (/fun fact/i.test(text) && tokens.some((t) => lower.includes(t))) score += 3;
      if (/^Q:\s/i.test(text.trim()) && tokens.some((t) => lower.includes(t))) score += 2;

      return { chunk, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.map((row) => row.chunk);
}

function mergeRetrievedChunks(semanticRanked, keywordHits, limit = TOP_K) {
  const seen = new Set();
  const merged = [];

  for (const chunk of [...keywordHits, ...semanticRanked]) {
    const key = chunk.id || chunk.text;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(chunk);
    if (merged.length >= limit) break;
  }
  return merged;
}

async function retrieveKnowledgeContext(openai, query, tenant) {
  const t = resolveTenant(tenant);
  const businessName = t.branding?.businessName || t.name || "the business";

  if (!isEnabled()) {
    const fallback = getStaticKnowledgeFallback(14000, t);
    return fallback ? `KNOWLEDGE (full source fallback):\n${fallback}` : "";
  }

  const indexData = getTenantIndex(t);
  if (!indexData?.chunks?.length) {
    const fallback = getStaticKnowledgeFallback(14000, t);
    if (fallback) {
      return `KNOWLEDGE (source files — run index-knowledge or sync for RAG search):\n${fallback}`;
    }
    return "";
  }

  if (!openai) {
    const fallback = getStaticKnowledgeFallback(14000, t);
    return fallback ? `KNOWLEDGE:\n${fallback}` : "";
  }

  try {
    const queryVec = await embedQuery(openai, query);
    const semanticRanked = indexData.chunks
      .map((chunk) => ({
        ...chunk,
        score: cosineSimilarity(queryVec, chunk.embedding),
      }))
      .sort((a, b) => b.score - a.score);

    const keywordHits = findPersonNameChunks(indexData.chunks, query).map((chunk) => ({
      ...chunk,
      score: 1,
    }));
    const ranked = mergeRetrievedChunks(semanticRanked, keywordHits, TOP_K);

    if (!ranked.length) return "";

    const body = ranked
      .map(
        (c, i) =>
          `[${i + 1}] (${c.source}, relevance ${c.score.toFixed(3)})\n${c.text}`
      )
      .join("\n\n");

    return (
      `KNOWLEDGE CONTEXT (retrieved from ${businessName} documents — use for facts, prices, FAQ; ` +
      "behavior rules in system instructions override if conflict):\n\n" +
      body
    );
  } catch (err) {
    console.error(`RAG [${t.id}] retrieve error:`, err.message);
    const fallback = getStaticKnowledgeFallback(14000, t);
    return fallback ? `KNOWLEDGE (RAG error — fallback):\n${fallback}` : "";
  }
}

function getIndexStatus(tenant) {
  if (tenant) {
    const t = resolveTenant(tenant);
    const indexData = getTenantIndex(t);
    const { indexPath } = pathsForTenant(t);
    return {
      tenantId: t.id,
      tenantName: t.name,
      enabled: isEnabled(),
      ready: isReady(t),
      indexPath,
      chunkCount: indexData?.chunks?.length || 0,
      builtAt: indexData?.builtAt || null,
      embeddingModel: indexData?.model || EMBEDDING_MODEL,
      sourceFiles: listSourceFiles(t).map((p) => path.basename(p)),
      topK: TOP_K,
      legacyPaths: usesLegacyPaths(t),
    };
  }

  return {
    enabled: isEnabled(),
    tenants: listTenants().map((t) => getIndexStatus(t)),
  };
}

module.exports = {
  INDEX_PATH,
  SOURCES_DIR,
  pathsForTenant,
  isEnabled,
  isReady,
  loadIndex,
  loadIndexForTenant,
  rebuildIndex,
  rebuildAllIndexes,
  retrieveKnowledgeContext,
  getStaticKnowledgeFallback,
  getIndexStatus,
  listSourceFiles,
};
