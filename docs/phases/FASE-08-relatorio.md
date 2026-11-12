# Fase 8 — Integrações: relatório

Data: 2026-11-12

## Implementado
Webhooks (assinatura, `event_id` único, DLQ, reprocessamento); WhatsApp (sandbox + adaptador Cloud API); pagamentos de clientes via `PaymentProvider` (sandbox) com recebimento idempotente no ledger; billing de assinaturas (trial, upgrade proporcional, downgrade na renovação, cancelamento, inadimplência→suspensão, reativação); Web Push (provider em memória); segredos por tenant cifrados com rotação/desconexão; ADR-0005/0006 com levantamento oficial; tela mínima de Integrações.

## Testado (automatizado: API 140 testes, shared 28; typecheck limpo)
| Critério | Resultado |
|---|---|
| 1 Assinatura inválida rejeitada; replay não duplica | Testado (Meta e pagamentos; mesmo `event_id` e mesma cobrança com outro `event_id`) |
| 2 Pagamento aprovado → recebimento/alocação idempotente no ledger | Testado (1 settlement, 1 alocação, ledger balanceado, saldo da carteira; valor divergente → falha/DLQ) |
| 3 Inadimplência suspende sem apagar dados | Testado (past_due → suspensão; dados intactos; dono ainda paga; pagamento reativa; replay não avança período) |
| 4 Tokens cifrados; rotação e desconexão | Testado (nada em claro no banco/API/auditoria; versão; segredo apagado; envios pendentes cancelados; isolamento entre tenants) |
| 5 Sandbox ponta a ponta | Testado (envio por outbox → entregue/lido → "PARAR" revoga marketing). **Produção não validada** |
| 6 Sem credenciais = bloqueado | Marcado abaixo |

## Validado em produção
**Nada.** Nenhuma transação real foi feita; e produção só será declarada validada após transação real autorizada por você.

## Bloqueado por dependência externa
WhatsApp real (Meta: app, verificação, templates, Embedded Signup — KI-061); gateway de pagamentos real (decisão + credenciais — KI-062); e-mail real (KI-010); chaves VAPID (KI-067).

## Planejado
KI-063 a KI-072 (valores Meta, preços dos planos, agendador do job de billing, proração anual, janela de 24h, UI completa).

## Decisões suas pendentes
- **Aprovar ADR-0005** (recomendação: avaliar Asaas; Mercado Pago/Stripe sem tabela oficial verificada) e **ADR-0006** (WABA da oficina via Embedded Signup).
- **Preços dos planos** (hoje R$ 0 — KI-064).
- Canal de OTP (KI-003), provedor de e-mail (KI-010), revisão jurídica de retenção/marketing (REM-003), padrões financeiros (multa 2%, juros 1% a.m., desconto 5%, estorno R$ 1.000).

## Lembretes
REM-001 (integrar WhatsApp) foi **atendido no que é possível sem credenciais** (adaptador, webhook, outbox, consentimento, sandbox); o envio real depende da Meta. Próxima: Fase 9 (avançado) — só inicio com o seu "Fase 9".
