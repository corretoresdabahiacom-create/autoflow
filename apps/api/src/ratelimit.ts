import type { Db } from "./db";
import { HttpError } from "./http";

export type RateRule = readonly [key: string, limit: number, windowSeconds: number];

/**
 * Janela fixa em tabela (funciona com Hyperdrive/Workers). Incrementa atomicamente
 * e bloqueia ao exceder. Chaves devem usar hashes, nunca PII em claro.
 */
export async function enforceRateLimit(db: Db, rules: readonly RateRule[]): Promise<void> {
  const exceeded = await db.system(async (q) => {
    let worst = 0;
    for (const [key, limit, windowSec] of rules) {
      const row = await q.one<{ count: number }>(
        `insert into rate_limits (key, window_start, count)
         values ($1, to_timestamp(floor(extract(epoch from now()) / $2::int) * $2::int), 1)
         on conflict (key, window_start) do update set count = rate_limits.count + 1
         returning count`,
        [key, windowSec],
      );
      if (row && row.count > limit) worst = Math.max(worst, windowSec);
    }
    return worst;
  });
  if (exceeded > 0) {
    throw new HttpError(429, "rate_limited", undefined, { "Retry-After": String(Math.min(exceeded, 900)) });
  }
}

/** Incrementa e devolve o contador da janela (sem lançar). Usado para atraso progressivo. */
export async function bumpCounter(db: Db, key: string, windowSec: number): Promise<number> {
  return db.system(async (q) => {
    const row = await q.one<{ count: number }>(
      `insert into rate_limits (key, window_start, count)
       values ($1, to_timestamp(floor(extract(epoch from now()) / $2::int) * $2::int), 1)
       on conflict (key, window_start) do update set count = rate_limits.count + 1
       returning count`,
      [key, windowSec],
    );
    return row?.count ?? 1;
  });
}
