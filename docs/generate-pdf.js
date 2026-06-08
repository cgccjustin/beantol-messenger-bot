const path = require("path");
const puppeteer = require("puppeteer");

async function main() {
  const htmlPath = path.join(__dirname, "Beantol-Messenger-Bot-Overview.html");
  const pdfPath = path.join(__dirname, "Beantol-Messenger-Bot-Overview.pdf");
  const fileUrl = "file:///" + htmlPath.replace(/\\/g, "/");

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(fileUrl, { waitUntil: "networkidle0" });
  await page.pdf({
    path: pdfPath,
    format: "A4",
    printBackground: true,
    margin: { top: "12mm", right: "12mm", bottom: "14mm", left: "12mm" },
  });
  await browser.close();
  console.log("PDF written:", pdfPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
