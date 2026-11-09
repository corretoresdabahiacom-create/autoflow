# AutoFlow — Integrações (Fase 0)

## 1. Camada de provedores desacoplada
`packages/providers` expõe interfaces; cada adapter tem **sandbox/mock** e flag por ambiente. Nenhum provedor é fixado sem ADR quando houver impacto de custo/arquitetura.

| Interface | Responsabilidade | Candidatos (a decidir) | Fase | Status |
|---|---|---|---|---|
| `EmailProvider` | Convites, reset, notificações | Cloudflare Email Service / Resend / SES | 1 (reset/convite) | decisão na Fase 1 |
| `MessagingProvider` | WhatsApp, OTP | Link `wa.me` (MVP) → WhatsApp Cloud API | 3 (OTP) / 8 | ADR-0006; **bloqueado por credenciais Meta** |
| `PushProvider` | Web Push (VAPID) | Web Push nativo | 8 | planejado |
| `MapsProvider` | Mapa e localização | Link externo + embed opcional (OSM/Google) | 6 | site funciona **sem** mapa pago |
| `PaymentProvider` | Cobrança ao cliente da oficina | ADR-0005 | 8 | planejado |
| `BillingProvider` | Assinatura da oficina | ADR-0005 | 8 | planejado |
| `StorageProvider` | R2 | Cloudflare R2 | 2 | decidido (prompt) |
| `ImageProvider` | Derivados | Cloudflare Images/Transformations | 2 | ADR-0007 |
| `PdfProvider` | PDFs operacionais | Browser Rendering / lib | 2 | ADR-0007 |
| `AnalyticsProvider` | Métricas do cartão/site | próprio, sem cookies, com anti-bot | 6 | planejado |

## 2. Regras comuns
Timeouts e retries com backoff; **idempotência** por chave; webhooks com assinatura verificada e `event_id` único; DLQ + alerta; segredo por tenant cifrado; métricas por integração (sucesso, latência, custo); feature flag e kill-switch.

## 3. WhatsApp: o que funciona sem credenciais
Botões `wa.me` com mensagem pré-preenchida (cartão, site, portal). **Não** há envio automático, status de entrega, templates nem inbound. Qualquer teste de adaptador usa mocks/sandbox; produção não simula envio.

## 4. OTP do portal sem WhatsApp oficial
Opções: SMS (provedor pago), e-mail, ou assistência presencial registrada. A escolha do canal padrão é **decisão pendente** (impacto em custo/segurança) — ver Perguntas em aberto no relatório.

## 5. Fiscal (fora do MVP)
Documentos do AutoFlow são **operacionais**, não fiscais. Arquitetura prevê futuro `FiscalProvider` (NFS-e, NF-e, NFC-e), certificados A1/A3, municípios, regimes tributários — somente após especificação e aprovação próprias.

## 6. Inventário de credenciais futuras
Cloudflare (API token, R2, Queues, Hyperdrive) · PostgreSQL (strings de conexão por ambiente) · e-mail · Meta/WhatsApp · gateway(s) · Turnstile · Sentry/observabilidade · VAPID keys · provedor de mapas (opcional).
