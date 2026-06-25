const fs = require("fs");
const rag = require("./rag");

const WHO_IS_INQUIRY =
  /\b(?:who\s+is|who'?s|sino\s+si|sino\s+ang|tell\s+me\s+about)\s+[a-z0-9]/i;

const WHO_IS_NAME =
  /\b(?:who\s+is|who'?s|sino\s+si|sino\s+ang|tell\s+me\s+about)\s+(.+?)\??\s*$/i;

/** Customer asking who a named person is (fun facts / team FAQ in knowledge doc). */
function isWhoIsFaqInquiry(text) {
  const t = String(text || "").trim();
  if (!t || t.length > 120) return false;
  if (!WHO_IS_INQUIRY.test(t)) return false;
  if (/\b(?:shop|store|offbeat|beantol|menu|hours|open|gcash|delivery)\b/i.test(t)) {
    return false;
  }
  return true;
}

function extractPersonNameFromQuery(text) {
  const m = String(text || "")
    .trim()
    .match(WHO_IS_NAME);
  if (!m) return null;
  return m[1].trim().replace(/[?.!]+$/, "");
}

/**
 * Parse "Q: Who is NAME? A: ..." entries from plain-text knowledge (Google Docs export).
 * Handles inline runs: "... A: answer. Q: Who is Next? A: ..."
 */
function parseWhoIsFaqs(text) {
  const map = new Map();
  const body = String(text || "");
  if (!body) return map;

  const parts = body.split(/\s(?=Q:\s*Who is\s+)/i);
  for (const part of parts) {
    const m = part.match(/^Q:\s*Who is\s+([^?]+)\?\s*A:\s*(.+)/is);
    if (!m) continue;
    const name = m[1].trim().toLowerCase();
    let answer = m[2].trim();
    const nextQ = answer.search(/\sQ:\s/i);
    if (nextQ >= 0) answer = answer.slice(0, nextQ).trim();

    const lines = answer.split("\n");
    const kept = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t) break;
      if (/^[•\-*]/.test(t)) break;
      if (/^Q:\s/i.test(t)) break;
      if (looksLikeSectionHeaderLine(t)) break;
      kept.push(t);
    }
    answer = kept.join(" ").replace(/\s+/g, " ").trim();
    if (name && answer) map.set(name, answer);
  }
  return map;
}

function looksLikeSectionHeaderLine(line) {
  const t = String(line || "").trim();
  if (!t || t.length < 3 || t.length > 55) return false;
  if (/[.,;:!?]/.test(t)) return false;
  if (t.split(/\s+/).length > 5) return false;
  if (/^[•\-*\d]/.test(t)) return false;
  return /^[A-Z][A-Za-z0-9 &,/-]*$/.test(t);
}

function loadWhoIsFaqIndex(tenant) {
  const map = new Map();
  for (const filePath of rag.listSourceFiles(tenant)) {
    const body = fs.readFileSync(filePath, "utf8");
    for (const [name, answer] of parseWhoIsFaqs(body)) {
      if (!map.has(name)) map.set(name, answer);
    }
  }
  return map;
}

function lookupWhoIsAnswer(faqIndex, personName) {
  const raw = String(personName || "").trim().toLowerCase();
  if (!raw) return null;

  if (faqIndex.has(raw)) return faqIndex.get(raw);

  const first = raw.split(/\s+/)[0];
  if (faqIndex.has(first)) return faqIndex.get(first);

  for (const [name, answer] of faqIndex) {
    if (name.startsWith(first) || first.startsWith(name.split(/\s+/)[0])) {
      return answer;
    }
  }
  return null;
}

function buildWhoIsFaqReply(tenant, userText) {
  const personName = extractPersonNameFromQuery(userText);
  if (!personName) return null;

  const faqIndex = loadWhoIsFaqIndex(tenant);
  const answer = lookupWhoIsAnswer(faqIndex, personName);
  if (!answer) return null;

  const displayName = personName
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  return `${displayName}? ${answer}`;
}

module.exports = {
  isWhoIsFaqInquiry,
  buildWhoIsFaqReply,
  parseWhoIsFaqs,
  extractPersonNameFromQuery,
};
