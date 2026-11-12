# Fase 7 — Estoque + CRM completo: relatório

Data: 2026-11-12

## Implementado
Estoque (itens, fornecedores, compras, reserva/consumo/devolução por OS, inventário, mínimo, código de barras, auditoria), custo médio móvel (ADR-0007/D-006), integração financeira (ledger, DRE, lucro por OS); CRM (conversão de lead, consentimento e opt-out auditáveis, campanhas, cupons, pontos, indicações, lembretes, satisfação/NPS, métricas); UI mínima de Estoque e CRM.

## Testado (automatizado: API 129 testes, shared 27; typecheck limpo)
- Saldo nunca negativo sob concorrência (5 consumos paralelos, saldo 3 ⇒ 3 sucessos); movimentos append-only; saldo só via trigger; auditoria saldo = soma dos movimentos.
- Custo médio, devolução parcial sem resíduo, reserva entre OS, frações, inventário.
- Ledger balanceado; consumo aparece em custo direto, DRE e lucro por OS; devolução reverte.
- Isolamento por unidade e permissões por papel.
- Campanha só para consentidos; opt-out imediato (inclusive já enfileirado); log de consentimento; link público assinado (assinatura inválida e origem externa rejeitadas).
- Pontos idempotentes, indicação, resgate serializado; cupom (validade, mínimo, exclusivo, limite, concorrência).
- Receita atribuída a leads == ledger == faturas (com desconto).

## Validado em produção
Nada (sem ambiente).

## Bloqueado por dependência externa
E-mail real/template com link de opt-out (KI-010/055); WhatsApp (Fase 8, REM-001).

## Planejado
KI-050 a KI-060 (contas a pagar da compra, aplicação automática de cupom, transferências, agendador de campanhas, pesquisa de satisfação automática).

## Lembretes
- **REM-001**: integrar WhatsApp na Fase 8 (obrigatório na abertura).
- Decisões suas pendentes: canal de OTP (KI-003), provedor de e-mail (KI-010), revisão jurídica de retenção (REM-003) e agora também de **base legal/consentimento de marketing (LGPD)**; padrões financeiros (multa 2%, juros 1% a.m., desconto 5%, estorno R$ 1.000).
