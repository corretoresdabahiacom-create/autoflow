/** Métricas em memória no formato Prometheus (sem PII: rota por PADRÃO, nunca por URL com ids/tokens). */
const BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
interface Series { count: number; sum: number; buckets: number[] }
export class Metrics {
  private readonly http = new Map<string, Series>();
  private readonly startedAt = Date.now();
  record(method: string, route: string, status: number, seconds: number): void {
    const key = `${method}\u0000${route}\u0000${status}`;
    const s = this.http.get(key) ?? { count: 0, sum: 0, buckets: BUCKETS.map(() => 0) };
    s.count++; s.sum += seconds; BUCKETS.forEach((b, i) => { if (seconds <= b) s.buckets[i]!++; });
    this.http.set(key, s);
  }
  /** p95 aproximado por rota (a partir do histograma) — usado nos relatórios de carga/testes. */
  p95(route: string): number | null {
    let count = 0; const b = BUCKETS.map(() => 0);
    for (const [k, s] of this.http) if (k.split("\u0000")[1] === route) { count += s.count; s.buckets.forEach((v, i) => (b[i] = b[i]! + v)); }
    if (!count) return null;
    const i = b.findIndex((v) => v / count >= 0.95); return i === -1 ? Infinity : BUCKETS[i]!;
  }
  render(gauges: Record<string, number>): string {
    const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const out: string[] = ["# TYPE autoflow_http_requests_total counter", "# TYPE autoflow_http_request_duration_seconds histogram"];
    for (const [k, s] of this.http) {
      const [m, r, st] = k.split("\u0000") as [string, string, string]; const l = `method="${m}",route="${esc(r)}",status="${st}"`;
      out.push(`autoflow_http_requests_total{${l}} ${s.count}`);
      BUCKETS.forEach((b, i) => out.push(`autoflow_http_request_duration_seconds_bucket{${l},le="${b}"} ${s.buckets[i]}`));
      out.push(`autoflow_http_request_duration_seconds_bucket{${l},le="+Inf"} ${s.count}`, `autoflow_http_request_duration_seconds_sum{${l}} ${s.sum.toFixed(6)}`, `autoflow_http_request_duration_seconds_count{${l}} ${s.count}`);
    }
    out.push("# TYPE autoflow_uptime_seconds gauge", `autoflow_uptime_seconds ${Math.round((Date.now() - this.startedAt) / 1000)}`);
    for (const [k, v] of Object.entries(gauges)) out.push(`# TYPE ${k} gauge`, `${k} ${v}`);
    return out.join("\n") + "\n";
  }
}
