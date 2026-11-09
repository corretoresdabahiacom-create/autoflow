-- AutoFlow 0003 — RLS (ENABLE + FORCE), políticas e privilégios mínimos para app_rw.
-- Premissas: contexto vem de SET LOCAL (app.actor, app.tenant_id, app.user_id, app.grant_id,
-- app.readonly, app.unit_scope, app.unit_ids) definido SOMENTE pela camada de acesso da API.
-- Atores: tenant | platform | system | support.
-- Obs.: INSERT ... RETURNING exige política de SELECT; por isso o ator 'platform' provisiona
-- units/memberships com ids gerados na aplicação, sem RETURNING.

-- Acesso excepcional: o ator 'support' só enxerga recurso coberto por grant válido (checado no banco).
create function af.support_ok(tid uuid, resource text) returns boolean language plpgsql stable as $$
begin
  if af.actor() <> 'support' then
    return true;
  end if;
  return exists (
    select 1 from support_access_grants g
    where g.id = af.grant_id()
      and g.tenant_id = tid
      and g.operator_id = af.user_id()
      and g.revoked_at is null
      and g.expires_at > now()
      and resource = any (g.scope)
  );
end $$;

-- Macro: RLS padrão de tabela de tenant (leitura: tenant ou suporte com grant; escrita: só ator 'tenant').
create function af.apply_tenant_rls(p_table regclass, p_resource text, p_unit_col text default null)
returns void language plpgsql as $$
declare
  read_cond text := format('tenant_id = af.tenant_id() and af.support_ok(tenant_id, %L)', p_resource);
  write_cond text := 'tenant_id = af.tenant_id() and af.actor() = ''tenant'' and not af.readonly()';
begin
  if p_unit_col is not null then
    read_cond := read_cond || format(' and af.unit_allowed(%I)', p_unit_col);
    write_cond := write_cond || format(' and af.unit_allowed(%I)', p_unit_col);
  end if;
  execute format('alter table %s enable row level security', p_table);
  execute format('alter table %s force row level security', p_table);
  execute format('create policy tenant_select on %s for select using (%s)', p_table, read_cond);
  execute format('create policy tenant_insert on %s for insert with check (%s)', p_table, write_cond);
  execute format('create policy tenant_update on %s for update using (%s) with check (%s)', p_table, write_cond, write_cond);
  execute format('create policy tenant_delete on %s for delete using (%s)', p_table, write_cond);
end $$;

-- Macro: tabela global de configuração (leitura geral; escrita só 'platform').
create function af.apply_platform_write_rls(p_table regclass)
returns void language plpgsql as $$
begin
  execute format('alter table %s enable row level security', p_table);
  execute format('alter table %s force row level security', p_table);
  execute format('create policy cfg_select on %s for select using (true)', p_table);
  execute format('create policy cfg_insert on %s for insert with check (af.actor() = ''platform'')', p_table);
  execute format('create policy cfg_update on %s for update using (af.actor() = ''platform'') with check (af.actor() = ''platform'')', p_table);
  execute format('create policy cfg_delete on %s for delete using (af.actor() = ''platform'')', p_table);
end $$;

-- ===== Tabelas globais de configuração =====
select af.apply_platform_write_rls('features');
select af.apply_platform_write_rls('plans');
select af.apply_platform_write_rls('plan_features');
select af.apply_platform_write_rls('permissions');
select af.apply_platform_write_rls('reserved_slugs');
select af.apply_platform_write_rls('platform_settings');
select af.apply_platform_write_rls('retention_policies');

