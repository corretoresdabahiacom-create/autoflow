import { LEAD_STATUSES, defaultSiteConfig, templateContrastErrors, validateSiteConfig, type SiteConfig, type TemplateName, TEMPLATES } from "@autoflow/shared";
import { z } from "zod";
import { audit } from "../audit";
import { sha256Hex } from "../crypto";
import type { Q } from "../db";
import { HttpError, conflict, notFound, parseJson } from "../http";
import type { Router } from "../router";
import { validateUpload } from "../storage";
import type { Deps, TenantPrincipal } from "../types";
import { tctx } from "./tenant";

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function registerSiteAdminRoutes(r: Router, deps: Deps): void {
  const SITE = { auth: "tenant", permission: "site:manage" } as const;
  const LR = { auth: "tenant", permission: "leads:read" } as const;
  const LM = { auth: "tenant", permission: "leads:manage" } as const;
  const tx = <T>(p: TenantPrincipal, fn: (q: Q) => Promise<T>) => deps.db.tx(tctx(p), fn);
  const nextNo = (q: Q) => q.one<{ n: number }>("select coalesce(max(version_no),0)+1 as n from site_versions").then((x) => x!.n);
  const problems = (config: unknown, template: string) => [...validateSiteConfig(config, template), ...((TEMPLATES as readonly string[]).includes(template) ? templateContrastErrors(template as TemplateName) : [])];
  const etagOf = (template: string, config: unknown, no: number) => sha256Hex(JSON.stringify([no, template, config])).then((h) => h.slice(0, 24));

  r.get("/site", SITE, async (c) => {
    const p = c.get("tenant");
    const out = await tx(p, async (q) => {
      const t = await q.one<{ slug: string; name: string }>("select slug, name from tenants where id = $1", [p.tenantId]);
      const vs = await q.many<any>("select id, version_no, status, template, config, published_at from site_versions where status in ('draft','published')");
      return { slug: t!.slug, publicUrl: `${deps.config.publicBaseUrl}/o/${t!.slug}`, cardUrl: `${deps.config.publicBaseUrl}/c/${t!.slug}`, templates: TEMPLATES,
        draft: vs.find((v) => v.status === "draft") ?? null, published: vs.find((v) => v.status === "published") ?? null, defaults: defaultSiteConfig(t!.name) };
    });
    return c.json(out);
  });

  r.put("/site/draft", SITE, async (c) => {
    const p = c.get("tenant");
    const b = await parseJson(c, z.object({ template: z.string(), config: z.unknown() }));
    const errs = problems(b.config, b.template);
    if (errs.length) return c.json({ error: "invalid_site", errors: errs }, 422);
    await tx(p, async (q) => {
      const d = await q.one<{ id: string }>("select id from site_versions where status = 'draft'");
      if (d) await q.query("update site_versions set template = $2, config = $3 where id = $1", [d.id, b.template, JSON.stringify(b.config)]);
      else await q.query("insert into site_versions (tenant_id, version_no, status, template, config, created_by) values ($1,$2,'draft',$3,$4,$5)", [p.tenantId, await nextNo(q), b.template, JSON.stringify(b.config), p.userId]);
    });
    return c.json({ ok: true });
  });

  r.post("/site/publish", SITE, async (c) => {
    const p = c.get("tenant");
    const out = await tx(p, async (q) => {
      const d = await q.one<{ id: string; template: string; config: SiteConfig; version_no: number }>("select id, template, config, version_no from site_versions where status = 'draft'");
      if (!d) throw conflict("no_draft");
      const errs = problems(d.config, d.template);
      if (errs.length) return { errs };
      const etag = await etagOf(d.template, d.config, d.version_no);
      await q.query("update site_versions set status = 'superseded' where status = 'published'");
      await q.query("update site_versions set status = 'published', published_at = now(), etag = $2 where id = $1", [d.id, etag]);
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "site.publish", entityType: "site", entityId: d.id, requestId: c.get("requestId") });
      return { etag };
    });
    if ("errs" in out) return c.json({ error: "invalid_site", errors: out.errs }, 422);
    return c.json({ ok: true, etag: out.etag });
  });

  r.get("/site/versions", SITE, async (c) => {
    const p = c.get("tenant");
    return c.json({ versions: await tx(p, (q) => q.many("select id, version_no, status, template, published_at, created_at from site_versions order by version_no desc limit 50")) });
  });
  // Restaurar = nova versão publicada com a configuração escolhida, revalidada pelas regras ATUAIS.
  r.post("/site/versions/:id/restore", SITE, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id"));
    const out = await tx(p, async (q) => {
      const v = await q.one<{ template: string; config: SiteConfig }>("select template, config from site_versions where id = $1", [id]);
      if (!v) throw notFound("version_not_found");
      const errs = problems(v.config, v.template); if (errs.length) return { errs };
      const no = await nextNo(q); const etag = await etagOf(v.template, v.config, no);
      await q.query("update site_versions set status = 'superseded' where status in ('published','draft')");
      await q.query("insert into site_versions (tenant_id, version_no, status, template, config, etag, created_by, published_at) values ($1,$2,'published',$3,$4,$5,$6,now())", [p.tenantId, no, v.template, JSON.stringify(v.config), etag, p.userId]);
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "site.restore", entityType: "site", entityId: id, requestId: c.get("requestId") });
      return { etag };
    });
    if ("errs" in out) return c.json({ error: "invalid_site", errors: out.errs }, 422);
    return c.json({ ok: true, etag: out.etag });
  });

  r.post("/site/media", SITE, async (c) => {
    const p = c.get("tenant");
    const f = (await c.req.parseBody())["file"];
    if (!(f instanceof File)) throw new HttpError(422, "file_required");
    if (f.size > 5 * 1024 * 1024) throw new HttpError(422, "file_too_large");
    const bytes = new Uint8Array(await f.arrayBuffer());
    const mime = validateUpload(bytes, f.type || undefined);
    if (mime === "application/pdf") throw new HttpError(422, "photo_must_be_image");
    const id = crypto.randomUUID(); const key = `${p.tenantId}/site/${id}`;
    await deps.storage.put(key, bytes);
    await tx(p, async (q) => q.query("insert into site_media (id, tenant_id, storage_key, mime, size_bytes, sha256, created_by) values ($1,$2,$3,$4,$5,$6,$7)", [id, p.tenantId, key, mime, bytes.length, await sha256Hex(Buffer.from(bytes).toString("binary")), p.userId]));
    return c.json({ id }, 201);
  });
  r.get("/site/media", SITE, async (c) => { const p = c.get("tenant"); return c.json({ media: await tx(p, (q) => q.many("select id, mime, size_bytes, created_at from site_media order by created_at desc limit 200")) }); });

  r.get("/site/stats", SITE, async (c) => {
    const p = c.get("tenant");
    const { from, to } = z.object({ from: date, to: date }).parse(Object.fromEntries(new URL(c.req.url).searchParams));
    const rows = await tx(p, (q) => q.many<any>("select day::text, page, source, visits from site_stats_daily where day between $1 and $2 order by day", [from, to]));
    const total = (page: string) => rows.filter((r) => r.page === page).reduce((s, r) => s + r.visits, 0);
    const leads = await tx(p, (q) => q.one<{ n: number }>("select count(*)::int n from leads where created_at::date between $1 and $2", [from, to]));
    return c.json({ rows, totals: { site: total("site"), card: total("card"), leads: leads!.n }, note: "Contagem anônima no servidor de origem: sem cookies, IP ou user-agent; bots filtrados; DNT/GPC respeitados. Páginas servidas do cache de borda não são contadas." });
  });

  // ---- CRM básico ----
  r.get("/leads", LR, async (c) => {
    const p = c.get("tenant"); const status = c.req.query("status");
    if (status) z.enum(LEAD_STATUSES).parse(status);
    const out = await tx(p, async (q) => ({
      leads: await q.many("select id, name, phone_e164, vehicle, plate, service, status, source, campaign, created_at from leads where ($1::text is null or status = $1) order by created_at desc limit 200", [status ?? null]),
      counts: Object.fromEntries((await q.many<{ status: string; n: number }>("select status, count(*)::int n from leads group by status")).map((x) => [x.status, x.n])),
    }));
    return c.json(out);
  });
  r.get("/leads/:id", LR, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id"));
    const out = await tx(p, async (q) => {
      const l = await q.one<any>("select id, unit_id, name, phone_e164, email, vehicle, plate, service, description, status, lost_reason, source, campaign, created_at from leads where id = $1", [id]);
      if (!l) throw notFound("lead_not_found");
      return { ...l, events: await q.many("select kind, from_status, to_status, note, at from lead_events where lead_id = $1 order by id", [id]), media: await q.many("select id, mime, size_bytes from lead_media where lead_id = $1", [id]) };
    });
    return c.json(out);
  });
  r.get("/leads/:id/media/:mediaId", LR, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id")); const mid = uuid.parse(c.req.param("mediaId"));
    const m = await tx(p, (q) => q.one<{ storage_key: string; mime: string }>("select storage_key, mime from lead_media where lead_id = $1 and id = $2", [id, mid]));
    const bytes = m ? await deps.storage.get(m.storage_key) : null;
    if (!m || !bytes) throw notFound("media_not_found");
    c.header("Content-Type", m.mime); c.header("Content-Disposition", "inline"); c.header("Content-Security-Policy", "default-src 'none'");
    return c.body(bytes as unknown as ArrayBuffer);
  });
  r.patch("/leads/:id/status", LM, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id"));
    const b = await parseJson(c, z.object({ status: z.enum(LEAD_STATUSES), note: z.string().trim().max(1000).optional(), lostReason: z.string().trim().min(3).max(300).optional() }));
    if (b.status === "lost" && !b.lostReason) throw new HttpError(422, "lost_reason_required");
    await tx(p, async (q) => {
      const l = await q.one<{ status: string; unit_id: string }>("select status, unit_id from leads where id = $1 for update", [id]);
      if (!l) throw notFound("lead_not_found");
      if (l.status === b.status) return;
      await q.query("update leads set status = $2, lost_reason = $3, updated_at = now() where id = $1", [id, b.status, b.status === "lost" ? b.lostReason : null]);
      await q.query("insert into lead_events (tenant_id, unit_id, lead_id, kind, from_status, to_status, note, user_id) values ($1,$2,$3,'status',$4,$5,$6,$7)", [p.tenantId, l.unit_id, id, l.status, b.status, b.note ?? b.lostReason ?? null, p.userId]);
    });
    return c.json({ ok: true });
  });
  r.post("/leads/:id/notes", LM, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id"));
    const b = await parseJson(c, z.object({ note: z.string().trim().min(1).max(1000) }));
    await tx(p, async (q) => {
      const l = await q.one<{ unit_id: string }>("select unit_id from leads where id = $1", [id]); if (!l) throw notFound("lead_not_found");
      await q.query("insert into lead_events (tenant_id, unit_id, lead_id, kind, note, user_id) values ($1,$2,$3,'note',$4,$5)", [p.tenantId, l.unit_id, id, b.note, p.userId]);
    });
    return c.json({ ok: true }, 201);
  });
}
