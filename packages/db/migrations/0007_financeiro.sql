-- AutoFlow 0007 — Fase 5: financeiro gerencial (ledger append-only, partida dobrada, recebíveis/pagáveis, caixa, conciliação).
-- Valores em CENTAVOS (bigint), consistente com a Fase 2 (desvio documentado de FINANCIAL_RULES §1: numeric(14,2) → bigint centavos).

select set_config('app.actor', 'platform', true);
insert into permissions (code, description) values
  ('finance:read','Ver DRE, fluxo de caixa, saldos e lucro por OS'),
  ('finance:receive','Registrar recebimentos'),
  ('finance:manage','Faturar, contas a pagar, pagamentos, carteiras, conciliação'),
  ('finance:discount','Conceder desconto até a alçada'),
  ('finance:reverse','Estornar/cancelar até a alçada'),
  ('finance:override','Aprovar desconto/estorno acima da alçada'),
  ('finance:settings','Configurar regras financeiras');
insert into role_permissions (role_id, permission_code)
select r.id, p.code from roles r cross join permissions p
where r.tenant_id is null and r.key in ('owner','admin') and p.code like 'finance:%';
insert into role_permissions (role_id, permission_code)
select r.id, p.code from roles r cross join permissions p
where r.tenant_id is null and r.key = 'manager' and p.code in ('finance:read','finance:receive','finance:manage','finance:discount','finance:reverse');
insert into role_permissions (role_id, permission_code)
select r.id, p.code from roles r cross join permissions p
where r.tenant_id is null and r.key = 'finance' and p.code in ('finance:read','finance:receive','finance:manage','finance:discount','finance:reverse');
insert into role_permissions (role_id, permission_code)
select r.id, p.code from roles r cross join permissions p
where r.tenant_id is null and r.key = 'attendant' and p.code in ('finance:receive');
select set_config('app.actor', '', true);

create table fin_settings (
  tenant_id uuid primary key references tenants(id),
  discount_limit_bp int not null default 500 check (discount_limit_bp between 0 and 10000),
  reversal_limit_cents bigint not null default 100000 check (reversal_limit_cents >= 0),
  late_fine_bp int not null default 200 check (late_fine_bp between 0 and 10000),
  late_interest_bp_month int not null default 100 check (late_interest_bp_month between 0 and 10000),
  overhead_method text not null default 'revenue' check (overhead_method in ('revenue','hours','fixed')),
  overhead_value bigint not null default 0 check (overhead_value >= 0),
  updated_at timestamptz not null default now()
);

create table fin_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  code text not null check (code ~ '^[A-Za-z0-9._-]{1,20}$'),
  name text not null check (length(name) between 2 and 80),
  type text not null check (type in ('asset','liability','equity','revenue','deduction','direct_cost','expense','financial')),
  system_key text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, code),
  unique (tenant_id, system_key)
);

create table cost_centers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid,
  name text not null check (length(name) between 2 and 80),
  active boolean not null default true,
  unique (tenant_id, id),
  foreign key (tenant_id, unit_id) references units (tenant_id, id)
);

create table fin_wallets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  name text not null check (length(name) between 2 and 80),
  kind text not null check (kind in ('cash','bank','card_machine','digital')),
  account_id uuid not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name),
  foreign key (tenant_id, account_id) references fin_accounts (tenant_id, id)
);

-- ===== Ledger =====
create table ledger_txns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  kind text not null check (kind in ('opening','invoice','receipt','payable','payment','transfer','reversal')),
  competence_date date not null,
  cash_date date,
  description text not null check (length(description) between 1 and 200),
  os_id uuid,
  reversal_of uuid,
  reversal_reason text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, id, unit_id),
  foreign key (tenant_id, unit_id) references units (tenant_id, id),
  foreign key (tenant_id, reversal_of) references ledger_txns (tenant_id, id),
  check ((kind = 'reversal') = (reversal_of is not null)),
  check (kind <> 'reversal' or length(btrim(coalesce(reversal_reason,''))) >= 3)
);
create unique index ledger_one_reversal on ledger_txns (reversal_of) where reversal_of is not null;
create index ledger_txn_comp on ledger_txns (tenant_id, competence_date);
create index ledger_txn_cash on ledger_txns (tenant_id, cash_date) where cash_date is not null;

