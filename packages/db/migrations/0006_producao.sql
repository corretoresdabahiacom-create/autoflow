-- AutoFlow 0006 — Fase 4: produção (etapas, boxes, tarefas, tempo apontado) e agenda básica.
create extension if not exists btree_gist;

select set_config('app.actor', 'platform', true);
insert into permissions (code, description) values
  ('production:read','Ver produção (Kanban/tarefas)'),
  ('production:manage','Configurar etapas/boxes, criar e atribuir tarefas, mudar etapa da OS'),
  ('production:work','Operar as próprias tarefas (iniciar, pausar, concluir)'),
  ('schedule:read','Ver agenda'),
  ('schedule:manage','Criar, reagendar e cancelar agendamentos');
insert into role_permissions (role_id, permission_code)
select r.id, p.code from roles r cross join permissions p
where r.tenant_id is null and r.key in ('owner','admin','manager')
  and p.code in ('production:read','production:manage','production:work','schedule:read','schedule:manage');
insert into role_permissions (role_id, permission_code)
select r.id, p.code from roles r cross join permissions p
where r.tenant_id is null and r.key = 'attendant' and p.code in ('production:read','schedule:read','schedule:manage');
insert into role_permissions (role_id, permission_code)
select r.id, p.code from roles r cross join permissions p
where r.tenant_id is null and r.key in ('mechanic','bodyworker','painter','aligner')
  and p.code in ('production:read','production:work','schedule:read');
select set_config('app.actor', '', true);

-- Etapas configuráveis: unit_id nulo = vale para todas as unidades do tenant.
create table production_stages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  unit_id uuid,
  name text not null check (length(name) between 2 and 60),
  position int not null check (position between 0 and 999),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, unit_id) references units (tenant_id, id)
);
create unique index production_stage_name on production_stages (tenant_id, coalesce(unit_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name)) where active;

alter table service_orders add column stage_id uuid;
alter table service_orders add constraint so_stage_fk foreign key (tenant_id, stage_id) references production_stages (tenant_id, id);
grant update (stage_id) on service_orders to app_rw;

create table os_stage_history (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  unit_id uuid not null,
  os_id uuid not null,
  from_stage_id uuid,
  to_stage_id uuid not null,
  changed_by uuid references users(id),
  at timestamptz not null default now(),
  foreign key (tenant_id, os_id, unit_id) references service_orders (tenant_id, id, unit_id),
  foreign key (tenant_id, to_stage_id) references production_stages (tenant_id, id)
);
create trigger os_stage_history_append_only before update or delete on os_stage_history for each row execute function af.append_only();

create table boxes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  name text not null check (length(name) between 1 and 60),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, unit_id, name),
  foreign key (tenant_id, unit_id) references units (tenant_id, id)
);

-- Funcionário = membership; custo/hora prepara a mão de obra da Fase 5 (centavos).
create table employee_rates (
  tenant_id uuid not null references tenants(id),
  membership_id uuid not null,
  hourly_cost_cents bigint not null check (hourly_cost_cents >= 0),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, membership_id),
  foreign key (tenant_id, membership_id) references memberships (tenant_id, id)
);

create table production_tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  os_id uuid not null,
  title text not null check (length(title) between 2 and 120),
  stage_id uuid,
  assignee_membership_id uuid,
  box_id uuid,
  planned_start timestamptz,
  planned_end timestamptz,
  due_at timestamptz,
  status text not null default 'todo' check (status in ('todo','in_progress','paused','done','cancelled')),
  started_at timestamptz,
  done_at timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (box_id is null or (planned_start is not null and planned_end is not null)),
  check (planned_end is null or planned_start is null or planned_end > planned_start),
  foreign key (tenant_id, os_id, unit_id) references service_orders (tenant_id, id, unit_id),
  foreign key (tenant_id, stage_id) references production_stages (tenant_id, id),
  foreign key (tenant_id, assignee_membership_id) references memberships (tenant_id, id),
  foreign key (tenant_id, box_id) references boxes (tenant_id, id),
  -- Um box não recebe duas tarefas ativas sobrepostas.
  constraint task_box_no_overlap exclude using gist (
    tenant_id with =, box_id with =, tstzrange(planned_start, planned_end) with &&
  ) where (box_id is not null and status in ('todo','in_progress','paused'))
);
create index task_os_idx on production_tasks (tenant_id, os_id);
create index task_assignee_idx on production_tasks (tenant_id, assignee_membership_id, status);

-- Tempo apontado: exatamente uma entrada aberta por tarefa; pausa exige motivo.
create table task_time_entries (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  unit_id uuid not null,
  task_id uuid not null,
  kind text not null check (kind in ('work','pause')),
  reason text,
  membership_id uuid,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  check (kind <> 'pause' or length(btrim(coalesce(reason,''))) >= 3),
  check (ended_at is null or ended_at >= started_at),
  foreign key (tenant_id, task_id) references production_tasks (tenant_id, id),
  foreign key (tenant_id, unit_id) references units (tenant_id, id)
);
create unique index task_one_open_entry on task_time_entries (task_id) where ended_at is null;

alter table attachments add column task_id uuid;
alter table attachments add constraint att_task_fk foreign key (tenant_id, task_id) references production_tasks (tenant_id, id);

-- Agenda básica
create table appointments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  unit_id uuid not null,
  box_id uuid,
  membership_id uuid,
  customer_id uuid,
  vehicle_id uuid,
  title text not null check (length(title) between 2 and 120),
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  status text not null default 'scheduled' check (status in ('scheduled','cancelled','done')),
  cancel_reason text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (status <> 'cancelled' or length(btrim(coalesce(cancel_reason,''))) >= 3),
  foreign key (tenant_id, unit_id) references units (tenant_id, id),
  foreign key (tenant_id, box_id) references boxes (tenant_id, id),
  foreign key (tenant_id, membership_id) references memberships (tenant_id, id),
  foreign key (tenant_id, customer_id) references customers (tenant_id, id),
  foreign key (tenant_id, vehicle_id) references vehicles (tenant_id, id),
  constraint appt_box_no_overlap exclude using gist (
    tenant_id with =, box_id with =, tstzrange(starts_at, ends_at) with &&
  ) where (box_id is not null and status = 'scheduled')
);
create index appt_range_idx on appointments (tenant_id, unit_id, starts_at);

select af.apply_tenant_rls('production_stages', 'orders');
select af.apply_tenant_rls('os_stage_history', 'orders', 'unit_id');
select af.apply_tenant_rls('boxes', 'orders', 'unit_id');
select af.apply_tenant_rls('employee_rates', 'members');
select af.apply_tenant_rls('production_tasks', 'orders', 'unit_id');
select af.apply_tenant_rls('task_time_entries', 'orders', 'unit_id');
select af.apply_tenant_rls('appointments', 'orders', 'unit_id');

grant select, insert, update on production_stages, boxes, employee_rates, production_tasks, appointments to app_rw;
grant select, insert on os_stage_history, task_time_entries to app_rw;
grant update (ended_at) on task_time_entries to app_rw;
grant usage, select on all sequences in schema public to app_rw;
