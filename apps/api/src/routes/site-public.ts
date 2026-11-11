import { TEMPLATE_TOKENS, type SiteConfig, type TemplateName, classifyReferrer, isBot, normalizePhoneBR, normalizePlate, optedOut, safeHttpsUrl, waLink } from "@autoflow/shared";
import QRCode from "qrcode";
import type { Context } from "hono";
import { z } from "zod";
import { randomToken, sha256Hex } from "../crypto";
import type { Q } from "../db";
import { HttpError, notFound, parseJson } from "../http";
import { enforceRateLimit } from "../ratelimit";
import type { Router } from "../router";
import { validateUpload } from "../storage";
import type { AppEnv, Deps } from "../types";

export const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"'`]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" })[ch]!);
const HEX = /^#[0-9a-fA-F]{6}$/;
const hex = (v: unknown, fb: string) => (typeof v === "string" && HEX.test(v) ? v : fb);
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const PUBLIC_CACHE = "public, max-age=60, s-maxage=300, stale-while-revalidate=600";

interface PublicSite { tenantId: string; name: string; slug: string; template: TemplateName; config: SiteConfig; etag: string }
async function loadSite(deps: Deps, slug: string): Promise<PublicSite | null> {
  if (!SLUG.test(slug)) return null;
  return deps.db.publicTx(async (q) => {
    const t = await q.one<{ id: string; name: string }>("select id, name from tenants where slug = $1", [slug]);
    if (!t) return null;
    const v = await q.one<{ template: TemplateName; config: SiteConfig; etag: string }>("select template, config, etag from site_versions where tenant_id = $1 and status = 'published'", [t.id]);
    return v ? { tenantId: t.id, name: t.name, slug, template: v.template, config: v.config, etag: v.etag } : null;
  });
}

const CSS = (tpl: TemplateName, primary: string, accent: string) => {
  const k = TEMPLATE_TOKENS[tpl];
  return `:root{--bg:${k.bg};--fg:${k.fg};--muted:${k.muted};--surface:${k.surface};--primary:${primary};--accent:${accent};--r:${k.radius}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:1rem/1.6 ${k.font}}
h1,h2,h3{font-family:${k.heading};font-weight:${k.weight};line-height:1.2}a{color:var(--fg)}
.w{max-width:60rem;margin:0 auto;padding:1rem}header.top{background:var(--surface)}header.top .w{display:flex;flex-wrap:wrap;gap:.5rem 1rem;align-items:center;justify-content:space-between}
nav a{margin-right:.75rem;display:inline-block;padding:.5rem 0}
.hero{padding:2.5rem 0}.btn{display:inline-block;background:var(--primary);color:#fff;border:2px solid var(--primary);padding:.75rem 1.25rem;border-radius:var(--r);text-decoration:none;font-weight:700;min-height:44px;margin:.25rem .5rem .25rem 0}
.btn.alt{background:transparent;color:var(--fg);border-color:var(--accent)}
section{padding:1.5rem 0}.grid{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr))}.card{background:var(--surface);padding:1rem;border-radius:var(--r)}
.muted{color:var(--muted)}img.g{width:100%;height:auto;aspect-ratio:4/3;object-fit:cover;border-radius:var(--r)}
label{display:block;margin:.75rem 0 .25rem;font-weight:600}input,textarea,select{width:100%;padding:.75rem;font:inherit;border:2px solid var(--muted);border-radius:var(--r);background:var(--bg);color:var(--fg);min-height:44px}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}.ok,.err{padding:.75rem;border-radius:var(--r);border:2px solid var(--primary)}
a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
footer{padding:1.5rem 0;font-size:.9rem}table{border-collapse:collapse}td{padding:.25rem 1rem .25rem 0}`;
};

function mapLink(b: SiteConfig["business"]): string | null {
  const own = safeHttpsUrl(b.mapUrl); if (own) return own;
  if (!b.address) return null;
  return `https://www.openstreetmap.org/search?query=${encodeURIComponent(`${b.address.street}, ${b.address.city} ${b.address.state}`)}`;
}
const addrLine = (b: SiteConfig["business"]) => (b.address ? `${b.address.street}, ${b.address.city} - ${b.address.state.toUpperCase()}${b.address.zip ? `, CEP ${b.address.zip}` : ""}` : "");