-- ===== tenants =====
alter table tenants enable row level security;
alter table tenants force row level security;
create policy tenants_select on tenants for select using (
  (id = af.tenant_id() and af.support_ok(id, 'tenant'))
  or af.actor() = 'platform'
  or exists (select 1 from memberships m where m.tenant_id = tenants.id and m.user_id = af.user_id())
);
create policy tenants_insert on tenants for insert with check (af.actor() = 'platform');
create policy tenants_update on tenants for update
  using (af.actor() = 'platform' or (id = af.tenant_id() and af.actor() = 'tenant' and not af.readonly()))
  with check (af.actor() = 'platform' or (id = af.tenant_id() and af.actor() = 'tenant' and not af.readonly()));

-- Somente o Super Admin altera slug/status; o tenant só pode renomear a si mesmo.
create function af.tenants_guard() returns trigger language plpgsql as $$
begin
  if af.actor() <> 'platform' and (
       new.slug is distinct from old.slug
    or new.status is distinct from old.status
    or new.suspended_reason is distinct from old.suspended_reason
  ) then
    raise exception 'apenas o Super Admin altera slug ou status do tenant' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger tenants_guard before update on tenants for each row execute function af.tenants_guard();

-- ===== units (escopo por unidade) =====
select af.apply_tenant_rls('units', 'units', 'id');
create policy platform_insert on units for insert with check (af.actor() = 'platform');

-- ===== memberships =====
alter table memberships enable row level security;
alter table memberships force row level security;
create policy memberships_select on memberships for select using (
  (tenant_id = af.tenant_id() and af.support_ok(tenant_id, 'members'))
  or user_id = af.user_id()
);
create policy memberships_insert on memberships for insert with check (
  af.actor() = 'platform'
  or (tenant_id = af.tenant_id() and af.actor() = 'tenant' and not af.readonly())
);
create policy memberships_update on memberships for update
  using (tenant_id = af.tenant_id() and af.actor() = 'tenant' and not af.readonly())
  with check (tenant_id = af.tenant_id() and af.actor() = 'tenant' and not af.readonly());

select af.apply_tenant_rls('unit_memberships', 'members', 'unit_id');
select af.apply_tenant_rls('membership_permission_overrides', 'members');

-- ===== roles / role_permissions =====
alter table roles enable row level security;
alter table roles force row level security;
create policy roles_select on roles for select using (
  tenant_id is null or (tenant_id = af.tenant_id() and af.support_ok(tenant_id, 'roles'))
);
create policy roles_insert on roles for insert with check (
  (tenant_id = af.tenant_id() and af.actor() = 'tenant' and not af.readonly())
  or (tenant_id is null and af.actor() = 'platform')
);
create policy roles_update on roles for update
  using ((tenant_id = af.tenant_id() and af.actor() = 'tenant' and not af.readonly()) or (tenant_id is null and af.actor() = 'platform'))
  with check ((tenant_id = af.tenant_id() and af.actor() = 'tenant' and not af.readonly()) or (tenant_id is null and af.actor() = 'platform'));
create policy roles_delete on roles for delete using (
  (tenant_id = af.tenant_id() and af.actor() = 'tenant' and not af.readonly())
  or (tenant_id is null and af.actor() = 'platform')
);

alter table role_permissions enable row level security;
alter table role_permissions force row level security;
create policy rp_select on role_permissions for select using (
  exists (select 1 from roles r where r.id = role_permissions.role_id)
);
create policy rp_write_ins on role_permissions for insert with check (
  exists (select 1 from roles r where r.id = role_permissions.role_id
          and ((r.tenant_id = af.tenant_id() and af.actor() = 'tenant' and not af.readonly())
               or (r.tenant_id is null and af.actor() = 'platform')))
);
create policy rp_write_upd on role_permissions for update using (
  exists (select 1 from roles r where r.id = role_permissions.role_id
          and ((r.tenant_id = af.tenant_id() and af.actor() = 'tenant' and not af.readonly())
               or (r.tenant_id is null and af.actor() = 'platform')))
);
create policy rp_write_del on role_permissions for delete using (
  exists (select 1 from roles r where r.id = role_permissions.role_id
          and ((r.tenant_id = af.tenant_id() and af.actor() = 'tenant' and not af.readonly())
               or (r.tenant_id is null and af.actor() = 'platform')))
);

