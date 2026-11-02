// Renders tools/icon.html in headless Chromium and writes every icon size into icons/.
// Usage: node tools/make-icons.js   (needs playwright; uses PIL via python3 for high-quality downscaling)
const { chromium } = require("playwright");
const http = require("http"), fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const root = path.resolve(__dirname, "..");
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split("?")[0]));
  fs.readFile(p, (e, b) => { if (e) { res.writeHead(404); res.end(); return; } res.end(b); });
}).listen(0);
(async () => {
  const port = server.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  const shot = async (scale, out) => {
    await page.goto(`http://localhost:${port}/tools/icon.html?scale=${scale}`);
    await page.waitForFunction(() => window.done === true, null, { timeout: 60000 });
    const data = await page.evaluate(() => document.getElementById("c").toDataURL("image/png"));
    fs.writeFileSync(out, Buffer.from(data.split(",")[1], "base64"));
  };
  const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "td-icon-"));
  await shot(1, path.join(tmp, "any.png"));
  await shot(0.78, path.join(tmp, "mask.png")); // maskable: keep everything inside the safe circle
  await browser.close(); server.close();
  const py = `
from PIL import Image
import sys
t, out = sys.argv[1], sys.argv[2]
a = Image.open(t + "/any.png").convert("RGB"); m = Image.open(t + "/mask.png").convert("RGB")
for name, img, size in [("icon-512.png", a, 512), ("icon-192.png", a, 192), ("apple-touch-icon.png", a, 180), ("favicon-64.png", a, 64), ("maskable-512.png", m, 512)]:
    img.resize((size, size), Image.LANCZOS).save(out + "/" + name, optimize=True)
`;
  execFileSync("python3", ["-c", py, tmp, path.join(root, "icons")], { stdio: "inherit" });
  console.log("icons written");
})();
