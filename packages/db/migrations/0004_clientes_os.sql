-- AutoFlow 0004 — Fase 2: clientes, veículos, OS, vistoria, orçamento versionado, aprovações, anexos, execução.
-- Valores monetários em centavos (bigint). Quantidades em numeric(12,3).

-- ===== Permissões novas (seed global: ator 'platform' só dentro desta transação de migração) =====
select set_config('app.actor', 'platform', true);
insert into permissions (code, description) values
  ('customers:read','Ver clientes e veículos'),
  ('customers:manage','Criar e editar clientes e veículos'),
  ('orders:read','Ver ordens de serviço'),
  ('orders:manage','Criar e editar OS, vistoria e execução'),
  ('estimates:manage','Editar orçamento (rascunho)'),
  ('estimates:publish','Publicar versão de orçamento'),
  ('approvals:assist','Registrar aprovação/recusa assistida'),
  ('approvals:exception','Autorizar execução excepcional sem aprovação'),
  ('attachments:read','Ver anexos'),
  ('attachments:manage','Enviar anexos');

insert into role_permissions (role_id, permission_code)
select r.id, p.code from roles r cross join permissions p
where r.tenant_id is null and r.key in ('owner','admin','manager')
  and p.code in ('customers:read','customers:manage','orders:read','orders:manage','estimates:manage',
                 'estimates:publish','approvals:assist','approvals:exception','attachments:read','attachments:manage');
insert into role_permissions (role_id, permission_code)
select r.id, p.code from roles r cross join permissions p
where r.tenant_id is null and r.key = 'attendant'
  and p.code in ('customers:read','customers:manage','orders:read','orders:manage','estimates:manage',
                 'estimates:publish','approvals:assist','attachments:read','attachments:manage');
insert into role_permissions (role_id, permission_code)
select r.id, p.code from roles r cross join permissions p
where r.tenant_id is null and r.key = 'finance'
  and p.code in ('customers:read','orders:read','attachments:read');
insert into role_permissions (role_id, permission_code)
select r.id, p.code from roles r cross join permissions p
where r.tenant_id is null and r.key in ('mechanic','bodyworker','painter','aligner')
  and p.code in ('orders:read','attachments:read','attachments:manage');
insert into role_permissions (role_id, permission_code)
select r.id, p.code from roles r cross join permissions p
where r.tenant_id is null and r.key = 'stockkeeper' and p.code in ('orders:read');

-- ===== Clientes e veículos (por tenant; sem escopo de unidade) =====
create table customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null check (length(name) between 2 and 120),
  phone_e164 text check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email citext,
  origin text,
  marketing_opt_in boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create index customers_phone_idx on customers (tenant_id, phone_e164 text_pattern_ops);
create index customers_name_trgm on customers using gin (name gin_trgm_ops);

create table vehicles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  customer_id uuid not null,
  plate text not null check (plate ~ '^[A-Z0-9]{7}$'),   -- normalizada (sem hífen, maiúscula)
  make text, model text,
  year int check (year between 1900 and 2100),
  km int check (km >= 0),
  fuel text,
  created_at timestamptz not null default now(),
  unique (tenant_id, plate),
  unique (tenant_id, id),
  foreign key (tenant_id, customer_id) references customers (tenant_id, id)
);
create index vehicles_customer_idx on vehicles (tenant_id, customer_id);
create index vehicles_plate_prefix on vehicles (tenant_id, plate text_pattern_ops);

-- ===== OS =====
create table os_counters (
  tenant_id uuid not null,
  unit_id uuid not null,
  last_number int not null default 0,
  primary key (tenant_id, unit_id),
  foreign key (tenant_id, unit_id) references units (tenant_id, id)
);

create table service_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  unit_id uuid not null,
  number int not null,
  customer_id uuid not null,
  vehicle_id uuid not null,
  status text not null default 'open' check (status in ('open','delivered','cancelled')),
  promised_at timestamptz,
  notes text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, unit_id, number),
  unique (tenant_id, id),
  unique (tenant_id, id, unit_id),
  foreign key (tenant_id, unit_id) references units (tenant_id, id),
  foreign key (tenant_id, customer_id) references customers (tenant_id, id),
  foreign key (tenant_id, vehicle_id) references vehicles (tenant_id, id)
);
create index so_number_idx on service_orders (tenant_id, number);
create index so_vehicle_idx on service_orders (tenant_id, vehicle_id);
create index so_customer_idx on service_orders (tenant_id, customer_id);

