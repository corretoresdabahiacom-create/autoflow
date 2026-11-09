# Fase 7 — Estoque e CRM

## Escopo
Fornecedores, compras, itens (peças, tintas, vernizes, materiais), código de barras, entradas/saídas/reservas/devoluções, inventário, estoque mínimo, **custo médio móvel** (ADR-0007), consumo por OS (alimenta custo/lucro); CRM completo (conversão lead→cliente/agendamento/OS), fidelização (cupons, pontos, indicações, lembretes de revisão/óleo/alinhamento, recuperação de orçamentos, inativos, satisfação) com **LGPD/opt-out**.

## Critérios de aceite
1. Movimentos append-only; saldo derivado consistente sob concorrência.
2. Reserva não permite saldo negativo (constraint/transação).
3. Custo médio correto em entradas/saídas/devoluções (casos de teste).
4. Consumo por OS gera custo na Fase 5.
5. Estoque por unidade isolado.
6. Campanhas só para contatos com consentimento; opt-out imediato e auditável.
7. Métricas de conversão e receita gerada reconciliam com ledger.
