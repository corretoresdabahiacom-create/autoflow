# ADR-0002 — Frontend, SEO e estrutura de aplicações

Status: **PROPOSTO — requer aprovação**

## Contexto
Painéis e portal exigem app interativo (PWA). Site público `/o/{slug}` e cartão `/c/{slug}` exigem indexação (SSR/SSG), performance e conteúdo dinâmico por tenant.

## Opções
1. SPA React única para tudo — **rejeitada** para público (SEO fraco, LCP pior).
2. Next.js no Cloudflare (OpenNext) para tudo — viável, porém mais pesado e com maior superfície de compatibilidade com Workers.
3. **React+Vite (PWA) para painéis/portal + Astro (SSR em Workers) para site/cartão** — recomendado.

## Decisão recomendada
- `apps/web`: React 18 + TypeScript + Vite + Tailwind + PWA (admin, operacional, portal, super admin como rotas/entradas distintas, bundles separados).
- `apps/public`: Astro com SSR em Cloudflare Workers; HTML estático por padrão, hidratação mínima (ilhas) para formulário; cache de borda com invalidação ao publicar.
- `apps/api`: Cloudflare Workers + Hono (REST + OpenAPI), validação com Zod.
- Monorepo `pnpm` workspaces: `packages/shared` (tipos, schemas Zod, regras puras), `packages/db` (schema/migrations), `packages/ui`.

## SEO (critérios)
Meta tags, OG, canonical, sitemap por tenant, robots, URLs amigáveis, Schema.org `AutoRepair`/`LocalBusiness`, imagens otimizadas, Core Web Vitals medidos. Tenants suspensos ou despublicados retornam 404/410 e saem do sitemap.

## Domínio
Fase 1–6: domínio compartilhado com slugs. **Domínio próprio por oficina** (CNAME/Cloudflare for SaaS) é planejado como recurso futuro (Premium) — fora do MVP.

## Consequências
Dois frameworks de UI (React e Astro) com design tokens compartilhados em `packages/ui`.
