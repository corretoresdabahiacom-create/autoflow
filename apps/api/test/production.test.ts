import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/password";
import { Client, type Harness, type SeededTenant, PW, loginOwner, makeHarness, ownerSql, seedTenant, uniq } from "./harness";

let h: Harness;
beforeAll(() => { h = makeHarness(); });
afterAll(async () => h.db.close());

let ipn = 1;
const nextIp = () => `10.88.${Math.floor(ipn / 250)}.${(ipn++ % 250) + 1}`;
const T = (min: number) => new Date(Date.UTC(2030, 0, 1, 12, 0) + min * 60_000).toISOString();

async function setup() {
  const t = await seedTenant(h);
  const c = await loginOwner(h, t, nextIp());
  const cu = await c.post("/customers", { name: "Maria Silva", phone: "(71) 99999-1234", email: "m@example.test" });
  const ve = await c.post(`/customers/${cu.json.id}/vehicles`, { plate: `PRD${Math.floor(Math.random() * 9)}${"ABCDEFGHJK"[Math.floor(Math.random() * 10)]}${Math.floor(Math.random() * 90 + 10)}`, make: "VW", model: "Gol" });
  const mkOrder = async (unitId?: string) => {
    const o = await c.post("/orders", { customerId: cu.json.id, vehicleId: ve.json.id, unitId });
    expect(o.status, JSON.stringify(o.json)).toBe(201); return o.json.id as string;
  };
  return { t, c, mkOrder, customerId: cu.json.id as string };
}
async function addMember(t: SeededTenant, role: string, units: "all" | string[] = "all") {
  const email = `${uniq("m")}@example.test`;
  const hash = await hashPassword(PW, 10);
  const u = await ownerSql<{ id: string }>("insert into users (email, password_hash) values ($1,$2) returning id", [email, hash]);
  const r = await ownerSql<{ id: string }>("select id from roles where tenant_id is null and key = $1", [role]);
  const m = await ownerSql<{ id: string }>("insert into memberships (tenant_id, user_id, role_id, status, all_units) values ($1,$2,$3,'active',$4) returning id", [t.tenantId, u[0]!.id, r[0]!.id, units === "all"]);
  if (units !== "all") for (const uid of units) await ownerSql("insert into unit_memberships (tenant_id, membership_id, unit_id) values ($1,$2,$3)", [t.tenantId, m[0]!.id, uid]);
  const cl = new Client(h, nextIp());
  const lr = await cl.post("/auth/login", { email, password: PW, tenantSlug: t.slug });
  expect(lr.status).toBe(200);
  return { cl, membershipId: m[0]!.id };
}
const task = (c: Client, orderId: string, body: Record<string, unknown>) => c.post(`/orders/${orderId}/tasks`, { title: "Troca de pastilhas", ...body });

describe("D1 concluir tarefa não conclui a OS; tarefas simultâneas", () => {
  it("várias tarefas por OS; concluir uma deixa a OS aberta", async () => {
    const s = await setup(); const os = await s.mkOrder();
    const a = await task(s.c, os, { title: "Freios" }); const b = await task(s.c, os, { title: "Alinhamento" });
    expect(a.status).toBe(201); expect(b.status).toBe(201);
    await s.c.post(`/production/tasks/${a.json.id}/start`); await s.c.post(`/production/tasks/${b.json.id}/start`);
    expect((await s.c.post(`/production/tasks/${a.json.id}/complete`)).json.status).toBe("done");
    const o = await s.c.get(`/orders/${os}`);
    expect(o.json.status ?? o.json.order?.status).toBe("open");
    const list = await s.c.get(`/orders/${os}/tasks`);
    expect(list.json.tasks.map((x: any) => x.status).sort()).toEqual(["done", "in_progress"]);
  });
});