create table ledger_entries (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  unit_id uuid not null,
  txn_id uuid not null,
  account_id uuid not null,
  side char(1) not null check (side in ('D','C')),
  amount_cents bigint not null check (amount_cents > 0),
  cost_center_id uuid,
  foreign key (tenant_id, txn_id, unit_id) references ledger_txns (tenant_id, id, unit_id),
  foreign key (tenant_id, account_id) references fin_accounts (tenant_id, id),
  foreign key (tenant_id, cost_center_id) references cost_centers (tenant_id, id)
);
create index ledger_entry_txn on ledger_entries (tenant_id, txn_id);
create index ledger_entry_acc on ledger_entries (tenant_id, account_id);
create trigger ledger_txns_append_only before update or delete on ledger_txns for each row execute function af.append_only();
create trigger ledger_entries_append_only before update or delete on ledger_entries for each row execute function af.append_only();

-- Partida dobrada: Σ débitos = Σ créditos por txn (verificado no COMMIT).
create function af.check_txn_balanced() returns trigger language plpgsql as $$
declare diff bigint; n int;
begin
  select coalesce(sum(case side when 'D' then amount_cents else -amount_cents end), 0), count(*) into diff, n
    from ledger_entries where tenant_id = new.tenant_id and txn_id = new.txn_id;
  if diff <> 0 or n < 2 then
    raise exception 'ledger txn % desbalanceada (diff=%, linhas=%)', new.txn_id, diff, n using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger ledger_balanced after insert on ledger_entries
  deferrable initially deferred for each row execute function af.check_txn_balanced();

-- ===== Documentos (a receber / a pagar), parcelas, liquidações =====
create table fin_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  kind text not null check (kind in ('receivable','payable')),
  os_id uuid,
  customer_id uuid,
  party_name text check (party_name is null or length(party_name) between 2 and 120),
  account_id uuid,
  cost_center_id uuid,
  description text not null check (length(description) between 2 and 200),
  gross_cents bigint not null check (gross_cents > 0),
  discount_cents bigint not null default 0 check (discount_cents >= 0),
  net_cents bigint not null check (net_cents > 0),
  competence_date date not null,
  txn_id uuid not null,
  cancelled_at timestamptz,
  cancel_reason text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (net_cents = gross_cents - discount_cents),
  check (cancelled_at is null or length(btrim(coalesce(cancel_reason,''))) >= 3),
  foreign key (tenant_id, unit_id) references units (tenant_id, id),
  foreign key (tenant_id, os_id, unit_id) references service_orders (tenant_id, id, unit_id),
  foreign key (tenant_id, customer_id) references customers (tenant_id, id),
  foreign key (tenant_id, account_id) references fin_accounts (tenant_id, id),
  foreign key (tenant_id, cost_center_id) references cost_centers (tenant_id, id),
  foreign key (tenant_id, txn_id) references ledger_txns (tenant_id, id)
);
-- Uma fatura ativa por OS (faturamento só após entrega; cancelar a fatura permite refaturar).
create unique index fin_one_active_invoice on fin_documents (tenant_id, os_id) where kind = 'receivable' and os_id is not null and cancelled_at is null;

create table fin_installments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  doc_id uuid not null,
  no int not null check (no >= 1),
  due_date date not null,
  amount_cents bigint not null check (amount_cents > 0),
  unique (tenant_id, id),
  unique (doc_id, no),
  foreign key (tenant_id, doc_id) references fin_documents (tenant_id, id)
);
-- Σ parcelas = valor líquido do documento (verificado no COMMIT).
create function af.check_installments_sum() returns trigger language plpgsql as $$
declare s bigint; n bigint;
begin
  select coalesce(sum(i.amount_cents),0), d.net_cents into s, n from fin_documents d
    left join fin_installments i on i.tenant_id = d.tenant_id and i.doc_id = d.id
   where d.tenant_id = new.tenant_id and d.id = new.doc_id group by d.net_cents;
  if s <> n then raise exception 'parcelas (%) != valor líquido (%) do documento %', s, n, new.doc_id using errcode = '23514'; end if;
  return null;