function shell(deps: Deps, site: PublicSite, o: { title: string; desc: string; path: string; body: string; ld?: unknown; nonce: string; ogImage?: string | null; turnstile: boolean }) {
  const c = site.config; const canonical = `${deps.config.publicBaseUrl}${o.path}`;
  const css = CSS(site.template, hex(c.theme?.primaryColor, "#0b3d91"), hex(c.theme?.accentColor, hex(c.theme?.primaryColor, "#0b3d91")));
  const ld = o.ld ? `<script type="application/ld+json">${JSON.stringify(o.ld).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")}</script>` : "";
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)}</title><meta name="description" content="${esc(o.desc)}"><link rel="canonical" href="${esc(canonical)}"><meta name="robots" content="index,follow">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(o.title)}"><meta property="og:description" content="${esc(o.desc)}"><meta property="og:url" content="${esc(canonical)}"><meta property="og:locale" content="pt_BR">
${o.ogImage ? `<meta property="og:image" content="${esc(o.ogImage)}"><meta name="twitter:card" content="summary_large_image">` : `<meta name="twitter:card" content="summary">`}
<meta name="theme-color" content="${esc(hex(c.theme?.primaryColor, "#0b3d91"))}">
<style nonce="${o.nonce}">${css}</style>${ld}${o.turnstile ? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` : ""}</head><body>${o.body}</body></html>`;
}
const csp = (nonce: string, turnstile: boolean) => `default-src 'none'; style-src 'nonce-${nonce}'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'${turnstile ? "; script-src https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src https://challenges.cloudflare.com" : ""}`;

