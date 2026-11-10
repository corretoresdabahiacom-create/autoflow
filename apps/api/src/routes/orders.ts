import { checkLimit } from "@autoflow/shared";
import { z } from "zod";
import { audit } from "../audit";
import type { Q } from "../db";
import { HttpError, conflict, notFound, parseJson } from "../http";
import { buildEntryTermPdf } from "../pdf";
import type { Router } from "../router";
import { MAX_UPLOAD_BYTES, signFileUrl, validateUpload, verifyFileSig } from "../storage";
import type { Deps } from "../types";
import { addTimeline } from "../timeline";
import { tctx } from "./tenant";

const uuid = z.string().uuid();
const SIGNED_URL_TTL_SECONDS = 300;

const OrderBody = z.object({
  customerId: uuid,
  vehicleId: uuid,
  unitId: uuid.optional(),
  promisedAt: z.string().datetime().optional(),
  notes: z.string().trim().max(1000).optional(),
});
const OrderPatch = z.object({
  promisedAt: z.string().datetime().nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  status: z.enum(["delivered", "cancelled"]).optional(),
});
const InspectionBody = z.object({
  km: z.number().int().min(0).max(5_000_000).optional(),
  fuelLevel: z.enum(["empty", "quarter", "half", "three_quarters", "full"]).optional(),
  notes: z.string().trim().max(1000).optional(),
});
const MarkBody = z.object({
  area: z.string().trim().min(2).max(60),
  kind: z.enum(["scratch", "dent", "crack", "broken", "missing", "other"]),
  note: z.string().trim().max(500).optional(),
  attachmentId: uuid.optional(),
});
const ConfirmBody = z.object({ confirmedByName: z.string().trim().min(2).max(120) });

/** OS aberta e visível no escopo do usuário (RLS). */
export async function loadOrder(q: Q, id: string) {
  const o = await q.one<{ id: string; unit_id: string; number: number; status: string; customer_id: string; vehicle_id: string }>(
    "select id, unit_id, number, status, customer_id, vehicle_id from service_orders where id = $1",
    [id],
  );
  if (!o) throw notFound("order_not_found");
  return o;
}
export function assertOpen(o: { status: string }): void {
  if (o.status !== "open") throw conflict("order_not_open");
}

