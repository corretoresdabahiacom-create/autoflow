import { normalizePhoneBR, normalizePlate } from "@autoflow/shared";
import { z } from "zod";
import { audit } from "../audit";
import { HttpError, conflict, notFound, parseJson } from "../http";
import type { Router } from "../router";
import type { Deps } from "../types";
import { tctx } from "./tenant";

const phone = z.string().trim().max(30).transform((v, ctx) => {
  const n = normalizePhoneBR(v);
  if (!n) ctx.addIssue({ code: "custom", message: "telefone inválido" });
  return n as string;
});
const CustomerBody = z.object({
  name: z.string().trim().min(2).max(120),
  phone: phone.optional(),
  email: z.string().trim().toLowerCase().email().max(254).optional(),
  origin: z.string().trim().max(60).optional(),
  marketingOptIn: z.boolean().default(false),
});
const CustomerPatch = CustomerBody.partial();
const plate = z.string().trim().max(12).transform((v, ctx) => {
  const n = normalizePlate(v);
  if (!n) ctx.addIssue({ code: "custom", message: "placa inválida" });
  return n as string;
});
const VehicleBody = z.object({
  plate,
  make: z.string().trim().max(60).optional(),
  model: z.string().trim().max(60).optional(),
  year: z.number().int().min(1900).max(2100).optional(),
  km: z.number().int().min(0).max(5_000_000).optional(),
  fuel: z.string().trim().max(30).optional(),
});
const uuid = z.string().uuid();

