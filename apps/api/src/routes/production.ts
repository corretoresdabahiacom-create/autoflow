import { z } from "zod";
import { audit } from "../audit";
import type { Q } from "../db";
import { HttpError, conflict, forbidden, notFound, parseJson } from "../http";
import type { Router } from "../router";
import { MAX_UPLOAD_BYTES, validateUpload } from "../storage";
import { addTimeline } from "../timeline";
import type { Deps, TenantPrincipal } from "../types";
import { tctx } from "./tenant";

const uuid = z.string().uuid();
const iso = z.string().datetime({ offset: true });
const DEFAULT_STAGES = ["Aguardando", "Em execução", "Controle de qualidade", "Pronto para entrega"];
const isManager = (p: TenantPrincipal) => p.permissions.has("production:manage");

const TaskSelect = `
  select t.id, t.os_id, t.unit_id, t.title, t.stage_id, t.assignee_membership_id, t.box_id, t.planned_start, t.planned_end,
         t.due_at, t.status, t.started_at, t.done_at, o.number as os_number,
         coalesce((select sum(extract(epoch from (coalesce(e.ended_at, now()) - e.started_at))) from task_time_entries e where e.task_id = t.id and e.kind = 'work'), 0)::bigint as tracked_seconds,
         coalesce((select sum(extract(epoch from (coalesce(e.ended_at, now()) - e.started_at))) from task_time_entries e where e.task_id = t.id and e.kind = 'pause'), 0)::bigint as paused_seconds,
         case when t.status in ('done') then greatest(0, extract(epoch from (t.done_at - t.due_at)))::bigint
              when t.status = 'cancelled' then 0
              else greatest(0, extract(epoch from (now() - t.due_at)))::bigint end as delay_seconds
    from production_tasks t join service_orders o on o.tenant_id = t.tenant_id and o.id = t.os_id`;

function presentTask(r: any) {
  return {
    id: r.id, osId: r.os_id, osNumber: r.os_number, unitId: r.unit_id, title: r.title, stageId: r.stage_id,
    assigneeMembershipId: r.assignee_membership_id, boxId: r.box_id, plannedStart: r.planned_start, plannedEnd: r.planned_end,
    dueAt: r.due_at, status: r.status, startedAt: r.started_at, doneAt: r.done_at,
    trackedMinutes: Math.round(Number(r.tracked_seconds) / 60), pausedMinutes: Math.round(Number(r.paused_seconds) / 60),
    delayMinutes: Math.round(Number(r.delay_seconds) / 60), delayed: Number(r.delay_seconds) > 0,
  };
}

async function ensureStages(q: Q, tenantId: string) {
  const n = await q.one<{ n: number }>("select count(*)::int as n from production_stages");
  if (n!.n === 0) for (const [i, name] of DEFAULT_STAGES.entries()) await q.query("insert into production_stages (tenant_id, name, position) values ($1,$2,$3)", [tenantId, name, i]);
}

