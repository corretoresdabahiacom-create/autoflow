import { outCost, parseQtyMilli, returnCost } from "@autoflow/shared";
import { z } from "zod";
import { audit } from "../audit";
import type { Q } from "../db";
import { HttpError, conflict, notFound, parseJson } from "../http";
import type { Router } from "../router";
import type { Deps, TenantPrincipal } from "../types";
import { ensureChart, postTxn, sysAcc } from "./finance";
import { tctx } from "./tenant";

const uuid = z.string().uuid();
const N = (v: unknown) => Number(v ?? 0);
const qty = z.number().positive().max(1_000_000).refine((v) => { try { parseQtyMilli(v); return true; } catch { return false; } }, "até 3 casas decimais");
const cents = z.number().int().min(0).max(100_000_000_00);
const CATEGORY = z.enum(["part", "paint", "varnish", "material", "other"]);
const UOM = z.enum(["un", "l", "ml", "kg", "g", "m"]);
const costAccountKey = (category: string) => (category === "part" ? "cost_parts" : category === "other" ? "cost_other_direct" : "cost_materials");

interface Lvl { on_hand_milli: string; reserved_milli: string; value_cents: string }

export function registerStockRoutes(r: Router, deps: Deps): void {
  const READ = { auth: "tenant", permission: "stock:read" } as const;
  const MANAGE = { auth: "tenant", permission: "stock:manage" } as const;
  const CONSUME = { auth: "tenant", permission: "stock:consume" } as const;
  const tx = <T>(p: TenantPrincipal, fn: (q: Q) => Promise<T>) => deps.db.tx(tctx(p), fn);

  const unitOf = async (q: Q, unitId?: string) => {
    const u = unitId ? await q.one<{ id: string }>("select id from units where id = $1", [unitId]) : await q.one<{ id: string }>("select id from units order by is_default desc, created_at limit 1");
    if (!u) throw new HttpError(403, "unit_not_allowed");
    return u.id;
  };
  const lockLevel = async (q: Q, p: TenantPrincipal, unitId: string, itemId: string) => {
    const l = await q.one<Lvl>("select on_hand_milli, reserved_milli, value_cents from stock_levels where unit_id = $1 and item_id = $2 for update", [unitId, itemId]);
    return { onHand: N(l?.on_hand_milli), reserved: N(l?.reserved_milli), value: N(l?.value_cents) };
  };
  const itemOf = async (q: Q, id: string) => { const i = await q.one<{ id: string; category: string; active: boolean }>("select id, category, active from stock_items where id = $1", [id]); if (!i) throw notFound("item_not_found"); return i; };
  const osReserved = async (q: Q, unitId: string, itemId: string, osId: string) =>
    N((await q.one<{ s: string }>("select coalesce(sum(reserved_delta),0)::bigint s from stock_movements where unit_id = $1 and item_id = $2 and os_id = $3", [unitId, itemId, osId]))!.s);

  /** Núcleo: grava o movimento (append-only); o trigger atualiza o saldo; lança no ledger quando há valor. */
  type Kind = "purchase" | "consume" | "return" | "adjust_in" | "adjust_out" | "reserve" | "release";
  async function move(q: Q, p: TenantPrincipal, a: { kind: Kind; qtyMilli: number; unitId: string; item: { id: string; category: string }; costCents?: number; reservedDelta?: number; osId?: string; purchaseId?: string; refMovementId?: number; reason?: string; txnId?: string | null; description?: string }): Promise<number> {
    const cost = a.costCents ?? 0;
    const inflow = a.kind === "purchase" || a.kind === "adjust_in" || a.kind === "return"; const outflow = a.kind === "consume" || a.kind === "adjust_out";
    const on = inflow ? a.qtyMilli : outflow ? -a.qtyMilli : 0;
    const res = a.kind === "reserve" ? a.qtyMilli : a.kind === "release" ? -a.qtyMilli : (a.reservedDelta ?? 0);
    const val = inflow ? cost : outflow ? -cost : 0;
    try {
      const x = await q.one<{ id: string }>(
        `insert into stock_movements (tenant_id, unit_id, item_id, kind, qty_milli, on_hand_delta, reserved_delta, value_delta_cents, os_id, purchase_id, ref_movement_id, reason, txn_id, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
        [p.tenantId, a.unitId, a.item.id, a.kind, a.qtyMilli, on, res, val, a.osId ?? null, a.purchaseId ?? null, a.refMovementId ?? null, a.reason ?? null, a.txnId ?? null, p.userId]);
      return Number(x!.id);
    } catch (e) { if ((e as { code?: string }).code === "23514") throw conflict("insufficient_stock"); throw e; }
  }
  /** Lança no ledger o efeito do movimento (D/C inventário × custo/GRNI). Retorna o id da txn (ou null se valor zero). */
  async function ledger(q: Q, p: TenantPrincipal, a: { unitId: string; osId?: string; description: string; cents: number; inventoryDebit: boolean; counterKey: string }): Promise<string | null> {
    if (a.cents <= 0) return null;
    await ensureChart(q, p.tenantId);
    const inv = await sysAcc(q, "inventory"); const other = await sysAcc(q, a.counterKey);
    return postTxn(q, { tenantId: p.tenantId, unitId: a.unitId, kind: "stock", description: a.description.slice(0, 200), osId: a.osId ?? null, userId: p.userId,
      entries: a.inventoryDebit ? [{ account: inv, side: "D", amount: a.cents }, { account: other, side: "C", amount: a.cents }] : [{ account: other, side: "D", amount: a.cents }, { account: inv, side: "C", amount: a.cents }] });
  }
  const orderOf = async (q: Q, osId: string) => { const o = await q.one<{ id: string; unit_id: string; status: string; number: number }>("select id, unit_id, status, number from service_orders where id = $1", [osId]); if (!o) throw notFound("order_not_found"); return o; };

  // ---- Compras (entrada com custo; atualiza custo médio) ----
  r.post("/stock/purchases", MANAGE, async (c) => {
    const p = c.get("tenant");
    const b = await parseJson(c, z.object({ unitId: uuid.optional(), supplierId: uuid.optional(), invoiceNo: z.string().trim().max(40).optional(), items: z.array(z.object({ itemId: uuid, qty, totalCents: cents })).min(1).max(100) }));
    const out = await tx(p, async (q) => {
      const unitId = await unitOf(q, b.unitId);
      if (b.supplierId && !(await q.one("select 1 from suppliers where id = $1 and active", [b.supplierId]))) throw notFound("supplier_not_found");
      const total = b.items.reduce((s, i) => s + i.totalCents, 0);
      const pur = await q.one<{ id: string }>("insert into purchases (tenant_id, unit_id, supplier_id, invoice_no, total_cents, created_by) values ($1,$2,$3,$4,$5,$6) returning id", [p.tenantId, unitId, b.supplierId ?? null, b.invoiceNo ?? null, total, p.userId]);
      const txnId = await ledger(q, p, { unitId, description: `Compra${b.invoiceNo ? ` NF ${b.invoiceNo}` : ""}`, cents: total, inventoryDebit: true, counterKey: "grni" });
      for (const it of b.items.sort((x, y) => x.itemId.localeCompare(y.itemId))) { // ordem estável evita deadlock entre compras concorrentes
        const item = await itemOf(q, it.itemId); if (!item.active) throw new HttpError(422, "item_inactive");
        const qm = parseQtyMilli(it.qty);
        await q.query("insert into purchase_items (tenant_id, purchase_id, item_id, qty_milli, line_total_cents) values ($1,$2,$3,$4,$5)", [p.tenantId, pur!.id, item.id, qm, it.totalCents]);
        await move(q, p, { kind: "purchase", qtyMilli: qm, unitId, item, costCents: it.totalCents, purchaseId: pur!.id, txnId });
      }
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "stock.purchase", entityType: "purchase", entityId: pur!.id, requestId: c.get("requestId") });
      return { id: pur!.id, totalCents: total, unitId };
    });
    return c.json(out, 201);
  });
  r.get("/stock/purchases", READ, async (c) => c.json({ purchases: await tx(c.get("tenant"), (q) => q.many("select p.id, p.unit_id, p.invoice_no, p.total_cents, p.created_at, s.name supplier from purchases p left join suppliers s on s.tenant_id = p.tenant_id and s.id = p.supplier_id order by p.created_at desc limit 100")) }));

  // ---- Reserva / consumo / devolução por OS (a unidade do estoque é a da OS) ----
  const StockLine = z.object({ itemId: uuid, qty });
  r.post("/orders/:id/stock/reserve", CONSUME, async (c) => {
    const p = c.get("tenant"); const osId = uuid.parse(c.req.param("id")); const b = await parseJson(c, StockLine);
    return c.json(await tx(p, async (q) => {
      const o = await orderOf(q, osId); if (o.status !== "open") throw conflict("order_not_open");
      const item = await itemOf(q, b.itemId); const qm = parseQtyMilli(b.qty);
      const l = await lockLevel(q, p, o.unit_id, item.id);
      if (qm > l.onHand - l.reserved) throw conflict("insufficient_stock");
      return { movementId: await move(q, p, { kind: "reserve", qtyMilli: qm, unitId: o.unit_id, item, osId }) };
    }), 201);
  });
  r.post("/orders/:id/stock/release", CONSUME, async (c) => {
    const p = c.get("tenant"); const osId = uuid.parse(c.req.param("id")); const b = await parseJson(c, StockLine);
    return c.json(await tx(p, async (q) => {
      const o = await orderOf(q, osId); const item = await itemOf(q, b.itemId); const qm = parseQtyMilli(b.qty);
      await lockLevel(q, p, o.unit_id, item.id);
      if (qm > (await osReserved(q, o.unit_id, item.id, osId))) throw conflict("release_exceeds_reserved");
      return { movementId: await move(q, p, { kind: "release", qtyMilli: qm, unitId: o.unit_id, item, osId }) };
    }), 201);
  });
  r.post("/orders/:id/stock/consume", CONSUME, async (c) => {
    const p = c.get("tenant"); const osId = uuid.parse(c.req.param("id")); const b = await parseJson(c, StockLine);
    return c.json(await tx(p, async (q) => {
      const o = await orderOf(q, osId); if (o.status !== "open") throw conflict("order_not_open");
      const item = await itemOf(q, b.itemId); const qm = parseQtyMilli(b.qty);
      const l = await lockLevel(q, p, o.unit_id, item.id);
      const mine = await osReserved(q, o.unit_id, item.id, osId); const fromReserve = Math.min(qm, mine);
      if (qm > l.onHand - (l.reserved - fromReserve)) throw conflict("insufficient_stock");
      let cost: number; try { cost = outCost({ onHandMilli: l.onHand, valueCents: l.value }, qm); } catch { throw conflict("insufficient_stock"); }
      const txnId = await ledger(q, p, { unitId: o.unit_id, osId, description: `Consumo OS ${o.number}: ${item.id.slice(0, 8)}`, cents: cost, inventoryDebit: false, counterKey: costAccountKey(item.category) });
      const id = await move(q, p, { kind: "consume", qtyMilli: qm, unitId: o.unit_id, item, costCents: cost, reservedDelta: -fromReserve, osId, txnId });
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "stock.consume", entityType: "service_order", entityId: osId, requestId: c.get("requestId") });
      return { movementId: id, costCents: cost };
    }), 201);
  });
  r.post("/orders/:id/stock/return", CONSUME, async (c) => {
    const p = c.get("tenant"); const osId = uuid.parse(c.req.param("id")); const b = await parseJson(c, z.object({ movementId: z.number().int().positive(), qty, reason: z.string().trim().min(3).max(200) }));
    return c.json(await tx(p, async (q) => {
      const o = await orderOf(q, osId); if (o.status === "cancelled") throw conflict("order_cancelled");
      const ref = await q.one<{ id: string; unit_id: string; item_id: string; qty_milli: string; value_delta_cents: string }>("select id, unit_id, item_id, qty_milli, value_delta_cents from stock_movements where id = $1 and os_id = $2 and kind = 'consume'", [b.movementId, osId]);
      if (!ref) throw notFound("consume_movement_not_found");
      const item = await itemOf(q, ref.item_id); const qm = parseQtyMilli(b.qty);
      await lockLevel(q, p, ref.unit_id, ref.item_id);
      const done = await q.one<{ q: string; v: string }>("select coalesce(sum(qty_milli),0)::bigint q, coalesce(sum(value_delta_cents),0)::bigint v from stock_movements where ref_movement_id = $1 and kind = 'return'", [b.movementId]);
      const remaining = N(ref.qty_milli) - N(done!.q); if (qm > remaining) throw conflict("return_exceeds_consumed");
      const origCost = -N(ref.value_delta_cents); const cost = qm === remaining ? origCost - N(done!.v) : returnCost(N(ref.qty_milli), origCost, qm);
      const txnId = await ledger(q, p, { unitId: ref.unit_id, osId, description: `Devolução OS ${o.number}`, cents: cost, inventoryDebit: true, counterKey: costAccountKey(item.category) });
      const id = await move(q, p, { kind: "return", qtyMilli: qm, unitId: ref.unit_id, item, costCents: cost, osId, refMovementId: b.movementId, reason: b.reason, txnId });
      return { movementId: id, costCents: cost };
    }), 201);
  });
  r.get("/orders/:id/stock", READ, async (c) => {
    const p = c.get("tenant"); const osId = uuid.parse(c.req.param("id"));
    return c.json(await tx(p, async (q) => {
      await orderOf(q, osId);
      const lines = await q.many<any>(`select m.item_id, i.sku, i.name, coalesce(sum(m.reserved_delta),0)::bigint reserved_milli,
          coalesce(sum(case when m.kind = 'consume' then m.qty_milli when m.kind = 'return' then -m.qty_milli else 0 end),0)::bigint consumed_milli,
          coalesce(sum(case when m.kind = 'consume' then -m.value_delta_cents when m.kind = 'return' then -m.value_delta_cents else 0 end),0)::bigint cost_cents
        from stock_movements m join stock_items i on i.tenant_id = m.tenant_id and i.id = m.item_id where m.os_id = $1 group by m.item_id, i.sku, i.name order by i.name`, [osId]);
      return { lines: lines.map((x) => ({ itemId: x.item_id, sku: x.sku, name: x.name, reservedMilli: N(x.reserved_milli), consumedMilli: N(x.consumed_milli), costCents: N(x.cost_cents) })), totalCostCents: lines.reduce((s, x) => s + N(x.cost_cents), 0) };
    }));
  });

  // ---- Inventário: contagem gera ajustes compensatórios (nunca edita saldo) ----
  r.post("/stock/inventory", MANAGE, async (c) => {
    const p = c.get("tenant");
    const b = await parseJson(c, z.object({ unitId: uuid.optional(), reason: z.string().trim().min(3).max(200), counts: z.array(z.object({ itemId: uuid, counted: z.number().min(0).max(1_000_000), unitCostCents: cents.optional() })).min(1).max(500) }));
    return c.json(await tx(p, async (q) => {
      const unitId = await unitOf(q, b.unitId); const adjustments: { itemId: string; diffMilli: number; costCents: number }[] = [];
      for (const cnt of [...b.counts].sort((x, y) => x.itemId.localeCompare(y.itemId))) {
        const item = await itemOf(q, cnt.itemId); const counted = Math.round(cnt.counted * 1000);
        const l = await lockLevel(q, p, unitId, item.id); const diff = counted - l.onHand;
        if (diff === 0) continue;
        if (diff < 0) {
          if (counted < l.reserved) throw conflict("count_below_reserved");
          const cost = outCost({ onHandMilli: l.onHand, valueCents: l.value }, -diff);
          const txnId = await ledger(q, p, { unitId, description: "Ajuste de inventário (perda)", cents: cost, inventoryDebit: false, counterKey: "cost_other_direct" });
          await move(q, p, { kind: "adjust_out", qtyMilli: -diff, unitId, item, costCents: cost, reason: b.reason, txnId }); adjustments.push({ itemId: item.id, diffMilli: diff, costCents: cost });
        } else {
          const cost = l.onHand > 0 ? Math.round((l.value * diff) / l.onHand) : cnt.unitCostCents === undefined ? -1 : Math.round((cnt.unitCostCents * diff) / 1000);
          if (cost < 0) throw new HttpError(422, "unit_cost_required");
          const txnId = await ledger(q, p, { unitId, description: "Ajuste de inventário (sobra)", cents: cost, inventoryDebit: true, counterKey: "cost_other_direct" });
          await move(q, p, { kind: "adjust_in", qtyMilli: diff, unitId, item, costCents: cost, reason: b.reason, txnId }); adjustments.push({ itemId: item.id, diffMilli: diff, costCents: cost });
        }
      }
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "stock.inventory", entityType: "unit", entityId: unitId, requestId: c.get("requestId") });
      return { unitId, adjustments };
    }), 201);
  });

  // ---- Fornecedores ----
  const Supplier = z.object({ name: z.string().trim().min(2).max(120), doc: z.string().trim().max(20).optional(), phone: z.string().trim().max(30).optional(), email: z.string().trim().email().max(120).optional() });
  r.post("/stock/suppliers", MANAGE, async (c) => {
    const p = c.get("tenant"); const b = await parseJson(c, Supplier);
    try { return c.json(await tx(p, (q) => q.one("insert into suppliers (tenant_id, name, doc, phone, email) values ($1,$2,$3,$4,$5) returning id", [p.tenantId, b.name, b.doc ?? null, b.phone ?? null, b.email ?? null])), 201); }
    catch (e) { if ((e as { code?: string }).code === "23505") throw conflict("supplier_exists"); throw e; }
  });
  r.get("/stock/suppliers", READ, async (c) => c.json({ suppliers: await tx(c.get("tenant"), (q) => q.many("select id, name, doc, phone, email, active from suppliers order by name")) }));
  r.patch("/stock/suppliers/:id", MANAGE, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id")); const b = await parseJson(c, Supplier.partial().extend({ active: z.boolean().optional() }));
    await tx(p, async (q) => { const x = await q.query("update suppliers set name = coalesce($2,name), doc = coalesce($3,doc), phone = coalesce($4,phone), email = coalesce($5,email), active = coalesce($6,active) where id = $1", [id, b.name ?? null, b.doc ?? null, b.phone ?? null, b.email ?? null, b.active ?? null]); if (x.rowCount !== 1) throw notFound("supplier_not_found"); });
    return c.json({ ok: true });
  });

  // ---- Itens ----
  const Item = z.object({ sku: z.string().regex(/^[A-Za-z0-9._-]{1,30}$/), name: z.string().trim().min(2).max(120), category: CATEGORY, uom: UOM.default("un"), barcode: z.string().regex(/^[0-9A-Za-z-]{4,32}$/).optional(), minQty: z.number().min(0).max(1_000_000).default(0) });
  r.post("/stock/items", MANAGE, async (c) => {
    const p = c.get("tenant"); const b = await parseJson(c, Item);
    try {
      const row = await tx(p, async (q) => {
        const x = await q.one<{ id: string }>("insert into stock_items (tenant_id, sku, name, category, uom, barcode, min_qty_milli) values ($1,$2,$3,$4,$5,$6,$7) returning id", [p.tenantId, b.sku, b.name, b.category, b.uom, b.barcode ?? null, Math.round(b.minQty * 1000)]);
        await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "stock.item.create", entityType: "stock_item", entityId: x!.id, requestId: c.get("requestId") });
        return x;
      });
      return c.json(row, 201);
    } catch (e) { if ((e as { code?: string }).code === "23505") throw conflict("item_exists"); throw e; }
  });
  r.get("/stock/items", READ, async (c) => c.json({ items: await tx(c.get("tenant"), (q) => q.many("select id, sku, name, category, uom, barcode, min_qty_milli, active from stock_items order by name limit 500")) }));
  r.patch("/stock/items/:id", MANAGE, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id")); const b = await parseJson(c, z.object({ name: z.string().trim().min(2).max(120).optional(), category: CATEGORY.optional(), barcode: z.string().regex(/^[0-9A-Za-z-]{4,32}$/).optional(), minQty: z.number().min(0).max(1_000_000).optional(), active: z.boolean().optional() }));
    try { await tx(p, async (q) => { const x = await q.query("update stock_items set name = coalesce($2,name), category = coalesce($3,category), barcode = coalesce($4,barcode), min_qty_milli = coalesce($5,min_qty_milli), active = coalesce($6,active) where id = $1", [id, b.name ?? null, b.category ?? null, b.barcode ?? null, b.minQty === undefined ? null : Math.round(b.minQty * 1000), b.active ?? null]); if (x.rowCount !== 1) throw notFound("item_not_found"); }); }
    catch (e) { if ((e as { code?: string }).code === "23505") throw conflict("barcode_exists"); throw e; }
    return c.json({ ok: true });
  });
  const levelSql = `select i.id item_id, i.sku, i.name, i.category, i.uom, i.barcode, i.min_qty_milli, l.unit_id,
      coalesce(l.on_hand_milli,0)::bigint on_hand_milli, coalesce(l.reserved_milli,0)::bigint reserved_milli, coalesce(l.value_cents,0)::bigint value_cents
    from stock_items i left join stock_levels l on l.tenant_id = i.tenant_id and l.item_id = i.id and ($1::uuid is null or l.unit_id = $1)`;
  const shape = (x: any) => ({ itemId: x.item_id, sku: x.sku, name: x.name, category: x.category, uom: x.uom, barcode: x.barcode, unitId: x.unit_id, onHandMilli: N(x.on_hand_milli), reservedMilli: N(x.reserved_milli), availableMilli: N(x.on_hand_milli) - N(x.reserved_milli), valueCents: N(x.value_cents),
    avgUnitCostCents: N(x.on_hand_milli) === 0 ? 0 : Math.round((N(x.value_cents) * 1000) / N(x.on_hand_milli)), minQtyMilli: N(x.min_qty_milli), belowMin: N(x.min_qty_milli) > 0 && N(x.on_hand_milli) - N(x.reserved_milli) <= N(x.min_qty_milli) });
  r.get("/stock/levels", READ, async (c) => {
    const p = c.get("tenant"); const unitId = c.req.query("unitId") ? uuid.parse(c.req.query("unitId")) : null;
    const rows = await tx(p, (q) => q.many(`${levelSql} where i.active order by i.name limit 1000`, [unitId]));
    const out = rows.map(shape); return c.json({ levels: c.req.query("low") === "1" ? out.filter((x) => x.belowMin) : out });
  });
  r.get("/stock/items/by-barcode/:code", READ, async (c) => {
    const p = c.get("tenant"); const code = c.req.param("code") ?? "";
    const rows = await tx(p, (q) => q.many(`${levelSql} where i.barcode = $2`, [null, code]));
    if (rows.length === 0) throw notFound("barcode_not_found");
    const r0 = rows[0]!;
    return c.json({ item: { id: r0.item_id, sku: r0.sku, name: r0.name, barcode: r0.barcode }, levels: rows.filter((x) => x.unit_id).map(shape) });
  });
  r.get("/stock/movements", READ, async (c) => {
    const p = c.get("tenant"); const itemId = c.req.query("itemId") ? uuid.parse(c.req.query("itemId")) : null; const unitId = c.req.query("unitId") ? uuid.parse(c.req.query("unitId")) : null;
    return c.json({ movements: await tx(p, (q) => q.many("select id, unit_id, item_id, kind, qty_milli, value_delta_cents, os_id, ref_movement_id, reason, created_at from stock_movements where ($1::uuid is null or item_id = $1) and ($2::uuid is null or unit_id = $2) order by id desc limit 200", [itemId, unitId])) });
  });
  // Consistência: saldo (trigger) == soma dos movimentos.
  r.get("/stock/audit", READ, async (c) => {
    const p = c.get("tenant");
    const bad = await tx(p, (q) => q.many(`select m.unit_id, m.item_id, sum(m.on_hand_delta)::bigint on_hand, coalesce(l.on_hand_milli,0)::bigint level_on_hand, sum(m.reserved_delta)::bigint reserved, coalesce(l.reserved_milli,0)::bigint level_reserved, sum(m.value_delta_cents)::bigint value, coalesce(l.value_cents,0)::bigint level_value
      from stock_movements m left join stock_levels l on l.tenant_id = m.tenant_id and l.unit_id = m.unit_id and l.item_id = m.item_id
      group by m.unit_id, m.item_id, l.on_hand_milli, l.reserved_milli, l.value_cents
      having sum(m.on_hand_delta) <> coalesce(l.on_hand_milli,0) or sum(m.reserved_delta) <> coalesce(l.reserved_milli,0) or sum(m.value_delta_cents) <> coalesce(l.value_cents,0)`));
    return c.json({ consistent: bad.length === 0, mismatches: bad });
  });

}
