# ADR-0005 — Gateway de pagamentos e billing (dois subsistemas)

Status: **ADIADO PARA A FASE 8 — decisão final requer aprovação**

## Subsistemas separados
A) **Assinaturas** que a oficina paga ao AutoFlow (billing SaaS).
B) **Pagamentos** que o cliente final paga à oficina (Pix/cartão/boleto).

## Critérios
Operação no Brasil, Pix recorrente/Pix Automático, boleto, cartão, recorrência, split (para B se a oficina for subconta), taxas, webhooks assinados, sandbox, KYC de subcontas, conciliação.

## Candidatos
Mercado Pago, Stripe (disponibilidade/recursos BR a validar), Asaas, Pagar.me/outros. **Taxas e recursos não verificados nesta sessão** — levantamento com fontes oficiais é entregável da Fase 8.

## Decisão provisória
- Interface `PaymentProvider` e `BillingProvider` desacopladas (ver INTEGRATIONS).
- Até credenciais: **somente sandbox/mock**. Nenhuma cobrança real será declarada.
- Fases 1–7 usam registro **manual** de recebimentos (dinheiro, Pix manual, cartão na maquininha).
- Webhooks: assinatura validada, idempotência por `event_id`, reprocessamento seguro.
- Dados de cartão **nunca** tocam o AutoFlow (tokenização/checkout hospedado) → escopo PCI mínimo.
