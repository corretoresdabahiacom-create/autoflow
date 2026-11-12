# ADR-0005 — Gateway de pagamentos e billing (dois subsistemas)

Status: **PROPOSTO (Fase 8) — aguardando sua aprovação. Nenhum gateway real foi integrado.**
Levantamento em 2026-11-12, fontes oficiais abaixo. O que não foi possível verificar está marcado.

## Subsistemas separados
A) **Assinaturas** que a oficina paga ao AutoFlow (billing SaaS). B) **Pagamentos** que o cliente final paga à oficina (Pix/boleto/cartão).

## Levantamento de taxas/recursos (fontes oficiais)
| Candidato | Resultado | Fonte |
|---|---|---|
| **Asaas** | Verificado (tabela padrão): Pix R$ 1,99/receb.; boleto R$ 1,99; débito R$ 0,35 + 1,89%; crédito à vista R$ 0,49 + 2,99%; 2–6x R$ 0,49 + 3,49%; 7–12x R$ 0,49 + 3,99%; 13–21x R$ 0,49 + 4,29%. Promoção de 3 meses para contas novas (Pix/boleto R$ 0,99). Assinaturas: mesmas taxas de cartão, sem mensalidade separada. **Não consta na página**: taxas de subconta/split, webhooks, sandbox (confirmar na conta/contrato). | https://www.asaas.com/precos-e-taxas |
| **Mercado Pago** | **Não verificado**: a página oficial de taxas não retornou valores nesta sessão. | https://www.mercadopago.com.br/developers/pt/support/taxas-de-servico-para-transacoes_37740 |
| **Stripe (Brasil)** | **Não verificado**: a página oficial de Pix não informa taxas nem requisitos de elegibilidade para empresas brasileiras (menciona BRL e liquidação em 2 dias úteis). | https://stripe.com/payment-method/pix |
| Pagar.me / outros | Não levantado. | — |

Observação de custo (B): para tíquetes médios de oficina, Pix/boleto com tarifa **fixa** (Asaas) tende a ser bem mais barato que percentual; cartão custa ~3–4,3%. Isso é análise a partir dos números acima, não cotação.

## Recomendação (a aprovar)
Avaliar **Asaas** para A e B (taxas verificadas, Pix/boleto fixos, API de cobranças/assinaturas). Antes de aprovar, confirmar por escrito: split/subcontas (KYC da oficina), webhooks assinados e sandbox, Pix Automático. Mercado Pago/Stripe só entram na comparação quando tiverem tabela oficial verificada.

## Implementado (independente do gateway)
- `PaymentProvider` (cobrança hospedada: dados de cartão **nunca** tocam o AutoFlow) com **Sandbox** determinístico e `UnconfiguredPayments` (503). Webhook assinado por HMAC, `event_id` único, DLQ e reprocessamento.
- Pagamento aprovado → `settleCore` (mesmo núcleo do recebimento manual): recebimento/alocação/ledger idempotentes.
- Billing próprio (trial, upgrade proporcional, downgrade na renovação, cancelamento no fim do período, inadimplência com carência de 7 dias → suspensão sem apagar dados, reativação ao pagar).
- Adaptador real do gateway: **não implementado** (sem credenciais/decisão) — Bloqueado por dependência externa.