function renderSite(deps: Deps, site: PublicSite, q: { sent?: boolean; err?: string; campaign?: string }, nonce: string) {
  const c = site.config; const b = c.business; const s = c.sections; const base = `/o/${site.slug}`;
  const wa = b.whatsapp ? waLink(b.whatsapp) : null; const tel = b.phone ? `tel:+${b.phone.replace(/\D/g, "").replace(/^(?!55)/, "55")}` : null;
  const turnstile = deps.captcha.name === "turnstile" && !!deps.config.turnstileSiteKey;
  const gal = (c.gallery ?? []).map((g) => `<img class="g" loading="lazy" decoding="async" width="800" height="600" src="/m/${site.slug}/${esc(g.mediaId)}" alt="${esc(g.alt)}">`).join("");
  const nav = [s.services && c.services.length ? ["servicos", "Serviços"] : null, s.about && b.about ? ["sobre", "Sobre"] : null, s.gallery && c.gallery.length ? ["galeria", "Galeria"] : null, s.hours && b.hours?.length ? ["horarios", "Horários"] : null, ["contato", "Contato"], ["orcamento", "Orçamento"]].filter(Boolean) as string[][];
  const body = `<a class="hp" href="#conteudo">Ir para o conteúdo</a>
<header class="top"><div class="w"><strong>${esc(b.name)}</strong><nav aria-label="Seções">${nav.map(([id, l]) => `<a href="#${id}">${esc(l)}</a>`).join("")}</nav></div></header>
<main id="conteudo"><div class="w">
<section class="hero"><h1>${esc(b.name)}</h1>${b.tagline ? `<p class="muted">${esc(b.tagline)}</p>` : ""}<a class="btn" href="#orcamento">${esc(c.cta.text)}</a>${wa ? `<a class="btn alt" href="${esc(wa)}" rel="noopener">WhatsApp</a>` : ""}${tel ? `<a class="btn alt" href="${esc(tel)}">Ligar</a>` : ""}</section>
${s.services && c.services.length ? `<section id="servicos"><h2>Serviços</h2><div class="grid">${c.services.map((x) => `<div class="card"><h3>${esc(x.title)}</h3>${x.description ? `<p>${esc(x.description)}</p>` : ""}${x.priceFrom ? `<p class="muted">A partir de ${esc(x.priceFrom)}</p>` : ""}</div>`).join("")}</div></section>` : ""}
${s.about && b.about ? `<section id="sobre"><h2>Sobre nós</h2><p>${esc(b.about).replace(/\n/g, "<br>")}</p></section>` : ""}
${s.gallery && c.gallery.length ? `<section id="galeria"><h2>Galeria</h2><div class="grid">${gal}</div></section>` : ""}
${s.hours && b.hours?.length ? `<section id="horarios"><h2>Horários</h2><table>${b.hours.map((h) => `<tr><td>${esc(h.days)}</td><td>${esc(h.open)}</td></tr>`).join("")}</table></section>` : ""}
${s.testimonials && c.testimonials.length ? `<section><h2>Depoimentos</h2><p class="muted">Depoimentos informados pela própria oficina.</p><div class="grid">${c.testimonials.map((t) => `<blockquote class="card">${esc(t.text)}<footer>— ${esc(t.author)}</footer></blockquote>`).join("")}</div></section>` : ""}
<section id="contato"><h2>Contato</h2>${b.address ? `<p><strong>Endereço:</strong> <span>${esc(addrLine(b))}</span></p>` : ""}${mapLink(b) ? `<p><a href="${esc(mapLink(b)!)}" rel="noopener">Abrir no mapa</a></p>` : ""}${b.phone ? `<p><strong>Telefone:</strong> <a href="${esc(tel)}">${esc(b.phone)}</a></p>` : ""}${b.email ? `<p><strong>E-mail:</strong> <a href="mailto:${esc(b.email)}">${esc(b.email)}</a></p>` : ""}
${[["Instagram", safeHttpsUrl(b.instagram)], ["Facebook", safeHttpsUrl(b.facebook)]].filter((x) => x[1]).map((x) => `<p><a href="${esc(x[1])}" rel="noopener">${x[0]}</a></p>`).join("")}<p><a href="/c/${site.slug}">Cartão digital</a></p></section>
<section id="orcamento"><h2>Peça seu orçamento</h2>
${q.sent ? `<p class="ok" role="status">Recebemos seu pedido! Entraremos em contato em breve.</p>` : ""}${q.err ? `<p class="err" role="alert">Não foi possível enviar: ${esc(q.err === "invalid_phone" ? "telefone inválido" : q.err === "captcha_failed" ? "verificação anti-robô falhou" : "confira os campos e tente novamente")}.</p>` : ""}
<form method="post" action="${base}/lead" enctype="multipart/form-data">
<label for="f-name">Nome</label><input id="f-name" name="name" required maxlength="80" autocomplete="name">
<label for="f-phone">Telefone (com DDD)</label><input id="f-phone" name="phone" type="tel" required maxlength="20" autocomplete="tel">
<label for="f-veh">Veículo (marca/modelo/ano)</label><input id="f-veh" name="vehicle" maxlength="60">
<label for="f-plate">Placa (opcional)</label><input id="f-plate" name="plate" maxlength="8">
<label for="f-svc">Serviço desejado</label><input id="f-svc" name="service" maxlength="60" list="svcs"><datalist id="svcs">${c.services.map((x) => `<option value="${esc(x.title)}">`).join("")}</datalist>
<label for="f-desc">Descreva o problema</label><textarea id="f-desc" name="description" rows="4" maxlength="1000"></textarea>
<label for="f-ph">Fotos (opcional, até 3)</label><input id="f-ph" name="photos" type="file" accept="image/jpeg,image/png,image/webp" multiple>
<input type="hidden" name="campaign" value="${esc(q.campaign ?? "")}">
<div class="hp" aria-hidden="true"><label>Não preencha<input name="website" tabindex="-1" autocomplete="off"></label></div>
${turnstile ? `<div class="cf-turnstile" data-sitekey="${esc(deps.config.turnstileSiteKey)}"></div>` : deps.captcha.name === "memory" ? `<input type="hidden" name="cf-turnstile-response" value="ok-token">` : ""}
<p><button class="btn" type="submit">Enviar pedido</button></p>
<p class="muted">Ao enviar, você autoriza a oficina a entrar em contato sobre este orçamento (LGPD). Não vendemos seus dados.</p></form></section>
</div></main><footer><div class="w muted">© ${esc(b.name)} · Contamos visitas de forma anônima (sem cookies) e respeitamos “Não rastrear”.</div></footer>`;
  const ld = { "@context": "https://schema.org", "@type": "AutoRepair", name: b.name, url: `${deps.config.publicBaseUrl}${base}`, ...(b.phone ? { telephone: b.phone } : {}), ...(b.email ? { email: b.email } : {}),
    ...(b.address ? { address: { "@type": "PostalAddress", streetAddress: b.address.street, addressLocality: b.address.city, addressRegion: b.address.state, ...(b.address.zip ? { postalCode: b.address.zip } : {}), addressCountry: "BR" } } : {}),
    ...(c.gallery[0] ? { image: `${deps.config.publicBaseUrl}/m/${site.slug}/${c.gallery[0].mediaId}` } : {}) };
  return shell(deps, site, { title: c.seo?.title || `${b.name}${b.address ? ` — Oficina em ${b.address.city}` : ""}`, desc: c.seo?.description || b.tagline || `Orçamento e serviços automotivos — ${b.name}`, path: base, body, ld, nonce, turnstile,
    ogImage: c.gallery[0] ? `${deps.config.publicBaseUrl}/m/${site.slug}/${c.gallery[0].mediaId}` : null });
}