end $$;
create constraint trigger fin_inst_sum after insert on fin_installments deferrable initially deferred for each row execute function af.check_installments_sum();

create table fin_settlements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  kind text not null check (kind in ('receipt','payment')),
  wallet_id uuid not null,
  principal_cents bigint not null check (principal_cents > 0),
  charges_cents bigint not null default 0 check (charges_cents >= 0),
  settled_on date not null,
  method text not null check (method in ('cash','pix','card','transfer','boleto','other')),
  idempotency_key text not null check (length(idempotency_key) between 8 and 80),
  request_hash text not null,
  txn_id uuid not null,
  reversed_at timestamptz,
  reversed_on date,
  reversal_reason text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, kind, idempotency_key),
  check (reversed_at is null or length(btrim(coalesce(reversal_reason,''))) >= 3),
  foreign key (tenant_id, unit_id) references units (tenant_id, id),
  foreign key (tenant_id, wallet_id) references fin_wallets (tenant_id, id),
  foreign key (tenant_id, txn_id) references ledger_txns (tenant_id, id)
);
create table fin_allocations (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  settlement_id uuid not null,
  installment_id uuid not null,
  principal_cents bigint not null check (principal_cents > 0),
  interest_cents bigint not null default 0 check (interest_cents >= 0),
  fine_cents bigint not null default 0 check (fine_cents >= 0),
  foreign key (tenant_id, settlement_id) references fin_settlements (tenant_id, id),
  foreign key (tenant_id, installment_id) references fin_installments (tenant_id, id)
);
create index fin_alloc_inst on fin_allocations (tenant_id, installment_id);

-- ===== Conciliação básica =====
create table bank_statement_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  wallet_id uuid not null,
  line_date date not null,
  description text not null check (length(description) between 1 and 200),
  amount_cents bigint not null check (amount_cents <> 0),
  external_ref text,
  matched_entry_id bigint,
  matched_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, wallet_id) references fin_wallets (tenant_id, id)
);
create unique index bank_line_ref on bank_statement_lines (tenant_id, wallet_id, external_ref) where external_ref is not null;
create unique index bank_line_match on bank_statement_lines (matched_entry_id) where matched_entry_id is not null;

select af.apply_tenant_rls('fin_settings', 'finance');
select af.apply_tenant_rls('fin_accounts', 'finance');
select af.apply_tenant_rls('cost_centers', 'finance');
select af.apply_tenant_rls('fin_wallets', 'finance');
select af.apply_tenant_rls('ledger_txns', 'finance', 'unit_id');
select af.apply_tenant_rls('ledger_entries', 'finance', 'unit_id');
select af.apply_tenant_rls('fin_documents', 'finance', 'unit_id');
select af.apply_tenant_rls('fin_installments', 'finance');
select af.apply_tenant_rls('fin_settlements', 'finance', 'unit_id');
select af.apply_tenant_rls('fin_allocations', 'finance');
select af.apply_tenant_rls('bank_statement_lines', 'finance');

grant select, insert, update on fin_settings, cost_centers to app_rw;
grant select, insert on fin_accounts, fin_wallets, ledger_txns, ledger_entries, fin_installments, fin_allocations, bank_statement_lines to app_rw;
grant update (name, active) on fin_accounts, fin_wallets to app_rw;
grant select, insert on fin_documents, fin_settlements to app_rw;
grant update (cancelled_at, cancel_reason) on fin_documents to app_rw;
grant update (reversed_at, reversed_on, reversal_reason) on fin_settlements to app_rw;
grant update (matched_entry_id, matched_at) on bank_statement_lines to app_rw;
grant usage, select on all sequences in schema public to app_rw;
