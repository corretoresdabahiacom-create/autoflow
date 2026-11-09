# Fase 1 — Relatório (Fundação)

Data: 2026-11-09. Honestidade: cada item abaixo está em **uma** categoria.

## Implementado e testado (local, Postgres 16, Node 22)
- Migrações 0001–0003 aplicam em banco vazio (recriado a cada execução de teste); roles `app_owner`/`app_rw` (sem superuser/BYPASSRLS).
- RLS ENABLE+FORCE em todas as tabelas de tenant — **meta-teste** falha se surgir tabela sem RLS (exceções explícitas e justificadas: users, platform_users, sessions, auth_tokens, rate_limits, schema_migrations).
- Isolamento A×B (API e banco): leitura, INSERT com tenant alheio, UPDATE, FK composta, auditoria; escopo por unidade (inclui falha fechada).
- Autenticação: login/logout, cookies HttpOnly/SameSite, token só em hash, respostas uniformes, expiração idle/absoluta, CSRF por Origin, lockout progressivo, rate limit (IP/conta), convite e reset (uso único, expiram, revogam sessões), MFA TOTP com anti-replay.
- Autorização: RBAC, anti-escalada, último proprietário, suspensão com efeito imediato, entitlements no backend (403), tenant/assinatura suspensos, teste de registro de rotas (toda rota declara política; protegidas dão 401 sem sessão).
- Super Admin: MFA obrigatório, MFA recente para ações sensíveis, provisionar/bloquear/reativar, sem acesso a dados internos sem grant; grant com motivo (≥15), ≤4 h, escopo, expiração, revogação, somente leitura, auditado, isolado por tenant.
- Auditoria append-only (DELETE/UPDATE negados).
- Resultado: `pnpm typecheck` limpo; 7 testes (shared) + 45 (api) passando.

## Implementado, **não** validado
- CI (`.github/workflows/ci.yml`, com serviço Postgres e `pnpm audit`): **nunca executado** (sem GitHub).
- Casca do frontend e design tokens (`apps/web`): arquivos estáticos, não revisados em navegador.
- Esquema de retenção/LGPD: tabelas e trigger de piso criados; **sem testes dedicados** e sem rotina de varredura.
- Script `create-platform-user`: escrito, não executado.

## Parcial / critérios do FASE-01 não totalmente atendidos
- Critério 1 (“reverter” migrações): **não há migrações de reversão**; apenas aplicação (recriar banco em dev/teste). Pendente decidir estratégia (roll-forward em produção).
- Critério 6: reset por e-mail depende do provedor (KI-010); fluxo testado com `MemoryEmailProvider`.
- Critério 8 (benchmark): medido em Node (~160 ms a N=2^15); **Workers não medido** (KI-005).
- Critério 9 (CI verde): não executado.
- Ambientes dev/test/staging: só definidos por configuração; nenhum deploy (KI-012).

## Bloqueado por dependência externa
Cloudflare/Hyperdrive/Postgres gerenciado (KI-006, KI-012), provedor de e-mail (KI-010), credencial GitHub (KI-002).

## Planejado
Fase 2 (clientes/veículos/frontend React). Retenção: sweeper e testes.

## Severidades abertas
P0: nenhum conhecido. P1: KI-005, KI-010, KI-012 (não bloqueiam desenvolvimento local; bloqueiam produção). Sem revisão de segurança independente feita — apenas testes próprios.

## Lembretes (REM-001)
**WhatsApp**: integração adiada por sua decisão; será tratada no fim da Fase 3 (decisão do canal OTP) e na abertura da Fase 8.
Pendentes de você: canal de OTP (KI-003), método de autenticação do GitHub (KI-002), provedor de e-mail (KI-010), revisão jurídica das retenções (REM-003).
