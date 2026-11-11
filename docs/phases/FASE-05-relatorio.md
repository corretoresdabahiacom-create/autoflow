# Relatório — Fase 5 (Financeiro gerencial)

> Todos os números são **gerenciais estimados**; não é contabilidade fiscal.

## Implementado
Ledger append-only com partida dobrada; plano de contas padrão; carteiras e transferências; faturamento pós-entrega (itens aprovados, parcelas com resto na última, desconto com alçada); contas a pagar (recorrência, vínculo com OS); recebimentos/pagamentos idempotentes; juros e multa v1; estorno e cancelamento por alçada; conciliação básica; DRE (competência e caixa), fluxo de caixa, saldos, dashboard (API); lucro por OS (margem de contribuição × resultado operacional estimado, separados).

## Testado (automatizado: 101 API + 21 shared passando)
| Critério | Teste |
|---|---|
| 1 UPDATE/DELETE em ledger falham p/ role da app | F1 (entries e txns) |
| 2 Σ débitos = Σ créditos por txn | F1 (rejeição no commit) + saldo zero em F3/F4/F7/F9 |
| 3 aprovação não gera receita; faturar só após entrega | F3 (+ C5 da Fase 2) |
| 4 parcial, várias parcelas, estorno, cancelamento, juros/multa | F4 |
| 5 competência × caixa em meses diferentes | F5 |
| 6 rateio sem perda de centavos | shared (splitCents/allocateProRata) + F4 (3333/3333/3334) |
| 7 idempotência e concorrência | F7 (replay, reuso de chave, 5 simultâneas, 3 recebimentos concorrentes) |
| 8 DRE reconcilia com ledger; rótulo gerencial | F8, F5 |
| 9 alçadas de desconto/estorno e permissões | F9 |
| 10 sem P0/P1 conhecidos; gráficos não contam | sem UI financeira (KI-032) |
Também: isolamento entre tenants, conciliação, transferências.

## Validado em produção
Nada.

## Bloqueado por dependência externa
Gateway/PIX (Fase 8); provedores (e-mail/OTP) e Workers/R2 (KI-010/003/012/015); concorrência sob Hyperdrive/carga real (KI-039).

## Planejado
UI financeira (KI-032), desconto na quitação/renegociação (KI-034), aprovação em duas pessoas (KI-040), comprovantes (KI-038), OFX/CSV (KI-037).

## Revisão pendente sua
Regra de juros/multa padrão (2% + 1% a.m.), alçada de desconto (5%) e limite de estorno (R$ 1.000) são **valores iniciais meus** — valide com seu contador. Retenção legal (REM-003) continua pendente.

## Lembretes
- **REM-001 — integrar WhatsApp**: pendente (Fase 8, abertura obrigatória).
