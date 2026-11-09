# ADR-0004 — Isolamento multi-tenant e por unidade

Status: **PROPOSTO — requer aprovação**

## Decisão
Banco único, esquema compartilhado, **`tenant_id` obrigatório** em toda tabela de tenant, com:
1. **RLS** em todas as tabelas de tenant (`USING tenant_id = current_setting('app.tenant_id')::uuid`); `FORCE ROW LEVEL SECURITY`.
2. FKs **compostas** `(tenant_id, id)` para impedir referência cruzada entre tenants (ex.: `os.vehicle` → `vehicles(tenant_id,id)`).
3. Escopo por unidade: coluna `unit_id` onde aplicável; política adicional `unit_id = ANY(app.unit_ids)` para papéis com escopo restrito.
4. Middleware único `withTenantContext()` abre transação e executa `SET LOCAL`; nenhuma query de tenant fora dele (lint/teste).
5. Role da aplicação sem `BYPASSRLS`. Super Admin acessa dados de tenant **somente** via mecanismo de acesso excepcional (sessão com `grant_id`, escopo e expiração) — políticas RLS específicas.
6. Tabelas globais (plans, features, permissions, platform settings, users globais) sem RLS de tenant, mas com GRANTs mínimos.

## Classificação (resumo; detalhe em DATA_MODEL)
Global: planos, features, permissões, configurações da plataforma, provedores, identidades de usuário. Tenant: empresa, assinatura, configurações, clientes, veículos, visual, site, cartão, financeiro, CRM. Unidade: boxes, estoque local, agenda, vínculos de funcionário, operações locais.

## Consequências
+ Defesa em profundidade (app + banco). − Complexidade de testes; exige fixtures de 2+ tenants em todo teste de integração.
