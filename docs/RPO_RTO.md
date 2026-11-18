# RPO / RTO

Metas do produto: **RPO 24 h, RTO 8 h** (FASE-10, critério 2).

## Medido (ensaio local, 2026-11-18, `ops/restore-drill.sh`)
- Banco: 112 tabelas, 12 migrações, ~650 KB (dados de teste, 2 tenants).
- `pg_dump -Fc` 0,15 s · `pg_restore` 1,14 s · verificação 0,46 s · **total 1,76 s**.
- Verificações aprovadas no restaurado: mesmas contagens (tabelas, migrações, tenants, razão, auditoria), checksum idêntico do razão, razão balanceado por transação, RLS ENABLE+FORCE em todas as tabelas com `tenant_id` (exceto `sessions`/`auth_tokens`, exceção documentada).

## O que isso NÃO prova
- Volume real: o tempo cresce com o tamanho; **não há medição** com dados de produção nem em infraestrutura gerenciada (rede, disco, instância).
- RTO de 8 h inclui detecção, decisão, provisionar instância, restaurar, trocar `DATABASE_URL`, validar e comunicar — só a parte "restaurar+validar" foi medida.
- **RPO**: é uma **afirmação de projeto**, não medida. Com backup lógico diário, RPO = até 24 h (no limite da meta, sem folga). Para RPO menor é preciso WAL/PITR no Postgres gerenciado (KI-090). Nenhum backup automatizado existe hoje.

## Ações para validar de verdade (precisam de infra)
1. Backup diário automatizado + retenção (30 dias sugeridos) + cópia em região/conta distinta.
2. Habilitar PITR; medir RPO (diferença entre falha simulada e último dado restaurado).
3. Repetir o drill trimestralmente com cópia de produção anonimizada, cronometrando ponta a ponta.
