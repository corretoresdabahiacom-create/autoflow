-- AutoFlow 0010 — Fase 8: conexões por tenant (segredo cifrado), webhooks (event_id único + DLQ), cobranças online, WhatsApp, Web Push e billing de assinaturas.
select set_config('app.actor', 'platform', true);
insert into permissions (code, description) values
  ('integrations:manage','Conectar, rotacionar e desconectar integrações (WhatsApp, pagamentos)'),
  ('billing:manage','Ver e gerenciar a assinatura do AutoFlow (plano, cancelamento, faturas)');
insert into role_permissions (role_id, permission_code)
select r.id, p.code from roles r cross join permissions p
where r.tenant_id is null and r.key in ('owner','admin') and p.code = 'integrations:manage';
insert into role_permissions (role_id, permission_code)
select r.id, p.code from roles r cross join permissions p
where r.tenant_id is null and r.key = 'owner' and p.code = 'billing:manage';
select set_config('app.actor', '', true);

-- ===== Conexões por tenant: o segredo NUNCA fica em texto claro =====
create table integration_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  kind text not null check (kind in ('whatsapp','payments')),
  provider text not null check (provider ~ '^[a-z_]{3,30}$'),
  status text not null default 'connected' check (status in ('connected','disconnected')),
  secret_enc text,
  secret_hint text,
  secret_version int not null default 1,
  config jsonb not null default '{}'::jsonb,
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check ((status = 'connected' and secret_enc is not null) or (status = 'disconnected' and secret_enc is null))
);
create unique index integration_one_connected on integration_connections (tenant_id, kind) where status = 'connected';
create index integration_wa_phone on integration_connections ((config->>'phone_number_id')) where kind = 'whatsapp' and status = 'connected';

-- Resolve o tenant dono de um número do WhatsApp para o processamento de webhooks (único acesso cruzado; devolve só o id).
create function af.wa_tenant_for_phone(p_phone_number_id text) returns uuid language sql stable security definer set search_path = public, pg_temp as $$
  select tenant_id from integration_connections where kind = 'whatsapp' and status = 'connected' and config->>'phone_number_id' = p_phone_number_id limit 1
$$;
-- Só o dono da função (SECURITY DEFINER => current_user = app_owner) enxerga conexões ativas de WhatsApp fora do contexto de tenant; app_rw não.
revoke all on function af.wa_tenant_for_phone(text) from public;
grant execute on function af.wa_tenant_for_phone(text) to app_rw;

-- ===== Webhooks recebidos (plataforma): replay não duplica efeito; DLQ = status 'dead' =====
create table webhook_events (
  id bigint generated always as identity primary key,
  provider text not null,
  event_id text not null check (length(event_id) between 1 and 200),
  event_type text not null,
  tenant_id uuid,
  payload jsonb not null,
  status text not null default 'received' check (status in ('received','processed','failed','dead','ignored')),
  attempts int not null default 0,
  last_error text,
  received_at timestamptz not null default now(),
  next_attempt_at timestamptz,
  processed_at timestamptz,
  unique (provider, event_id)
);
create index webhook_events_pending on webhook_events (status, next_attempt_at) where status in ('received','failed','dead');
alter table webhook_events enable row level security; alter table webhook_events force row level security;
create policy wh_all on webhook_events for all using (af.actor() in ('platform','system')) with check (af.actor() in ('platform','system'));

-- ===== Cobranças online de parcelas =====
create table payment_charges (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  installment_id uuid not null,
  wallet_id uuid not null,
  provider text not null,
  provider_charge_id text not null,
  method text not null check (method in ('pix','boleto','card')),
  amount_cents bigint not null check (amount_cents > 0),
  principal_cents bigint not null check (principal_cents > 0),
  quoted_on date not null,
  status text not null default 'pending' check (status in ('pending','paid','failed')),
  checkout_url text,
  paid_at timestamptz,
  settlement_id uuid,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (provider, provider_charge_id),
  foreign key (tenant_id, unit_id) references units (tenant_id, id),
  foreign key (tenant_id, installment_id) references fin_installments (tenant_id, id),
  foreign key (tenant_id, wallet_id) references fin_wallets (tenant_id, id)
);
create unique index one_pending_charge_per_installment on payment_charges (tenant_id, installment_id) where status = 'pending';

-- ===== WhatsApp: log de mensagens (sem corpo livre de cliente) =====
create table wa_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  customer_id uuid,
  direction text not null check (direction in ('out','in')),
  category text check (category in ('utility','marketing','authentication')),
  template text check (template is null or (template ~ '^[a-z0-9_]+$' and length(template) <= 512)),
  to_phone text,
  provider_message_id text,
  status text not null default 'queued' check (status in ('queued','sent','delivered','read','failed','received')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, customer_id) references customers (tenant_id, id)
);
create index wa_messages_pid on wa_messages (provider_message_id) where provider_message_id is not null;

-- ===== Web Push =====
create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null references users(id),
  endpoint text not null check (endpoint ~ '^https://' and length(endpoint) <= 1000),
  p256dh text not null check (length(p256dh) <= 200),
  auth text not null check (length(auth) <= 100),
  created_at timestamptz not null default now(),
  unique (tenant_id, endpoint)
);

-- ===== Billing de assinaturas =====
alter table subscriptions add column grace_until timestamptz, add column cancel_at_period_end boolean not null default false, add column pending_plan_id uuid references plans(id);
create table subscription_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  kind text not null check (kind in ('renewal','upgrade')),
  plan_id uuid not null references plans(id),
  period_start date not null,
  period_end date not null,
  amount_cents integer not null check (amount_cents >= 0),
  status text not null default 'open' check (status in ('open','paid','void')),
  due_date timestamptz not null,
  paid_at timestamptz,
  provider text,
  provider_charge_id text,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, kind, period_start)
);
alter table subscription_invoices enable row level security; alter table subscription_invoices force row level security;
create policy inv_select on subscription_invoices for select using (af.actor() in ('platform','system') or (tenant_id = af.tenant_id() and af.actor() = 'tenant'));
create policy inv_write on subscription_invoices for all using (af.actor() = 'platform') with check (af.actor() = 'platform');

select af.apply_tenant_rls('integration_connections', 'integrations');
create policy wa_lookup_by_definer on integration_connections for select using (current_user = 'app_owner' and kind = 'whatsapp' and status = 'connected');
select af.apply_tenant_rls('payment_charges', 'finance', 'unit_id');
select af.apply_tenant_rls('wa_messages', 'crm');
select af.apply_tenant_rls('push_subscriptions', 'integrations');

grant select, insert on integration_connections, payment_charges, wa_messages, push_subscriptions to app_rw;
grant update (status, secret_enc, secret_hint, secret_version, config, disconnected_at, updated_at, connected_at) on integration_connections to app_rw;
grant update (status, paid_at, settlement_id) on payment_charges to app_rw;
grant update (status, provider_message_id, error, updated_at) on wa_messages to app_rw;
grant update (user_id, p256dh, auth) on push_subscriptions to app_rw;
grant delete on push_subscriptions to app_rw;
grant select, insert, update on webhook_events to app_rw;
grant select, insert, update on subscription_invoices to app_rw;
grant update (grace_until, cancel_at_period_end, pending_plan_id, status, plan_id, current_period_end, trial_ends_at) on subscriptions to app_rw;
grant usage, select on all sequences in schema public to app_rw;
