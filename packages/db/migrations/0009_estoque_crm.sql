-- AutoFlow 0009 — Fase 7: estoque (movimentos append-only, saldo derivado por trigger, custo médio móvel), compras, CRM completo e fidelização.
select set_config('app.actor', 'platform', true);
insert into permissions (code, description) values
  ('stock:read','Ver estoque, itens, fornecedores e compras'),
  ('stock:manage','Cadastrar itens/fornecedores, comprar, inventariar e ajustar'),
  ('stock:consume','Reservar, consumir e devolver peças em OS'),
  ('crm:read','Ver CRM, cupons, pontos, lembretes e métricas'),
  ('crm:manage','Converter leads, cupons, pontos, indicações, lembretes e satisfação'),
  ('campaigns:manage','Criar e disparar campanhas (somente com consentimento)');
insert into role_permissions (role_id, permission_code)
select r.id, p.code from roles r cross join permissions p
where r.tenant_id is null and r.key in ('owner','admin','manager','stockkeeper') and p.code in ('stock:read','stock:manage','stock:consume');
insert into role_permissions (role_id, permission_code)
select r.id, p.code from roles r cross join permissions p
where r.tenant_id is null and r.key in ('owner','admin','manager','attendant') and p.code in ('crm:read','crm:manage');
insert into role_permissions (role_id, permission_code)
select r.id, p.code from roles r cross join permissions p
where r.tenant_id is null and r.key in ('owner','admin','manager') and p.code = 'campaigns:manage';
select set_config('app.actor', '', true);

alter table ledger_txns drop constraint ledger_txns_kind_check;
alter table ledger_txns add constraint ledger_txns_kind_check check (kind in ('opening','invoice','receipt','payable','payment','transfer','reversal','stock'));

-- ===== Catálogo =====
create table suppliers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null check (length(name) between 2 and 120),
  doc text check (doc is null or length(doc) <= 20),
  phone text check (phone is null or length(phone) <= 30),
  email text check (email is null or length(email) <= 120),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);
create table stock_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  sku text not null check (sku ~ '^[A-Za-z0-9._-]{1,30}$'),
  name text not null check (length(name) between 2 and 120),
  category text not null check (category in ('part','paint','varnish','material','other')),
  uom text not null check (uom in ('un','l','ml','kg','g','m')),
  barcode text check (barcode is null or barcode ~ '^[0-9A-Za-z-]{4,32}$'),
  min_qty_milli bigint not null default 0 check (min_qty_milli >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, sku)
);
create unique index stock_items_barcode on stock_items (tenant_id, barcode) where barcode is not null;

-- ===== Movimentos (append-only) e saldo derivado =====
create table purchases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  supplier_id uuid,
  invoice_no text check (invoice_no is null or length(invoice_no) <= 40),
  total_cents bigint not null check (total_cents >= 0),
  txn_id uuid,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, unit_id) references units (tenant_id, id),
  foreign key (tenant_id, supplier_id) references suppliers (tenant_id, id)
);
create table purchase_items (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  purchase_id uuid not null,
  item_id uuid not null,
  qty_milli bigint not null check (qty_milli > 0),
  line_total_cents bigint not null check (line_total_cents >= 0),
  foreign key (tenant_id, purchase_id) references purchases (tenant_id, id),
  foreign key (tenant_id, item_id) references stock_items (tenant_id, id)
);