function renderCard(deps: Deps, site: PublicSite, nonce: string) {
  const b = site.config.business; const url = `${deps.config.publicBaseUrl}/o/${site.slug}`; const wa = b.whatsapp ? waLink(b.whatsapp) : null;
  const tel = b.phone ? `tel:+${b.phone.replace(/\D/g, "").replace(/^(?!55)/, "55")}` : null;
  const share = `https://wa.me/?text=${encodeURIComponent(`${b.name} — ${url}`)}`;
  const body = `<main><div class="w"><section class="hero"><h1>${esc(b.name)}</h1>${b.tagline ? `<p class="muted">${esc(b.tagline)}</p>` : ""}
${tel ? `<a class="btn" href="${esc(tel)}">Ligar</a>` : ""}${wa ? `<a class="btn" href="${esc(wa)}" rel="noopener">WhatsApp</a>` : ""}${b.email ? `<a class="btn alt" href="mailto:${esc(b.email)}">E-mail</a>` : ""}
<a class="btn alt" href="/c/${site.slug}/vcard.vcf">Salvar contato</a><a class="btn alt" href="/o/${site.slug}">Ver site</a><a class="btn alt" href="${esc(share)}" rel="noopener">Compartilhar</a></section>
${b.address ? `<section><h2>Endereço</h2><p>${esc(addrLine(b))}</p>${mapLink(b) ? `<p><a href="${esc(mapLink(b)!)}" rel="noopener">Abrir no mapa</a></p>` : ""}</section>` : ""}
<section><h2>QR Code</h2><img src="/c/${site.slug}/qr.svg" width="220" height="220" alt="QR Code para o site de ${esc(b.name)}"><p><a href="/c/${site.slug}/qr.svg" download>Baixar SVG</a> · <a href="/c/${site.slug}/qr.png" download>Baixar PNG</a></p></section></div></main>`;
  return shell(deps, site, { title: `${b.name} — Cartão digital`, desc: b.tagline || `Contatos de ${b.name}`, path: `/c/${site.slug}`, body, nonce, turnstile: false });
}

