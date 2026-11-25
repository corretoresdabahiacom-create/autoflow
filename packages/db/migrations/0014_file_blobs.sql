-- Fase 11: armazenamento de arquivos no Postgres (alternativa gratuita e sem cartão ao R2/S3 para staging e pequenas bases).
-- Acesso SOMENTE pelo ator 'system' via PgStorage (a rota de download é autenticada por URL assinada, sem sessão de tenant).
-- A chave sempre começa com "<tenant_id>/", garantido por CHECK. Limite prático: o armazenamento do plano do Postgres (Neon free = 1 GB).
create table file_blobs (
  key text primary key check (length(key) between 40 and 300),
  tenant_id uuid not null references tenants(id),
  bytes bytea not null check (octet_length(bytes) <= 10485760),
  created_at timestamptz not null default now(),
  check (position(tenant_id::text || '/' in key) = 1)
);
create index file_blobs_tenant_idx on file_blobs (tenant_id);
alter table file_blobs enable row level security;
alter table file_blobs force row level security;
create policy blobs_select on file_blobs for select using (af.actor() = 'system');
create policy blobs_insert on file_blobs for insert with check (af.actor() = 'system');
create policy blobs_delete on file_blobs for delete using (af.actor() = 'system');
grant select, insert, delete on file_blobs to app_rw;
