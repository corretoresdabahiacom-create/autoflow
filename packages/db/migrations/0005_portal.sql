-- AutoFlow 0005 — Fase 3: portal do cliente.
select set_config('app.actor', 'platform', true);
insert into permissions (code, description) values
  ('portal:manage','Gerar/revogar/renovar links do portal, ver log de acesso e editar tema');
insert into role_permissions (role_id, permission_code)
select r.id, 'portal:manage' from roles r
where r.tenant_id is null and r.key in ('owner','admin','manager','attendant');
select set_config('app.actor', '', true);

alter table service_orders add column delivered_at timestamptz;
alter table attachments add column portal_visible boolean not null default false;
grant update (portal_visible) on attachments to app_rw;

alter table approvals drop constraint approvals_channel_check;
alter table approvals add constraint approvals_channel_check check (channel in ('assisted','portal'));

create table portal_settings (
  tenant_id uuid primary key references tenants(id),
  link_ttl_days int not null default 90 check (link_ttl_days between 1 and 365),
  updated_at timestamptz not null default now()
);

-- Só o hash do token é guardado. O token nunca é recuperável.
create table portal_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  os_id uuid not null,
  token_hash text not null unique,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, os_id, unit_id) references service_orders (tenant_id, id, unit_id)
);
create index portal_links_os on portal_links (tenant_id, os_id);

create table portal_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  os_id uuid not null,
  link_id uuid not null,
  token_hash text not null unique,
  idle_expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at timestamptz,
  ip_hash text,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, link_id) references portal_links (tenant_id, id),
  foreign key (tenant_id, os_id, unit_id) references service_orders (tenant_id, id, unit_id)
);

create table portal_otps (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  os_id uuid not null,
  session_id uuid not null,
  code_hash text not null,
  channel text not null,
  destination_masked text not null,
  attempts int not null default 0,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, os_id, unit_id) references service_orders (tenant_id, id, unit_id)
);
create index portal_otps_session on portal_otps (tenant_id, session_id, created_at desc);

create table portal_access_log (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  unit_id uuid not null,
  os_id uuid not null,
  link_id uuid,
  event text not null check (event in ('exchange','view','otp_requested','otp_failed','approval','chat_send','revoked','denied')),
  ip_hash text,
  user_agent text,
  at timestamptz not null default now(),
  foreign key (tenant_id, os_id, unit_id) references service_orders (tenant_id, id, unit_id)
);
create trigger portal_access_log_append_only before update or delete on portal_access_log for each row execute function af.append_only();

create table os_timeline (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  os_id uuid not null,
  kind text not null,
  title text not null check (length(title) between 2 and 160),
  visible_to_customer boolean not null default true,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, os_id, unit_id) references service_orders (tenant_id, id, unit_id)
);
create index os_timeline_os on os_timeline (tenant_id, os_id, created_at);
create trigger os_timeline_append_only before update or delete on os_timeline for each row execute function af.append_only();

create table portal_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  os_id uuid not null,
  sender text not null check (sender in ('customer','staff')),
  sender_user uuid references users(id),
  body text not null check (length(body) between 1 and 2000),
  attachment_id uuid,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, os_id, unit_id) references service_orders (tenant_id, id, unit_id),
  foreign key (tenant_id, attachment_id) references attachments (tenant_id, id)
);
create index portal_messages_os on portal_messages (tenant_id, os_id, created_at);
create trigger portal_messages_append_only before update or delete on portal_messages for each row execute function af.append_only();

-- Outbox transacional: o evento nasce na mesma transação da mudança (sem perda).
create table outbox (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  unit_id uuid not null,
  os_id uuid,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','sent','failed','skipped')),
  attempts int not null default 0,
  last_error text,
  available_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, unit_id) references units (tenant_id, id)
);
create index outbox_pending on outbox (tenant_id, status, available_at);

-- Tema do portal: rascunho / publicado / restauração. Campos obrigatórios nunca podem ser ocultados.
create table portal_theme_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  version_no int not null,
  status text not null check (status in ('draft','published','superseded')),
  config jsonb not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (tenant_id, version_no),
  check (not (coalesce(config->'hidden', '[]'::jsonb) ?| array['orderInfo','status','estimate','shopContact','privacyNotice']))
);
create unique index portal_theme_one_draft on portal_theme_versions (tenant_id) where status = 'draft';
create unique index portal_theme_one_published on portal_theme_versions (tenant_id) where status = 'published';

select af.apply_tenant_rls('portal_settings', 'orders');
select af.apply_tenant_rls('portal_links', 'orders', 'unit_id');
select af.apply_tenant_rls('portal_sessions', 'orders', 'unit_id');
select af.apply_tenant_rls('portal_otps', 'orders', 'unit_id');
select af.apply_tenant_rls('portal_access_log', 'orders', 'unit_id');
select af.apply_tenant_rls('os_timeline', 'orders', 'unit_id');
select af.apply_tenant_rls('portal_messages', 'orders', 'unit_id');
select af.apply_tenant_rls('outbox', 'orders', 'unit_id');
select af.apply_tenant_rls('portal_theme_versions', 'orders');

grant select, insert, update on portal_settings, portal_links, portal_sessions, portal_otps, outbox, portal_theme_versions to app_rw;
grant select, insert on portal_access_log, os_timeline, portal_messages to app_rw;
grant usage, select on all sequences in schema public to app_rw;