describe("D2 box sem sobreposição (EXCLUDE)", () => {
  it("boxes diferentes simultâneos ok; mesmo box sobreposto = 409; adjacente ok; cancelada libera", async () => {
    const s = await setup(); const os = await s.mkOrder();
    const b1 = (await s.c.post("/production/boxes", { unitId: s.t.unitIds[0], name: "Box 1" })).json.id;
    const b2 = (await s.c.post("/production/boxes", { unitId: s.t.unitIds[0], name: "Box 2" })).json.id;
    const t1 = await task(s.c, os, { boxId: b1, plannedStart: T(0), plannedEnd: T(60) });
    expect(t1.status, JSON.stringify(t1.json)).toBe(201);
    expect((await task(s.c, os, { boxId: b2, plannedStart: T(0), plannedEnd: T(60) })).status).toBe(201);
    const clash = await task(s.c, os, { boxId: b1, plannedStart: T(30), plannedEnd: T(90) });
    expect(clash.status).toBe(409); expect(clash.json.error).toBe("box_conflict");
    expect((await task(s.c, os, { boxId: b1, plannedStart: T(60), plannedEnd: T(120) })).status).toBe(201);
    await s.c.post(`/production/tasks/${t1.json.id}/cancel`, { reason: "cliente desistiu" });
    expect((await task(s.c, os, { boxId: b1, plannedStart: T(10), plannedEnd: T(50) })).status).toBe(201);
    // box exige janela planejada
    expect((await task(s.c, os, { boxId: b2 })).status).toBe(409);
  });
  it("concorrência: 10 tentativas simultâneas no mesmo box/horário => exatamente 1 sucesso", async () => {
    const s = await setup(); const os = await s.mkOrder();
    const b = (await s.c.post("/production/boxes", { unitId: s.t.unitIds[0], name: "Box C" })).json.id;
    const res = await Promise.all(Array.from({ length: 10 }, () => task(s.c, os, { boxId: b, plannedStart: T(0), plannedEnd: T(60) })));
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409)).toHaveLength(9);
  });
});

describe("D3 escopo do mecânico", () => {
  it("vê/opera só as suas tarefas; sem permissões de gestão; unidade respeitada", async () => {
    const s = await setup();
    const os0 = await s.mkOrder(s.t.unitIds[0]!); const os1 = await s.mkOrder(s.t.unitIds[1]!);
    const mec = await addMember(s.t, "mechanic", [s.t.unitIds[0]!]);
    const other = await addMember(s.t, "mechanic", "all");
    const mine = await task(s.c, os0, { title: "Minha", assigneeMembershipId: mec.membershipId });
    const theirs = await task(s.c, os0, { title: "Do outro", assigneeMembershipId: other.membershipId });
    const u1 = await task(s.c, os1, { title: "Outra unidade", assigneeMembershipId: mec.membershipId });
    expect(u1.status).toBe(201);
    const list = await mec.cl.get("/production/tasks");
    expect(list.json.tasks.map((t: any) => t.title)).toEqual(["Minha"]); // nem do outro, nem da outra unidade
    expect((await mec.cl.post(`/production/tasks/${theirs.json.id}/start`)).status).toBe(404);
    expect((await mec.cl.post(`/production/tasks/${u1.json.id}/start`)).status).toBe(404);
    expect((await mec.cl.get(`/production/tasks/${theirs.json.id}/time`)).status).toBe(404);
    expect((await mec.cl.post(`/production/tasks/${mine.json.id}/start`)).status).toBe(200);
    expect((await mec.cl.post(`/orders/${os0}/tasks`, { title: "Nova" })).status).toBe(403);
    expect((await mec.cl.put(`/orders/${os0}/stage`, { stageId: crypto.randomUUID() })).status).toBe(403);
    expect((await mec.cl.get(`/orders/${os0}/labor`)).status).toBe(403);
    const board = await mec.cl.get("/production/board");
    expect(board.json.columns.flatMap((c: any) => c.orders).map((o: any) => o.id)).toEqual([os0]);
    const emp = await mec.cl.get("/production/employees");
    expect(emp.json.employees.every((e: any) => e.hourly_cost_cents === null)).toBe(true);
  });
  it("tenant B não enxerga tarefas do A", async () => {
    const A = await setup(); const B = await setup();
    const os = await A.mkOrder(); const t = await task(A.c, os, {});
    expect((await B.c.post(`/production/tasks/${t.json.id}/start`)).status).toBe(404);
    expect((await B.c.get("/production/tasks")).json.tasks).toHaveLength(0);
  });
});

