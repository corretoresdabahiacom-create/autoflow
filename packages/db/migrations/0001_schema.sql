-- AutoFlow 0001 — schema base (global, tenant, unidade, auth, auditoria, suporte, retenção)
-- Convenções: PK uuid; FKs compostas (tenant_id, id) para impedir referência entre tenants;
-- RLS é habilitada em 0003 (após seeds).

create extension if not exists citext;

create schema if not exists af;

-- Funções de contexto da requisição (definidas por SET LOCAL pela aplicação).
create function af.tenant_id() returns uuid language sql stable as
$$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;

create function af.user_id() returns uuid language sql stable as
$$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

create function af.grant_id() returns uuid language sql stable as
$$ select nullif(current_setting('app.grant_id', true), '')::uuid $$;

create function af.actor() returns text language sql stable as
$$ select coalesce(nullif(current_setting('app.actor', true), ''), 'none') $$;

create function af.readonly() returns boolean language sql stable as
$$ select coalesce(current_setting('app.readonly', true), 'off') = 'on' $$;

-- Escopo de unidade: 'all' ou lista de ids em app.unit_ids (csv). Sem definição => nega.
create function af.unit_allowed(u uuid) returns boolean language sql stable as
$$ select case coalesce(current_setting('app.unit_scope', true), '')
       when 'all' then true
       else coalesce(u = any (string_to_array(nullif(current_setting('app.unit_ids', true), ''), ',')::uuid[]), false)
     end $$;

-- ========== GLOBAL ==========
create table users (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique,
  password_hash text,                       -- null = convidado ainda sem senha
  status text not null default 'active' check (status in ('active','disabled')),
  mfa_secret_enc text,
  mfa_enabled boolean not null default false,
  mfa_last_step bigint,
  failed_logins int not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);

create table platform_users (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique,
  password_hash text not null,
  status text not null default 'active' check (status in ('active','disabled')),
  mfa_secret_enc text,
  mfa_enabled boolean not null default false,
  mfa_last_step bigint,
  failed_logins int not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);

create table features (
  code text primary key,
  kind text not null check (kind in ('boolean','limit')),
  description text not null
);

create table plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  price_cents integer not null default 0 check (price_cents >= 0),
  billing_interval text not null default 'month' check (billing_interval in ('month','year')),
  active boolean not null default true
);

create table plan_features (
  plan_id uuid not null references plans(id),
  feature_code text not null references features(code),
  value jsonb not null,                      -- boolean, número (limite) ou null (ilimitado)
  primary key (plan_id, feature_code)
);

create table permissions (
  code text primary key,
  description text not null
);

create table reserved_slugs (slug text primary key);

create table platform_settings (
  key text primary key,
  value jsonb not null
);

-- ========== TENANT ==========
create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 2 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  status text not null default 'trial' check (status in ('trial','active','suspended','cancelled')),
  suspended_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create function af.check_slug_not_reserved() returns trigger language plpgsql as $$
begin
  if exists (select 1 from reserved_slugs r where r.slug = new.slug) then
    raise exception 'slug reservado: %', new.slug using errcode = '23514';
  end if;
  return new;
end $$;
create trigger tenants_slug_reserved before insert or update of slug on tenants
  for each row execute function af.check_slug_not_reserved();

create table units (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null check (length(name) between 2 and 120),
  code text not null check (code ~ '^[A-Z0-9-]{1,12}$'),
  is_default boolean not null default false,
  status text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, code)
);
create unique index units_one_default_per_tenant on units (tenant_id) where is_default;

create table roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id),     -- null = papel de sistema
  key text not null,
  name text not null,
  is_system boolean not null default false,
  unique (id, tenant_id)
);
create unique index roles_key_unique on roles (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), key);

create table role_permissions (
  role_id uuid not null references roles(id) on delete cascade,
  permission_code text not null references permissions(code),
  primary key (role_id, permission_code)
);

create table memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id),
  role_id uuid not null references roles(id),
  status text not null default 'invited' check (status in ('invited','active','suspended')),
  all_units boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, user_id)
);

create table unit_memberships (
  tenant_id uuid not null,
  membership_id uuid not null,
  unit_id uuid not null,
  primary key (membership_id, unit_id),
  foreign key (tenant_id, membership_id) references memberships (tenant_id, id) on delete cascade,
  foreign key (tenant_id, unit_id) references units (tenant_id, id)
);