create table stock_movements (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  unit_id uuid not null,
  item_id uuid not null,
  kind text not null check (kind in ('purchase','consume','return','adjust_in','adjust_out','reserve','release')),
  qty_milli bigint not null check (qty_milli > 0),
  on_hand_delta bigint not null,
  reserved_delta bigint not null default 0,
  value_delta_cents bigint not null default 0,
  os_id uuid,
  purchase_id uuid,
  ref_movement_id bigint,
  reason text check (reason is null or length(reason) <= 200),
  txn_id uuid,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, unit_id) references units (tenant_id, id),
  foreign key (tenant_id, item_id) references stock_items (tenant_id, id),
  foreign key (tenant_id, os_id) references service_orders (tenant_id, id),
  foreign key (tenant_id, purchase_id) references purchases (tenant_id, id),
  foreign key (tenant_id, ref_movement_id) references stock_movements (tenant_id, id),
  check (case kind
    when 'purchase'   then on_hand_delta = qty_milli and reserved_delta = 0 and value_delta_cents >= 0 and purchase_id is not null
    when 'consume'    then on_hand_delta = -qty_milli and reserved_delta between -qty_milli and 0 and value_delta_cents <= 0 and os_id is not null
    when 'return'     then on_hand_delta = qty_milli and reserved_delta = 0 and value_delta_cents >= 0 and os_id is not null and ref_movement_id is not null
    when 'adjust_in'  then on_hand_delta = qty_milli and reserved_delta = 0 and value_delta_cents >= 0 and length(btrim(coalesce(reason,''))) >= 3
    when 'adjust_out' then on_hand_delta = -qty_milli and reserved_delta = 0 and value_delta_cents <= 0 and length(btrim(coalesce(reason,''))) >= 3
    when 'reserve'    then on_hand_delta = 0 and reserved_delta = qty_milli and value_delta_cents = 0 and os_id is not null
    when 'release'    then on_hand_delta = 0 and reserved_delta = -qty_milli and value_delta_cents = 0 and os_id is not null
  end)
);
create index stock_mov_item on stock_movements (tenant_id, unit_id, item_id, id);
create index stock_mov_os on stock_movements (tenant_id, os_id) where os_id is not null;
create trigger stock_movements_append_only before update or delete on stock_movements for each row execute function af.append_only();
create trigger purchases_append_only before update or delete on purchases for each row execute function af.append_only();
create trigger purchase_items_append_only before update or delete on purchase_items for each row execute function af.append_only();

-- Saldo por unidade+item. SOMENTE o trigger altera (app_rw só lê): saldo é derivado dos movimentos e serializado pelo lock da linha.
create table stock_levels (
  tenant_id uuid not null,
  unit_id uuid not null,
  item_id uuid not null,
  on_hand_milli bigint not null default 0 check (on_hand_milli >= 0),
  reserved_milli bigint not null default 0 check (reserved_milli >= 0),
  value_cents bigint not null default 0 check (value_cents >= 0),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, unit_id, item_id),
  foreign key (tenant_id, unit_id) references units (tenant_id, id),
  foreign key (tenant_id, item_id) references stock_items (tenant_id, id),
  check (reserved_milli <= on_hand_milli),
  check (on_hand_milli > 0 or value_cents = 0)
);
create function af.stock_apply() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- UPDATE primeiro (os CHECKs avaliam o saldo resultante, não o delta); INSERT só na 1ª movimentação; corrida no INSERT => repete o UPDATE.
  loop
    update stock_levels set on_hand_milli = on_hand_milli + new.on_hand_delta, reserved_milli = reserved_milli + new.reserved_delta,
           value_cents = value_cents + new.value_delta_cents, updated_at = now()
     where tenant_id = new.tenant_id and unit_id = new.unit_id and item_id = new.item_id;
    if found then return new; end if;
    begin
      insert into stock_levels (tenant_id, unit_id, item_id, on_hand_milli, reserved_milli, value_cents)
      values (new.tenant_id, new.unit_id, new.item_id, new.on_hand_delta, new.reserved_delta, new.value_delta_cents);
      return new;
    exception when unique_violation then null;
    end;
  end loop;
end $$;
create trigger stock_movements_apply after insert on stock_movements for each row execute function af.stock_apply();

-- ===== CRM =====
alter table lead_events drop constraint lead_events_kind_check;
alter table lead_events add constraint lead_events_kind_check check (kind in ('created','status','note','converted'));
alter table leads add column converted_customer_id uuid, add column converted_order_id uuid, add column converted_at timestamptz, add column scheduled_for timestamptz;
alter table leads add foreign key (tenant_id, converted_customer_id) references customers (tenant_id, id);
alter table leads add foreign key (tenant_id, converted_order_id) references service_orders (tenant_id, id);