export function registerOrderRoutes(r: Router, deps: Deps): void {
  r.post("/orders", { auth: "tenant", permission: "orders:manage" }, async (c) => {
    const p = c.get("tenant");
    const b = await parseJson(c, OrderBody);

    // Limite mensal do plano: contado sem filtro de unidade (o limite é do tenant).
    const monthly = await deps.db.tx({ actor: "tenant", tenantId: p.tenantId, userId: p.userId, unitScope: "all" }, (q) =>
      q.one<{ n: string }>("select count(*) as n from service_orders where created_at >= date_trunc('month', now())"),
    );
    const lim = checkLimit(p.entitlements, "orders.monthly", Number(monthly?.n ?? 0));
    if (!lim.ok) throw new HttpError(403, "limit_reached", `orders.monthly=${lim.limit}`);

    const row = await deps.db.tx(tctx(p), async (q) => {
      const veh = await q.one<{ customer_id: string }>("select customer_id from vehicles where id = $1", [b.vehicleId]);
      if (!veh) throw notFound("vehicle_not_found");
      if (veh.customer_id !== b.customerId) throw new HttpError(422, "vehicle_customer_mismatch");
      const unit = b.unitId
        ? await q.one<{ id: string }>("select id from units where id = $1", [b.unitId])
        : await q.one<{ id: string }>("select id from units order by is_default desc, created_at limit 1");
      if (!unit) throw new HttpError(403, "unit_not_allowed");
      // Numeração: UPSERT atômico no contador (lock de linha serializa criações concorrentes).
      const n = await q.one<{ last_number: number }>(
        `insert into os_counters (tenant_id, unit_id, last_number) values ($1,$2,1)
         on conflict (tenant_id, unit_id) do update set last_number = os_counters.last_number + 1
         returning last_number`,
        [p.tenantId, unit.id],
      );
      const o = await q.one<{ id: string }>(
        `insert into service_orders (tenant_id, unit_id, number, customer_id, vehicle_id, promised_at, notes, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [p.tenantId, unit.id, n!.last_number, b.customerId, b.vehicleId, b.promisedAt ?? null, b.notes ?? null, p.userId],
      );
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "order.create", entityType: "order", entityId: o!.id, requestId: c.get("requestId") });
      await addTimeline(q, { tenantId: p.tenantId, unitId: unit.id, osId: o!.id, kind: "order.created", title: `OS ${n!.last_number} aberta` });
      return { id: o!.id, number: n!.last_number, unitId: unit.id };
    });
    return c.json(row, 201);
  });

  r.get("/orders", { auth: "tenant", permission: "orders:read" }, async (c) => {
    const p = c.get("tenant");
    const status = z.enum(["open", "delivered", "cancelled"]).optional().parse(c.req.query("status"));
    const rows = await deps.db.tx(tctx(p), (q) =>
      q.many(
        `select o.id, o.number, o.status, u.code as unit_code, v.plate, c.name as customer_name, o.created_at
           from service_orders o join units u on u.id = o.unit_id
           join vehicles v on v.tenant_id = o.tenant_id and v.id = o.vehicle_id
           join customers c on c.tenant_id = o.tenant_id and c.id = o.customer_id
          where ($1::text is null or o.status = $1) order by o.created_at desc limit 100`,
        [status ?? null],
      ),
    );
    return c.json({ orders: rows });
  });

  r.get("/orders/:id", { auth: "tenant", permission: "orders:read" }, async (c) => {
    const p = c.get("tenant");
    const id = uuid.parse(c.req.param("id"));
    const out = await deps.db.tx(tctx(p), async (q) => {
      const o = await q.one(
        `select o.id, o.number, o.status, o.unit_id, o.promised_at, o.notes, o.created_at,
                c.id as customer_id, c.name as customer_name, v.id as vehicle_id, v.plate, v.make, v.model
           from service_orders o
           join vehicles v on v.tenant_id = o.tenant_id and v.id = o.vehicle_id
           join customers c on c.tenant_id = o.tenant_id and c.id = o.customer_id
          where o.id = $1`,
        [id],
      );
      if (!o) throw notFound("order_not_found");
      const inspection = await q.one("select id, km, fuel_level, notes, confirmed_at, confirmed_by_name from inspections where os_id = $1", [id]);
      const marks = inspection
        ? await q.many("select id, area, kind, note, attachment_id from damage_marks where inspection_id = $1 order by created_at", [(inspection as { id: string }).id])
        : [];
      return { ...o, inspection, marks };
    });
    return c.json(out);
  });

  r.patch("/orders/:id", { auth: "tenant", permission: "orders:manage" }, async (c) => {
    const p = c.get("tenant");
    const id = uuid.parse(c.req.param("id"));
    const b = await parseJson(c, OrderPatch);
    await deps.db.tx(tctx(p), async (q) => {
      const o = await loadOrder(q, id);
      assertOpen(o);
      await q.query(
        `update service_orders set promised_at = case when $2 then $3::timestamptz else promised_at end,
                notes = case when $4 then $5 else notes end, status = coalesce($6, status),
                delivered_at = case when $6 = 'delivered' then now() else delivered_at end where id = $1`,
        [id, b.promisedAt !== undefined, b.promisedAt ?? null, b.notes !== undefined, b.notes ?? null, b.status ?? null],
      );
      if (b.status) {
        // Entrega/cancelamento: links do portal passam a expirar após o prazo configurado (padrão 90 dias).
        const st = await q.one<{ link_ttl_days: number }>("select link_ttl_days from portal_settings");
        await q.query(
          "update portal_links set expires_at = least(expires_at, now() + make_interval(days => $2)) where os_id = $1 and revoked_at is null",
          [id, st?.link_ttl_days ?? 90],
        );
        await addTimeline(q, { tenantId: p.tenantId, unitId: o.unit_id, osId: id, kind: `order.${b.status}`, title: b.status === "delivered" ? `OS ${o.number} entregue` : `OS ${o.number} cancelada` });
      }
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "order.update", entityType: "order", entityId: id, requestId: c.get("requestId"), metadata: { status: b.status } });
    });
    return c.json({ ok: true });
  });

  // ---- Anexos ----
  r.post("/orders/:id/attachments", { auth: "tenant", permission: "attachments:manage" }, async (c) => {
    const p = c.get("tenant");
    const id = uuid.parse(c.req.param("id"));
    const form = await c.req.parseBody();
    const file = form["file"];
    if (!(file instanceof File)) throw new HttpError(422, "file_required");
    if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(422, "file_too_large");
    const kind = z.enum(["photo", "document"]).parse(typeof form["kind"] === "string" ? form["kind"] : "photo");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mime = validateUpload(bytes, file.type || undefined);
    if (kind === "photo" && mime === "application/pdf") throw new HttpError(422, "photo_must_be_image");

    const saved = await deps.db.tx(tctx(p), async (q) => {
      const o = await loadOrder(q, id);
      assertOpen(o);
      const attId = crypto.randomUUID();
      const key = `${p.tenantId}/${id}/${attId}`;
      const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)), (x) => x.toString(16).padStart(2, "0")).join("");
      await q.query(
        "insert into attachments (id, tenant_id, unit_id, os_id, kind, storage_key, mime, size_bytes, sha256, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [attId, p.tenantId, o.unit_id, id, kind, key, mime, bytes.length, sha, p.userId],
      );
      await deps.storage.put(key, bytes); // se falhar, a transação reverte o registro
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "attachment.upload", entityType: "attachment", entityId: attId, requestId: c.get("requestId"), metadata: { kind, mime, size: bytes.length } });
      return { id: attId, mime, size: bytes.length };
    });
    return c.json(saved, 201);
  });

  r.get("/orders/:id/attachments", { auth: "tenant", permission: "attachments:read" }, async (c) => {
    const p = c.get("tenant");
    const id = uuid.parse(c.req.param("id"));
    const rows = await deps.db.tx(tctx(p), async (q) => {
      await loadOrder(q, id);
      return q.many<{ id: string; kind: string; mime: string; size_bytes: number; created_at: Date }>(
        "select id, kind, mime, size_bytes, created_at from attachments where os_id = $1 order by created_at",
        [id],
      );
    });
    const withUrls = await Promise.all(
      rows.map(async (a) => ({ ...a, url: await signFileUrl(deps.config.encryptionKey, p.tenantId, a.id, SIGNED_URL_TTL_SECONDS) })),
    );
    return c.json({ attachments: withUrls });
  });

  // Download por URL assinada e de curta duração. Sem sessão: a assinatura (tenant+arquivo+expiração) é a credencial.
  r.get("/files/:tenantId/:id", { auth: "public" }, async (c) => {
    const tenantId = uuid.parse(c.req.param("tenantId"));
    const id = uuid.parse(c.req.param("id"));
    const exp = c.req.query("exp") ?? "";
    const sig = c.req.query("sig") ?? "";
    if (!(await verifyFileSig(deps.config.encryptionKey, tenantId, id, exp, sig))) throw new HttpError(403, "invalid_or_expired_url");
    const att = await deps.db.tx({ actor: "tenant", tenantId, unitScope: "all" }, (q) =>
      q.one<{ storage_key: string; mime: string }>("select storage_key, mime from attachments where id = $1", [id]),
    );
    if (!att) throw notFound("file_not_found");
    const bytes = await deps.storage.get(att.storage_key);
    if (!bytes) throw notFound("file_not_found");
    return new Response(bytes as BodyInit, {
      headers: {
        "Content-Type": att.mime,
        "Content-Disposition": "inline",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  // ---- Vistoria ----
  r.put("/orders/:id/inspection", { auth: "tenant", permission: "orders:manage" }, async (c) => {
    const p = c.get("tenant");
    const id = uuid.parse(c.req.param("id"));
    const b = await parseJson(c, InspectionBody);
    await deps.db.tx(tctx(p), async (q) => {
      const o = await loadOrder(q, id);
      assertOpen(o);
      await q.query(
        `insert into inspections (tenant_id, unit_id, os_id, km, fuel_level, notes) values ($1,$2,$3,$4,$5,$6)
         on conflict (tenant_id, os_id) do update set km = excluded.km, fuel_level = excluded.fuel_level, notes = excluded.notes`,
        [p.tenantId, o.unit_id, id, b.km ?? null, b.fuelLevel ?? null, b.notes ?? null],
      );
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "inspection.save", entityType: "order", entityId: id, requestId: c.get("requestId") });
    });
    return c.json({ ok: true });
  });

  r.post("/orders/:id/inspection/marks", { auth: "tenant", permission: "orders:manage" }, async (c) => {
    const p = c.get("tenant");
    const id = uuid.parse(c.req.param("id"));
    const b = await parseJson(c, MarkBody);
    const row = await deps.db.tx(tctx(p), async (q) => {
      const o = await loadOrder(q, id);
      const insp = await q.one<{ id: string }>("select id from inspections where os_id = $1", [id]);
      if (!insp) throw conflict("inspection_missing");
      if (b.attachmentId) {
        const a = await q.one("select 1 from attachments where id = $1 and os_id = $2", [b.attachmentId, id]);
        if (!a) throw new HttpError(422, "attachment_not_in_order");
      }
      const m = await q.one<{ id: string }>(
        "insert into damage_marks (tenant_id, unit_id, inspection_id, area, kind, note, attachment_id) values ($1,$2,$3,$4,$5,$6,$7) returning id",
        [p.tenantId, o.unit_id, insp.id, b.area, b.kind, b.note ?? null, b.attachmentId ?? null],
      );
      return m;
    });
    return c.json(row, 201);
  });

  r.delete("/orders/:id/inspection/marks/:markId", { auth: "tenant", permission: "orders:manage" }, async (c) => {
    const p = c.get("tenant");
    const id = uuid.parse(c.req.param("id"));
    const markId = uuid.parse(c.req.param("markId"));
    await deps.db.tx(tctx(p), async (q) => {
      await loadOrder(q, id);
      const res = await q.query("delete from damage_marks where id = $1 and inspection_id in (select id from inspections where os_id = $2)", [markId, id]);
      if (res.rowCount !== 1) throw notFound("mark_not_found");
    });
    return c.json({ ok: true });
  });

  /** Confirma a vistoria (imutável a partir daqui) e gera/armazena o termo de entrada em PDF. */
  r.post("/orders/:id/inspection/confirm", { auth: "tenant", permission: "orders:manage" }, async (c) => {
    const p = c.get("tenant");
    const id = uuid.parse(c.req.param("id"));
    const b = await parseJson(c, ConfirmBody);
    const out = await deps.db.tx(tctx(p), async (q) => {
      const o = await loadOrder(q, id);
      assertOpen(o);
      const insp = await q.one<{ id: string; km: number | null; fuel_level: string | null; notes: string | null; confirmed_at: Date | null }>(
        "select id, km, fuel_level, notes, confirmed_at from inspections where os_id = $1 for update",
        [id],
      );
      if (!insp) throw conflict("inspection_missing");
      if (insp.confirmed_at) throw conflict("inspection_already_confirmed");
      const marks = await q.many<{ area: string; kind: string; note: string | null }>("select area, kind, note from damage_marks where inspection_id = $1 order by created_at", [insp.id]);
      const info = await q.one<{ tenant_name: string; customer_name: string; plate: string; make: string | null; model: string | null }>(
        `select t.name as tenant_name, c.name as customer_name, v.plate, v.make, v.model
           from service_orders o join tenants t on t.id = o.tenant_id
           join customers c on c.tenant_id = o.tenant_id and c.id = o.customer_id
           join vehicles v on v.tenant_id = o.tenant_id and v.id = o.vehicle_id where o.id = $1`,
        [id],
      );
      const confirmedAt = new Date();
      const pdf = await buildEntryTermPdf({
        tenantName: info!.tenant_name, osNumber: o.number, customerName: info!.customer_name, plate: info!.plate,
        vehicle: [info!.make, info!.model].filter(Boolean).join(" ") || "nao informado",
        km: insp.km, fuelLevel: insp.fuel_level, notes: insp.notes, marks, confirmedByName: b.confirmedByName, confirmedAt,
      });
      const attId = crypto.randomUUID();
      const key = `${p.tenantId}/${id}/${attId}`;
      const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", pdf as BufferSource)), (x) => x.toString(16).padStart(2, "0")).join("");
      await q.query(
        "insert into attachments (id, tenant_id, unit_id, os_id, kind, storage_key, mime, size_bytes, sha256, created_by) values ($1,$2,$3,$4,'entry_term',$5,'application/pdf',$6,$7,$8)",
        [attId, p.tenantId, o.unit_id, id, key, pdf.length, sha, p.userId],
      );
      await deps.storage.put(key, pdf);
      await q.query(
        "update inspections set confirmed_at = $2, confirmed_by_name = $3, confirmed_by_user = $4, term_attachment_id = $5 where id = $1",
        [insp.id, confirmedAt, b.confirmedByName, p.userId, attId],
      );
      await addTimeline(q, { tenantId: p.tenantId, unitId: o.unit_id, osId: id, kind: "inspection.confirmed", title: "Vistoria de entrada confirmada" });
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "inspection.confirm", entityType: "order", entityId: id, requestId: c.get("requestId") });
      return { termAttachmentId: attId };
    });
    return c.json({ ...out, termUrl: await signFileUrl(deps.config.encryptionKey, p.tenantId, out.termAttachmentId, SIGNED_URL_TTL_SECONDS) }, 201);
  });
}