export function registerCustomerRoutes(r: Router, deps: Deps): void {
  r.post("/customers", { auth: "tenant", permission: "customers:manage" }, async (c) => {
    const p = c.get("tenant");
    const b = await parseJson(c, CustomerBody);
    const row = await deps.db.tx(tctx(p), async (q) => {
      const x = await q.one<{ id: string }>(
        "insert into customers (tenant_id, name, phone_e164, email, origin, marketing_opt_in) values ($1,$2,$3,$4,$5,$6) returning id",
        [p.tenantId, b.name, b.phone ?? null, b.email ?? null, b.origin ?? null, b.marketingOptIn],
      );
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "customer.create", entityType: "customer", entityId: x!.id, requestId: c.get("requestId") });
      return x;
    });
    return c.json(row, 201);
  });

  r.get("/customers", { auth: "tenant", permission: "customers:read" }, async (c) => {
    const p = c.get("tenant");
    const rows = await deps.db.tx(tctx(p), (q) => q.many("select id, name, phone_e164, email from customers order by created_at desc limit 100"));
    return c.json({ customers: rows });
  });

  r.get("/customers/:id", { auth: "tenant", permission: "customers:read" }, async (c) => {
    const p = c.get("tenant");
    const id = uuid.parse(c.req.param("id"));
    const out = await deps.db.tx(tctx(p), async (q) => {
      const cu = await q.one("select id, name, phone_e164, email, origin, marketing_opt_in from customers where id = $1", [id]);
      if (!cu) throw notFound("customer_not_found");
      const vehicles = await q.many("select id, plate, make, model, year, km, fuel from vehicles where customer_id = $1 order by created_at", [id]);
      return { ...cu, vehicles };
    });
    return c.json(out);
  });

  r.patch("/customers/:id", { auth: "tenant", permission: "customers:manage" }, async (c) => {
    const p = c.get("tenant");
    const id = uuid.parse(c.req.param("id"));
    const b = await parseJson(c, CustomerPatch);
    await deps.db.tx(tctx(p), async (q) => {
      const res = await q.query(
        `update customers set name = coalesce($2, name), phone_e164 = coalesce($3, phone_e164), email = coalesce($4, email),
                origin = coalesce($5, origin), marketing_opt_in = coalesce($6, marketing_opt_in) where id = $1`,
        [id, b.name ?? null, b.phone ?? null, b.email ?? null, b.origin ?? null, b.marketingOptIn ?? null],
      );
      if (res.rowCount !== 1) throw notFound("customer_not_found");
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "customer.update", entityType: "customer", entityId: id, requestId: c.get("requestId") });
    });
    return c.json({ ok: true });
  });

  r.post("/customers/:id/vehicles", { auth: "tenant", permission: "customers:manage" }, async (c) => {
    const p = c.get("tenant");
    const customerId = uuid.parse(c.req.param("id"));
    const b = await parseJson(c, VehicleBody);
    const row = await deps.db.tx(tctx(p), async (q) => {
      const cu = await q.one("select 1 from customers where id = $1", [customerId]);
      if (!cu) throw notFound("customer_not_found");
      try {
        const v = await q.one<{ id: string }>(
          "insert into vehicles (tenant_id, customer_id, plate, make, model, year, km, fuel) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id",
          [p.tenantId, customerId, b.plate, b.make ?? null, b.model ?? null, b.year ?? null, b.km ?? null, b.fuel ?? null],
        );
        await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "vehicle.create", entityType: "vehicle", entityId: v!.id, requestId: c.get("requestId") });
        return v;
      } catch (e) {
        if ((e as { code?: string }).code === "23505") throw conflict("plate_exists");
        throw e;
      }
    });
    return c.json(row, 201);
  });

  // ---- Busca unificada: placa / telefone / nome / nº da OS ----
  r.get("/search", { auth: "tenant", permission: "customers:read" }, async (c) => {
    const p = c.get("tenant");
    const raw = (c.req.query("q") ?? "").trim();
    const numericQuery = /^[\d\s()+\-.]+$/.test(raw);
    if (raw.length < (numericQuery ? 1 : 2) || raw.length > 60) throw new HttpError(422, "query_length"); // nº de OS pode ter 1 dígito

    const plateExact = normalizePlate(raw);
    const alnum = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const platePrefix = !plateExact && alnum.length >= 3 && /^[A-Z]{3}/.test(alnum) ? alnum : null;
    const isNumeric = /^[\d\s()+\-.]+$/.test(raw);
    const digits = raw.replace(/\D/g, "");
    const phoneExact = isNumeric ? normalizePhoneBR(raw) : null;
    const phonePrefixes = isNumeric && digits.length >= 8 ? [`+55${digits}`, `+${digits}`] : [];
    const osNumber = isNumeric && digits.length >= 1 && digits.length <= 7 && !phoneExact ? Number(digits) : null;
    const nameLike = !isNumeric && raw.length >= 3 ? `%${raw.replace(/[\\%_]/g, "\\$&")}%` : null;

    const out = await deps.db.tx(tctx(p), async (q) => {
      const customers = await q.many(
        `select id, name, phone_e164 from customers
          where ($1::text is not null and name ilike $1)
             or ($2::text is not null and phone_e164 = $2)
             or (cardinality($3::text[]) > 0 and (phone_e164 like $3[1] || '%' or phone_e164 like $3[2] || '%'))
          order by name limit 20`,
        [nameLike, phoneExact, phonePrefixes.length ? phonePrefixes : []],
      );
      const vehicles = await q.many(
        `select v.id, v.plate, v.model, v.customer_id, c.name as customer_name
           from vehicles v join customers c on c.tenant_id = v.tenant_id and c.id = v.customer_id
          where ($1::text is not null and v.plate = $1) or ($2::text is not null and v.plate like $2 || '%')
          order by v.plate limit 20`,
        [plateExact, platePrefix],
      );
      const orders = await q.many(
        `select o.id, o.number, o.status, u.code as unit_code, v.plate, c.name as customer_name
           from service_orders o
           join vehicles v on v.tenant_id = o.tenant_id and v.id = o.vehicle_id
           join customers c on c.tenant_id = o.tenant_id and c.id = o.customer_id
           join units u on u.id = o.unit_id
          where ($1::int is not null and o.number = $1)
             or ($2::text is not null and v.plate = $2)
          order by o.created_at desc limit 20`,
        [osNumber, plateExact],
      );
      return { customers, vehicles, orders };
    });
    return c.json(out);
  });
}
