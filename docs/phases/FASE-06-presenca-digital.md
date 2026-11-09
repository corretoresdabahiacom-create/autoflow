# Fase 6 — Presença digital (+ CRM básico de leads)

## Escopo
`/c/{slug}` cartão (VCF, QR PNG/SVG, compartilhar, copiar endereço); `/o/{slug}` site SSR com todas as seções; formulário de orçamento (nome, telefone, veículo, placa opcional, serviço, descrição, fotos opcionais) → lead com origem/campanha + notificação; SEO (meta, OG, canonical, sitemap, robots, Schema.org, imagens, performance); editor visual (modelos Moderno, Premium, Minimalista, Esportivo, Industrial, Elegante; rascunho/publicação/histórico/restauração; JSON por schema, **sem código arbitrário**); estatísticas com privacidade e anti-bot; mapa opcional com fallback; menu PRESENÇA DIGITAL; CRM básico (funil Novo→Perdido).

## Critérios de aceite
1. Páginas renderizam HTML completo sem JS (verificado com curl); Lighthouse mobile SEO ≥ 95 e Performance ≥ 90 (meta, medir).
2. Slug único global; reservados bloqueados; tenant suspenso ⇒ 404/410 e fora do sitemap.
3. Editor: injeção de `<script>`/`javascript:` em qualquer campo é neutralizada (teste XSS).
4. Isolamento: editor/mídia de A inacessível a B.
5. Formulário: Turnstile + rate limit; honeypot; upload validado; lead criado na unidade/tenant corretos.
6. Estatísticas sem PII; bots filtrados; opt-out respeitado.
7. Site funciona sem provedor de mapa.
8. Publicação e restauração de versões testadas; cache invalidado.
9. WCAG AA nos templates; contraste validado antes de publicar tema.
