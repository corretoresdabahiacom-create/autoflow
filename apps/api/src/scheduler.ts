import { processOutbox } from "./outbox";
import { runBilling } from "./routes/billing";
import { runAutomations } from "./routes/advanced";
import { retryDue } from "./webhooks";
import type { Deps } from "./types";

export type JobName = "outbox" | "webhooks" | "automation" | "billing";
export interface JobStat { lastRunTs: number; lastSuccessTs: number; failures: number; lastError: string | null }
export const jobStats: Record<JobName, JobStat> = Object.fromEntries((["outbox", "webhooks", "automation", "billing"] as JobName[]).map((j) => [j, { lastRunTs: 0, lastSuccessTs: 0, failures: 0, lastError: null }])) as Record<JobName, JobStat>;

/** Intervalos em ms. billing é idempotente (por período); rodar a cada hora é seguro. */
export const JOBS: Record<JobName, { everyMs: number; run: (deps: Deps) => Promise<unknown> }> = {
  outbox: { everyMs: 30_000, run: async (deps) => {
    const tenants = await deps.db.tx({ actor: "platform" }, (q) => q.many<{ id: string }>("select id from tenants where status in ('active','trial') order by id"));
    const total = { sent: 0, skipped: 0, failed: 0 };
    for (const t of tenants) { const r = await processOutbox(deps, t.id); total.sent += r.sent; total.skipped += r.skipped; total.failed += r.failed; }
    return total;
  } },
  webhooks: { everyMs: 60_000, run: (deps) => retryDue(deps) },
  automation: { everyMs: 300_000, run: (deps) => runAutomations(deps) },
  billing: { everyMs: 3_600_000, run: (deps) => runBilling(deps) },
};

const lockKey = (job: JobName) => `autoflow:job:${job}`;

/**
 * Executa um job com exclusão entre instâncias (advisory lock de sessão). Retorna `skipped` se outra instância já o executa.
 * Falhas são contadas e registradas (sem PII); nunca propagam, para não derrubar o laço.
 */
export async function runJob(deps: Deps, job: JobName): Promise<{ status: "ok" | "skipped" | "failed"; result?: unknown }> {
  const client = await deps.db.pool.connect();
  const st = jobStats[job];
  try {
    const got = (await client.query("select pg_try_advisory_lock(hashtextextended($1, 0)) as ok", [lockKey(job)])).rows[0]?.ok === true;
    if (!got) return { status: "skipped" };
    st.lastRunTs = Date.now() / 1000;
    try {
      const result = await JOBS[job].run(deps);
      st.lastSuccessTs = Date.now() / 1000; st.lastError = null;
      return { status: "ok", result };
    } catch (e) {
      st.failures++; st.lastError = e instanceof Error ? e.message.slice(0, 200) : "error";
      if (deps.config.logLevel !== "silent") console.error(JSON.stringify({ level: "error", msg: "job_failed", job, error: st.lastError }));
      return { status: "failed" };
    } finally {
      await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [lockKey(job)]);
    }
  } finally { client.release(); }
}

/** Liga os temporizadores. Retorna função de parada. Habilitado por SCHEDULER=on (desligado por padrão: testes e dev). */
export function startScheduler(deps: Deps): () => void {
  const timers = (Object.keys(JOBS) as JobName[]).map((j) => {
    const t = setInterval(() => { void runJob(deps, j); }, JOBS[j].everyMs); t.unref();
    return t;
  });
  return () => timers.forEach(clearInterval);
}

export function jobGauges(): Record<string, number> {
  const g: Record<string, number> = {};
  for (const [j, s] of Object.entries(jobStats)) { g[`autoflow_job_${j}_last_success_timestamp_seconds`] = Math.round(s.lastSuccessTs); g[`autoflow_job_${j}_failures_total`] = s.failures; }
  return g;
}
