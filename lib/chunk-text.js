/**
 * Split markdown/plain text into chunks for embedding.
 */

const DEFAULT_MAX_CHARS = 900;
const DEFAULT_OVERLAP = 120;

function splitByHeadings(text) {
  const lines = text.split("\n");
  const sections = [];
  let current = [];

  for (const line of lines) {
    if (/^#{1,3}\s/.test(line) && current.length) {
      sections.push(current.join("\n").trim());
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length) sections.push(current.join("\n").trim());
  return sections.filter(Boolean);
}

function splitLongSection(text, maxChars, overlap) {
  if (text.length <= maxChars) return [text];

  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      const slice = text.slice(start, end);
      const breakAt = Math.max(
        slice.lastIndexOf("\n\n"),
        slice.lastIndexOf(". "),
        slice.lastIndexOf("? "),
        slice.lastIndexOf("! ")
      );
      if (breakAt > maxChars * 0.4) end = start + breakAt + 1;
    }
    chunks.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter(Boolean);
}

function chunkText(text, options = {}) {
  const maxChars = options.maxChars || DEFAULT_MAX_CHARS;
  const overlap = options.overlap || DEFAULT_OVERLAP;
  const normalized = String(text || "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!normalized) return [];

  const sections = splitByHeadings(normalized);
  const out = [];
  for (const section of sections) {
    out.push(...splitLongSection(section, maxChars, overlap));
  }
  return out;
}

module.exports = { chunkText };
