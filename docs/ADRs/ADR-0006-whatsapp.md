# ADR-0006 — Modelo comercial do WhatsApp

Status: **ADIADO PARA A FASE 8 — requer aprovação**

## Opções
1. **WABA individual por oficina via Embedded Signup** (a oficina é dona da conta/número; AutoFlow como Tech Provider).
2. Modelo provedor (BSP/Tech Provider) com WABA(s) gerenciadas pelo AutoFlow.
3. Intermediário já certificado (revenda de API) — menor esforço, maior custo/dependência.

## Recomendação provisória
Opção 1 como alvo (propriedade clara do número/conta, custo de conversas repassado à oficina, desconexão limpa). Depende de aprovação de app e verificação de negócio na Meta — **bloqueio externo**.

## Até lá
- **Link de conversa** (`wa.me`) — funciona hoje, não é API oficial, sem envio automático, sem templates.
- Adaptador `MessagingProvider` com sandbox e mocks; nenhum envio real simulado como produção.
- Definições necessárias: propriedade da conta, token por tenant (cifrado, com rotação), templates e aprovação, webhooks (verificação de assinatura), limites de envio, permissões por papel, desconexão e revogação, opt-in/opt-out (LGPD).
- Funcionalidades bloqueadas sem credenciais: envio de templates, recebimento de mensagens, status de entrega, campanhas.