-- Consentimento de marketing: cada mudança é registrada (append-only) por trigger, inclusive opt-out.
create table marketing_consent_log (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  customer_id uuid not null,
  action text not null check (action in ('grant','revoke')),
  source text not null default 'staff',
  actor_id uuid,
  at timestamptz not null default now(),
  foreign key (tenant_id, customer_id) references customers (tenant_id, id)
);
create index mcl_customer on marketing_consent_log (tenant_id, customer_id, id);
create trigger mcl_append_only before update or delete on marketing_consent_log for each row execute function af.append_only();
create function af.log_marketing_consent() returns trigger language plpgsql as $$
declare src text := coalesce(nullif(current_setting('app.consent_source', true), ''), 'staff');
begin
  if tg_op = 'INSERT' then
    if new.marketing_opt_in then insert into marketing_consent_log (tenant_id, customer_id, action, source, actor_id) values (new.tenant_id, new.id, 'grant', src, nullif(current_setting('app.user_id', true), '')::uuid); end if;
  elsif new.marketing_opt_in is distinct from old.marketing_opt_in then
    insert into marketing_consent_log (tenant_id, customer_id, action, source, actor_id) values (new.tenant_id, new.id, case when new.marketing_opt_in then 'grant' else 'revoke' end, src, nullif(current_setting('app.user_id', true), '')::uuid);
  end if;
  return new;
end $$;
create trigger customers_consent_log after insert or update of marketing_opt_in on customers for each row execute function af.log_marketing_consent();

create table coupons (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  code text not null check (code ~ '^[A-Z0-9_-]{3,20}$'),
  kind text not null check (kind in ('percent','fixed')),
  value int not null check (value > 0),
  min_total_cents bigint not null default 0 check (min_total_cents >= 0),
  valid_from date, valid_until date,
  max_uses int check (max_uses is null or max_uses > 0),
  customer_id uuid,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id), unique (tenant_id, code),
  check (kind <> 'percent' or value <= 100),
  check (valid_until is null or valid_from is null or valid_until >= valid_from),
  foreign key (tenant_id, customer_id) references customers (tenant_id, id)
);
create table coupon_redemptions (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  coupon_id uuid not null,
  os_id uuid not null,
  customer_id uuid not null,
  discount_cents bigint not null check (discount_cents >= 0),
  created_at timestamptz not null default now(),
  unique (coupon_id, os_id),
  foreign key (tenant_id, coupon_id) references coupons (tenant_id, id),
  foreign key (tenant_id, os_id) references service_orders (tenant_id, id),
  foreign key (tenant_id, customer_id) references customers (tenant_id, id)
);
create trigger coupon_redemptions_append_only before update or delete on coupon_redemptions for each row execute function af.append_only();

create table loyalty_settings (
  tenant_id uuid primary key references tenants(id),
  points_per_real int not null default 1 check (points_per_real between 0 and 100),
  referral_bonus_points int not null default 100 check (referral_bonus_points between 0 and 100000)
);
create table loyalty_ledger (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  customer_id uuid not null,
  points int not null check (points <> 0),
  reason text not null check (reason in ('earn','redeem','referral','adjust')),
  os_id uuid,
  note text check (note is null or length(note) <= 200),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, customer_id) references customers (tenant_id, id),
  foreign key (tenant_id, os_id) references service_orders (tenant_id, id),
  check ((reason in ('earn','referral') and points > 0) or (reason = 'redeem' and points < 0) or reason = 'adjust')
);
create unique index loyalty_one_earn_per_os on loyalty_ledger (tenant_id, os_id) where reason = 'earn';
create index loyalty_customer on loyalty_ledger (tenant_id, customer_id);
create trigger loyalty_append_only before update or delete on loyalty_ledger for each row execute function af.append_only();

create table referrals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  referrer_customer_id uuid not null,
  referred_customer_id uuid not null,
  status text not null default 'pending' check (status in ('pending','rewarded')),
  rewarded_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, referred_customer_id),
  check (referrer_customer_id <> referred_customer_id),
  foreign key (tenant_id, referrer_customer_id) references customers (tenant_id, id),
  foreign key (tenant_id, referred_customer_id) references customers (tenant_id, id)
);