-- ===== assinatura, entitlements e uso (escrita: Super Admin / sistema) =====
alter table subscriptions enable row level security;
alter table subscriptions force row level security;
create policy subs_select on subscriptions for select using (
  (tenant_id = af.tenant_id() and af.support_ok(tenant_id, 'subscription')) or af.actor() = 'platform'
);
create policy subs_insert on subscriptions for insert with check (af.actor() = 'platform');
create policy subs_update on subscriptions for update using (af.actor() = 'platform') with check (af.actor() = 'platform');

alter table tenant_feature_overrides enable row level security;
alter table tenant_feature_overrides force row level security;
create policy tfo_select on tenant_feature_overrides for select using (
  (tenant_id = af.tenant_id() and af.support_ok(tenant_id, 'entitlements')) or af.actor() = 'platform'
);
create policy tfo_insert on tenant_feature_overrides for insert with check (af.actor() = 'platform');
create policy tfo_update on tenant_feature_overrides for update using (af.actor() = 'platform') with check (af.actor() = 'platform');
create policy tfo_delete on tenant_feature_overrides for delete using (af.actor() = 'platform');

alter table usage_records enable row level security;
alter table usage_records force row level security;
create policy usage_select on usage_records for select using (
  (tenant_id = af.tenant_id() and af.support_ok(tenant_id, 'usage')) or af.actor() = 'platform'
);
create policy usage_insert on usage_records for insert with check (af.actor() in ('platform','system'));
create policy usage_update on usage_records for update
  using (af.actor() in ('platform','system')) with check (af.actor() in ('platform','system'));

-- ===== auditoria (append-only) =====
alter table audit_log enable row level security;
alter table audit_log force row level security;
create policy audit_select on audit_log for select using (
  (tenant_id = af.tenant_id() and af.support_ok(tenant_id, 'audit'))
  or (af.actor() = 'platform' and tenant_id is null)
);
create policy audit_insert on audit_log for insert with check (
  af.actor() in ('platform','system')
  or (tenant_id = af.tenant_id() and af.actor() in ('tenant','support'))
);

-- ===== acesso excepcional =====
alter table support_access_grants enable row level security;
alter table support_access_grants force row level security;
create policy grants_select on support_access_grants for select using (
  af.actor() in ('platform','support') or tenant_id = af.tenant_id()
);
create policy grants_insert on support_access_grants for insert with check (af.actor() = 'platform');
create policy grants_update on support_access_grants for update using (af.actor() = 'platform') with check (af.actor() = 'platform');

-- ===== retenção / LGPD =====
select af.apply_tenant_rls('tenant_retention_overrides', 'retention');
select af.apply_tenant_rls('legal_holds', 'retention');
select af.apply_tenant_rls('retention_runs', 'retention');
select af.apply_tenant_rls('privacy_requests', 'privacy');
select af.apply_tenant_rls('consents', 'privacy');

-- ===== privilégios mínimos para app_rw (sem DDL, sem BYPASSRLS) =====
revoke all on all tables in schema public from app_rw;
revoke all on all sequences in schema public from app_rw;
grant usage on schema public, af to app_rw;

grant select, insert, update on users, platform_users, tenants, units, memberships, subscriptions,
  usage_records, retention_runs, privacy_requests, consents, support_access_grants, legal_holds, auth_tokens
  to app_rw;
grant select, insert, update, delete on roles, role_permissions, unit_memberships, membership_permission_overrides,
  tenant_feature_overrides, tenant_retention_overrides, sessions, rate_limits,
  features, plans, plan_features, permissions, reserved_slugs, platform_settings, retention_policies
  to app_rw;
grant select, insert on audit_log to app_rw;              -- sem UPDATE/DELETE/TRUNCATE
grant usage on all sequences in schema public to app_rw;
