# Deploy na Cloudflare — AUTOFLOW 2.0

> **Estado honesto:** o código está **preparado e validado localmente em workerd** (o runtime real dos Workers, via `wrangler dev --local`). **Nada foi implantado** em conta Cloudflare: não há conta, Hyperdrive, R2, Postgres gerenciado, domínio nem segredos reais. Ver "Validado × não validado".

## Arquitetura
```
Navegador ──► Cloudflare (domínio único)
                ├─ /            → Workers Static Assets (React/Vite, SPA)
                ├─ /api/*       → Worker (Hono) ── Hyperdrive ──► Postgres externo (RLS)
                ├─ /o /c /m /files /webhooks /robots.txt /sitemap* /health /ready /metrics → Worker
                ├─ R2 (privado)  ← anexos/fotos (R2Storage)
                └─ Cron Triggers → scheduled() → outbox/webhooks (1 min), automações (5 min), cobrança (1 h)
```
Mesmo domínio para front e API ⇒ cookie de sessão HttpOnly sem CORS.

## Por que Postgres externo
A Cloudflare não oferece Postgres nativo; o produto depende de Postgres 16 (RLS ENABLE+FORCE, roles `app_owner`/`app_rw`, advisory locks, triggers). Use um Postgres gerenciado que permita **criar roles** e **conexão direta** (Neon, Supabase, RDS, Cloud SQL…), com backup diário + **PITR** (ver RPO_RTO.md). O Worker acessa via **Hyperdrive** (pool e cache de conexão). Há `perTx` no `Db`: cada transação abre/fecha um cliente, pois conexões TCP não podem ser compartilhadas entre requisições no Worker.

## Pré-requisitos (você)
1. Conta Cloudflare com **Workers Paid** (necessário: o hash de senha scrypt N=2^15 consome centenas de ms de CPU; o plano gratuito limita CPU a ~10 ms e quebraria o login — ver KI-097).
2. Postgres gerenciado e as roles: `app_owner` (migrações, dono do schema) e `app_rw` (aplicação, sem BYPASSRLS, sem superusuário). Veja `packages/db/src/bootstrap.ts` para o que o bootstrap cria.
3. Domínio na Cloudflare (DNS/TLS).
4. Decisões pendentes que afetam produção (e-mail, OTP, gateway, WhatsApp — ver relatório da Fase 10): sem elas o Worker sobe em modo "falha fechada" (503) para esses recursos.

## Passo a passo
```bash
# 0) Login
cd apps/api && npx wrangler login

# 1) Hyperdrive apontando para a conexão do app_rw (pooler do provedor se houver)
npx wrangler hyperdrive create autoflow-db --connection-string="postgres://app_rw:SENHA@HOST:5432/autoflow"
#    -> copie o id para wrangler.jsonc ("hyperdrive"[0].id)

# 2) R2 privado (NÃO habilite domínio público/r2.dev)
npx wrangler r2 bucket create autoflow-files

# 3) Segredos
openssl rand -base64 32 | npx wrangler secret put APP_ENCRYPTION_KEY
openssl rand -base64 24 | npx wrangler secret put IP_HASH_SALT
openssl rand -base64 36 | npx wrangler secret put METRICS_TOKEN
npx wrangler secret put TURNSTILE_SECRET          # quando criar o widget Turnstile
# (META_APP_SECRET, WA_VERIFY_TOKEN, SANDBOX_WEBHOOK_SECRET conforme as integrações)

# 4) Variáveis: edite wrangler.jsonc  ->  ALLOWED_ORIGINS / PUBLIC_BASE_URL / PORTAL_BASE_URL = https://SEU-DOMINIO

# 5) Migrações (conexão DIRETA como app_owner, fora do Worker)
MIGRATION_DATABASE_URL="postgres://app_owner:SENHA@HOST:5432/autoflow" pnpm --filter @autoflow/db cli migrate
#    (primeira vez: criar o banco/roles com o bootstrap equivalente do provedor)

# 6) Build do front e deploy
pnpm --filter @autoflow/web build
cd apps/api && npx wrangler deploy

# 7) Smoke
curl -fsS https://SEU-DOMINIO/ready          # {"ok":true,"db":"up"}
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" https://SEU-DOMINIO/metrics | head
```
Ou use o workflow manual `.github/workflows/deploy-cloudflare.yml` (secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `MIGRATION_DATABASE_URL`; variável `APP_HOST`).

## Cron e jobs
Os Cron Triggers de `wrangler.jsonc` ↔ `CRON_JOBS` em `src/worker.ts` (mantenha as strings idênticas). Cada job usa advisory lock de sessão por conexão direta do Worker→Postgres via Hyperdrive; se o provedor/pooler operar em **modo transaction**, o lock de sessão **não funciona** — nesse caso a execução concorrente deve ser tolerada pela idempotência dos jobs (cobrança, outbox com `for update skip locked`) ou o Hyperdrive deve apontar para conexão direta (KI-095).

## Rollback
`npx wrangler rollback` volta o Worker à versão anterior (assets incluídos). Migrações são forward-only: siga ROLLBACK.md (expand → migrate → contract).

## Validado × não validado
| Item | Situação |
|---|---|
| Bundle do Worker (`wrangler deploy --dry-run`) | **Validado**: 2,5 MB (538 KB gzip), dentro dos limites |
| Worker em workerd local: `/health`, `/ready`, `/metrics`, `/api/*`, SPA, `robots.txt` | **Validado** (local) |
| `pg` + RLS + transação por requisição em workerd (Hyperdrive **simulado** com Postgres local) | **Validado** (local): login (scrypt 2^15), `/auth/me`, criar/listar cliente |
| `scheduled()` com os 3 crons e métricas `autoflow_job_*` | **Validado** (local, `--test-scheduled`) |
| Testes automatizados (`worker.test.ts`): roteamento, 500 genérico em falha de config, cron, `Db perTx`, `R2Storage` com bucket falso | **Validado** (Node) |
| Hyperdrive real, R2 real, TLS, domínio, WAF, limites de CPU/memória reais, cold start | **Não validado** (sem conta) |
| Turnstile, e-mail, OTP, WhatsApp e gateway reais | **Não validado / bloqueado** (decisões e credenciais) |
| Tempo de CPU por requisição (login) sob o limite do plano | **Não medido** (wrangler local não aplica limite) |
| Upload→R2, PDF (termo de entrada), QR code e download assinado em workerd | **Validado** (local; R2 simulado). Arquivos de 10 MB e R2 real: não |
