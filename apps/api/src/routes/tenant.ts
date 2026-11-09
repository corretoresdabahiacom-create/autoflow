import { UNIT_CODE_PATTERN, canGrantRole, checkLimit } from "@autoflow/shared";
import { z } from "zod";
import { audit } from "../audit";
import { randomToken, sha256Hex } from "../crypto";
import { type DbContext } from "../db";
import { HttpError, conflict, forbidden, notFound, parseJson } from "../http";
import type { Router } from "../router";
import type { Deps, TenantPrincipal } from "../types";

export const tctx = (p: TenantPrincipal): DbContext => ({
  actor: "tenant",
  tenantId: p.tenantId,
  userId: p.userId,
  unitScope: p.unitScope,
  unitIds: p.unitIds,
});

const UnitBody = z.object({ name: z.string().trim().min(2).max(80), code: z.string().regex(UNIT_CODE_PATTERN) });
const InviteBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  roleKey: z.string().min(2).max(40),
  allUnits: z.boolean().default(false),
  unitIds: z.array(z.string().uuid()).max(50).default([]),
});
const RoleChangeBody = z.object({ roleKey: z.string().min(2).max(40) });
const MemberStatusBody = z.object({ status: z.enum(["active", "suspended"]) });
const uuidParam = z.string().uuid();

