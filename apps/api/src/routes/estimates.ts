import {
  type ItemCategory,
  type ItemStatus,
  type VersionItem,
  canExecuteItem,
  computeEffectiveStatuses,
  diffVersions,
  itemHash,
  lineTotalCents,
} from "@autoflow/shared";
import { z } from "zod";
import { audit } from "../audit";
import { sha256Hex } from "../crypto";
import type { Q } from "../db";
import { HttpError, conflict, forbidden, notFound, parseJson } from "../http";
import type { Router } from "../router";
import type { Deps, TenantPrincipal } from "../types";
import { assertOpen, loadOrder } from "./orders";
import { tctx } from "./tenant";

const uuid = z.string().uuid();
const category = z.enum(["service", "part", "other"]);
const ItemBody = z.object({
  description: z.string().trim().min(2).max(300),
  category,
  qty: z.number().positive().max(999999).refine((n) => Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-6, "no máximo 3 casas"),
  unitPriceCents: z.number().int().min(0).max(10_000_000_00),
});
const ItemPatch = ItemBody.partial();
const DecisionsBody = z.object({
  customerName: z.string().trim().min(2).max(120),
  note: z.string().trim().max(500).optional(),
  decisions: z
    .array(z.object({ itemId: uuid, decision: z.enum(["approved", "rejected"]), justification: z.string().trim().max(500).optional() }))
    .min(1)
    .max(100),
});
const ExecutionBody = z.union([
  z.object({ itemId: uuid }),
  z.object({
    description: z.string().trim().min(2).max(300),
    amountCents: z.number().int().min(0).max(10_000_000_00),
    exception: z.object({ justification: z.string().trim().min(20).max(500), evidenceAttachmentId: uuid }),
  }),
]);
const PolicyBody = z.object({ enabled: z.boolean(), maxCents: z.number().int().min(0).max(10_000_000_00) });

interface ItemRow {
  id: string; line_key: string; position: number; description: string; category: ItemCategory;
  qty: string; unit_price_cents: string; item_hash: string; version_id: string;
}
interface VersionRow {
  id: string; version_no: number; status: "draft" | "published" | "superseded";
  total_cents: string | null; presented_hash: string | null; published_at: Date | null;
}

async function loadModel(q: Q, osId: string) {
  const est = await q.one<{ id: string; unit_id: string }>("select id, unit_id from estimates where os_id = $1", [osId]);
  if (!est) return { est: null, versions: [] as (VersionRow & { items: (ItemRow & { status: ItemStatus })[] })[] };
  const versions = await q.many<VersionRow>(
    "select id, version_no, status, total_cents, presented_hash, published_at from estimate_versions where estimate_id = $1 order by version_no",
    [est.id],
  );
  const items = await q.many<ItemRow>(
    "select i.* from estimate_items i join estimate_versions v on v.id = i.version_id and v.tenant_id = i.tenant_id where v.estimate_id = $1 order by i.position, i.created_at",
    [est.id],
  );
  const decisions = await q.many<{ item_id: string; decision: "approved" | "rejected" }>(
    "select a.item_id, a.decision from approvals a join estimate_versions v on v.id = a.version_id and v.tenant_id = a.tenant_id where v.estimate_id = $1",
    [est.id],
  );
  const own = new Map(decisions.map((d) => [d.item_id, d.decision]));
  const statuses = computeEffectiveStatuses(
    versions.map((v) => ({
      versionNo: v.version_no,
      items: items.filter((i) => i.version_id === v.id).map((i) => ({ id: i.id, lineKey: i.line_key, hash: i.item_hash, ownDecision: own.get(i.id) ?? null })),
    })),
  );
  return {
    est,
    versions: versions.map((v) => ({
      ...v,
      items: items.filter((i) => i.version_id === v.id).map((i) => ({ ...i, status: statuses.get(i.id) ?? ("pending" as ItemStatus) })),
    })),
  };
}

