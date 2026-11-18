# Checklist de deploy e rollback — AUTOFLOW 2.0

> **Estado:** este checklist foi **ensaiado apenas localmente** (Postgres local, sem staging). Nenhum item de "staging" ou "produção" foi executado. Ver FASE-10-relatorio e KI-086.

## Pré-requisitos (dependem de você / infra)
- [ ] Ambiente de staging e produção provisionados (KI-012: runtime Node vs Workers decidido) — **não existe hoje**
- [ ] Segredos configurados no cofre do provedor: `DATABASE_URL`, `ENCRYPTION_KEY`, `METRICS_TOKEN` (≥24 chars), chaves de e-mail (KI-010), Turnstile (KI-042), WhatsApp (KI-061), gateway (KI-062)
- [ ] Domínio + TLS; `ALLOWED_ORIGINS` apontando só para o domínio real
- [ ] Postgres gerenciado com backup diário **e WAL/PITR** (necessário para RPO < 24h; ver RPO_RTO.md)
- [ ] Prometheus/Alertmanager (ou equivalente) com `ops/alerts.yml`; canal de notificação testado
- [ ] Agendador (cron) para: `/platform/billing/run`, `retryDue`, `processOutbox`, `/platform/automation/run` (KI-024, KI-065, KI-076)
- [ ] Revisão jurídica dos Termos e da Política (docs/legal/) e da retenção (REM-003)

## Sequência de deploy
1. **Congelar** versão (commit/tag). `pnpm -r typecheck && pnpm -r test` verdes.
2. **Backup lógico imediato** (`pg_dump -Fc`) e conferir tamanho/arquivo. Guardar o ID.
3. Subir a **nova versão do código sem tráfego** (ou em instância paralela).
4. Aplicar **migrações** (`packages/db` migrate). São forward-only e idempotentes por checksum; **não editar migrações já aplicadas**.
5. Smoke: `GET /ready` = 200 `{db:"up"}`; `GET /health`; login de um usuário de teste; criar/abrir OS; `GET /metrics` com token.
6. Virar tráfego (gradual se possível). Observar 15 min: taxa 5xx, p95, fila do outbox.
7. Registrar no CHANGELOG/Log de deploy: versão, horário, responsável.

## Critérios para abortar (rollback)
- `/ready` ≠ 200 por > 2 min, ou 5xx > 2% por 5 min, ou falha de migração, ou invariante financeira violada (razão desbalanceado).

## Rollback
Ver `docs/ROLLBACK.md`.

## Execução registrada
| Ambiente | Executado? | Data | Observação |
|---|---|---|---|
| Local (dev) — ensaio de backup→migrar→smoke→restore | Sim (parcial, ver relatório) | 2026-11-18 | Não é staging |
| Staging | **Não** | — | Não existe |
| Produção | **Não** | — | Não existe |
