# AutoFlow — Arquitetura (proposta Fase 0)

## 1. Visão de contêineres
```
Navegador/PWA ──► Cloudflare (DNS, WAF, CDN, Turnstile)
   ├─ apps/web     (React PWA: admin, operacional, portal, super admin)  ── Workers Static Assets
   ├─ apps/public  (Astro SSR: /o/{slug}, /c/{slug}, sitemap, robots)    ── Worker
   └─ apps/api     (Hono REST/OpenAPI)                                   ── Worker
          ├─ Hyperdrive ─► PostgreSQL gerenciado (RLS)         [ADR-0001/0004]
          ├─ R2 (privado) ─ anexos, fotos, PDFs; URLs assinadas [ADR-0007]
          ├─ Queues (+DLQ) ─ notificações, scans, derivados, webhooks
          ├─ Cron Triggers ─ expiração de links/sessões, metering, backups, alertas
          └─ Durable Objects (opcional) ─ rate limit, locks de numeração/idempotência
Provedores externos (atrás de interfaces): e-mail, WhatsApp, Web Push, mapas, pagamentos, imagens, PDF, analytics
```

## 2. Monorepo (pnpm)
```
apps/api  apps/web  apps/public
packages/shared (Zod, tipos, regras puras: financeiro, aprovações, permissões)
packages/db (schema, migrations, seeds de teste)
packages/providers (interfaces + adapters + mocks)
packages/ui (tokens, componentes)
docs/  infra/  scripts/
```

## 3. Camadas do backend
Rota (validação Zod) → **middleware de contexto** (auth → tenant → unidade → entitlements → permissão) → serviço de domínio (regras puras + transação) → repositório (Drizzle) → auditoria/outbox.
- **Outbox transacional**: eventos de domínio gravados na mesma transação e despachados para Queues (evita perda de mensagens, P1).
- **Idempotência**: header `Idempotency-Key` em mutações críticas (pagamento, aprovação, upload).

## 4. Autorização (ordem fixa, falha fecha)
1. Autenticado (ou política pública específica do endpoint: portal/site/cartão).
2. Tenant ativo e **não suspenso**; membership ativa.
3. Acesso à unidade (quando recurso é de unidade).
4. Permissão (`recurso:ação`) via papel + overrides.
5. **Entitlement** do plano para a feature e **limite de uso** (soft/hard conforme política).
6. Feature flag habilitada.
Testes garantem que cada rota declara requisitos (rota sem declaração falha no CI).

## 5. Portal do cliente (resumo; detalhe em SECURITY.md)
Token 256 bits aleatório, só hash no banco, vinculado a **uma OS**; troca por sessão curta; aprovações sensíveis exigem OTP no telefone cadastrado; revogação/renovação/expiração; log de acessos; rate limit por token e IP.

## 6. Presença digital e editor
Conteúdo estruturado em **JSON validado por schema** (seções, tokens de tema), nunca HTML/JS arbitrário. Rascunho/publicado/versões; publicação gera snapshot servido pelo Astro com cache de borda e invalidação por slug. Sanitização de texto rico por allowlist. Mídia por tenant em R2 com prefixo `t/{tenant_id}/`.

## 7. Custo inicial (ordem de grandeza — validar)
Dev/staging: quase zero (planos gratuitos). Produção inicial: Workers (gratuito ou plano pago de entrada) + PostgreSQL pago de entrada + domínio. Ver ADR-0001 para ressalvas.

## 8. Ambientes
`development` (local: Miniflare/Wrangler + Postgres em container), `test` (efêmero, fixtures fictícias), `staging` (dados sintéticos), `production`. Secrets por ambiente; **nunca** copiar dados de produção para staging sem anonimização.

## 9. PWA
Manifest, SW com Workbox: cache de shell/estáticos e leituras não sensíveis; **sem cache** de portal, financeiro, documentos e tokens; sem operações críticas offline; rascunhos locais (OS em preenchimento, fotos de vistoria) sincronizados com `client_id` idempotente, `version` otimista e detecção de conflito.

## 10. Observabilidade
Logs estruturados JSON com `request_id`, `tenant_id` (hash quando sensível), sem PII; erros (Sentry ou Workers Observability — escolha na Fase 1); métricas de negócio e técnicas; alertas; DLQ monitorada. Detalhe em OPERATIONS.

## 11. Mapeamento de dependências entre fases
Fundação (1) → OS/Clientes (2) → Portal (3, depende de aprovações da 2) → Produção (4) → Financeiro (5, depende de OS/orçamentos) → Presença (6, independente do financeiro; depende de CRM básico) → Estoque/CRM (7) → Integrações (8, depende de provedores/credenciais) → Avançado (9) → Lançamento (10).
