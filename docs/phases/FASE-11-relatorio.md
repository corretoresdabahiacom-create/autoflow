# Fase 11 — Fechamento de pendências de código: relatório

**Escopo escolhido por você:** o que dá para fazer sem credenciais, ambiente ou decisões externas. Não havia especificação de Fase 11 no roadmap; este escopo foi definido na conversa.

## Implementado e testado (local)
- **Agendador interno** (`apps/api/src/scheduler.ts`): resolve a ausência de cron (KI-024/065/076). Opt-in por `SCHEDULER=on`. Lock por job via advisory lock (uma instância por vez), falhas contadas sem derrubar o laço, métricas `autoflow_job_*`, alerta `JobStale`. Testes: todos os jobs rodam; lock concorrente → `skipped`; falha é contida e libera o lock; outbox real.
- **Fila LGPD com prazo** (migração 0013, rotas `/lgpd/tickets`, tela Privacidade): prazo 15 dias, atrasados primeiro, encerramento único e auditado, RLS por tenant. Testes: prazo, atraso, duplo encerramento (409), isolamento, 401.
- **Acessibilidade**: axe-core (WCAG 2.1 A/AA) com API simulada em 4 telas do SPA, 0 violações.

## Cloudflare (adicionado a pedido)
Código e configuração prontos; **nada implantado** (KI-098). Detalhes, passo a passo e tabela validado × não validado em `docs/CLOUDFLARE.md`. Pontos de atenção: Postgres externo obrigatório, plano Workers Paid (KI-097), locks de job em modo transaction (KI-095).

## Telas de gestão (KI-085b)
Sinistros, comissões (leitura), lista de espera e histórico de transferências no Avançado; axe sem violações (7 telas no total). Criação de regras/adiantamentos/pagamentos de comissão e de transferências segue só na API.

## Não feito / limites
- Nada bloqueado externamente mudou: **NO-GO da Fase 10 permanece** (ver FASE-10-relatorio.md).
- Agendador não validado em réplicas reais nem atrás de pgbouncer em modo transaction (KI-095).
- Prazo de 15 dias e fluxo LGPD sem revisão jurídica (KI-096/091); sem notificação de vencimento.
- UI de sinistros/transferências/comissões/agenda/regras de automação continua inexistente (KI-085b).
- Acessibilidade: portal do cliente, site SSR e teste manual de teclado/leitor de tela não cobertos (KI-093).

## Lembretes permanentes
REM-001 WhatsApp (produção Meta bloqueada externamente) e as decisões pendentes listadas na Fase 10 (gateway ADR-0005, WhatsApp ADR-0006, e-mail, OTP, preços, padrões financeiros, revisão jurídica/contábil).