export function registerProductionRoutes(r: Router, deps: Deps): void {
  const R = { auth: "tenant", permission: "production:read" } as const;
  const M = { auth: "tenant", permission: "production:manage" } as const;
  const W = { auth: "tenant", permission: "production:work" } as const;

  const loadTask = async (q: Q, id: string) => {
    const t = await q.one<any>(`${TaskSelect} where t.id = $1`, [id]);
    if (!t) throw notFound("task_not_found");
    return t;
  };
  /** Mecânico só enxerga/opera tarefa atribuída a ele; gestor (production:manage) vê todas da(s) sua(s) unidade(s). */
  const assertCanSee = (p: TenantPrincipal, t: { assignee_membership_id: string | null }) => {
    if (!isManager(p) && t.assignee_membership_id !== p.membershipId) throw notFound("task_not_found");
  };
  const assertCanOperate = (p: TenantPrincipal, t: { assignee_membership_id: string | null }) => {
    if (!isManager(p) && t.assignee_membership_id !== p.membershipId) throw notFound("task_not_found");
  };

  // ---- Etapas ----
  r.get("/production/stages", R, async (c) => {
    const p = c.get("tenant");
    const rows = await deps.db.tx(tctx(p), async (q) => {
      await ensureStages(q, p.tenantId); // defaults só se o tenant ainda não tem etapas
      return q.many("select id, unit_id, name, position, active from production_stages where active order by position, name");
    });
    return c.json({ stages: rows });
  });
  r.post("/production/stages", M, async (c) => {
    const p = c.get("tenant");
    const b = await parseJson(c, z.object({ name: z.string().trim().min(2).max(60), position: z.number().int().min(0).max(999), unitId: uuid.optional() }));
    const row = await deps.db.tx(tctx(p), async (q) => {
      const x = await q.one<{ id: string }>("insert into production_stages (tenant_id, unit_id, name, position) values ($1,$2,$3,$4) returning id", [p.tenantId, b.unitId ?? null, b.name, b.position]);
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "stage.create", entityType: "stage", entityId: x!.id, requestId: c.get("requestId") });
      return x;
    });
    return c.json(row, 201);
  });
  r.patch("/production/stages/:id", M, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id"));
    const b = await parseJson(c, z.object({ name: z.string().trim().min(2).max(60).optional(), position: z.number().int().min(0).max(999).optional(), active: z.boolean().optional() }));
    const ok = await deps.db.tx(tctx(p), (q) => q.one("update production_stages set name = coalesce($2,name), position = coalesce($3,position), active = coalesce($4,active) where id = $1 returning id", [id, b.name ?? null, b.position ?? null, b.active ?? null]));
    if (!ok) throw notFound("stage_not_found");
    return c.json({ ok: true });
  });

  // ---- Boxes ----
  r.get("/production/boxes", R, async (c) => {
    const p = c.get("tenant");
    return c.json({ boxes: await deps.db.tx(tctx(p), (q) => q.many("select id, unit_id, name, active from boxes order by name")) });
  });
  r.post("/production/boxes", M, async (c) => {
    const p = c.get("tenant");
    const b = await parseJson(c, z.object({ unitId: uuid, name: z.string().trim().min(1).max(60) }));
    const row = await deps.db.tx(tctx(p), (q) => q.one<{ id: string }>("insert into boxes (tenant_id, unit_id, name) values ($1,$2,$3) returning id", [p.tenantId, b.unitId, b.name]));
    return c.json(row, 201);
  });
  r.patch("/production/boxes/:id", M, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id"));
    const b = await parseJson(c, z.object({ name: z.string().trim().min(1).max(60).optional(), active: z.boolean().optional() }));
    const ok = await deps.db.tx(tctx(p), (q) => q.one("update boxes set name = coalesce($2,name), active = coalesce($3,active) where id = $1 returning id", [id, b.name ?? null, b.active ?? null]));
    if (!ok) throw notFound("box_not_found");
    return c.json({ ok: true });
  });

  // ---- Funcionários (memberships) e custo/hora ----
  r.get("/production/employees", R, async (c) => {
    const p = c.get("tenant");
    const rows = await deps.db.tx(tctx(p), (q) => q.many(
      `select m.id as membership_id, u.email, ro.key as role_key, ro.name as role_name, ${isManager(p) ? "er.hourly_cost_cents" : "null::bigint as hourly_cost_cents"}
         from memberships m join users u on u.id = m.user_id join roles ro on ro.id = m.role_id
         left join employee_rates er on er.tenant_id = m.tenant_id and er.membership_id = m.id
        where m.status = 'active' order by u.email`));
    return c.json({ employees: rows });
  });
  r.put("/production/employees/:membershipId/rate", M, async (c) => {
    const p = c.get("tenant"); const mid = uuid.parse(c.req.param("membershipId"));
    const b = await parseJson(c, z.object({ hourlyCostCents: z.number().int().min(0).max(10_000_000) }));
    await deps.db.tx(tctx(p), async (q) => {
      await q.query("insert into employee_rates (tenant_id, membership_id, hourly_cost_cents) values ($1,$2,$3) on conflict (tenant_id, membership_id) do update set hourly_cost_cents = excluded.hourly_cost_cents, updated_at = now()", [p.tenantId, mid, b.hourlyCostCents]);
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "employee.rate_set", entityType: "membership", entityId: mid, requestId: c.get("requestId") });
    });
    return c.json({ ok: true });
  });

  // ---- Kanban ----
  r.get("/production/board", R, async (c) => {
    const p = c.get("tenant");
    const unitId = c.req.query("unitId");
    if (unitId) uuid.parse(unitId);
    const out = await deps.db.tx(tctx(p), async (q) => {
      await ensureStages(q, p.tenantId); // defaults só se o tenant ainda não tem etapas
      const stages = await q.many<{ id: string; name: string; position: number }>("select id, name, position from production_stages where active order by position, name");
      const own = isManager(p) ? "" : "and exists (select 1 from production_tasks t where t.tenant_id = o.tenant_id and t.os_id = o.id and t.assignee_membership_id = $2)";
      const params: unknown[] = [unitId ?? null];
      if (!isManager(p)) params.push(p.membershipId);
      const orders = await q.many<{ id: string; number: number; stage_id: string | null; plate: string; unit_id: string; tasks_open: number; tasks_done: number }>(
        `select o.id, o.number, o.stage_id, o.unit_id, v.plate,
                (select count(*)::int from production_tasks t where t.tenant_id = o.tenant_id and t.os_id = o.id and t.status in ('todo','in_progress','paused')) as tasks_open,
                (select count(*)::int from production_tasks t where t.tenant_id = o.tenant_id and t.os_id = o.id and t.status = 'done') as tasks_done
           from service_orders o join vehicles v on v.tenant_id = o.tenant_id and v.id = o.vehicle_id
          where o.status = 'open' and ($1::uuid is null or o.unit_id = $1) ${own} order by o.number`, params);
      const first = stages[0]?.id ?? null;
      return {
        columns: stages.map((s) => ({ ...s, orders: orders.filter((o) => (o.stage_id ?? first) === s.id).map((o) => ({ id: o.id, number: o.number, plate: o.plate, unitId: o.unit_id, tasksOpen: o.tasks_open, tasksDone: o.tasks_done })) })),
      };
    });
    return c.json(out);
  });

  // Mudança de etapa: histórico + timeline/outbox na mesma transação (sem perda de notificação).
  r.put("/orders/:id/stage", M, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id"));
    const b = await parseJson(c, z.object({ stageId: uuid }));
    await deps.db.tx(tctx(p), async (q) => {
      const o = await q.one<{ unit_id: string; status: string; stage_id: string | null }>("select unit_id, status, stage_id from service_orders where id = $1 for update", [id]);
      if (!o) throw notFound("order_not_found");
      if (o.status !== "open") throw conflict("order_not_open");
      const s = await q.one<{ id: string; name: string }>("select id, name from production_stages where id = $1 and active", [b.stageId]);
      if (!s) throw new HttpError(422, "invalid_stage");
      if (o.stage_id === s.id) return;
      await q.query("update service_orders set stage_id = $2 where id = $1", [id, s.id]);
      await q.query("insert into os_stage_history (tenant_id, unit_id, os_id, from_stage_id, to_stage_id, changed_by) values ($1,$2,$3,$4,$5,$6)", [p.tenantId, o.unit_id, id, o.stage_id, s.id, p.userId]);
      await addTimeline(q, { tenantId: p.tenantId, unitId: o.unit_id, osId: id, kind: "stage.changed", title: `Seu veículo está na etapa: ${s.name}` });
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "order.stage_change", entityType: "order", entityId: id, requestId: c.get("requestId"), metadata: { to: s.id } });
    });
    return c.json({ ok: true });
  });

  // ---- Tarefas ----
  const TaskBody = z.object({
    title: z.string().trim().min(2).max(120),
    stageId: uuid.optional(), assigneeMembershipId: uuid.nullable().optional(), boxId: uuid.nullable().optional(),
    plannedStart: iso.nullable().optional(), plannedEnd: iso.nullable().optional(), dueAt: iso.nullable().optional(),
  });
  r.post("/orders/:id/tasks", M, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id"));
    const b = await parseJson(c, TaskBody);
    const row = await deps.db.tx(tctx(p), async (q) => {
      const o = await q.one<{ unit_id: string; status: string }>("select unit_id, status from service_orders where id = $1", [id]);
      if (!o) throw notFound("order_not_found");
      if (o.status !== "open") throw conflict("order_not_open");
      const x = await q.one<{ id: string }>(
        `insert into production_tasks (tenant_id, unit_id, os_id, title, stage_id, assignee_membership_id, box_id, planned_start, planned_end, due_at, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
        [p.tenantId, o.unit_id, id, b.title, b.stageId ?? null, b.assigneeMembershipId ?? null, b.boxId ?? null, b.plannedStart ?? null, b.plannedEnd ?? null, b.dueAt ?? null, p.userId]);
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "task.create", entityType: "task", entityId: x!.id, requestId: c.get("requestId") });
      return x;
    });
    return c.json(row, 201);
  });

  r.get("/orders/:id/tasks", R, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id"));
    const rows = await deps.db.tx(tctx(p), (q) => q.many<any>(`${TaskSelect} where t.os_id = $1 ${isManager(p) ? "" : "and t.assignee_membership_id = $2"} order by t.created_at`, isManager(p) ? [id] : [id, p.membershipId]));
    return c.json({ tasks: rows.map(presentTask) });
  });

  r.get("/production/tasks", R, async (c) => {
    const p = c.get("tenant");
    const unitId = c.req.query("unitId"); const status = c.req.query("status"); const assignee = c.req.query("assignee");
    if (unitId) uuid.parse(unitId);
    if (status) z.enum(["todo", "in_progress", "paused", "done", "cancelled"]).parse(status);
    if (assignee) uuid.parse(assignee);
    const where: string[] = []; const params: unknown[] = [];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
    if (!isManager(p)) add("t.assignee_membership_id = ?", p.membershipId);
    else if (assignee) add("t.assignee_membership_id = ?", assignee);
    if (unitId) add("t.unit_id = ?", unitId);
    if (status) add("t.status = ?", status);
    const rows = await deps.db.tx(tctx(p), (q) => q.many<any>(`${TaskSelect} ${where.length ? "where " + where.join(" and ") : ""} order by t.due_at nulls last, t.created_at limit 200`, params));
    return c.json({ tasks: rows.map(presentTask) });
  });

  r.patch("/production/tasks/:id", M, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id"));
    const b = await parseJson(c, TaskBody.partial());
    await deps.db.tx(tctx(p), async (q) => {
      const cur = await loadTask(q, id);
      if (["done", "cancelled"].includes(cur.status)) throw conflict("task_closed");
      const has = (k: keyof typeof b) => k in b;
      await q.query(
        `update production_tasks set title = $2, stage_id = $3, assignee_membership_id = $4, box_id = $5, planned_start = $6, planned_end = $7, due_at = $8 where id = $1`,
        [id, b.title ?? cur.title, has("stageId") ? b.stageId ?? null : cur.stage_id, has("assigneeMembershipId") ? b.assigneeMembershipId ?? null : cur.assignee_membership_id,
          has("boxId") ? b.boxId ?? null : cur.box_id, has("plannedStart") ? b.plannedStart ?? null : cur.planned_start,
          has("plannedEnd") ? b.plannedEnd ?? null : cur.planned_end, has("dueAt") ? b.dueAt ?? null : cur.due_at]);
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "task.update", entityType: "task", entityId: id, requestId: c.get("requestId") });
    });
    return c.json({ ok: true });
  });

  // Ações do executor. Concluir tarefa NUNCA altera a OS.
  const action = (name: "start" | "pause" | "resume" | "complete" | "cancel") =>
    r.post(`/production/tasks/:id/${name}`, name === "cancel" ? M : W, async (c) => {
      const p = c.get("tenant"); const id = uuid.parse(c.req.param("id"));
      const b = name === "pause" || name === "cancel" ? await parseJson(c, z.object({ reason: z.string().trim().min(3).max(300) })) : null;
      const out = await deps.db.tx(tctx(p), async (q) => {
        const t = await loadTask(q, id);
        assertCanOperate(p, t);
        const st = t.status as string;
        const closeOpen = () => q.query("update task_time_entries set ended_at = now() where task_id = $1 and ended_at is null", [id]);
        const open = (kind: "work" | "pause", reason?: string) => q.query(
          "insert into task_time_entries (tenant_id, unit_id, task_id, kind, reason, membership_id) values ($1,$2,$3,$4,$5,$6)", [p.tenantId, t.unit_id, id, kind, reason ?? null, p.membershipId]);
        const need = (...ok: string[]) => { if (!ok.includes(st)) throw conflict(`invalid_transition_from_${st}`); };
        if (name === "start") {
          need("todo");
          const os = await q.one<{ status: string }>("select status from service_orders where id = $1", [t.os_id]);
          if (os?.status !== "open") throw conflict("order_not_open");
          await q.query("update production_tasks set status = 'in_progress', started_at = now() where id = $1", [id]); await open("work");
        } else if (name === "pause") {
          need("in_progress"); await closeOpen(); await open("pause", b!.reason);
          await q.query("update production_tasks set status = 'paused' where id = $1", [id]);
        } else if (name === "resume") {
          need("paused"); await closeOpen(); await open("work");
          await q.query("update production_tasks set status = 'in_progress' where id = $1", [id]);
        } else if (name === "complete") {
          need("in_progress", "paused"); await closeOpen();
          await q.query("update production_tasks set status = 'done', done_at = now() where id = $1", [id]);
        } else {
          need("todo", "in_progress", "paused"); await closeOpen();
          await q.query("update production_tasks set status = 'cancelled' where id = $1", [id]);
        }
        await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: `task.${name}`, entityType: "task", entityId: id, requestId: c.get("requestId"), metadata: b ? { reason: b.reason } : undefined });
        return presentTask(await loadTask(q, id));
      });
      return c.json(out);
    });
  (["start", "pause", "resume", "complete", "cancel"] as const).forEach(action);

  r.get("/production/tasks/:id/time", R, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id"));
    const rows = await deps.db.tx(tctx(p), async (q) => {
      assertCanSee(p, await loadTask(q, id));
      return q.many("select kind, reason, started_at, ended_at from task_time_entries where task_id = $1 order by id", [id]);
    });
    return c.json({ entries: rows });
  });

  // Fotos da tarefa (vão para os anexos da OS, vinculados à tarefa)
  r.post("/production/tasks/:id/photos", W, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id"));
    const form = await c.req.parseBody();
    const file = form["file"];
    if (!(file instanceof File)) throw new HttpError(422, "file_required");
    if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(422, "file_too_large");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mime = validateUpload(bytes, file.type || undefined);
    if (mime === "application/pdf") throw new HttpError(422, "photo_must_be_image");
    const saved = await deps.db.tx(tctx(p), async (q) => {
      const t = await loadTask(q, id); assertCanOperate(p, t);
      const attId = crypto.randomUUID(); const key = `${p.tenantId}/${t.os_id}/${attId}`;
      const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)), (x) => x.toString(16).padStart(2, "0")).join("");
      await q.query("insert into attachments (id, tenant_id, unit_id, os_id, kind, storage_key, mime, size_bytes, sha256, created_by, task_id) values ($1,$2,$3,$4,'photo',$5,$6,$7,$8,$9,$10)",
        [attId, p.tenantId, t.unit_id, t.os_id, key, mime, bytes.length, sha, p.userId, id]);
      await deps.storage.put(key, bytes);
      return { id: attId };
    });
    return c.json(saved, 201);
  });

  // Mão de obra (preparação Fase 5): minutos apontados × custo/hora. Apenas gestão.
  r.get("/orders/:id/labor", M, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id"));
    const rows = await deps.db.tx(tctx(p), (q) => q.many<{ task_id: string; membership_id: string | null; seconds: string; rate: string | null }>(
      `select e.task_id, e.membership_id, sum(extract(epoch from (coalesce(e.ended_at, now()) - e.started_at)))::bigint as seconds, er.hourly_cost_cents as rate
         from task_time_entries e join production_tasks t on t.tenant_id = e.tenant_id and t.id = e.task_id
         left join employee_rates er on er.tenant_id = e.tenant_id and er.membership_id = e.membership_id
        where t.os_id = $1 and e.kind = 'work' group by e.task_id, e.membership_id, er.hourly_cost_cents`, [id]));
    const lines = rows.map((x) => ({ taskId: x.task_id, membershipId: x.membership_id, minutes: Math.round(Number(x.seconds) / 60), costCents: x.rate === null ? null : Math.round((Number(x.seconds) * Number(x.rate)) / 3600) }));
    return c.json({ lines, totalMinutes: lines.reduce((s, l) => s + l.minutes, 0), totalCostCents: lines.reduce((s, l) => s + (l.costCents ?? 0), 0), missingRate: lines.some((l) => l.costCents === null) });
  });

  // ---- Agenda básica ----
  const AppBody = z.object({
    unitId: uuid, title: z.string().trim().min(2).max(120), startsAt: iso, endsAt: iso,
    boxId: uuid.nullable().optional(), membershipId: uuid.nullable().optional(), customerId: uuid.nullable().optional(), vehicleId: uuid.nullable().optional(),
  });
  r.post("/appointments", { auth: "tenant", permission: "schedule:manage" }, async (c) => {
    const p = c.get("tenant");
    const b = await parseJson(c, AppBody);
    const row = await deps.db.tx(tctx(p), (q) => q.one<{ id: string }>(
      `insert into appointments (tenant_id, unit_id, title, starts_at, ends_at, box_id, membership_id, customer_id, vehicle_id, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [p.tenantId, b.unitId, b.title, b.startsAt, b.endsAt, b.boxId ?? null, b.membershipId ?? null, b.customerId ?? null, b.vehicleId ?? null, p.userId]));
    return c.json(row, 201);
  });
  r.patch("/appointments/:id", { auth: "tenant", permission: "schedule:manage" }, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id"));
    const b = await parseJson(c, z.object({ startsAt: iso, endsAt: iso, boxId: uuid.nullable().optional(), membershipId: uuid.nullable().optional() }));
    const ok = await deps.db.tx(tctx(p), async (q) => {
      const cur = await q.one<{ status: string; box_id: string | null; membership_id: string | null }>("select status, box_id, membership_id from appointments where id = $1", [id]);
      if (!cur) throw notFound("appointment_not_found");
      if (cur.status !== "scheduled") throw conflict("appointment_closed");
      await q.query("update appointments set starts_at = $2, ends_at = $3, box_id = $4, membership_id = $5 where id = $1",
        [id, b.startsAt, b.endsAt, "boxId" in b ? b.boxId ?? null : cur.box_id, "membershipId" in b ? b.membershipId ?? null : cur.membership_id]);
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "appointment.reschedule", entityType: "appointment", entityId: id, requestId: c.get("requestId") });
      return true;
    });
    return c.json({ ok });
  });
  r.post("/appointments/:id/cancel", { auth: "tenant", permission: "schedule:manage" }, async (c) => {
    const p = c.get("tenant"); const id = uuid.parse(c.req.param("id"));
    const b = await parseJson(c, z.object({ reason: z.string().trim().min(3).max(300) }));
    const ok = await deps.db.tx(tctx(p), async (q) => {
      const x = await q.one("update appointments set status = 'cancelled', cancel_reason = $2 where id = $1 and status = 'scheduled' returning id", [id, b.reason]);
      if (!x) throw notFound("appointment_not_found");
      await audit(q, { tenantId: p.tenantId, actorType: "user", actorId: p.userId, action: "appointment.cancel", entityType: "appointment", entityId: id, requestId: c.get("requestId") });
      return true;
    });
    return c.json({ ok });
  });

  /** Visões dia/semana/mês = intervalo from/to (o cliente escolhe). Filtros por unidade/box/funcionário. Mecânico só vê o que é seu. */
  r.get("/schedule", { auth: "tenant", permission: "schedule:read" }, async (c) => {
    const p = c.get("tenant");
    const q0 = z.object({ from: iso, to: iso, unitId: uuid.optional(), boxId: uuid.optional(), membershipId: uuid.optional() }).parse(Object.fromEntries(new URL(c.req.url).searchParams));
    if (new Date(q0.to).getTime() - new Date(q0.from).getTime() > 45 * 86400_000) throw new HttpError(422, "range_too_large");
    const own = p.permissions.has("schedule:manage") || isManager(p) ? null : p.membershipId;
    const out = await deps.db.tx(tctx(p), async (q) => {
      const ap = await q.many(
        `select id, unit_id, box_id, membership_id, customer_id, vehicle_id, title, starts_at, ends_at, status from appointments
          where starts_at < $2 and ends_at > $1 and status <> 'cancelled' and ($3::uuid is null or unit_id = $3) and ($4::uuid is null or box_id = $4)
            and ($5::uuid is null or membership_id = $5) and ($6::uuid is null or membership_id = $6) order by starts_at`,
        [q0.from, q0.to, q0.unitId ?? null, q0.boxId ?? null, q0.membershipId ?? null, own]);
      const tk = await q.many<any>(
        `${TaskSelect} where t.planned_start < $2 and t.planned_end > $1 and t.status in ('todo','in_progress','paused')
           and ($3::uuid is null or t.unit_id = $3) and ($4::uuid is null or t.box_id = $4) and ($5::uuid is null or t.assignee_membership_id = $5)
           and ($6::uuid is null or t.assignee_membership_id = $6) order by t.planned_start`,
        [q0.from, q0.to, q0.unitId ?? null, q0.boxId ?? null, q0.membershipId ?? null, own ?? (isManager(p) ? null : p.membershipId)]);
      return { appointments: ap, tasks: tk.map(presentTask) };
    });
    return c.json(out);
  });
  void forbidden;
}
