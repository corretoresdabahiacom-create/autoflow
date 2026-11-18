-- AutoFlow 0012 — Fase 10: direitos do titular (LGPD) e leitura operacional agregada.
select set_config('app.actor', 'platform', true);
insert into permissions (code, description) values ('lgpd:manage','Exportar e anonimizar dados de titulares (LGPD)');
insert into role_permissions (role_id, permission_code)
select r.id, 'lgpd:manage' from roles r where r.tenant_id is null and r.key in ('owner','admin');
select set_config('app.actor', '', true);

alter table customers add column anonymized_at timestamptz;
-- Evidência de atendimento a requisições de titulares (append-only; sem PII: só ids, tipo e contagens).
create table lgpd_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  customer_id uuid not null,
  kind text not null check (kind in ('export','anonymize')),
  reason text check (reason is null or length(reason) between 3 and 300),
  details jsonb not null default '{}',
  requested_by uuid references users(id),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, customer_id) references customers (tenant_id, id)
);
create trigger lgpd_requests_append_only before update or delete on lgpd_requests for each row execute function af.append_only();
select af.apply_tenant_rls('lgpd_requests', 'lgpd');
grant select, insert on lgpd_requests to app_rw;
grant update (name, phone_e164, email, vehicle, plate, description, ip_hash) on leads to app_rw;
grant update (to_phone) on wa_messages to app_rw;
-- Métricas operacionais agregadas (somente contagens): o ator 'platform' lê a fila para o /metrics.
create policy outbox_ops_read on outbox for select using (af.actor() = 'platform');
