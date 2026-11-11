-- AutoFlow 0008 — Fase 6: presença digital (site/cartão), mídia pública, leads (CRM básico), estatísticas anônimas.
select set_config('app.actor', 'platform', true);
insert into permissions (code, description) values
  ('site:manage','Editar, publicar e restaurar o site e o cartão'),
  ('leads:read','Ver leads'),
  ('leads:manage','Mover leads no funil e anotar');
insert into role_permissions (role_id, permission_code)
select r.id, p.code from roles r cross join permissions p
where r.tenant_id is null and r.key in ('owner','admin','manager') and p.code in ('site:manage','leads:read','leads:manage');
insert into role_permissions (role_id, permission_code)
select r.id, p.code from roles r cross join permissions p
where r.tenant_id is null and r.key = 'attendant' and p.code in ('leads:read','leads:manage');
select set_config('app.actor', '', true);

-- Leitura pública (ator 'public', sem sessão): apenas tenants ativos/trial e versão publicada.
create policy tenants_public_select on tenants for select using (af.actor() = 'public' and status in ('trial','active'));

create table site_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  version_no int not null,
  status text not null check (status in ('draft','published','superseded')),
  template text not null check (template in ('moderno','premium','minimalista','esportivo','industrial','elegante')),
  config jsonb not null,
  etag text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, version_no),
  check (status <> 'published' or (published_at is not null and etag is not null))
);
create unique index site_one_draft on site_versions (tenant_id) where status = 'draft';
create unique index site_one_published on site_versions (tenant_id) where status = 'published';
select af.apply_tenant_rls('site_versions', 'site');
create policy site_public_select on site_versions for select using (af.actor() = 'public' and status = 'published');

create table site_media (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  storage_key text not null,
  mime text not null check (mime in ('image/jpeg','image/png','image/webp')),
  size_bytes int not null check (size_bytes between 1 and 5242880),
  sha256 text not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);
select af.apply_tenant_rls('site_media', 'site');
create policy site_media_public_select on site_media for select using (af.actor() = 'public');

-- Leads
create table leads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  source text not null check (source in ('site','card','manual')) default 'site',
  campaign text check (campaign is null or campaign ~ '^[A-Za-z0-9_-]{1,40}$'),
  name text not null check (length(name) between 2 and 80),
  phone_e164 text not null check (phone_e164 ~ '^\+[0-9]{10,15}$'),
  email text check (email is null or length(email) <= 120),
  vehicle text check (vehicle is null or length(vehicle) <= 60),
  plate text check (plate is null or plate ~ '^[A-Z0-9]{7}$'),
  service text check (service is null or length(service) <= 60),
  description text check (description is null or length(description) <= 1000),
  status text not null default 'new' check (status in ('new','contacted','quoted','scheduled','won','lost')),
  lost_reason text,
  ip_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (status <> 'lost' or length(btrim(coalesce(lost_reason,''))) >= 3),
  foreign key (tenant_id, unit_id) references units (tenant_id, id)
);
create index leads_status on leads (tenant_id, status, created_at desc);

create table lead_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  unit_id uuid not null,
  lead_id uuid not null,
  kind text not null check (kind in ('created','status','note')),
  from_status text,
  to_status text,
  note text check (note is null or length(note) <= 1000),
  user_id uuid references users(id),
  at timestamptz not null default now(),
  foreign key (tenant_id, lead_id) references leads (tenant_id, id)
);
create trigger lead_events_append_only before update or delete on lead_events for each row execute function af.append_only();

create table lead_media (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  lead_id uuid not null,
  storage_key text not null,
  mime text not null check (mime in ('image/jpeg','image/png','image/webp')),
  size_bytes int not null check (size_bytes between 1 and 5242880),
  sha256 text not null,
  foreign key (tenant_id, lead_id) references leads (tenant_id, id)
);

-- Estatísticas agregadas SEM dados pessoais (sem IP, sem cookie, sem user-agent).
create table site_stats_daily (
  tenant_id uuid not null references tenants(id),
  day date not null,
  page text not null check (page in ('site','card','vcard','lead_submit')),
  source text not null check (source in ('direct','search','social','other')),
  visits int not null default 0,
  primary key (tenant_id, day, page, source)
);

select af.apply_tenant_rls('leads', 'leads', 'unit_id');
select af.apply_tenant_rls('lead_events', 'leads', 'unit_id');
select af.apply_tenant_rls('lead_media', 'leads', 'unit_id');
select af.apply_tenant_rls('site_stats_daily', 'site');

grant select, insert, update on site_versions to app_rw;
grant select, insert on site_media, lead_events, lead_media to app_rw;
grant select, insert on leads to app_rw;
grant update (status, lost_reason, updated_at) on leads to app_rw;
grant select, insert, update on site_stats_daily to app_rw;
grant usage, select on all sequences in schema public to app_rw;