describe("D4 pausas, atrasos e tempo", () => {
  it("pausa exige motivo; tempo/pausa calculados; atraso calculado", async () => {
    const s = await setup(); const os = await s.mkOrder();
    const t = await task(s.c, os, { dueAt: new Date(Date.now() - 3600_000).toISOString() });
    const id = t.json.id;
    expect((await s.c.post(`/production/tasks/${id}/pause`, {})).status).toBe(422);
    expect((await s.c.post(`/production/tasks/${id}/pause`, { reason: "x" })).status).toBe(422);
    expect((await s.c.post(`/production/tasks/${id}/pause`, { reason: "aguardando peça" })).status).toBe(409); // não iniciada
    await s.c.post(`/production/tasks/${id}/start`);
    expect((await s.c.post(`/production/tasks/${id}/start`)).status).toBe(409);
    await s.c.post(`/production/tasks/${id}/pause`, { reason: "aguardando peça" });
    // recua entradas de tempo no banco para valores determinísticos
    await ownerSql("update task_time_entries set started_at = started_at - interval '90 minutes', ended_at = ended_at - interval '60 minutes' where task_id = $1 and kind = 'work'", [id]);
    await ownerSql("update task_time_entries set started_at = started_at - interval '60 minutes' where task_id = $1 and kind = 'pause'", [id]);
    await s.c.post(`/production/tasks/${id}/resume`);
    const done = await s.c.post(`/production/tasks/${id}/complete`);
    expect(done.status).toBe(200);
    expect(done.json.trackedMinutes).toBeGreaterThanOrEqual(30);
    expect(done.json.pausedMinutes).toBeGreaterThanOrEqual(59);
    expect(done.json.delayed).toBe(true);
    expect(done.json.delayMinutes).toBeGreaterThanOrEqual(59);
    const time = await s.c.get(`/production/tasks/${id}/time`);
    expect(time.json.entries.find((e: any) => e.kind === "pause").reason).toBe("aguardando peça");
    expect((await s.c.post(`/production/tasks/${id}/resume`)).status).toBe(409);
    // banco: pausa sem motivo e duas entradas abertas são impossíveis
    await expect(ownerSql("insert into task_time_entries (tenant_id, unit_id, task_id, kind) select tenant_id, unit_id, id, 'pause' from production_tasks where id = $1", [id])).rejects.toThrow();
  });
});

describe("D5 etapa notifica o portal via outbox sem perda", () => {
  it("mudança de etapa grava histórico, timeline e outbox na mesma transação; etapa inválida não deixa rastro", async () => {
    const s = await setup(); const os = await s.mkOrder();
    const st = (await s.c.get("/production/stages")).json.stages;
    expect(st.length).toBeGreaterThanOrEqual(4);
    const before = await ownerSql<{ n: number }>("select count(*)::int n from outbox where os_id = $1", [os]);
    expect((await s.c.put(`/orders/${os}/stage`, { stageId: crypto.randomUUID() })).status).toBe(422);
    expect((await ownerSql<{ n: number }>("select count(*)::int n from outbox where os_id = $1", [os]))[0]!.n).toBe(before[0]!.n);
    expect((await s.c.put(`/orders/${os}/stage`, { stageId: st[1].id })).status).toBe(200);
    expect((await ownerSql<{ n: number }>("select count(*)::int n from outbox where os_id = $1", [os]))[0]!.n).toBe(before[0]!.n + 1);
    expect((await ownerSql("select 1 from os_stage_history where os_id = $1", [os]))).toHaveLength(1);
    expect((await ownerSql("select 1 from os_timeline where os_id = $1 and kind = 'stage.changed'", [os]))).toHaveLength(1);
    expect((await s.c.put(`/orders/${os}/stage`, { stageId: st[1].id })).status).toBe(200); // idempotente
    expect((await ownerSql("select 1 from os_stage_history where os_id = $1", [os]))).toHaveLength(1);
    const board = await s.c.get("/production/board");
    expect(board.json.columns.find((c: any) => c.id === st[1].id).orders.map((o: any) => o.id)).toContain(os);
    await expect(ownerSql("update os_stage_history set to_stage_id = to_stage_id where os_id = $1", [os])).rejects.toThrow();
  });
  it("etapas configuráveis (criar/renomear/desativar)", async () => {
    const s = await setup(); await s.c.get("/production/stages");
    const n = await s.c.post("/production/stages", { name: "Lanternagem", position: 5 });
    expect(n.status).toBe(201);
    expect((await s.c.post("/production/stages", { name: "lanternagem", position: 6 })).status).toBe(409);
    expect((await s.c.patch(`/production/stages/${n.json.id}`, { active: false })).status).toBe(200);
    expect((await s.c.get("/production/stages")).json.stages.some((x: any) => x.id === n.json.id)).toBe(false);
  });
});

