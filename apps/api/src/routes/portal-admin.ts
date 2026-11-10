import { DEFAULT_THEME, validateTheme, type ThemeConfig } from "@autoflow/shared";
import QRCode from "qrcode";
import { z } from "zod";
import { audit } from "../audit";
import type { Q } from "../db";
import { HttpError, conflict, notFound, parseJson } from "../http";
import type { Router } from "../router";
import type { Deps } from "../types";
import { newPortalLink } from "./portal";
import { tctx } from "./tenant";

const uuid = z.string().uuid();
const ThemeBody = z.object({
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  welcomeText: z.string().trim().max(500).optional(),
  hidden: z.array(z.string().max(30)).max(10).default([]),
});

async function orderRow(q: Q, id: string) {
  const o = await q.one<{ id: string; unit_id: string; status: string }>("select id, unit_id, status from service_orders where id = $1", [id]);
  if (!o) throw notFound("order_not_found");
  return o;
}

export function registerPortalAdminRoutes(r: Router, deps: Deps): void {
  const pol = { auth: "tenant", permission: "portal:manage", feature: "portal" } as const;
  const base = deps.config.portalBaseUrl.replace(/\/$/, "");

  const issue = async (q: Q, p: { tenantId: string; userId: string }, o: { id: string; unit_id: string; status: string }, reqId: string, action: string) => {
    const delivered = o.status === "delivered" || o.status === "cancelled";
    const link = await newPortalLink(q, p.tenantId, o.unit_id, o.id, p.userId, delivered);
    const url = `${base}/portal#${link.token}`; // token no fragmento: não vai ao servidor nem a logs
    await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action, entityType: "order", entityId: o.id, requestId: reqId, metadata: { linkId: link.id } });
    return { id: link.id, url, expiresAt: link.expiresAt, qrSvg: await QRCode.toString(url, { type: "svg", margin: 1 }) };
  };

  r.post("/orders/:id/portal-link", pol, async (c) => {
    const p = c.get("tenant");
    const id = uuid.parse(c.req.param("id"));
    return c.json(await deps.db.tx(tctx(p), async (q) => issue(q, p, await orderRow(q, id), c.get("requestId"), "portal.link_create")), 201);
  });

  r.get("/orders/:id/portal-links", pol, async (c) => {
    const p = c.get("tenant");
    const id = uuid.parse(c.req.param("id"));
    const rows = await deps.db.tx(tctx(p), (q) => q.many("select id, created_at, expires_at, revoked_at, last_used_at from portal_links where os_id = $1 order by created_at desc", [id]));
    return c.json({ links: rows });
  });

  r.post("/orders/:id/portal-links/:linkId/revoke", pol, async (c) => {
    const p = c.get("tenant");
    const id = uuid.parse(c.req.param("id")); const linkId = uuid.parse(c.req.param("linkId"));
    await deps.db.tx(tctx(p), async (q) => {
      const l = await q.one<{ id: string }>("update portal_links set revoked_at = now() where id = $1 and os_id = $2 and revoked_at is null returning id", [linkId, id]);
      if (!l) throw notFound("link_not_found");
      await q.query("update portal_sessions set revoked_at = now() where link_id = $1 and revoked_at is null", [linkId]);
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "portal.link_revoke", entityType: "order", entityId: id, requestId: c.get("requestId"), metadata: { linkId } });
    });
    return c.json({ ok: true });
  });

  // Renovação: apenas pela equipe (verificada); revoga os ativos e emite novo link.
  r.post("/orders/:id/portal-links/renew", pol, async (c) => {
    const p = c.get("tenant");
    const id = uuid.parse(c.req.param("id"));
    return c.json(await deps.db.tx(tctx(p), async (q) => {
      const o = await orderRow(q, id);
      await q.query("update portal_sessions set revoked_at = now() where os_id = $1 and revoked_at is null", [id]);
      await q.query("update portal_links set revoked_at = now() where os_id = $1 and revoked_at is null", [id]);
      return issue(q, p, o, c.get("requestId"), "portal.link_renew");
    }), 201);
  });

  r.get("/orders/:id/portal-access-log", pol, async (c) => {
    const p = c.get("tenant");
    const id = uuid.parse(c.req.param("id"));
    return c.json({ log: await deps.db.tx(tctx(p), (q) => q.many("select event, at, user_agent from portal_access_log where os_id = $1 order by id desc limit 200", [id])) });
  });

  r.put("/attachments/:id/portal-visibility", { auth: "tenant", permission: "portal:manage" }, async (c) => {
    const p = c.get("tenant");
    const id = uuid.parse(c.req.param("id"));
    const b = await parseJson(c, z.object({ visible: z.boolean() }));
    const ok = await deps.db.tx(tctx(p), (q) => q.one("update attachments set portal_visible = $2 where id = $1 returning id", [id, b.visible]));
    if (!ok) throw notFound("attachment_not_found");
    return c.json({ ok: true });
  });

  r.put("/portal/settings", pol, async (c) => {
    const p = c.get("tenant");
    const b = await parseJson(c, z.object({ linkTtlDays: z.number().int().min(1).max(365) }));
    await deps.db.tx(tctx(p), (q) => q.query(
      "insert into portal_settings (tenant_id, link_ttl_days) values ($1,$2) on conflict (tenant_id) do update set link_ttl_days = excluded.link_ttl_days", [p.tenantId, b.linkTtlDays]));
    return c.json({ ok: true });
  });

  // Mensagens da oficina
  r.post("/orders/:id/portal-messages", { auth: "tenant", permission: "orders:manage", feature: "portal" }, async (c) => {
    const p = c.get("tenant");
    const id = uuid.parse(c.req.param("id"));
    const b = await parseJson(c, z.object({ body: z.string().trim().min(1).max(2000) }));
    await deps.db.tx(tctx(p), async (q) => {
      const o = await orderRow(q, id);
      await q.query("insert into portal_messages (tenant_id, unit_id, os_id, sender, body, sender_user) values ($1,$2,$3,'staff',$4,$5)", [p.tenantId, o.unit_id, id, b.body, p.userId]);
    });
    return c.json({ ok: true }, 201);
  });
  r.get("/orders/:id/portal-messages", { auth: "tenant", permission: "orders:read", feature: "portal" }, async (c) => {
    const p = c.get("tenant");
    const id = uuid.parse(c.req.param("id"));
    return c.json({ messages: await deps.db.tx(tctx(p), (q) => q.many("select sender, body, created_at from portal_messages where os_id = $1 order by created_at", [id])) });
  });

  // ---- Tema: rascunho → publicar → restaurar ----
  r.get("/portal/theme", pol, async (c) => {
    const p = c.get("tenant");
    const rows = await deps.db.tx(tctx(p), (q) => q.many("select id, version_no, status, config, published_at from portal_theme_versions order by version_no desc limit 20"));
    return c.json({ versions: rows, default: DEFAULT_THEME });
  });

  r.put("/portal/theme/draft", pol, async (c) => {
    const p = c.get("tenant");
    const b = await parseJson(c, ThemeBody);
    const config = b as ThemeConfig;
    const errors = validateTheme(config);
    if (errors.length) return c.json({ error: "invalid_theme", errors }, 422);
    await deps.db.tx(tctx(p), async (q) => {
      const d = await q.one<{ id: string }>("select id from portal_theme_versions where status = 'draft'");
      if (d) await q.query("update portal_theme_versions set config = $2 where id = $1", [d.id, JSON.stringify(config)]);
      else await q.query(
        `insert into portal_theme_versions (tenant_id, version_no, status, config, created_by)
         values ($1, coalesce((select max(version_no) from portal_theme_versions), 0) + 1, 'draft', $2, $3)`, [p.tenantId, JSON.stringify(config), p.userId]);
    });
    return c.json({ ok: true });
  });

  r.post("/portal/theme/publish", pol, async (c) => {
    const p = c.get("tenant");
    await deps.db.tx(tctx(p), async (q) => {
      const d = await q.one<{ id: string; config: ThemeConfig }>("select id, config from portal_theme_versions where status = 'draft'");
      if (!d) throw conflict("no_draft");
      const errors = validateTheme(d.config);
      if (errors.length) throw new HttpError(422, "invalid_theme");
      await q.query("update portal_theme_versions set status = 'superseded' where status = 'published'");
      await q.query("update portal_theme_versions set status = 'published', published_at = now() where id = $1", [d.id]);
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "portal.theme_publish", entityType: "portal_theme", entityId: d.id, requestId: c.get("requestId") });
    });
    return c.json({ ok: true });
  });

  // Restaurar = nova versão publicada com a configuração da escolhida (histórico preservado).
  r.post("/portal/theme/:id/restore", pol, async (c) => {
    const p = c.get("tenant");
    const id = uuid.parse(c.req.param("id"));
    await deps.db.tx(tctx(p), async (q) => {
      const v = await q.one<{ config: ThemeConfig }>("select config from portal_theme_versions where id = $1", [id]);
      if (!v) throw notFound("theme_not_found");
      await q.query("update portal_theme_versions set status = 'superseded' where status = 'published'");
      await q.query("update portal_theme_versions set status = 'superseded' where status = 'draft'");
      await q.query(
        `insert into portal_theme_versions (tenant_id, version_no, status, config, created_by, published_at)
         values ($1, coalesce((select max(version_no) from portal_theme_versions), 0) + 1, 'published', $2, $3, now())`,
        [p.tenantId, JSON.stringify(v.config), p.userId]);
    });
    return c.json({ ok: true });
  });

  // ---- Consentimento de notificações ----
  r.post("/customers/:id/consents", { auth: "tenant", permission: "customers:manage" }, async (c) => {
    const p = c.get("tenant");
    const id = uuid.parse(c.req.param("id"));
    const b = await parseJson(c, z.object({ channel: z.enum(["email", "whatsapp", "sms"]), granted: z.boolean() }));
    await deps.db.tx(tctx(p), async (q) => {
      if (b.granted) await q.query("insert into consents (tenant_id, subject_ref, purpose, channel, evidence) values ($1,$2,'order_notifications',$3,$4)", [p.tenantId, `customer:${id}`, b.channel, JSON.stringify({ by: p.userId, via: "staff" })]);
      else await q.query("update consents set revoked_at = now() where subject_ref = $1 and purpose = 'order_notifications' and channel = $2 and revoked_at is null", [`customer:${id}`, b.channel]);
    });
    return c.json({ ok: true }, 201);
  });
}