const toVersionItem = (i: ItemRow): VersionItem => ({
  lineKey: i.line_key, hash: i.item_hash, description: i.description, category: i.category,
  qty: Number(i.qty), unitPriceCents: Number(i.unit_price_cents),
});

const present = (i: ItemRow & { status: ItemStatus }) => ({
  id: i.id, lineKey: i.line_key, description: i.description, category: i.category, qty: Number(i.qty),
  unitPriceCents: Number(i.unit_price_cents), totalCents: lineTotalCents(Number(i.qty), Number(i.unit_price_cents)), status: i.status,
});

/** Garante um rascunho: cria o orçamento e/ou a versão v+1 copiando a última versão (mesmas lineKeys/hashes). */
async function ensureDraft(q: Q, p: TenantPrincipal, os: { id: string; unit_id: string }): Promise<string> {
  let est = await q.one<{ id: string }>("select id from estimates where os_id = $1", [os.id]);
  if (!est) {
    est = await q.one<{ id: string }>("insert into estimates (tenant_id, unit_id, os_id) values ($1,$2,$3) returning id", [p.tenantId, os.unit_id, os.id]);
  }
  const draft = await q.one<{ id: string }>("select id from estimate_versions where estimate_id = $1 and status = 'draft'", [est!.id]);
  if (draft) return draft.id;
  const last = await q.one<{ id: string; version_no: number }>(
    "select id, version_no from estimate_versions where estimate_id = $1 order by version_no desc limit 1", [est!.id],
  );
  const v = await q.one<{ id: string }>(
    "insert into estimate_versions (tenant_id, unit_id, estimate_id, version_no) values ($1,$2,$3,$4) returning id",
    [p.tenantId, os.unit_id, est!.id, (last?.version_no ?? 0) + 1],
  );
  if (last) {
    await q.query(
      `insert into estimate_items (tenant_id, unit_id, version_id, line_key, position, description, category, qty, unit_price_cents, item_hash)
       select tenant_id, unit_id, $2, line_key, position, description, category, qty, unit_price_cents, item_hash
         from estimate_items where version_id = $1`,
      [last.id, v!.id],
    );
  }
  return v!.id;
}