const vEsc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
function vcard(deps: Deps, site: PublicSite) {
  const b = site.config.business; const L = ["BEGIN:VCARD", "VERSION:3.0", `FN:${vEsc(b.name)}`, `ORG:${vEsc(b.name)}`, `URL:${deps.config.publicBaseUrl}/o/${site.slug}`];
  if (b.phone) L.push(`TEL;TYPE=WORK,VOICE:${b.phone.replace(/[^\d+]/g, "")}`); if (b.email) L.push(`EMAIL;TYPE=WORK:${vEsc(b.email)}`);
  if (b.address) L.push(`ADR;TYPE=WORK:;;${vEsc(b.address.street)};${vEsc(b.address.city)};${vEsc(b.address.state)};${vEsc(b.address.zip ?? "")};Brasil`);
  L.push("END:VCARD"); return L.join("\r\n") + "\r\n";
}

const LeadBody = z.object({
  name: z.string().trim().min(2).max(80), phone: z.string().trim().min(8).max(20), vehicle: z.string().trim().max(60).optional(), plate: z.string().trim().max(8).optional(),
  service: z.string().trim().max(60).optional(), description: z.string().trim().max(1000).optional(), campaign: z.string().max(40).optional(), email: z.string().trim().max(120).optional(),
});
const clean = (s: string | undefined) => (s ? s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "") : undefined);