create table service_reminders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  customer_id uuid not null,
  vehicle_id uuid not null,
  kind text not null check (kind in ('oil','revision','alignment','other')),
  due_date date not null,
  source_os_id uuid,
  status text not null default 'pending' check (status in ('pending','queued','done','cancelled')),
  created_at timestamptz not null default now(),
  unique (tenant_id, vehicle_id, kind, due_date),
  foreign key (tenant_id, customer_id) references customers (tenant_id, id),
  foreign key (tenant_id, vehicle_id) references vehicles (tenant_id, id),
  foreign key (tenant_id, source_os_id) references service_orders (tenant_id, id)
);

create table campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null check (length(name) between 2 and 80),
  kind text not null check (kind in ('inactive','quote_recovery','reminders','custom')),
  params jsonb not null default '{}'::jsonb,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create table campaign_recipients (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  campaign_id uuid not null,
  customer_id uuid not null,
  status text not null check (status in ('queued','skipped')),
  reason text,
  created_at timestamptz not null default now(),
  unique (campaign_id, customer_id),
  foreign key (tenant_id, campaign_id) references campaigns (tenant_id, id),
  foreign key (tenant_id, customer_id) references customers (tenant_id, id)
);

create table satisfaction_surveys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  os_id uuid not null,
  customer_id uuid not null,
  score int not null check (score between 0 and 10),
  comment text check (comment is null or length(comment) <= 500),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, os_id),
  foreign key (tenant_id, os_id, unit_id) references service_orders (tenant_id, id, unit_id),
  foreign key (tenant_id, customer_id) references customers (tenant_id, id)
);
create trigger satisfaction_append_only before update or delete on satisfaction_surveys for each row execute function af.append_only();

-- ===== RLS =====
select af.apply_tenant_rls('suppliers', 'stock');
select af.apply_tenant_rls('stock_items', 'stock');
select af.apply_tenant_rls('purchases', 'stock', 'unit_id');
select af.apply_tenant_rls('purchase_items', 'stock');
select af.apply_tenant_rls('stock_movements', 'stock', 'unit_id');
select af.apply_tenant_rls('stock_levels', 'stock', 'unit_id');
select af.apply_tenant_rls('marketing_consent_log', 'crm');
select af.apply_tenant_rls('coupons', 'crm');
select af.apply_tenant_rls('coupon_redemptions', 'crm');
select af.apply_tenant_rls('loyalty_settings', 'crm');
select af.apply_tenant_rls('loyalty_ledger', 'crm');
select af.apply_tenant_rls('referrals', 'crm');
select af.apply_tenant_rls('service_reminders', 'crm');
select af.apply_tenant_rls('campaigns', 'crm');
select af.apply_tenant_rls('campaign_recipients', 'crm');
select af.apply_tenant_rls('satisfaction_surveys', 'crm', 'unit_id');

grant select, insert on suppliers, stock_items to app_rw;
grant update (name, doc, phone, email, active) on suppliers to app_rw;
grant update (name, category, barcode, min_qty_milli, active) on stock_items to app_rw;
grant select, insert on purchases, purchase_items, stock_movements to app_rw;
grant select on stock_levels to app_rw;
grant update (updated_at) on stock_levels to app_rw; -- necessário para SELECT ... FOR UPDATE (serialização); saldo só muda via trigger
grant select, insert on marketing_consent_log, coupons, coupon_redemptions, loyalty_ledger, referrals, service_reminders, campaigns, campaign_recipients, satisfaction_surveys to app_rw;
grant update (active) on coupons to app_rw;
grant update (status, rewarded_at) on referrals to app_rw;
grant update (status) on service_reminders to app_rw;
grant update (status, reason) on campaign_recipients to app_rw;
grant select, insert, update on loyalty_settings to app_rw;
grant update (converted_customer_id, converted_order_id, converted_at, scheduled_for) on leads to app_rw;
grant usage, select on all sequences in schema public to app_rw;