describe("D6 tempo apontado → mão de obra", () => {
  it("custo = minutos × custo/hora (centavos); sem taxa sinaliza", async () => {
    const s = await setup(); const os = await s.mkOrder();
    const emp = (await s.c.get("/production/employees")).json.employees[0];
    expect((await s.c.put(`/production/employees/${emp.membership_id}/rate`, { hourlyCostCents: 6000 })).status).toBe(200);
    const t = await task(s.c, os, {});
    await s.c.post(`/production/tasks/${t.json.id}/start`);
    await s.c.post(`/production/tasks/${t.json.id}/complete`);
    await ownerSql("update task_time_entries set started_at = now() - interval '2 hours', ended_at = now() where task_id = $1", [t.json.id]);
    const l = await s.c.get(`/orders/${os}/labor`);
    expect(l.json.totalMinutes).toBe(120);
    expect(l.json.totalCostCents).toBe(12000);
    expect(l.json.missingRate).toBe(false);
  });
});

describe("Agenda básica", () => {
  it("cria, filtra (dia/semana), reagenda, cancela com motivo; conflito de box; mecânico não gerencia", async () => {
    const s = await setup();
    const box = (await s.c.post("/production/boxes", { unitId: s.t.unitIds[0], name: "Box A" })).json.id;
    const mk = (startMin: number, endMin: number, extra: Record<string, unknown> = {}) =>
      s.c.post("/appointments", { unitId: s.t.unitIds[0], title: "Revisão", startsAt: T(startMin), endsAt: T(endMin), boxId: box, customerId: s.customerId, ...extra });
    const a = await mk(0, 60); expect(a.status, JSON.stringify(a.json)).toBe(201);
    expect((await mk(30, 90)).status).toBe(409);
    const b = await mk(60, 120); expect(b.status).toBe(201);
    const day = await s.c.get(`/schedule?from=${encodeURIComponent(T(-60))}&to=${encodeURIComponent(T(30))}&unitId=${s.t.unitIds[0]}`);
    expect(day.json.appointments).toHaveLength(1);
    const week = await s.c.get(`/schedule?from=${encodeURIComponent(T(-60))}&to=${encodeURIComponent(T(7 * 1440))}&boxId=${box}`);
    expect(week.json.appointments).toHaveLength(2);
    expect((await s.c.patch(`/appointments/${b.json.id}`, { startsAt: T(30), endsAt: T(90) })).status).toBe(409);
    expect((await s.c.patch(`/appointments/${b.json.id}`, { startsAt: T(120), endsAt: T(180) })).status).toBe(200);
    expect((await s.c.post(`/appointments/${a.json.id}/cancel`, {})).status).toBe(422);
    expect((await s.c.post(`/appointments/${a.json.id}/cancel`, { reason: "cliente remarcou" })).status).toBe(200);
    expect((await mk(0, 60)).status).toBe(201); // box liberado
    const mec = await addMember(s.t, "mechanic");
    expect((await mec.cl.post("/appointments", { unitId: s.t.unitIds[0], title: "X", startsAt: T(0), endsAt: T(5) })).status).toBe(403);
    expect((await s.c.get(`/schedule?from=${encodeURIComponent(T(0))}&to=${encodeURIComponent(T(60 * 24 * 90))}`)).status).toBe(422);
  });
});

describe("Fotos da tarefa", () => {
  it("executor anexa foto (vinculada à tarefa e à OS); outro mecânico não consegue", async () => {
    const s = await setup(); const os = await s.mkOrder();
    const mec = await addMember(s.t, "mechanic"); const other = await addMember(s.t, "mechanic");
    const t = await task(s.c, os, { assigneeMembershipId: mec.membershipId });
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const send = async (cl: Client) => {
      const fd = new FormData(); fd.set("file", new File([png as BlobPart], "x.png", { type: "image/png" }));
      return h.app.request(`/production/tasks/${t.json.id}/photos`, { method: "POST", headers: { origin: "http://localhost:5173", "x-real-ip": nextIp(), cookie: [...cl.cookies].map(([k, v]) => `${k}=${v}`).join("; ") }, body: fd });
    };
    expect((await send(other.cl)).status).toBe(404);
    expect((await send(mec.cl)).status).toBe(201);
    expect((await ownerSql("select 1 from attachments where task_id = $1 and os_id = $2", [t.json.id, os]))).toHaveLength(1);
  });
});