-- ===== Anexos (arquivo nunca público; storage_key opaco) =====
create table attachments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  os_id uuid not null,
  kind text not null check (kind in ('photo','document','entry_term')),
  storage_key text not null unique,
  mime text not null check (mime in ('image/jpeg','image/png','image/webp','application/pdf')),
  size_bytes int not null check (size_bytes > 0),
  sha256 text not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, os_id, unit_id) references service_orders (tenant_id, id, unit_id)
);
create index attachments_os_idx on attachments (tenant_id, os_id);

-- ===== Vistoria =====
create table inspections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  os_id uuid not null,
  km int check (km >= 0),
  fuel_level text check (fuel_level in ('empty','quarter','half','three_quarters','full')),
  notes text,
  confirmed_at timestamptz,
  confirmed_by_name text,
  confirmed_by_user uuid references users(id),
  term_attachment_id uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, os_id),
  foreign key (tenant_id, os_id, unit_id) references service_orders (tenant_id, id, unit_id),
  foreign key (tenant_id, term_attachment_id) references attachments (tenant_id, id)
);

create table damage_marks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  inspection_id uuid not null,
  area text not null check (length(area) between 2 and 60),
  kind text not null check (kind in ('scratch','dent','crack','broken','missing','other')),
  note text check (length(note) <= 500),
  attachment_id uuid,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, inspection_id) references inspections (tenant_id, id) on delete cascade,
  foreign key (tenant_id, attachment_id) references attachments (tenant_id, id)
);

-- Vistoria confirmada é imutável (marcas e dados).
create function af.inspection_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.confirmed_at is not null then
    raise exception 'vistoria confirmada não pode ser alterada' using errcode = '23514';
  end if;
  return coalesce(new, old);
end $$;
create trigger inspections_guard before update on inspections for each row execute function af.inspection_guard();

create function af.damage_guard() returns trigger language plpgsql as $$
declare done timestamptz;
begin
  select confirmed_at into done from inspections
   where tenant_id = coalesce(new.tenant_id, old.tenant_id) and id = coalesce(new.inspection_id, old.inspection_id);
  if done is not null then
    raise exception 'vistoria confirmada não pode ser alterada' using errcode = '23514';
  end if;
  return coalesce(new, old);
end $$;
create trigger damage_marks_guard before insert or update or delete on damage_marks for each row execute function af.damage_guard();

-- ===== Orçamento versionado =====
create table estimates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  os_id uuid not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, os_id),                       -- decisão: 1 orçamento por OS, N versões
  foreign key (tenant_id, os_id, unit_id) references service_orders (tenant_id, id, unit_id)
);

create table estimate_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  estimate_id uuid not null,
  version_no int not null check (version_no >= 1),
  status text not null default 'draft' check (status in ('draft','published','superseded')),
  total_cents bigint,
  presented_hash text,                             -- hash do conteúdo publicado (itens+totais)
  published_at timestamptz,
  published_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, estimate_id, version_no),
  foreign key (tenant_id, estimate_id) references estimates (tenant_id, id)
);
-- no máximo um rascunho e uma versão publicada vigente por orçamento
create unique index estimate_one_draft on estimate_versions (tenant_id, estimate_id) where status = 'draft';
create unique index estimate_one_published on estimate_versions (tenant_id, estimate_id) where status = 'published';

create function af.version_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'versão publicada não pode ser apagada' using errcode = '23514';
    end if;
    return old;
  end if;
  if old.status = 'draft' then
    return new;                                    -- rascunho é editável; publicar é draft -> published
  end if;
  -- publicada/superseded: só published -> superseded, nada mais muda
  if old.status = 'published' and new.status = 'superseded'
     and (new.id, new.tenant_id, new.unit_id, new.estimate_id, new.version_no, new.total_cents, new.presented_hash,
          new.published_at, new.published_by, new.created_at)
         is not distinct from
         (old.id, old.tenant_id, old.unit_id, old.estimate_id, old.version_no, old.total_cents, old.presented_hash,
          old.published_at, old.published_by, old.created_at) then
    return new;
  end if;
  raise exception 'versão publicada é imutável' using errcode = '23514';
end $$;
create trigger estimate_versions_guard before update or delete on estimate_versions
  for each row execute function af.version_guard();

