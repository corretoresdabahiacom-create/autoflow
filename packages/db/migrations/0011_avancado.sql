-- AutoFlow 0011 — Fase 9: seguradoras, transferências entre unidades, comissões/adiantamentos, automações, lista de espera.
select set_config('app.actor', 'platform', true);
insert into permissions (code, description) values
  ('insurers:read','Ver seguradoras e sinistros'),
  ('insurers:manage','Gerenciar seguradoras, sinistros e autorizações'),
  ('reports:advanced','Ver relatórios avançados e consolidados'),
  ('automation:manage','Criar/ativar regras de automação'),
  ('commissions:read','Ver comissões e adiantamentos'),
  ('commissions:manage','Cadastrar regras, calcular, adiantar e pagar comissões');
insert into role_permissions (role_id, permission_code)
select r.id, p.code from roles r cross join permissions p
where r.tenant_id is null and r.key in ('owner','admin') and p.code in ('insurers:read','insurers:manage','reports:advanced','automation:manage','commissions:read','commissions:manage');
insert into role_permissions (role_id, permission_code)
select r.id, p.code from roles r cross join permissions p
where r.tenant_id is null and r.key = 'manager' and p.code in ('insurers:read','insurers:manage','reports:advanced','commissions:read');
insert into role_permissions (role_id, permission_code)
select r.id, p.code from roles r cross join permissions p
where r.tenant_id is null and r.key = 'finance' and p.code in ('reports:advanced','commissions:read','commissions:manage');
insert into role_permissions (role_id, permission_code)
select r.id, p.code from roles r cross join permissions p
where r.tenant_id is null and r.key = 'attendant' and p.code in ('insurers:read','insurers:manage');

-- Limite mensal de execuções de automação (configurável por plano; Premium = placeholder comercial).
insert into features (code, kind, description) values ('automation.monthly','limit','Execuções de automação por mês');
insert into plan_features (plan_id, feature_code, value)
select p.id, 'automation.monthly', case p.code when 'PREMIUM' then '2000'::jsonb else '0'::jsonb end from plans p;
select set_config('app.actor', '', true);

-- ===== Seguradoras e sinistros =====
create table insurers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null check (length(name) between 2 and 120),
  doc text check (doc is null or length(doc) <= 20),
  phone text check (phone is null or length(phone) <= 30),
  email text check (email is null or length(email) <= 120),
  sla_authorization_hours int not null default 48 check (sla_authorization_hours between 1 and 720),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);
create table insurance_claims (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  os_id uuid not null,
  insurer_id uuid not null,
  claim_no text not null check (claim_no ~ '^[A-Za-z0-9._/-]{3,40}$'),
  policy_no text check (policy_no is null or length(policy_no) <= 40),
  deductible_cents bigint not null default 0 check (deductible_cents >= 0),
  status text not null default 'opened' check (status in ('opened','awaiting_authorization','authorized','partially_authorized','denied','completed','paid','cancelled')),
  requested_cents bigint not null default 0 check (requested_cents >= 0),
  authorized_cents bigint not null default 0 check (authorized_cents >= 0 and authorized_cents <= requested_cents),
  authorization_due_at timestamptz,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  created_by uuid references users(id),
  unique (tenant_id, id),
  unique (tenant_id, insurer_id, claim_no),
  check ((status in ('paid','cancelled')) = (closed_at is not null)),
  foreign key (tenant_id, os_id, unit_id) references service_orders (tenant_id, id, unit_id),
  foreign key (tenant_id, insurer_id) references insurers (tenant_id, id)
);
create index claims_os on insurance_claims (tenant_id, os_id);
create index claims_due on insurance_claims (tenant_id, authorization_due_at) where status = 'awaiting_authorization';
-- Cada rodada de autorização é imutável (histórico de pedidos/decisões).
create table claim_authorizations (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  claim_id uuid not null,
  version_no int not null check (version_no >= 1),
  requested_cents bigint not null check (requested_cents >= 0),
  authorized_cents bigint not null check (authorized_cents >= 0),
  decision text not null check (decision in ('authorized','partial','denied')),
  code text check (code is null or length(code) <= 40),
  note text check (note is null or length(note) <= 500),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (claim_id, version_no),
  check (case decision when 'denied' then authorized_cents = 0 when 'authorized' then authorized_cents = requested_cents and requested_cents > 0 else authorized_cents > 0 and authorized_cents < requested_cents end),
  foreign key (tenant_id, claim_id) references insurance_claims (tenant_id, id)
);
create table claim_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  claim_id uuid not null,
  kind text not null check (kind in ('opened','status','authorization','note')),
  detail text check (detail is null or length(detail) <= 500),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, claim_id) references insurance_claims (tenant_id, id)
);
create trigger claim_auth_append_only before update or delete on claim_authorizations for each row execute function af.append_only();
create trigger claim_events_append_only before update or delete on claim_events for each row execute function af.append_only();