create table membership_permission_overrides (
  tenant_id uuid not null,
  membership_id uuid not null,
  permission_code text not null references permissions(code),
  effect text not null check (effect in ('allow','deny')),
  primary key (membership_id, permission_code),
  foreign key (tenant_id, membership_id) references memberships (tenant_id, id) on delete cascade
);

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references tenants(id),
  plan_id uuid not null references plans(id),
  status text not null default 'trial' check (status in ('trial','active','past_due','suspended','cancelled')),
  trial_ends_at timestamptz,
  current_period_end timestamptz,
  created_at timestamptz not null default now()
);

create table tenant_feature_overrides (
  tenant_id uuid not null references tenants(id),
  feature_code text not null references features(code),
  value jsonb not null,
  reason text not null,
  set_by uuid references platform_users(id),
  created_at timestamptz not null default now(),
  primary key (tenant_id, feature_code)
);

create table usage_records (
  tenant_id uuid not null references tenants(id),
  metric text not null,
  period date not null,
  qty bigint not null default 0,
  primary key (tenant_id, metric, period)
);

-- ========== SESSÕES E TOKENS ==========
create table sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  user_id uuid references users(id),
  platform_user_id uuid references platform_users(id),
  tenant_id uuid references tenants(id),
  membership_id uuid,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  idle_expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at timestamptz,
  mfa_verified_at timestamptz,
  ip_hash text,
  user_agent text,
  check ((user_id is not null)::int + (platform_user_id is not null)::int = 1)
);
create index sessions_user_idx on sessions (user_id) where revoked_at is null;
create index sessions_tenant_idx on sessions (tenant_id) where revoked_at is null;

create table auth_tokens (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('invite','password_reset')),
  token_hash text not null unique,
  user_id uuid not null references users(id),
  tenant_id uuid references tenants(id),
  membership_id uuid,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table rate_limits (
  key text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (key, window_start)
);

-- ========== AUDITORIA (append-only) ==========
create table audit_log (
  id bigint generated always as identity primary key,
  tenant_id uuid references tenants(id),
  actor_type text not null check (actor_type in ('user','platform_user','system')),
  actor_id uuid,
  action text not null,
  entity_type text,
  entity_id text,
  request_id text,
  ip_hash text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_tenant_idx on audit_log (tenant_id, created_at desc);

create function af.audit_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log é append-only (% bloqueado)', tg_op using errcode = '42501';
end $$;
create trigger audit_no_update_delete before update or delete on audit_log
  for each row execute function af.audit_append_only();
create trigger audit_no_truncate before truncate on audit_log
  for each statement execute function af.audit_append_only();

-- ========== SUPORTE: ACESSO EXCEPCIONAL ==========
create table support_access_grants (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references platform_users(id),
  tenant_id uuid not null references tenants(id),
  reason text not null check (length(reason) >= 15),
  scope text[] not null check (cardinality(scope) >= 1),
  read_only boolean not null default true check (read_only),   -- Fase 1: somente leitura
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '4 hours')
);
create index support_grants_tenant_idx on support_access_grants (tenant_id, created_at desc);

-- ========== RETENÇÃO / LGPD ==========
create table retention_policies (
  category text primary key,
  trigger_event text not null,
  default_period interval not null,
  floor_period interval not null,
  legal_basis text not null,
  action text not null check (action in ('anonymize','delete','archive','keep')),
  reviewed_by_legal_at timestamptz,
  check (default_period >= floor_period)
);

create table tenant_retention_overrides (
  tenant_id uuid not null references tenants(id),
  category text not null references retention_policies(category),
  period interval not null,
  primary key (tenant_id, category)
);

create function af.check_retention_floor() returns trigger language plpgsql as $$
declare f interval;
begin
  select floor_period into f from retention_policies where category = new.category;
  if new.period < f then
    raise exception 'prazo de retenção abaixo do piso legal (%) para %', f, new.category using errcode = '23514';
  end if;
  return new;
end $$;
create trigger retention_override_floor before insert or update on tenant_retention_overrides
  for each row execute function af.check_retention_floor();

create table legal_holds (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  scope text not null,
  reason text not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  released_at timestamptz
);

create table retention_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  category text not null references retention_policies(category),
  mode text not null check (mode in ('dry_run','apply')),
  counts jsonb not null default '{}'::jsonb,
  approved_by uuid,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create table privacy_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  subject_ref text not null,
  type text not null check (type in ('confirmation','access','correction','anonymization','deletion','portability','sharing_info','consent_revocation')),
  received_at timestamptz not null default now(),
  due_at timestamptz not null default (now() + interval '15 days'),
  status text not null default 'open' check (status in ('open','in_progress','answered','rejected_with_reason')),
  handled_by uuid,
  outcome text
);

create table consents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  subject_ref text not null,
  purpose text not null,
  channel text not null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  evidence jsonb not null default '{}'::jsonb
);
