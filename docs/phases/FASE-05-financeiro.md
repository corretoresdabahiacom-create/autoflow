# Fase 5 — Financeiro

## Escopo
Plano de contas, centros de custo, contas financeiras, contas a pagar/receber, parcelas, recebimentos/pagamentos, alocações, **ledger append-only**, estornos, conciliação básica, fluxo de caixa, DRE por competência e caixa, lucro por OS (margem de contribuição × resultado operacional estimado), dashboard financeiro. Registro **manual** de recebimentos (gateway só na Fase 8).

## Critérios de aceite
1. UPDATE/DELETE em `ledger_entries` falham para o role da aplicação (teste).
2. Σ débitos = Σ créditos por `txn_id`.
3. Aprovação de orçamento não gera receita recebida; faturamento só após conclusão.
4. Recebimento parcial, múltiplas parcelas, estorno e cancelamento conforme FINANCIAL_RULES §10 — todos testados.
5. Competência × caixa divergem corretamente entre meses.
6. Rateio sem perda de centavos.
7. Idempotência e concorrência (2 recebimentos simultâneos) sem corrupção.
8. DRE reconcilia com ledger; rótulos "gerencial estimado".
9. Permissões de estorno/desconto por alçada.
10. Sem P0/P1. Gráficos **não** contam como "financeiro pronto".
