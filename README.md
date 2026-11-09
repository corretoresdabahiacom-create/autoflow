# AutoFlow

SaaS multi-tenant para oficinas mecânicas. Documentação em `docs/` (comece por `docs/PRD.md` e `docs/ROADMAP.md`).

## Desenvolvimento
```bash
pnpm install
pnpm typecheck
pnpm test          # exige Postgres 16 local; usa o banco descartável `autoflow_test`
pnpm bench:hash    # custo do scrypt (Node)
```
Variáveis: ver `.env.example`. Testes usam `TEST_SUPERUSER_URL` (padrão `postgres://postgres:postgres@127.0.0.1:5432/postgres`) e **recriam** o banco `autoflow_test`.

Criar o primeiro Super Admin: `PLATFORM_EMAIL=... PLATFORM_PASSWORD=... pnpm db:create-platform-user` (MFA é cadastrado no primeiro login).

Status por fase: `docs/phases/`.
