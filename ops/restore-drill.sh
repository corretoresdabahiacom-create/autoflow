#!/usr/bin/env bash
# Ensaio de restauração: dump (formato custom) -> restore em banco novo -> verificação de invariantes -> RTO medido.
# Uso: SRC_DB=autoflow_test ./ops/restore-drill.sh   (rodar como usuário com acesso ao Postgres; ex.: su postgres)
set -euo pipefail
SRC_DB="${SRC_DB:-autoflow_test}"; DST_DB="${DST_DB:-autoflow_drill}"; OUT="${OUT:-/tmp/autoflow-drill.dump}"
now() { date +%s.%N; }
t0=$(now)
pg_dump -Fc -f "$OUT" "$SRC_DB"; t1=$(now)
dropdb --if-exists "$DST_DB"; createdb "$DST_DB"
# roles do app já existem no cluster (global); em DR real recriar antes com ops/roles.sql
pg_restore -d "$DST_DB" "$OUT" 2>/tmp/restore.err || true; t2=$(now)
q() { psql -tA -d "$1" -c "$2"; }
fail=0
check() { # nome, sql (deve retornar valor igual nos dois bancos)
  local a b; a=$(q "$SRC_DB" "$2"); b=$(q "$DST_DB" "$2")
  if [ "$a" = "$b" ]; then echo "OK   $1 ($a)"; else echo "FAIL $1 src=$a dst=$b"; fail=1; fi; }
check "tabelas"               "select count(*) from information_schema.tables where table_schema in ('public','af')"
check "migrações aplicadas"   "select count(*) from schema_migrations"
check "tenants"               "select count(*) from tenants"
check "lançamentos contábeis" "select count(*) from ledger_entries"
check "checksum do razão"     "select coalesce(md5(string_agg(id::text||amount_cents::text, ',' order by id)),'') from ledger_entries"
check "auditoria"             "select count(*) from audit_log"
unb=$(q "$DST_DB" "select count(*) from (select txn_id from ledger_entries group by txn_id having sum(case side when 'D' then amount_cents else -amount_cents end) <> 0) x")
[ "$unb" = "0" ] && echo "OK   razão balanceado por transação no restaurado" || { echo "FAIL transações desbalanceadas: $unb"; fail=1; }
nrls=$(q "$DST_DB" "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname not in ('sessions','auth_tokens') and c.relname in (select table_name from information_schema.columns where column_name='tenant_id' and table_schema='public') and not (c.relrowsecurity and c.relforcerowsecurity)")
[ "$nrls" = "0" ] && echo "OK   RLS ENABLE+FORCE em todas as tabelas com tenant_id" || { echo "FAIL tabelas sem RLS forçada: $nrls"; fail=1; }
t3=$(now)
printf "dump=%.2fs restore=%.2fs verificacao=%.2fs RTO_tecnico_total=%.2fs dump_bytes=%s\n" "$(echo "$t1-$t0"|bc)" "$(echo "$t2-$t1"|bc)" "$(echo "$t3-$t2"|bc)" "$(echo "$t3-$t0"|bc)" "$(stat -c%s "$OUT")"
dropdb "$DST_DB"; exit $fail
