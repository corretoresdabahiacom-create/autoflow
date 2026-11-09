# Fase 1 — Fundação

**Subfases:** 1A projeto/CI/banco · 1B auth/RBAC · 1C tenancy/Super Admin/auditoria.

## Escopo
Monorepo pnpm; Workers (Hono) + Hyperdrive + Postgres; migrations; RLS e roles; `withTenantContext`; users/memberships/units; auth (ADR-0003) com MFA Super Admin; RBAC + permissões + entitlements (estrutura e tabelas de planos/features, sem billing real); Super Admin básico (tenants, bloqueio/reativação, planos, limites, métricas técnicas, **acesso excepcional**); auditoria; CI; ambientes dev/test/staging; design tokens e shell do frontend.

**Retenção/LGPD (esquema apenas):** tabelas `retention_policies`, `tenant_retention_overrides`, `legal_holds`, `retention_runs`, `privacy_requests`, `consents`, seed de `retention_policies` conforme `LEGAL_RETENTION.md` §3 (marcado "não revisado pelo jurídico"). A rotina `retention-sweeper` só nasce quando houver dados a expurgar (Fase 2 em diante).

## Fora de escopo
OS, clientes, financeiro, portal, site, gateway, WhatsApp.

## Critérios de aceite
1. Migrations aplicam/revertem em banco limpo; seed de teste com ≥2 tenants e ≥2 unidades.
2. Meta-teste: toda tabela de tenant tem RLS ativa e FORCE; role da app sem BYPASSRLS.
3. Teste A×B: nenhuma rota/consulta retorna dado do outro tenant; FK composta rejeita referência cruzada.
4. Usuário restrito a unidade X não acessa unidade Y (API e RLS).
5. Entitlement ausente ⇒ 403 no backend mesmo com frontend adulterado.
6. Login/logout/reset/convite/MFA com rate limit e lockout testados; sessões revogáveis.
7. Super Admin sem grant não lê dados de tenant; com grant: escopo, duração, auditoria e encerramento automático comprovados por teste.
8. Auditoria registra ações sensíveis sem PII indevida; append-only comprovado.
9. Benchmark de hash de senha documentado (KI-005 fechado).
10. CI verde (lint, tipos, unit, integração, isolamento). Zero P0/P1 abertos.

## Entregáveis
Código, migrations, testes, docs atualizados (DATA_MODEL, SECURITY), relatório da fase (PARTE XVI §46).
