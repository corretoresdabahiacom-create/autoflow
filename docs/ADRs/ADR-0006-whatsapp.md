# ADR-0006 — Modelo comercial do WhatsApp

Status: **PROPOSTO (Fase 8) — aguardando sua aprovação; produção bloqueada por aprovação/verificação na Meta.**

## Levantamento (fonte oficial, 2026-11-12) — https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing
- Cobrança **por mensagem** desde 1/7/2025 (conversas deixaram de ser a unidade). Só mensagens **template entregues** são cobradas; categorias: marketing, utilidade, autenticação. Preço varia por categoria, faixa de volume e país.
- **Janela de atendimento de 24h** (após o cliente escrever): mensagens livres são gratuitas e templates de utilidade enviados dentro dela também. Fora dela, só templates. Janela de ponto de entrada gratuito (anúncio Click-to-WhatsApp): 72h.
- **Moeda BRL**: a Meta publica tabela em BRL; a partir de 1/7/2026 só clientes elegíveis (Brasil) criam WABAs novas em BRL e a migração de todas é obrigatória até 30/6/2027 (faturamento pela Facebook Brasil).
- **Não verificado**: os valores em R$ por categoria/faixa (estão na tabela de tarifas linkada pela Meta, que não foi lida aqui).

## Opções e recomendação (a aprovar)
Opção 1 (WABA da própria oficina via Embedded Signup; AutoFlow como Tech Provider) segue como alvo: a conta/número é da oficina, o custo por mensagem é dela e a desconexão é limpa. Exige app aprovado e verificação de negócio (externo). Alternativa de menor esforço: intermediário (BSP), com custo/dependência maiores.

## Implementado
- `WhatsAppProvider` com **Sandbox** (não envia nada) e adaptador **Cloud API** (código pronto, **não validado contra a Meta**).
- Token por tenant cifrado (AES-GCM), rotação versionada, desconexão que apaga o segredo e cancela envios pendentes.
- Envio **somente de templates** via outbox (backoff); marketing exige consentimento reverificado no envio.
- Webhook: verificação do desafio, assinatura `X-Hub-Signature-256` sobre o corpo bruto, `event_id` único (replay sem efeito), status sent/delivered/read sem regressão, e "PARAR" revoga o consentimento de marketing (auditável).
- Resolução de tenant pelo `phone_number_id` por função SECURITY DEFINER estreita (devolve só o id).

## Bloqueado por dependência externa
Embedded Signup, aprovação de templates, número verificado e qualquer envio real. "Sandbox validado" **não** equivale a "produção validada".
