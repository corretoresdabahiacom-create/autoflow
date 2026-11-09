# Fase 8 — Integrações

## Escopo
Fechar ADR-0005 e ADR-0006 com levantamento de taxas/recursos **em fontes oficiais**; WhatsApp (adaptador + sandbox; produção após aprovação Meta); e-mail; Web Push; pagamentos de clientes (PaymentProvider); billing de assinaturas (BillingProvider: trial, upgrade/downgrade, cancelamento, suspensão, reativação, inadimplência, renovação); mapas configuráveis; webhooks assinados + DLQ + reprocessamento.

## Critérios de aceite
1. Webhook com assinatura inválida é rejeitado; replay não duplica efeito (`event_id` único).
2. Pagamento aprovado gera recebimento/alocação idempotente no ledger.
3. Inadimplência suspende conforme política **sem apagar dados**.
4. Tokens por tenant cifrados; rotação e desconexão testadas.
5. Sandbox validado ponta a ponta; **produção só é declarada validada após transação real autorizada pelo usuário**.
6. Integração sem credenciais fica marcada "Bloqueado por dependência externa".