export function registerSitePublicRoutes(r: Router, deps: Deps): void {
  const pub = { auth: "public" } as const;
  const serve = async (c: Context<AppEnv>, slug: string, page: "site" | "card", render: (site: PublicSite, nonce: string) => string) => {
    const site = await loadSite(deps, slug);
    if (!site) throw notFound("not_found");
    // Estatística anônima: sem IP/cookie/UA; ignora bots e quem pediu opt-out (DNT / GPC).
    if (!isBot(c.req.header("user-agent")) && !optedOut({ dnt: c.req.header("dnt"), gpc: c.req.header("sec-gpc") })) {
      const src = classifyReferrer(c.req.header("referer"), new URL(deps.config.publicBaseUrl).hostname);
      await deps.db.tx({ actor: "tenant", tenantId: site.tenantId, unitScope: "all" }, (q) =>
        q.query(`insert into site_stats_daily (tenant_id, day, page, source, visits) values ($1, (now() at time zone 'America/Sao_Paulo')::date, $2, $3, 1)
                 on conflict (tenant_id, day, page, source) do update set visits = site_stats_daily.visits + 1`, [site.tenantId, page, src]));
    }
    const etag = `"${site.etag}-${page}"`;
    c.header("ETag", etag); c.header("Cache-Control", PUBLIC_CACHE); c.header("Vary", "Accept-Encoding");
    if (c.req.header("if-none-match") === etag) return c.body(null, 304);
    const nonce = randomToken(12);
    c.header("Content-Security-Policy", csp(nonce, deps.captcha.name === "turnstile" && !!deps.config.turnstileSiteKey && page === "site"));
    c.header("Referrer-Policy", "strict-origin-when-cross-origin"); c.header("X-Frame-Options", "DENY");
    return c.html(render(site, nonce));
  };

  r.get("/o/:slug", pub, (c) => {
    const u = new URL(c.req.url);
    const campaign = /^[A-Za-z0-9_-]{1,40}$/.test(u.searchParams.get("utm_campaign") ?? "") ? u.searchParams.get("utm_campaign")! : undefined;
    const dynamic = u.searchParams.has("sent") || u.searchParams.has("err");
    return serve(c, (c.req.param("slug") ?? ""), "site", (site, nonce) => renderSite(deps, site, { sent: u.searchParams.get("sent") === "1", err: u.searchParams.get("err") ?? undefined, campaign }, nonce)).then((res) => {
      if (dynamic) res.headers.set("Cache-Control", "no-store"); // confirmação/erro não vai para cache compartilhado
      return res;
    });
  });
  r.get("/c/:slug", pub, (c) => serve(c, (c.req.param("slug") ?? ""), "card", (site, nonce) => renderCard(deps, site, nonce)));

  r.get("/c/:slug/vcard.vcf", pub, async (c) => {
    const site = await loadSite(deps, (c.req.param("slug") ?? "")); if (!site) throw notFound("not_found");
    c.header("Content-Type", "text/vcard; charset=utf-8"); c.header("Content-Disposition", `attachment; filename="${site.slug}.vcf"`); c.header("Cache-Control", PUBLIC_CACHE);
    return c.body(vcard(deps, site));
  });
  r.get("/c/:slug/qr.svg", pub, async (c) => {
    const site = await loadSite(deps, (c.req.param("slug") ?? "")); if (!site) throw notFound("not_found");
    c.header("Content-Type", "image/svg+xml; charset=utf-8"); c.header("Cache-Control", PUBLIC_CACHE); c.header("Content-Security-Policy", "default-src 'none'");
    return c.body(await QRCode.toString(`${deps.config.publicBaseUrl}/o/${site.slug}`, { type: "svg", margin: 2 }));
  });
  r.get("/c/:slug/qr.png", pub, async (c) => {
    const site = await loadSite(deps, (c.req.param("slug") ?? "")); if (!site) throw notFound("not_found");
    c.header("Content-Type", "image/png"); c.header("Cache-Control", PUBLIC_CACHE);
    return c.body(new Uint8Array(await QRCode.toBuffer(`${deps.config.publicBaseUrl}/o/${site.slug}`, { type: "png", margin: 2, width: 512 })));
  });

  // Mídia pública do site: somente imagens raster validadas (nunca SVG/HTML), nosniff, tenant ativo + site publicado.
  r.get("/m/:slug/:id", pub, async (c) => {
    const id = z.string().uuid().safeParse(c.req.param("id")); if (!id.success) throw notFound("not_found");
    const site = await loadSite(deps, (c.req.param("slug") ?? "")); if (!site) throw notFound("not_found");
    const m = await deps.db.publicTx((q) => q.one<{ storage_key: string; mime: string }>("select storage_key, mime from site_media where tenant_id = $1 and id = $2", [site.tenantId, id.data]));
    const bytes = m ? await deps.storage.get(m.storage_key) : null;
    if (!m || !bytes) throw notFound("not_found");
    c.header("Content-Type", m.mime); c.header("Cache-Control", "public, max-age=3600, s-maxage=86400"); c.header("Content-Security-Policy", "default-src 'none'"); c.header("Cross-Origin-Resource-Policy", "same-site");
    return c.body(bytes as unknown as ArrayBuffer);
  });

  r.get("/robots.txt", pub, (c) => { c.header("Cache-Control", PUBLIC_CACHE); return c.text(`User-agent: *\nAllow: /o/\nAllow: /c/\nDisallow: /api/\nDisallow: /portal\nSitemap: ${deps.config.publicBaseUrl}/sitemap.xml\n`); });
  r.get("/sitemap.xml", pub, async (c) => {
    const rows = await deps.db.publicTx((q: Q) => q.many<{ slug: string; published_at: Date }>(
      "select t.slug, v.published_at from tenants t join site_versions v on v.tenant_id = t.id and v.status = 'published' order by t.slug limit 50000"));
    const u = (p: string, d: Date) => `<url><loc>${esc(deps.config.publicBaseUrl + p)}</loc><lastmod>${d.toISOString().slice(0, 10)}</lastmod></url>`;
    c.header("Content-Type", "application/xml; charset=utf-8"); c.header("Cache-Control", PUBLIC_CACHE);
    return c.body(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${rows.map((x) => u(`/o/${x.slug}`, x.published_at) + u(`/c/${x.slug}`, x.published_at)).join("")}</urlset>`);
  });

  // ---- Formulário de orçamento → lead ----
  r.post("/o/:slug/lead", pub, async (c) => {
    const slug = (c.req.param("slug") ?? ""); const ipHash = c.get("ipHash");
    const wantsJson = (c.req.header("accept") ?? "").includes("application/json") || (c.req.header("content-type") ?? "").startsWith("application/json");
    const done = (ok: boolean, code?: string, status = 201) => wantsJson ? c.json(ok ? { ok: true } : { error: code }, ok ? 201 : (status as 422)) : c.redirect(`/o/${slug}?${ok ? "sent=1" : `err=${code}`}#orcamento`, 303);
    await enforceRateLimit(deps.db, [[`lead:ip:${ipHash}`, 5, 3600], [`lead:ip-day:${ipHash}`, 20, 86400], [`lead:site:${slug}`, 300, 86400]]);
    const site = await loadSite(deps, slug); if (!site) throw notFound("not_found");
    let raw: Record<string, unknown>; const files: File[] = [];
    if (wantsJson && (c.req.header("content-type") ?? "").startsWith("application/json")) raw = await parseJson(c, z.record(z.string(), z.unknown()));
    else {
      raw = await c.req.parseBody({ all: true });
      for (const f of ([] as unknown[]).concat(raw["photos"] ?? [])) if (f instanceof File && f.size > 0) files.push(f);
    }
    const str = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : undefined);
    if (str("website")) return done(true); // honeypot: finge sucesso, não cria nada
    if (!(await deps.captcha.verify(str("cf-turnstile-response"), c.req.header("cf-connecting-ip") ?? "local"))) return done(false, "captcha_failed", 403);
    const parsed = LeadBody.safeParse({ name: str("name"), phone: str("phone"), vehicle: str("vehicle") || undefined, plate: str("plate") || undefined, service: str("service") || undefined, description: str("description") || undefined, campaign: str("campaign") || undefined, email: str("email") || undefined });
    if (!parsed.success) return done(false, "invalid_fields", 422);
    const b = parsed.data; const phone = normalizePhoneBR(b.phone); if (!phone) return done(false, "invalid_phone", 422);
    const plate = b.plate ? normalizePlate(b.plate) : null; if (b.plate && !plate) return done(false, "invalid_plate", 422);
    const campaign = b.campaign && /^[A-Za-z0-9_-]{1,40}$/.test(b.campaign) ? b.campaign : null;
    if (files.length > 3) return done(false, "too_many_photos", 422);
    const photos: { bytes: Uint8Array; mime: string }[] = [];
    try {
      for (const f of files) { if (f.size > 5 * 1024 * 1024) throw new HttpError(422, "file_too_large"); const bytes = new Uint8Array(await f.arrayBuffer()); const mime = validateUpload(bytes, f.type || undefined); if (mime === "application/pdf") throw new HttpError(422, "photo_must_be_image"); photos.push({ bytes, mime }); }
    } catch (e) { if (e instanceof HttpError) return done(false, e.code, 422); throw e; }

    await deps.db.tx({ actor: "tenant", tenantId: site.tenantId, unitScope: "all" }, async (q) => {
      const unit = await q.one<{ id: string }>("select id from units where is_default and status = 'active'");
      if (!unit) throw new HttpError(503, "unit_missing");
      const lead = await q.one<{ id: string }>(
        `insert into leads (tenant_id, unit_id, source, campaign, name, phone_e164, email, vehicle, plate, service, description, ip_hash) values ($1,$2,'site',$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
        [site.tenantId, unit.id, campaign, clean(b.name), phone, clean(b.email) ?? null, clean(b.vehicle) ?? null, plate, clean(b.service) ?? null, clean(b.description) ?? null, ipHash]);
      await q.query("insert into lead_events (tenant_id, unit_id, lead_id, kind, to_status) values ($1,$2,$3,'created','new')", [site.tenantId, unit.id, lead!.id]);
      for (const p of photos) {
        const id = crypto.randomUUID(); const key = `${site.tenantId}/leads/${lead!.id}/${id}`; const sha = await sha256Hex(Buffer.from(p.bytes).toString("binary"));
        await deps.storage.put(key, p.bytes);
        await q.query("insert into lead_media (id, tenant_id, unit_id, lead_id, storage_key, mime, size_bytes, sha256) values ($1,$2,$3,$4,$5,$6,$7,$8)", [id, site.tenantId, unit.id, lead!.id, key, p.mime, p.bytes.length, sha]);
      }
      await q.query("insert into outbox (tenant_id, unit_id, kind, payload) values ($1,$2,'lead.new',$3)", [site.tenantId, unit.id, JSON.stringify({ leadId: lead!.id, title: `Novo pedido de orçamento: ${clean(b.name)}` })]);
    });
    return done(true);
  });
}