create table estimate_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  version_id uuid not null,
  line_key uuid not null,                          -- estável entre versões
  position int not null default 0,
  description text not null check (length(description) between 2 and 300),
  category text not null check (category in ('service','part','other')),
  qty numeric(12,3) not null check (qty > 0),
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  item_hash text not null,                         -- SHA-256 de (description, category, qty, unit_price)
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (version_id, line_key),
  foreign key (tenant_id, version_id) references estimate_versions (tenant_id, id)
);

create function af.item_guard() returns trigger language plpgsql as $$
declare st text;
begin
  select status into st from estimate_versions
   where tenant_id = coalesce(new.tenant_id, old.tenant_id) and id = coalesce(new.version_id, old.version_id);
  if st is distinct from 'draft' then
    raise exception 'itens de versão publicada são imutáveis' using errcode = '23514';
  end if;
  return coalesce(new, old);
end $$;
create trigger estimate_items_guard before insert or update or delete on estimate_items
  for each row execute function af.item_guard();

-- ===== Aprovações (append-only; ligadas a versão + item + hash) =====
create table approvals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  version_id uuid not null,
  item_id uuid not null,
  decision text not null check (decision in ('approved','rejected')),
  item_hash_at_decision text not null,
  channel text not null check (channel in ('assisted')),   -- 'portal' entra na Fase 3
  decided_by uuid references users(id),
  justification text,
  evidence jsonb not null,
  decided_at timestamptz not null default now(),
  unique (tenant_id, item_id),                     -- uma decisão por item; mudar de ideia = nova versão
  foreign key (tenant_id, version_id) references estimate_versions (tenant_id, id),
  foreign key (tenant_id, item_id) references estimate_items (tenant_id, id),
  check (decision = 'approved' or length(coalesce(justification, '')) >= 5)
);
create function af.append_only() returns trigger language plpgsql as $$
begin
  raise exception '% é append-only', tg_table_name using errcode = '23514';
end $$;
create trigger approvals_append_only before update or delete on approvals for each row execute function af.append_only();

-- ===== Execução (bloqueio de serviço sem aprovação) =====
create table execution_policies (
  tenant_id uuid primary key references tenants(id),
  exception_enabled boolean not null default false,
  exception_max_cents bigint not null default 0 check (exception_max_cents >= 0),
  updated_at timestamptz not null default now()
);

create table service_executions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  os_id uuid not null,
  item_id uuid,
  description text not null,
  amount_cents bigint not null check (amount_cents >= 0),
  started_by uuid references users(id),
  started_at timestamptz not null default now(),
  exception jsonb,                                 -- justificativa, evidência e quem autorizou
  foreign key (tenant_id, os_id, unit_id) references service_orders (tenant_id, id, unit_id),
  foreign key (tenant_id, item_id) references estimate_items (tenant_id, id),
  check ((item_id is not null and exception is null) or (item_id is null and exception is not null))
);
create unique index exec_item_once on service_executions (tenant_id, item_id) where item_id is not null;

-- ===== RLS =====
select af.apply_tenant_rls('customers', 'customers');
select af.apply_tenant_rls('vehicles', 'customers');
select af.apply_tenant_rls('os_counters', 'orders', 'unit_id');
select af.apply_tenant_rls('service_orders', 'orders', 'unit_id');
select af.apply_tenant_rls('attachments', 'orders', 'unit_id');
select af.apply_tenant_rls('inspections', 'orders', 'unit_id');
select af.apply_tenant_rls('damage_marks', 'orders', 'unit_id');
select af.apply_tenant_rls('estimates', 'orders', 'unit_id');
select af.apply_tenant_rls('estimate_versions', 'orders', 'unit_id');
select af.apply_tenant_rls('estimate_items', 'orders', 'unit_id');
select af.apply_tenant_rls('approvals', 'orders', 'unit_id');
select af.apply_tenant_rls('execution_policies', 'orders');
select af.apply_tenant_rls('service_executions', 'orders', 'unit_id');

-- ===== Privilégios mínimos =====
grant select, insert, update on customers, vehicles, service_orders, os_counters, inspections,
  estimates, estimate_versions, execution_policies to app_rw;
grant select, insert, update, delete on damage_marks, estimate_items to app_rw;   -- só em rascunho/vistoria aberta (triggers)
grant select, insert, delete on estimate_versions to app_rw;                       -- delete só de rascunho (trigger)
grant select, insert on attachments, approvals, service_executions to app_rw;      -- sem UPDATE/DELETE
