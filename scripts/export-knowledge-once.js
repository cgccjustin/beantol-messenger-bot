const fs = require("fs");
const path = require("path");

const serverPath = path.join(__dirname, "..", "server.js");
const s = fs.readFileSync(serverPath, "utf8");
const start = s.indexOf("const SYSTEM_PROMPT = `");
const end = s.indexOf("`;\n\nconst openai", start);
if (start < 0 || end < 0) {
  console.error("Could not find SYSTEM_PROMPT");
  process.exit(1);
}
const full = s.slice(start + "const SYSTEM_PROMPT = `".length, end);
const aboutIdx = full.indexOf("ABOUT US:");
const rulesIdx = full.indexOf("\n\nRULES:");
const knowledge = full.slice(aboutIdx, rulesIdx).trim();

const outDir = path.join(__dirname, "..", "knowledge", "sources");
fs.mkdirSync(outDir, { recursive: true });

const cuts = [
  { name: "01-about-hours-order.md", start: 0, end: full.indexOf("PRICING (") - aboutIdx },
  {
    name: "02-pricing-products-beans.md",
    start: full.indexOf("PRICING (") - aboutIdx,
    end: full.indexOf("ROAST PHILOSOPHY") - aboutIdx,
  },
  {
    name: "03-roast-brewing-team-faq.md",
    start: full.indexOf("ROAST PHILOSOPHY") - aboutIdx,
    end: knowledge.length,
  },
];

for (const cut of cuts) {
  const chunk = knowledge.slice(cut.start, cut.end).trim();
  if (chunk) {
    fs.writeFileSync(
      path.join(outDir, cut.name),
      `# ${cut.name.replace(".md", "")}\n\n${chunk}\n`
    );
    console.log("Wrote", cut.name, chunk.length, "chars");
  }
}