-- ===== Transferência de estoque entre unidades =====
create table stock_transfers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  from_unit_id uuid not null,
  to_unit_id uuid not null,
  note text check (note is null or length(note) <= 200),
  idempotency_key text not null check (length(idempotency_key) between 8 and 80),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, idempotency_key),
  check (from_unit_id <> to_unit_id),
  foreign key (tenant_id, from_unit_id) references units (tenant_id, id),
  foreign key (tenant_id, to_unit_id) references units (tenant_id, id)
);
create trigger stock_transfers_append_only before update or delete on stock_transfers for each row execute function af.append_only();
alter table stock_movements add column transfer_id uuid;
alter table stock_movements add foreign key (tenant_id, transfer_id) references stock_transfers (tenant_id, id);
do $$
declare c record;
begin
  for c in select conname from pg_constraint where conrelid = 'stock_movements'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%adjust_out%' loop
    execute format('alter table stock_movements drop constraint %I', c.conname);
  end loop;
end $$;
alter table stock_movements add constraint stock_movements_kind_check check (kind in ('purchase','consume','return','adjust_in','adjust_out','reserve','release','transfer_out','transfer_in'));
alter table stock_movements add constraint stock_movements_shape_check check (case kind
    when 'purchase'   then on_hand_delta = qty_milli and reserved_delta = 0 and value_delta_cents >= 0 and purchase_id is not null
    when 'consume'    then on_hand_delta = -qty_milli and reserved_delta between -qty_milli and 0 and value_delta_cents <= 0 and os_id is not null
    when 'return'     then on_hand_delta = qty_milli and reserved_delta = 0 and value_delta_cents >= 0 and os_id is not null and ref_movement_id is not null
    when 'adjust_in'  then on_hand_delta = qty_milli and reserved_delta = 0 and value_delta_cents >= 0 and length(btrim(coalesce(reason,''))) >= 3
    when 'adjust_out' then on_hand_delta = -qty_milli and reserved_delta = 0 and value_delta_cents <= 0 and length(btrim(coalesce(reason,''))) >= 3
    when 'reserve'    then on_hand_delta = 0 and reserved_delta = qty_milli and value_delta_cents = 0 and os_id is not null
    when 'release'    then on_hand_delta = 0 and reserved_delta = -qty_milli and value_delta_cents = 0 and os_id is not null
    when 'transfer_out' then on_hand_delta = -qty_milli and reserved_delta = 0 and value_delta_cents <= 0 and transfer_id is not null
    when 'transfer_in'  then on_hand_delta = qty_milli and reserved_delta = 0 and value_delta_cents >= 0 and transfer_id is not null
  end);

-- ===== Comissões e adiantamentos =====
-- Regra versionada e IMUTÁVEL: nova vigência = nova linha; o cálculo usa a regra vigente na entrega da OS.
create table commission_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  membership_id uuid not null,
  version_no int not null check (version_no >= 1),
  basis text not null check (basis in ('os_net_revenue','os_margin')),
  rate_bps int not null check (rate_bps between 1 and 10000),
  valid_from timestamptz not null,
  note text check (note is null or length(note) <= 200),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, membership_id, version_no),
  foreign key (tenant_id, membership_id) references memberships (tenant_id, id)
);
create table commission_entries (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  unit_id uuid not null,
  os_id uuid not null,
  membership_id uuid not null,
  rule_id uuid not null,
  kind text not null check (kind in ('accrual','adjustment')),
  basis_cents bigint not null,
  rate_bps int not null,
  amount_cents bigint not null,
  txn_id uuid,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  check ((kind = 'accrual' and amount_cents >= 0) or (kind = 'adjustment' and amount_cents <> 0)),
  foreign key (tenant_id, os_id, unit_id) references service_orders (tenant_id, id, unit_id),
  foreign key (tenant_id, membership_id) references memberships (tenant_id, id),
  foreign key (tenant_id, rule_id) references commission_rules (tenant_id, id)
);
create unique index commission_one_accrual on commission_entries (tenant_id, os_id, membership_id) where kind = 'accrual';
create index commission_member on commission_entries (tenant_id, membership_id);
create table commission_advances (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  membership_id uuid not null,
  amount_cents bigint not null check (amount_cents > 0),
  wallet_id uuid not null,
  txn_id uuid not null,
  note text check (note is null or length(note) <= 200),
  idempotency_key text not null check (length(idempotency_key) between 8 and 80),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, idempotency_key),
  foreign key (tenant_id, unit_id) references units (tenant_id, id),
  foreign key (tenant_id, membership_id) references memberships (tenant_id, id),
  foreign key (tenant_id, wallet_id) references fin_wallets (tenant_id, id)
);
create table commission_payouts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  membership_id uuid not null,
  gross_cents bigint not null check (gross_cents > 0),
  advance_offset_cents bigint not null check (advance_offset_cents >= 0),
  net_cents bigint not null check (net_cents >= 0),
  wallet_id uuid,
  txn_id uuid not null,
  idempotency_key text not null check (length(idempotency_key) between 8 and 80),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, idempotency_key),
  check (gross_cents = advance_offset_cents + net_cents),
  check ((net_cents > 0) = (wallet_id is not null)),
  foreign key (tenant_id, unit_id) references units (tenant_id, id),
  foreign key (tenant_id, membership_id) references memberships (tenant_id, id),
  foreign key (tenant_id, wallet_id) references fin_wallets (tenant_id, id)
);
create trigger commission_rules_ao before update or delete on commission_rules for each row execute function af.append_only();
create trigger commission_entries_ao before update or delete on commission_entries for each row execute function af.append_only();
create trigger commission_advances_ao before update or delete on commission_advances for each row execute function af.append_only();
create trigger commission_payouts_ao before update or delete on commission_payouts for each row execute function af.append_only();

