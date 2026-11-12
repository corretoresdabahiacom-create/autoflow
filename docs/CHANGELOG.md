# Changelog

## [Fase 7] — 2026-11-12
### Adicionado
- Migração 0009: fornecedores, itens, compras, movimentos de estoque (append-only), saldo derivado por trigger, consentimento de marketing auditável, cupons, fidelidade, indicações, lembretes, campanhas, satisfação; permissões `stock:*`, `crm:*`, `campaigns:manage`.
- Estoque: compras com custo médio móvel, reserva/consumo/devolução por OS, inventário com ajustes, mínimo, código de barras, auditoria de consistência; integração com ledger/DRE/lucro por OS.
- CRM: conversão de lead (cliente/veículo/agendamento/OS), opt-out (staff e link público), campanhas (inativos, orçamentos parados, lembretes) só para consentidos, cupons, pontos, indicações, lembretes, NPS, métricas reconciliadas com o ledger.
- Web: telas mínimas Estoque e CRM.
### Alterado
- Ledger aceita `kind = 'stock'`; plano de contas ganha Estoque e GRNI (criados sob demanda); `lead_events` aceita `converted`.

## [Fase 6] — 2026-11-11
### Adicionado
- Migração 0008: versões do site (rascunho/publicado/substituído), mídia, leads (funil Novo→Perdido), eventos de lead (append-only), mídia de lead, estatísticas diárias anônimas; permissões `site:manage`, `leads:read`, `leads:manage`; políticas RLS de leitura pública estreitas.
- Público (HTML SSR sem JS, CSP restritiva): `/o/:slug`, `/c/:slug` (vCard, QR SVG/PNG), `/m/:slug/:id`, `/sitemap.xml`, `/robots.txt`, `POST /o/:slug/lead` (captcha, honeypot, rate limit, upload validado, lead + notificação).
- Admin: rascunho/publicação/histórico/restauração, mídia, estatísticas, leads (funil, notas, eventos).
- `@autoflow/shared/site`: modelos, validação por schema, contraste AA, URLs https, bot/DNT/GPC, origem de referência.
- Web: tela "PRESENÇA DIGITAL" mínima.
### Alterado
- `Cache-Control` global só aplica `no-store` se a rota não definiu cabeçalho; CSRF aceita origem do site público apenas no formulário de lead.
- Teste de assinatura da Fase 2 estabilizado (flaky).

## [Fase 5] — 2026-11-11
### Adicionado
- Migração 0007: plano de contas, centros de custo, carteiras, **ledger append-only** (txn + lançamentos, partida dobrada verificada no commit, estorno por `reversal_of` único), documentos a receber/pagar, parcelas (Σ = líquido verificada no commit), liquidações com alocações e idempotência, conciliação, permissões `finance:*`.
- API: faturamento (OS entregue, só itens aprovados, desconto com alçada), contas a pagar (com recorrência mensal), recebimentos/pagamentos idempotentes e serializados, juros/multa v1, estornos/cancelamento por alçada, transferências, conciliação, DRE (competência e caixa), fluxo de caixa (realizado e projetado), saldos, dashboard e lucro por OS (margem de contribuição × resultado operacional estimado).
- `@autoflow/shared/finance`: splitCents, allocateProRata, lateCharges, installmentStatus, buildDre, overheadForOrder (21 testes).
### Alterado
- Teste C5 (Fase 2): agora afirma que aprovar não cria lançamento no ledger.

## [Fase 4] — 2026-11-10
### Adicionado
- Migração 0006: etapas configuráveis, histórico de etapas (append-only), boxes, custo/hora, tarefas (EXCLUDE de box), tempo apontado (trabalho/pausa com motivo), agenda (EXCLUDE de box), `attachments.task_id`, permissões `production:*` e `schedule:*`.
- API: Kanban, mudança de etapa (histórico + timeline + outbox transacionais), tarefas por OS (iniciar/pausar/retomar/concluir/cancelar), tempo, atraso, fotos, mão de obra (minutos × custo/hora), agenda básica (intervalo livre, filtros, reagendar, cancelar com motivo).
- Web: Kanban com arrastar, teclado (←/→) e seletor "Mover para".

## [Fase 3] — 2026-11-10
### Adicionado
- Migração 0005: links/sessões/OTPs do portal, log de acesso e timeline (append-only), mensagens, outbox, versões de tema (CHECK impede ocultar blocos obrigatórios), permissão `portal:manage`, `delivered_at`, `attachments.portal_visible`, canal de aprovação `portal`.
- API do portal (`/portal/*`): troca de token por sessão (token em fragmento, só hash no banco, ≥256 bits), visão da OS derivada da sessão, OTP + aprovação por item com evidência completa, chat, logout.
- API da equipe: criar/listar/revogar/renovar link (QR SVG), log de acesso, visibilidade de anexos, TTL, mensagens, tema (rascunho/publicar/restaurar), consentimento de notificações.
- Outbox transacional + processador com consentimento, backoff e `skipped/failed`.
- Página `/portal` no web (mobile-first, token removido da URL após troca).
### Alterado
- Decisões assistidas e publicações agora geram timeline/outbox (teste C5 atualizado). Entrega encurta validade do link (padrão 90 dias).


## [Fase 2 — Clientes e OS] — 2026-11-09
### Adicionado
- Migração 0004: clientes, veículos (placa única por tenant), OS (contador por unidade), vistoria + marcações, anexos, orçamento versionado (triggers de imutabilidade), aprovações append-only, política/execuções com exceção, permissões e RLS.
- API: clientes/veículos/busca unificada, OS, vistoria + termo de entrada em PDF, upload validado (tamanho/MIME/magic bytes) e URL assinada, orçamento (rascunho/publicar/diff), aprovação assistida, bloqueio de execução e exceção controlada.
- `packages/shared/estimates`: hash do item, total em inteiros, diff, regra de herança, status efetivo.
- `apps/web`: React+Vite mobile-first mínimo (login, busca, nova OS, orçamento).
### Decisões
- Valores em **centavos**; 1 orçamento por OS com N versões; herança de aprovação só da versão imediatamente anterior e só com hash idêntico (recusa não herda); aprovação única por item (mudar de ideia = nova versão).
- Ver `docs/phases/FASE-02-relatorio.md`.

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
