-- Fase 11: fila de requisições de titulares (LGPD art. 18/19) com prazo de resposta.
-- Sem PII: só referência ao cliente (opcional) e uma nota curta orientada a não conter dados pessoais.
create table lgpd_tickets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  customer_id uuid,
  kind text not null check (kind in ('access','correction','anonymization','portability','sharing_info','consent_revocation')),
  channel text not null default 'other' check (channel in ('email','phone','in_person','portal','other')),
  received_at timestamptz not null default now(),
  due_at timestamptz not null,
  status text not null default 'open' check (status in ('open','done','rejected')),
  closed_at timestamptz,
  closed_by uuid references users(id),
  resolution text check (resolution is null or length(resolution) between 3 and 300),
  created_by uuid references users(id),
  foreign key (tenant_id, customer_id) references customers (tenant_id, id),
  check ((status = 'open') = (closed_at is null))
);
create index lgpd_tickets_open_idx on lgpd_tickets (tenant_id, due_at) where status = 'open';
select af.apply_tenant_rls('lgpd_tickets', 'lgpd');
grant select, insert on lgpd_tickets to app_rw;
grant update (status, closed_at, closed_by, resolution) on lgpd_tickets to app_rw;
