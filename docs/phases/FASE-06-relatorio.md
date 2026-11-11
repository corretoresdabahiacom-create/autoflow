# Fase 6 — Presença digital + CRM básico: relatório

Data: 2026-11-11

## Implementado
- Slug público = `tenants.slug` (único global, reservados bloqueados).
- Site `/o/{slug}` e cartão `/c/{slug}` em HTML SSR sem JS; VCF, QR PNG/SVG; SEO (meta, OG, canonical, sitemap, robots, Schema.org `AutoRepair`).
- Formulário de orçamento → lead (origem/campanha, unidade padrão, fotos ≤3, outbox `lead.new` → e-mail da equipe).
- Editor por JSON validado (6 modelos, tokens fixos), rascunho/publicar/histórico/restaurar com revalidação; contraste AA barrado antes de publicar.
- Estatísticas anônimas (sem IP/cookie/UA), filtro de bots, DNT/GPC.
- Mapa só como link (fallback OSM); funil de leads Novo→Perdido com motivo, notas e eventos.
- UI mínima "PRESENÇA DIGITAL".

## Testado (automatizado: API 115 testes, shared 24; typecheck limpo)
| Critério | Resultado |
|---|---|
| 1 HTML sem JS | Testado (HTML completo, sem `<script>` executável). **Lighthouse não medido** (KI-041) |
| 2 Slug/suspenso | Testado: 404 e fora do sitemap; reservado bloqueado no banco |
| 3 XSS | Testado: escape em todos os campos, JSON-LD escapado, `javascript:`/`http:`/`data:` → 422 |
| 4 Isolamento | Testado: rascunho, mídia, versões e leads de A inacessíveis a B |
| 5 Formulário | Testado: captcha, honeypot, rate limit, upload por magic bytes, lead na unidade/tenant corretos |
| 6 Estatísticas | Testado: sem PII (colunas), bots/DNT/GPC ignorados |
| 7 Sem mapa | Testado: sem iframe/script externo |
| 8 Publicar/restaurar | Testado: ETag muda, 304, restauração revalidada |
| 9 WCAG AA | Contraste dos temas testado; auditoria completa não feita |

## Validado em produção
Nada (sem ambiente de produção/staging).

## Bloqueado por dependência externa
Turnstile real (KI-042), e-mail real (KI-010), Lighthouse/CDN em staging (KI-041/043/044).

## Planejado
Converter lead em cliente (Fase 7), editor visual, imagens responsivas (KI-045/047/049).

## Lembretes
- **REM-001**: integrar WhatsApp na Fase 8 (obrigatório na abertura da Fase 8).
- Decisões pendentes suas: canal de OTP (KI-003), provedor de e-mail (KI-010), revisão jurídica de retenção (REM-003), validação dos padrões financeiros (multa 2%, juros 1% a.m., limite de desconto 5%, limite de estorno R$ 1.000).
