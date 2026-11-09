import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { Db } from "../src/db";
import { MemoryEmailProvider } from "../src/email";
import { hashPassword } from "../src/password";
import { newTotpSecret, totpAtStep, totpStepNow, encryptSecret } from "../src/crypto";

export const ORIGIN = "http://localhost:5173";
export const PW = "Senha-Forte-123!";

export function makeHarness() {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: process.env.TEST_DATABASE_URL!,
    PASSWORD_SCRYPT_LOG_N: "10",
    ALLOWED_ORIGINS: ORIGIN,
    LOG_LEVEL: "silent",
  });
  const db = new Db(config.databaseUrl, 5);
  const email = new MemoryEmailProvider();
  const { app, registry } = createApp({ config, db, email });
  return { config, db, email, app, registry };
}
export type Harness = ReturnType<typeof makeHarness>;

/** Cliente com jar de cookies simples. */
export class Client {
  cookies = new Map<string, string>();
  constructor(private h: Harness, private ip = "10.0.0.1") {}
  async req(method: string, path: string, body?: unknown, opts: { origin?: string | null } = {}) {
    const headers: Record<string, string> = { "x-real-ip": this.ip };
    if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await this.h.app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(";");
      const i = pair!.indexOf("=");
      const k = pair!.slice(0, i);
      const v = pair!.slice(i + 1);
      if (v === "" || /max-age=0/i.test(sc)) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    const json = await res.json().catch(() => null) as Record<string, any> | null;
    return { status: res.status, json: json ?? {}, headers: res.headers };
  }
  get = (p: string) => this.req("GET", p);
  post = (p: string, b?: unknown) => this.req("POST", p, b ?? {});
  patch = (p: string, b?: unknown) => this.req("PATCH", p, b ?? {});
  put = (p: string, b?: unknown) => this.req("PUT", p, b ?? {});
}

let counter = 0;
export const uniq = (p: string) => `${p}${Date.now().toString(36)}${(counter++).toString(36)}`;

export interface SeededTenant {
  tenantId: string;
  slug: string;
  unitIds: string[];
  owners: { email: string; userId: string };
}

/** Cria tenant diretamente como dono do schema (fixture de teste; não passa pela API). */
export async function seedTenant(h: Harness, opts: { plan?: string; units?: number } = {}): Promise<SeededTenant> {
  const pg = (await import("pg")).default;
  const c = new pg.Client({ connectionString: process.env.TEST_OWNER_URL });
  await c.connect();
  try {
    const slug = uniq("t").toLowerCase();
    const t = await c.query("insert into tenants (name, slug, status) values ($1,$2,'active') returning id", [`Oficina ${slug}`, slug]);
    const tenantId = t.rows[0].id as string;
    const plan = await c.query("select id from plans where code = $1", [opts.plan ?? "PREMIUM"]);
    await c.query("insert into subscriptions (tenant_id, plan_id, status) values ($1,$2,'active')", [tenantId, plan.rows[0].id]);
    const unitIds: string[] = [];
    for (let i = 0; i < (opts.units ?? 2); i++) {
      const u = await c.query("insert into units (tenant_id, name, code, is_default) values ($1,$2,$3,$4) returning id", [tenantId, `Unidade ${i}`, `U${i}`, i === 0]);
      unitIds.push(u.rows[0].id);
    }
    const email = `${slug}-owner@example.test`;
    const hash = await hashPassword(PW, 10);
    const u = await c.query("insert into users (email, password_hash) values ($1,$2) returning id", [email, hash]);
    const role = await c.query("select id from roles where tenant_id is null and key = 'owner'");
    await c.query("insert into memberships (tenant_id, user_id, role_id, status, all_units) values ($1,$2,$3,'active',true)", [tenantId, u.rows[0].id, role.rows[0].id]);
    return { tenantId, slug, unitIds, owners: { email, userId: u.rows[0].id } };
  } finally {
    await c.end();
  }
}

export async function loginOwner(h: Harness, t: SeededTenant, ip = "10.0.0.1"): Promise<Client> {
  const cl = new Client(h, ip);
  const r = await cl.post("/auth/login", { email: t.owners.email, password: PW, tenantSlug: t.slug });
  if (r.status !== 200) throw new Error(`login falhou: ${r.status} ${JSON.stringify(r.json)}`);
  return cl;
}

export async function ownerSql<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const pg = (await import("pg")).default;
  const c = new pg.Client({ connectionString: process.env.TEST_OWNER_URL });
  await c.connect();
  try {
    await c.query("select set_config('app.actor','platform',false)"); // fixtures de plataforma (ex.: status do tenant)
    return (await c.query(sql, params)).rows as T[];
  } finally {
    await c.end();
  }
}

export async function seedPlatformUser(h: Harness, mfa = true) {
  const email = `${uniq("sa")}@example.test`;
  const secret = newTotpSecret();
  const enc = await encryptSecret(secret, h.config.encryptionKey);
  const hash = await hashPassword(PW, 10);
  const r = await ownerSql<{ id: string }>(
    "insert into platform_users (email, password_hash, mfa_secret_enc, mfa_enabled) values ($1,$2,$3,$4) returning id",
    [email, hash, mfa ? enc : null, mfa],
  );
  return { id: r[0]!.id, email, secret };
}

/** Código TOTP do passo atual. Zera mfa_last_step do usuário para permitir vários logins por teste. */
export async function freshCode(table: "users" | "platform_users", id: string, secret: string): Promise<string> {
  await ownerSql(`update ${table} set mfa_last_step = null where id = $1`, [id]);
  return totpAtStep(secret, totpStepNow());
}
