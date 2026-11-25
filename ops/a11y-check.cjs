// Verificação axe-core (WCAG 2.0/2.1 A/AA) do SPA com API simulada. Uso: NODE_PATH=... node ops/a11y-check.js (precisa de apps/web/dist e axe-core).
// Cobre: login, home (atendimento), Privacidade, Avançado. NÃO cobre portal do cliente, site SSR nem teste manual de teclado/leitor de tela (KI-093).
const { chromium } = require("playwright"); const http = require("http"), fs = require("fs"), path = require("path");
const root = path.resolve(__dirname, "../apps/web/dist");
const mock = {
  "/auth/me": { userId: "u", tenantId: "t", permissions: [] },
  "/orders?status=open": { orders: [] },
  "/lgpd/tickets?status=open": { overdue: 1, tickets: [{ id: "1", kind: "access", received_at: "2026-11-01T00:00:00Z", due_at: "2026-11-16T00:00:00Z", overdue: true, days_left: -9 }, { id: "2", kind: "portability", received_at: "2026-11-20T00:00:00Z", due_at: "2026-12-05T00:00:00Z", overdue: false, days_left: 10 }] },
  "/reports/consolidated": { scope: "all", label: "Gerencial estimado", units: [{ unitId: "a", name: "Matriz", dre: { grossRevenue: 100000, directCosts: 40000, operatingResult: 60000 }, stockValueCents: 5000 }], total: { dre: { grossRevenue: 100000, directCosts: 40000, operatingResult: 60000 }, stockValueCents: 5000 } },
  "/claims": { claims: [{ id: "c1", claimNo: "SIN-001", insurerId: "i1", status: "awaiting_authorization", deadline: "overdue", authorizationDueAt: "2026-11-20T10:00:00Z", requestedCents: 100000, authorizedCents: 0 }] },
  "/insurers": { insurers: [{ id: "i1", name: "Seguradora X" }] }, "/customers": { customers: [{ id: "k1", name: "Maria" }] },
  "/commissions/rules": { rules: [{ id: "r1", membership_id: "abcdef12-0000", version_no: 1, basis: "os_margin", rate_bps: 500, valid_from: "2026-11-01T00:00:00Z" }] }, "/commissions/entries": { entries: [] },
  "/agenda/waitlist": { entries: [{ id: "w1", title: "Revisão", duration_minutes: 60, window_from: "2026-12-01T10:00:00Z", window_to: "2026-12-01T18:00:00Z", status: "waiting" }] },
  "/stock/transfers": { transfers: [{ id: "t1", from_unit_id: "aaaaaaaa-1", to_unit_id: "bbbbbbbb-2", note: null, created_at: "2026-11-20T10:00:00Z" }] },
  "/claims?deadline=overdue": { claims: [] }, "/automation/settings": { enabled: true, usedThisMonth: 3, monthlyLimit: 2000, platformKillSwitch: false },
};
const srv = http.createServer((q, s) => { let p = path.join(root, q.url.split("?")[0]); if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(root, "index.html"); s.setHeader("content-type", { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" }[path.extname(p)] || "application/octet-stream"); s.end(fs.readFileSync(p)); }).listen(4173, async () => {
  const b = await chromium.launch(); let bad = 0;
  const run = async (name, authed, clickText) => {
    const pg = await b.newPage();
    await pg.route("**/api/**", (r) => { const u = new URL(r.request().url()); const key = u.pathname.replace(/^\/api/, "") + (u.pathname.endsWith("tickets") || u.pathname.endsWith("orders") ? u.search : ""); const hit = Object.entries(mock).find(([k]) => k === key || k.split("?")[0] === u.pathname.replace(/^\/api/, "")); if (!authed || !hit) return r.fulfill({ status: !authed ? 401 : 404, contentType: "application/json", body: '{"error":"x"}' }); r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(hit[1]) }); });
    await pg.goto("http://localhost:4173/"); await pg.waitForTimeout(600);
    for (const t of [].concat(clickText || [])) { await pg.getByRole(t === "Comissões" || t === "Agenda e espera" || t === "Transferências" ? "tab" : "button", { name: t }).first().click(); await pg.waitForTimeout(400); }
    await pg.addScriptTag({ path: require.resolve("axe-core") });
    const r = await pg.evaluate(() => axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21aa"] }));
    console.log(name.padEnd(12), "violações:", r.violations.length, "regras ok:", r.passes.length); for (const v of r.violations) { bad++; console.log("  -", v.id, v.impact, v.nodes.length, v.help); }
    await pg.close();
  };
  await run("login", false); await run("home", true); await run("privacidade", true, "Privacidade"); await run("avancado", true, "Avançado");
  for (const t of ["Comissões", "Agenda e espera", "Transferências"]) await run("gestao:" + t, true, ["Avançado", t]);
  await b.close(); srv.close(); process.exit(bad ? 1 : 0);
});
