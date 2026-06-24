const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { getGoogleAuth, hasGoogleCredentials } = require("./google-auth");
const { getKnowledgeDocIds } = require("./tenant-google");
const { listTenants, getDefaultTenant } = require("./tenant-registry");
const rag = require("./rag");

/**
 * GOOGLE_KNOWLEDGE_DOC_IDS format (comma-separated):
 *   documentId:filename,documentId:filename
 */
function parseDocEntriesFromRaw(raw) {
  if (!raw?.trim()) return [];

  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      if (part.includes(":")) {
        const [id, name] = part.split(":");
        return { id: id.trim(), name: sanitizeFilename(name.trim()) };
      }
      return { id: part, name: sanitizeFilename(part) };
    });
}

function parseDocEntries() {
  return parseDocEntriesFromRaw(process.env.GOOGLE_KNOWLEDGE_DOC_IDS || "");
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "google-doc";
}

function getGoogleAuthForDrive() {
  return getGoogleAuth(["https://www.googleapis.com/auth/drive.readonly"]);
}

async function exportDocPlainText(drive, documentId) {
  let mimeType = "";
  try {
    const meta = await drive.files.get({
      fileId: documentId,
      fields: "mimeType,name",
      supportsAllDrives: true,
    });
    mimeType = meta.data?.mimeType || "";
    if (mimeType && mimeType !== "application/vnd.google-apps.document") {
      throw new Error(
        `Knowledge file "${meta.data?.name || documentId}" is mimeType ${mimeType}, not a native Google Doc. ` +
          "Create a blank Google Doc at docs.google.com, paste your content, share with the service account (Editor), and use that document ID."
      );
    }
  } catch (err) {
    if (err.message?.includes("not a native Google Doc")) throw err;
    console.warn(`Google Docs sync: could not read mimeType for ${documentId}:`, err.message);
  }

  try {
    const res = await drive.files.export(
      { fileId: documentId, mimeType: "text/plain" },
      { responseType: "text" }
    );
    return String(res.data || "").trim();
  } catch (err) {
    const googleMsg = err.googleError?.message || err.response?.data?.error?.message;
    throw new Error(
      googleMsg ||
        err.message ||
        `Drive export failed for document ${documentId}`
    );
  }
}

async function syncGoogleDocsForTenant(tenant) {
  const entries = parseDocEntriesFromRaw(getKnowledgeDocIds(tenant));
  if (!entries.length) {
    throw new Error(`No knowledgeDocIds configured for tenant ${tenant.id}.`);
  }

  const auth = getGoogleAuthForDrive();
  const drive = google.drive({ version: "v3", auth });
  const { sourcesDir } = rag.pathsForTenant(tenant);

  fs.mkdirSync(sourcesDir, { recursive: true });

  const synced = [];
  for (const entry of entries) {
    const text = await exportDocPlainText(drive, entry.id);
    const filename = `${entry.name}.txt`;
    const filePath = path.join(sourcesDir, filename);
    const header = `# Synced from Google Doc (${entry.id})\n# Tenant: ${tenant.id}\n# Updated: ${new Date().toISOString()}\n\n`;
    fs.writeFileSync(filePath, header + text);
    synced.push({ id: entry.id, file: filename, chars: text.length });
    console.log(`Google Docs sync [${tenant.id}]: ${filename} (${text.length} chars)`);
  }

  return { tenantId: tenant.id, synced, count: synced.length };
}

async function syncGoogleDocs(tenant) {
  const t = tenant || getDefaultTenant();
  return syncGoogleDocsForTenant(t);
}

async function syncAllGoogleDocs() {
  const results = [];
  for (const tenant of listTenants()) {
    if (!getKnowledgeDocIds(tenant)) {
      console.warn(`Google Docs sync [${tenant.id}]: skipped — no knowledgeDocIds`);
      continue;
    }
    results.push(await syncGoogleDocsForTenant(tenant));
  }
  if (!results.length) {
    throw new Error("No tenants with knowledgeDocIds configured.");
  }
  return results;
}

function isGoogleSyncConfigured(tenant) {
  const t = tenant || getDefaultTenant();
  return Boolean(getKnowledgeDocIds(t)?.trim() && hasGoogleCredentials());
}

function isAnyGoogleSyncConfigured() {
  return listTenants().some((t) => isGoogleSyncConfigured(t));
}

module.exports = {
  syncGoogleDocs,
  syncGoogleDocsForTenant,
  syncAllGoogleDocs,
  isGoogleSyncConfigured,
  isAnyGoogleSyncConfigured,
  parseDocEntries,
  parseDocEntriesFromRaw,
};