-- ===== Agenda avançada: lista de espera =====
create table agenda_waitlist (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  customer_id uuid not null,
  vehicle_id uuid,
  title text not null check (length(title) between 2 and 120),
  duration_minutes int not null check (duration_minutes between 15 and 1440),
  window_from timestamptz not null,
  window_to timestamptz not null,
  priority int not null default 0 check (priority between 0 and 9),
  status text not null default 'waiting' check (status in ('waiting','scheduled','cancelled')),
  appointment_id uuid,
  note text check (note is null or length(note) <= 200),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (window_to > window_from),
  check ((status = 'scheduled') = (appointment_id is not null)),
  foreign key (tenant_id, unit_id) references units (tenant_id, id),
  foreign key (tenant_id, customer_id) references customers (tenant_id, id),
  foreign key (tenant_id, vehicle_id) references vehicles (tenant_id, id),
  foreign key (tenant_id, appointment_id) references appointments (tenant_id, id)
);

-- ===== Automações configuráveis =====
create table automation_settings (
  tenant_id uuid primary key references tenants(id),
  enabled boolean not null default true,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);
create table automation_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null check (length(name) between 2 and 80),
  trigger_kind text not null check (trigger_kind ~ '^[a-z0-9_.]{3,40}$' and trigger_kind not like 'automation.%'),
  action text not null check (action in ('whatsapp_template','internal_note')),
  config jsonb not null,
  enabled boolean not null default false,
  version int not null default 1,
  activated_at timestamptz not null default now(),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);
-- Uma execução por (regra, evento de origem): a chave única É a idempotência.
create table automation_runs (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  rule_id uuid not null,
  rule_version int not null,
  source_key text not null check (length(source_key) <= 80),
  status text not null check (status in ('done','skipped','failed')),
  detail text check (detail is null or length(detail) <= 200),
  created_at timestamptz not null default now(),
  unique (tenant_id, rule_id, source_key),
  foreign key (tenant_id, rule_id) references automation_rules (tenant_id, id)
);
create index automation_runs_month on automation_runs (tenant_id, created_at) where status = 'done';
create trigger automation_runs_ao before update or delete on automation_runs for each row execute function af.append_only();

-- ===== RLS e grants =====
select af.apply_tenant_rls('insurers', 'insurers');
select af.apply_tenant_rls('insurance_claims', 'insurers', 'unit_id');
select af.apply_tenant_rls('claim_authorizations', 'insurers');
select af.apply_tenant_rls('claim_events', 'insurers');
select af.apply_tenant_rls('stock_transfers', 'stock');
select af.apply_tenant_rls('commission_rules', 'members');
select af.apply_tenant_rls('commission_entries', 'finance', 'unit_id');
select af.apply_tenant_rls('commission_advances', 'finance', 'unit_id');
select af.apply_tenant_rls('commission_payouts', 'finance', 'unit_id');
select af.apply_tenant_rls('agenda_waitlist', 'orders', 'unit_id');
select af.apply_tenant_rls('automation_settings', 'automation');
select af.apply_tenant_rls('automation_rules', 'automation');
select af.apply_tenant_rls('automation_runs', 'automation');
-- O job (ator platform) só LÊ regras para descobrir quais tenants processar; escrever segue sendo ator 'tenant'.
create policy automation_rules_job_read on automation_rules for select using (af.actor() in ('platform','system'));

grant select, insert on insurers, insurance_claims, claim_authorizations, claim_events, stock_transfers, commission_rules, commission_entries,
  commission_advances, commission_payouts, agenda_waitlist, automation_rules, automation_runs to app_rw;
grant select, insert, update on automation_settings to app_rw;
grant update (name, doc, phone, email, sla_authorization_hours, active) on insurers to app_rw;
grant update (policy_no, deductible_cents, status, requested_cents, authorized_cents, authorization_due_at, closed_at) on insurance_claims to app_rw;
grant update (status, appointment_id, priority, window_from, window_to) on agenda_waitlist to app_rw;
grant update (name, config, enabled, version, activated_at, updated_at) on automation_rules to app_rw;
grant usage, select on all sequences in schema public to app_rw;
grant select, insert, update on platform_settings to app_rw; -- escrita protegida por RLS (somente ator 'platform')
