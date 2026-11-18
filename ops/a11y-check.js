const { chromium } = require("playwright"); const http = require("http"), fs = require("fs"), path = require("path");
const root = "/home/claude/autoflow/apps/web/dist";
const srv = http.createServer((q, s) => { let p = path.join(root, q.url.split("?")[0]); if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(root, "index.html"); const ext = path.extname(p); s.setHeader("content-type", { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" }[ext] || "application/octet-stream"); s.end(fs.readFileSync(p)); }).listen(4173, async () => {
  const b = await chromium.launch(); const pg = await b.newPage();
  await pg.route("**/api/**", (r) => r.fulfill({ status: 401, contentType: "application/json", body: '{"error":"unauthorized"}' }));
  await pg.goto("http://localhost:4173/"); await pg.waitForTimeout(800);
  await pg.addScriptTag({ path: require.resolve("axe-core") });
  const r = await pg.evaluate(() => axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21aa"] }));
  console.log(JSON.stringify({ url: "/", violations: r.violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, help: v.help })), passes: r.passes.length }, null, 1));
  await b.close(); srv.close();
});