export function registerEstimateRoutes(r: Router, deps: Deps): void {
  r.get("/orders/:id/estimate", { auth: "tenant", permission: "orders:read" }, async (c) => {
    const p = c.get("tenant");
    const id = uuid.parse(c.req.param("id"));
    const model = await deps.db.tx(tctx(p), async (q) => {
      await loadOrder(q, id);
      return loadModel(q, id);
    });
    return c.json({
      versions: model.versions.map((v) => ({
        versionNo: v.version_no, status: v.status, totalCents: v.total_cents === null ? null : Number(v.total_cents),
        publishedAt: v.published_at, items: v.items.map(present),
      })),
    });
  });

  r.post("/orders/:id/estimate/items", { auth: "tenant", permission: "estimates:manage" }, async (c) => {
    const p = c.get("tenant");
    const id = uuid.parse(c.req.param("id"));
    const b = await parseJson(c, ItemBody);
    const out = await deps.db.tx(tctx(p), async (q) => {
      const os = await loadOrder(q, id);
      assertOpen(os);
      const vid = await ensureDraft(q, p, os);
      const pos = await q.one<{ n: string }>("select count(*) as n from estimate_items where version_id = $1", [vid]);
      const lineKey = crypto.randomUUID();
      const row = await q.one<{ id: string }>(
        `insert into estimate_items (tenant_id, unit_id, version_id, line_key, position, description, category, qty, unit_price_cents, item_hash)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
        [p.tenantId, os.unit_id, vid, lineKey, Number(pos?.n ?? 0), b.description, b.category, b.qty, b.unitPriceCents, itemHash(b)],
      );
      return { id: row!.id, lineKey };
    });
    return c.json(out, 201);
  });

  r.patch("/orders/:id/estimate/items/:lineKey", { auth: "tenant", permission: "estimates:manage" }, async (c) => {
    const p = c.get("tenant");
    const id = uuid.parse(c.req.param("id"));
    const lineKey = uuid.parse(c.req.param("lineKey"));
    const b = await parseJson(c, ItemPatch);
    await deps.db.tx(tctx(p), async (q) => {
      const os = await loadOrder(q, id);
      assertOpen(os);
      const vid = await ensureDraft(q, p, os); // editar versão publicada => cria v+1, nunca altera a publicada
      const cur = await q.one<ItemRow>("select * from estimate_items where version_id = $1 and line_key = $2", [vid, lineKey]);
      if (!cur) throw notFound("item_not_found");
      const next = {
        description: b.description ?? cur.description, category: b.category ?? cur.category,
        qty: b.qty ?? Number(cur.qty), unitPriceCents: b.unitPriceCents ?? Number(cur.unit_price_cents),
      };
      await q.query(
        "update estimate_items set description=$2, category=$3, qty=$4, unit_price_cents=$5, item_hash=$6 where id = $1",
        [cur.id, next.description, next.category, next.qty, next.unitPriceCents, itemHash(next)],
      );
    });
    return c.json({ ok: true });
  });

  r.delete("/orders/:id/estimate/items/:lineKey", { auth: "tenant", permission: "estimates:manage" }, async (c) => {
    const p = c.get("tenant");
    const id = uuid.parse(c.req.param("id"));
    const lineKey = uuid.parse(c.req.param("lineKey"));
    await deps.db.tx(tctx(p), async (q) => {
      const os = await loadOrder(q, id);
      assertOpen(os);
      const vid = await ensureDraft(q, p, os);
      const res = await q.query("delete from estimate_items where version_id = $1 and line_key = $2", [vid, lineKey]);
      if (res.rowCount !== 1) throw notFound("item_not_found");
    });
    return c.json({ ok: true });
  });

  r.post("/orders/:id/estimate/publish", { auth: "tenant", permission: "estimates:publish" }, async (c) => {
    const p = c.get("tenant");
    const id = uuid.parse(c.req.param("id"));
    const out = await deps.db.tx(tctx(p), async (q) => {
      const os = await loadOrder(q, id);
      assertOpen(os);
      const model = await loadModel(q, id);
      const draft = model.versions.find((v) => v.status === "draft");
      if (!draft || draft.items.length === 0) throw conflict("nothing_to_publish");
      const prev = [...model.versions].reverse().find((v) => v.status === "published");
      if (prev) {
        const d = diffVersions(prev.items.map(toVersionItem), draft.items.map(toVersionItem));
        if (!d.added.length && !d.removed.length && !d.changed.length) throw conflict("no_changes");
      }
      const total = draft.items.reduce((s, i) => s + lineTotalCents(Number(i.qty), Number(i.unit_price_cents)), 0);
      const canonical = JSON.stringify([draft.version_no, [...draft.items].map((i) => [i.line_key, i.item_hash]).sort(), total]);
      const presentedHash = await sha256Hex(canonical);
      if (prev) await q.query("update estimate_versions set status = 'superseded' where id = $1", [prev.id]);
      await q.query(
        "update estimate_versions set status = 'published', total_cents = $2, presented_hash = $3, published_at = now(), published_by = $4 where id = $1",
        [draft.id, total, presentedHash, p.userId],
      );
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "estimate.publish", entityType: "order", entityId: id, requestId: c.get("requestId"), metadata: { versionNo: draft.version_no, total } });
      return { versionNo: draft.version_no, totalCents: total, presentedHash };
    });
    return c.json(out, 201);
  });

  r.get("/orders/:id/estimate/diff", { auth: "tenant", permission: "orders:read" }, async (c) => {
    const p = c.get("tenant");
    const id = uuid.parse(c.req.param("id"));
    const from = z.coerce.number().int().min(1).parse(c.req.query("from"));
    const to = z.coerce.number().int().min(1).parse(c.req.query("to"));
    const model = await deps.db.tx(tctx(p), async (q) => {
      await loadOrder(q, id);
      return loadModel(q, id);
    });
    const a = model.versions.find((v) => v.version_no === from);
    const b = model.versions.find((v) => v.version_no === to);
    if (!a || !b) throw notFound("version_not_found");
    return c.json(diffVersions(a.items.map(toVersionItem), b.items.map(toVersionItem)));
  });

  /** Aprovação/recusa assistida: vinculada a versão + item + hash. Aprovar NÃO cria cobrança/recebimento. */
  r.post("/orders/:id/estimate/decisions", { auth: "tenant", permission: "approvals:assist" }, async (c) => {
    const p = c.get("tenant");
    const id = uuid.parse(c.req.param("id"));
    const b = await parseJson(c, DecisionsBody);
    const ua = (c.req.header("user-agent") ?? "").slice(0, 120);
    const result = await deps.db.tx(tctx(p), async (q) => {
      const os = await loadOrder(q, id);
      assertOpen(os);
      const model = await loadModel(q, id);
      const cur = model.versions.find((v) => v.status === "published");
      if (!cur) throw conflict("no_published_version");
      const byId = new Map(cur.items.map((i) => [i.id, i]));
      for (const d of b.decisions) {
        const it = byId.get(d.itemId);
        if (!it) throw new HttpError(422, "item_not_in_current_version");
        if (it.status === "approved" || it.status === "rejected") throw conflict("already_decided");
        if (it.status === "approved_inherited") throw conflict("already_approved_inherited");
        if (d.decision === "rejected" && (d.justification ?? "").length < 5) throw new HttpError(422, "justification_required");
        // Integridade: o hash armazenado deve corresponder ao conteúdo apresentado.
        const recomputed = itemHash({ description: it.description, category: it.category, qty: Number(it.qty), unitPriceCents: Number(it.unit_price_cents) });
        if (recomputed !== it.item_hash) throw new HttpError(500, "item_integrity_failure");
      }
      for (const d of b.decisions) {
        const it = byId.get(d.itemId)!;
        await q.query(
          `insert into approvals (tenant_id, unit_id, version_id, item_id, decision, item_hash_at_decision, channel, decided_by, justification, evidence)
           values ($1,$2,$3,$4,$5,$6,'assisted',$7,$8,$9)`,
          [
            p.tenantId, os.unit_id, cur.id, it.id, d.decision, it.item_hash, p.userId, d.justification ?? null,
            JSON.stringify({
              procedure: "assisted", declaredCustomerName: b.customerName, note: b.note ?? null, versionNo: cur.version_no,
              presentedHash: cur.presented_hash, recordedBy: p.userId, ipHash: c.get("ipHash"), userAgent: ua, at: new Date().toISOString(),
            }),
          ],
        );
      }
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "approval.assisted", entityType: "order", entityId: id, requestId: c.get("requestId"), metadata: { versionNo: cur.version_no, count: b.decisions.length } });
      const after = await loadModel(q, id);
      return after.versions.find((v) => v.status === "published")!.items.map(present);
    });
    return c.json({ items: result }, 201);
  });

  // ---- Política de exceção e execução ----
  r.get("/execution-policy", { auth: "tenant", permission: "orders:read" }, async (c) => {
    const p = c.get("tenant");
    const row = await deps.db.tx(tctx(p), (q) => q.one<{ exception_enabled: boolean; exception_max_cents: string }>("select exception_enabled, exception_max_cents from execution_policies"));
    return c.json({ enabled: row?.exception_enabled ?? false, maxCents: Number(row?.exception_max_cents ?? 0) });
  });

  r.put("/execution-policy", { auth: "tenant", permission: "approvals:exception" }, async (c) => {
    const p = c.get("tenant");
    const b = await parseJson(c, PolicyBody);
    await deps.db.tx(tctx(p), async (q) => {
      await q.query(
        `insert into execution_policies (tenant_id, exception_enabled, exception_max_cents) values ($1,$2,$3)
         on conflict (tenant_id) do update set exception_enabled = excluded.exception_enabled, exception_max_cents = excluded.exception_max_cents, updated_at = now()`,
        [p.tenantId, b.enabled, b.maxCents],
      );
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "execution_policy.update", requestId: c.get("requestId"), metadata: b });
    });
    return c.json({ ok: true });
  });

  r.post("/orders/:id/executions", { auth: "tenant", permission: "orders:manage" }, async (c) => {
    const p = c.get("tenant");
    const id = uuid.parse(c.req.param("id"));
    const b = await parseJson(c, ExecutionBody);
    const out = await deps.db.tx(tctx(p), async (q) => {
      const os = await loadOrder(q, id);
      assertOpen(os);
      if ("itemId" in b) {
        const model = await loadModel(q, id);
        const cur = model.versions.find((v) => v.status === "published");
        const it = cur?.items.find((i) => i.id === b.itemId);
        const chk = canExecuteItem(it ? it.status : null, Boolean(it));
        if (!chk.allowed || !it) throw new HttpError(409, chk.reason ?? "not_approved");
        const ex = await q.one<{ id: string }>(
          `insert into service_executions (tenant_id, unit_id, os_id, item_id, description, amount_cents, started_by)
           values ($1,$2,$3,$4,$5,$6,$7) returning id`,
          [p.tenantId, os.unit_id, id, it.id, it.description, lineTotalCents(Number(it.qty), Number(it.unit_price_cents)), p.userId],
        );
        await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "execution.start", entityType: "order", entityId: id, requestId: c.get("requestId") });
        return { id: ex!.id, exception: false };
      }
      // Serviço fora do orçamento aprovado: só por procedimento de exceção configurado.
      if (!p.permissions.has("approvals:exception")) throw forbidden("exception_permission_required");
      const pol = await q.one<{ exception_enabled: boolean; exception_max_cents: string }>("select exception_enabled, exception_max_cents from execution_policies");
      if (!pol?.exception_enabled) throw new HttpError(409, "not_approved", "exceção não habilitada para esta oficina");
      if (b.amountCents > Number(pol.exception_max_cents)) throw new HttpError(409, "exception_over_limit");
      const ev = await q.one("select 1 from attachments where id = $1 and os_id = $2 and kind in ('photo','document')", [b.exception.evidenceAttachmentId, id]);
      if (!ev) throw new HttpError(422, "evidence_required");
      const ex = await q.one<{ id: string }>(
        `insert into service_executions (tenant_id, unit_id, os_id, description, amount_cents, started_by, exception)
         values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [
          p.tenantId, os.unit_id, id, b.description, b.amountCents, p.userId,
          JSON.stringify({ justification: b.exception.justification, evidenceAttachmentId: b.exception.evidenceAttachmentId, authorizedBy: p.userId, policyMaxCents: Number(pol.exception_max_cents), at: new Date().toISOString() }),
        ],
      );
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "execution.exception", entityType: "order", entityId: id, requestId: c.get("requestId"), metadata: { amountCents: b.amountCents } });
      return { id: ex!.id, exception: true };
    });
    return c.json(out, 201);
  });

  r.get("/orders/:id/executions", { auth: "tenant", permission: "orders:read" }, async (c) => {
    const p = c.get("tenant");
    const id = uuid.parse(c.req.param("id"));
    const rows = await deps.db.tx(tctx(p), async (q) => {
      await loadOrder(q, id);
      return q.many("select id, item_id, description, amount_cents, started_at, exception is not null as is_exception from service_executions where os_id = $1 order by started_at", [id]);
    });
    return c.json({ executions: rows });
  });
}
