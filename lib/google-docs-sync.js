const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { getGoogleAuth, hasGoogleCredentials } = require("./google-auth");

const SOURCES_DIR = path.join(__dirname, "..", "knowledge", "sources");

/**
 * GOOGLE_KNOWLEDGE_DOC_IDS format (comma-separated):
 *   documentId:filename,documentId:filename
 * Example:
 *   1abcXYZ_beantol:beantol-knowledge,1def456_faq:beantol-faq
 *
 * Or document IDs only (uses doc id as filename):
 *   1abcXYZ_beantol,1def456_faq
 */
function parseDocEntries() {
  const raw = process.env.GOOGLE_KNOWLEDGE_DOC_IDS || "";
  if (!raw.trim()) return [];

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

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "google-doc";
}

function getGoogleAuthForDrive() {
  return getGoogleAuth(["https://www.googleapis.com/auth/drive.readonly"]);
}

async function exportDocPlainText(drive, documentId) {
  const res = await drive.files.export(
    { fileId: documentId, mimeType: "text/plain" },
    { responseType: "text" }
  );
  return String(res.data || "").trim();
}

async function syncGoogleDocs() {
  const entries = parseDocEntries();
  if (!entries.length) {
    throw new Error("GOOGLE_KNOWLEDGE_DOC_IDS is empty.");
  }

  const auth = getGoogleAuthForDrive();
  const drive = google.drive({ version: "v3", auth });

  fs.mkdirSync(SOURCES_DIR, { recursive: true });

  const synced = [];
  for (const entry of entries) {
    const text = await exportDocPlainText(drive, entry.id);
    const filename = `${entry.name}.txt`;
    const filePath = path.join(SOURCES_DIR, filename);
    const header = `# Synced from Google Doc (${entry.id})\n# Updated: ${new Date().toISOString()}\n\n`;
    fs.writeFileSync(filePath, header + text);
    synced.push({ id: entry.id, file: filename, chars: text.length });
    console.log(`Google Docs sync: ${filename} (${text.length} chars)`);
  }

  return { synced, count: synced.length };
}

function isGoogleSyncConfigured() {
  return (
    Boolean(process.env.GOOGLE_KNOWLEDGE_DOC_IDS?.trim()) && hasGoogleCredentials()
  );
}

module.exports = {
  syncGoogleDocs,
  isGoogleSyncConfigured,
  parseDocEntries,
};
