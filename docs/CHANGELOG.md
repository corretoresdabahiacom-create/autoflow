# Changelog

## [Fase 1 — Fundação] — 2026-11-09
### Adicionado
- Monorepo pnpm (`packages/shared`, `packages/db`, `apps/api`, `apps/web` casca).
- Migrações 0001–0003 (schema, seeds, RLS ENABLE+FORCE, roles `app_owner`/`app_rw`), runner com checksum e lock.
- API Hono: login/logout, sessão opaca, lockout, rate limit, convite, reset de senha, MFA TOTP (obrigatório p/ Super Admin), RBAC, entitlements, escopo por unidade, anti-escalada, último proprietário, auditoria append-only.
- Super Admin: tenants (provisionar/bloquear/reativar), planos, overrides, métricas, acesso excepcional (grant com motivo/escopo/≤4h/somente leitura aplicado pela RLS).
- Testes (45 + 7 unitários), CI com Postgres, design tokens.
### Observações
- Ver `docs/phases/FASE-01-relatorio.md`. Pendências: KI-005 (parcial), KI-010, KI-012.

## [Fase 0 — revisão 1] — 2026-11-09
### Adicionado
- `LEGAL_RETENTION.md`: pesquisa legal (CDC, Código Civil, CTN, Marco Civil, LGPD, Res. ANPD 15/2024), tabela de temporalidade com pisos, desenho de `retention-sweeper`, anonimização, direitos do titular e incidentes.
- `REMINDERS.md` (WhatsApp e demais lembretes).
### Alterado
- `DATA_MODEL.md` §5 aponta para `LEGAL_RETENTION.md`; `KNOWN_ISSUES.md` (KI-003, 004, 008, 009); `DECISIONS.md` (D-001 a D-003); `FASE-01` inclui esquema de retenção.
### Observação
- Nenhum código foi escrito. A Fase 1 continua bloqueada até aprovação explícita.

## [Fase 0] — 2026-11-09
### Adicionado
- Documentos de planejamento: PRD, ARCHITECTURE, DATA_MODEL, SECURITY, FINANCIAL_RULES, INTEGRATIONS, ROADMAP, TEST_STRATEGY, OPERATIONS, DECISIONS, KNOWN_ISSUES.
- ADRs 0001–0007 e especificações por fase em `/docs/phases/`.
### Observações
- Projeto identificado como GREENFIELD. Nenhum código de funcionalidade foi escrito.
- Repositório Git local **não** inicializado; publicação em GitHub aguarda aprovação (ver KNOWN_ISSUES).