export function registerTenantRoutes(r: Router, deps: Deps): void {
  r.get("/tenant", { auth: "tenant", permission: "tenant:read" }, async (c) => {
    const p = c.get("tenant");
    const row = await deps.db.tx(tctx(p), (q) => q.one("select id, name, slug, status from tenants where id = $1", [p.tenantId]));
    return c.json(row);
  });

  r.get("/tenant/entitlements", { auth: "tenant", permission: "subscription:read" }, (c) => {
    const e = c.get("tenant").entitlements;
    return c.json({ status: e.subscriptionStatus, values: e.values });
  });

  // ---- Unidades ----
  r.get("/units", { auth: "tenant", permission: "units:read" }, async (c) => {
    const p = c.get("tenant");
    const rows = await deps.db.tx(tctx(p), (q) => q.many("select id, name, code, is_default from units order by created_at"));
    return c.json({ units: rows });
  });

  r.post("/units", { auth: "tenant", permission: "units:manage" }, async (c) => {
    const p = c.get("tenant");
    const body = await parseJson(c, UnitBody);
    const unit = await deps.db.tx(tctx(p), async (q) => {
      const cnt = await q.one<{ n: string }>("select count(*) as n from units");
      const lim = checkLimit(p.entitlements, "units.max", Number(cnt?.n ?? 0));
      if (!lim.ok) throw new HttpError(403, "limit_reached", `units.max=${lim.limit}`);
      try {
        const u = await q.one<{ id: string }>(
          "insert into units (tenant_id, name, code) values ($1,$2,$3) returning id",
          [p.tenantId, body.name, body.code],
        );
        await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "unit.create", entityType: "unit", entityId: u?.id, requestId: c.get("requestId") });
        return u;
      } catch (e) {
        if ((e as { code?: string }).code === "23505") throw conflict("unit_code_exists");
        throw e;
      }
    });
    return c.json(unit, 201);
  });

  // ---- Membros ----
  r.get("/members", { auth: "tenant", permission: "members:read" }, async (c) => {
    const p = c.get("tenant");
    const rows = await deps.db.tx(tctx(p), (q) =>
      q.many(
        `select m.id, u.email, r.key as role, m.status, m.all_units
           from memberships m join users u on u.id = m.user_id join roles r on r.id = m.role_id
          order by m.created_at`,
      ),
    );
    return c.json({ members: rows });
  });

  async function rolePerms(q: import("../db").Q, tenantId: string, roleKey: string) {
    const role = await q.one<{ id: string }>(
      "select id from roles where key = $1 and (tenant_id = $2 or tenant_id is null) order by tenant_id nulls last limit 1",
      [roleKey, tenantId],
    );
    if (!role) throw notFound("role_not_found");
    const perms = (await q.many<{ permission_code: string }>("select permission_code from role_permissions where role_id = $1", [role.id])).map((x) => x.permission_code);
    return { id: role.id, perms };
  }

  r.post("/members/invite", { auth: "tenant", permission: "members:manage" }, async (c) => {
    const p = c.get("tenant");
    const body = await parseJson(c, InviteBody);
    const token = randomToken(32);
    const tokenHash = await sha256Hex(token);
    const result = await deps.db.tx(tctx(p), async (q) => {
      const role = await rolePerms(q, p.tenantId, body.roleKey);
      if (!canGrantRole(p.permissions, role.perms)) throw forbidden("role_escalation");
      const cnt = await q.one<{ n: string }>("select count(*) as n from memberships where status <> 'suspended'");
      const lim = checkLimit(p.entitlements, "users.max", Number(cnt?.n ?? 0));
      if (!lim.ok) throw new HttpError(403, "limit_reached", `users.max=${lim.limit}`);
      if (!body.allUnits && body.unitIds.length === 0) throw new HttpError(422, "validation_error", "unitIds ou allUnits");

      let user = await q.one<{ id: string }>("select id from users where email = $1", [body.email]);
      if (!user) user = await q.one<{ id: string }>("insert into users (email) values ($1) returning id", [body.email]);
      const exists = await q.one("select 1 from memberships where user_id = $1", [user!.id]);
      if (exists) throw conflict("already_member");
      const m = await q.one<{ id: string }>(
        "insert into memberships (tenant_id, user_id, role_id, all_units) values ($1,$2,$3,$4) returning id",
        [p.tenantId, user!.id, role.id, body.allUnits],
      );
      if (!body.allUnits) {
        for (const unitId of body.unitIds) {
          // FK composta (tenant_id, unit_id) impede unidade de outro tenant.
          await q.query("insert into unit_memberships (tenant_id, membership_id, unit_id) values ($1,$2,$3)", [p.tenantId, m!.id, unitId]);
        }
      }
      await q.query(
        "insert into auth_tokens (kind, token_hash, user_id, tenant_id, membership_id, expires_at) values ('invite',$1,$2,$3,$4, now() + interval '72 hours')",
        [tokenHash, user!.id, p.tenantId, m!.id],
      );
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "member.invite", entityType: "membership", entityId: m!.id, requestId: c.get("requestId"), metadata: { role: body.roleKey } });
      return { membershipId: m!.id };
    });
    try {
      await deps.email.send({ to: body.email, template: "invite", vars: { token } });
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
    }
    return c.json({ ...result, ...(deps.config.exposeDevTokens ? { devToken: token } : {}) }, 201);
  });

  r.patch("/members/:id/role", { auth: "tenant", permission: "members:manage" }, async (c) => {
    const p = c.get("tenant");
    const id = uuidParam.parse(c.req.param("id"));
    const body = await parseJson(c, RoleChangeBody);
    await deps.db.tx(tctx(p), async (q) => {
      const role = await rolePerms(q, p.tenantId, body.roleKey);
      if (!canGrantRole(p.permissions, role.perms)) throw forbidden("role_escalation");
      const cur = await q.one<{ role_key: string; status: string }>(
        "select r.key as role_key, m.status from memberships m join roles r on r.id = m.role_id where m.id = $1 for update of m",
        [id],
      );
      if (!cur) throw notFound("member_not_found");
      if (cur.role_key === "owner" && body.roleKey !== "owner") await assertNotLastOwner(q);
      await q.query("update memberships set role_id = $2 where id = $1", [id, role.id]);
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "member.role_change", entityType: "membership", entityId: id, requestId: c.get("requestId"), metadata: { to: body.roleKey } });
    });
    return c.json({ ok: true });
  });

  r.patch("/members/:id/status", { auth: "tenant", permission: "members:manage" }, async (c) => {
    const p = c.get("tenant");
    const id = uuidParam.parse(c.req.param("id"));
    const body = await parseJson(c, MemberStatusBody);
    await deps.db.tx(tctx(p), async (q) => {
      const cur = await q.one<{ role_key: string; status: string }>(
        "select r.key as role_key, m.status from memberships m join roles r on r.id = m.role_id where m.id = $1 for update of m",
        [id],
      );
      if (!cur) throw notFound("member_not_found");
      if (cur.status === "invited") throw conflict("member_not_accepted");
      if (body.status === "suspended" && cur.role_key === "owner") await assertNotLastOwner(q);
      await q.query("update memberships set status = $2 where id = $1", [id, body.status]);
      if (body.status === "suspended") {
        await q.query("update sessions set revoked_at = now() where membership_id = $1 and revoked_at is null", [id]).catch(() => undefined);
      }
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "member.status", entityType: "membership", entityId: id, requestId: c.get("requestId"), metadata: { status: body.status } });
    });
    return c.json({ ok: true });
  });

  r.get("/roles", { auth: "tenant", permission: "roles:read" }, async (c) => {
    const p = c.get("tenant");
    const rows = await deps.db.tx(tctx(p), (q) =>
      q.many(
        `select r.key, r.name, coalesce(array_agg(rp.permission_code order by rp.permission_code) filter (where rp.permission_code is not null), '{}') as permissions
           from roles r left join role_permissions rp on rp.role_id = r.id
          group by r.id order by r.key`,
      ),
    );
    return c.json({ roles: rows });
  });

  r.get("/audit", { auth: "tenant", permission: "audit:read" }, async (c) => {
    const p = c.get("tenant");
    const rows = await deps.db.tx(tctx(p), (q) =>
      q.many("select id, action, actor_type, actor_id, entity_type, entity_id, created_at from audit_log order by id desc limit 100"),
    );
    return c.json({ events: rows });
  });
}

async function assertNotLastOwner(q: import("../db").Q): Promise<void> {
  const n = await q.one<{ n: string }>(
    "select count(*) as n from memberships m join roles r on r.id = m.role_id where r.key = 'owner' and m.status = 'active'",
  );
  if (Number(n?.n ?? 0) <= 1) throw conflict("last_owner");
}
