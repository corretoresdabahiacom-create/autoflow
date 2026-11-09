# AutoFlow — Modelo de dados (conceitual, Fase 0)

Convenções: PK `id uuid` (UUIDv7 recomendado, ordenável); `created_at/updated_at timestamptz`; `tenant_id` em toda tabela de tenant; FK composta `(tenant_id, id)`; dinheiro `numeric(14,2)` + `currency char(3)='BRL'`; soft-delete só onde LGPD/legal permitir; `version int` para controle otimista.

## 1. Escopo por entidade
**GLOBAL:** `platform_users`, `users` (identidade), `plans`, `features`, `plan_features`, `permissions`, `platform_settings`, `providers`.
**TENANT:** `tenants`, `memberships`, `roles`, `role_permissions`, `membership_permission_overrides`, `subscriptions`, `subscription_items`, `usage_records`, `usage_limits`, `billing_events`, `tenant_settings`, `customers`, `vehicles`, `service_orders`*, `estimates`, `estimate_versions`, `estimate_items`, `approvals`, `approval_evidence`, `portal_links`, `portal_sessions`, `portal_access_log`, `messages`, `attachments`, `financial_*`, `leads`, `brand_profiles`, `site_drafts/published`, `card_*`, `audit_log`, `consents`, `privacy_requests`.
**UNIDADE:** `units`, `boxes`, `unit_memberships`, `inventory_*` (fase 7), `appointments`, `production_tasks`*, `service_orders.unit_id`.
(*) pertencem ao tenant e carregam `unit_id`.

## 2. Núcleo (tabelas e regras)
| Tabela | Campos-chave | Constraints / índices |
|---|---|---|
| `tenants` | id, name, slug, status (trial/active/suspended/cancelled), plan refs | `UNIQUE(slug)` global; slugs reservados |
| `users` | id, email (citext), password_hash, mfa | `UNIQUE(email)` |
| `memberships` | user_id, tenant_id, status, role_id | `UNIQUE(user_id,tenant_id)` |
| `units` | tenant_id, name, code, is_default | `UNIQUE(tenant_id,code)` |
| `customers` | tenant_id, name, phone_e164, whatsapp, email, doc_hash/doc_enc (opcional), origin, marketing_opt_in | `idx(tenant_id,phone)`, busca `pg_trgm` em nome; **sem UNIQUE global** em CPF/CNPJ |
| `vehicles` | tenant_id, customer_id, plate, make, model, year, chassis, km, fuel | **`UNIQUE(tenant_id, plate)`** (placa normalizada); histórico de propriedade em `vehicle_owners` |
| `service_orders` | tenant_id, unit_id, number, customer_id, vehicle_id, status, stage_id, promised_at | **`UNIQUE(tenant_id, unit_id, number)`**; número por sequência transacional (tabela `os_counters` com `FOR UPDATE`) |
| `inspections`, `inspection_items`, `damage_marks` | os_id, area, photos, notes | FK composta |
| `estimates` | os_id, current_version_id | 1 por OS (ou N, definir na Fase 2) |
| `estimate_versions` | estimate_id, version_no, status (draft/published/superseded), published_at, totals | `UNIQUE(estimate_id,version_no)`; **imutável após published** (trigger bloqueia UPDATE/DELETE em published) |
| `estimate_items` | version_id, line_key (estável entre versões), description, qty, unit_price, cost, category, supplier_id, lead_days, owner_id | trigger de imutabilidade; `item_hash` do conteúdo (qty/preço/escopo) |
| `approvals` | version_id, item_id, decision (approved/rejected), decided_at, channel, verified_phone, otp_ref, justification, item_hash_at_decision | `UNIQUE(item_id)` por decisão vigente; append-only; decisão referencia **versão+item+hash** |
| `portal_links` | os_id, token_hash, status, expires_at, revoked_at, last_used_at | `UNIQUE(token_hash)`; token **nunca** em claro; um token por OS |
| `production_tasks` | os_id, unit_id, box_id, assignee_id, stage, due_at, started/paused/finished, pause_reason | tarefa concluída **não** fecha a OS |
| `ledger_entries` | tenant_id, entry_id, account_id, debit/credit, competence_date, cash_date, source_type/id, reversal_of | **append-only** (REVOKE UPDATE/DELETE + trigger); `reverses` obrigatório para estorno; partida dobrada (soma por `txn_id` = 0) |
| `receivables`/`installments`/`receipts`/`allocations` | ver FINANCIAL_RULES | |
| `audit_log` | actor, tenant_id, action, entity, before/after (sem PII sensível), request_id, ip_hash | append-only, particionado por mês |
| `support_access_grants` | operator_id, tenant_id, reason, scope, expires_at, approved_by | RLS do super admin só com grant ativo |

## 3. Billing
`plans(id,code,price,interval)`, `features(code,type: boolean/limit)`, `plan_features(plan_id,feature_code,value)`, `subscriptions(tenant_id,plan_id,status: trial/active/past_due/suspended/cancelled, period_start/end, trial_end)`, `subscription_items`, `usage_records(tenant_id,metric,period,qty)`, `usage_limits(plan,metric,soft,hard,on_exceed)`, `billing_events(provider_event_id UNIQUE, payload, processed_at)`. Entitlements = plano ∪ overrides do tenant, resolvidos em cache curto.

## 4. Permissões
`permissions(code 'recurso:ação')`, `roles(tenant_id|null sistema)`, `role_permissions`, `membership_permission_overrides(allow/deny)`, `unit_memberships(membership_id, unit_id)`. Papéis de sistema: owner, admin, manager, attendant, mechanic, bodyworker, painter, aligner, stockkeeper, finance.

## 5. Retenção/LGPD
Tabela de temporalidade, base legal e verificação das fontes: **`LEGAL_RETENTION.md`** (fonte única; não duplicar prazos aqui).
Tabelas adicionais previstas (globais/tenant): `retention_policies`, `tenant_retention_overrides`, `legal_holds`, `retention_runs`, `privacy_requests`, `consents`. Regra: prazo do tenant **nunca abaixo do piso legal**; `legal_holds` suspende qualquer expurgo; anonimização preserva `id` para integridade referencial e não altera valores do ledger.

## 6. Pendências de modelagem para a Fase 1
Definir UUIDv7 vs v4, `numeric` vs centavos, particionamento de `audit_log`, estratégia de `citext`/`pg_trgm` no provedor escolhido.
