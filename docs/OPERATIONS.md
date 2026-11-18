# AutoFlow — Operações

## 1. Observabilidade
Logs JSON estruturados (`request_id`, `tenant_id`, rota, status, latência; **sem PII**) · rastreamento de requisição · métricas (erro, latência p95, filas, DLQ, uso por tenant) · alertas (erro 5xx, DLQ>0, falha de backup, fila atrasada, limites de uso) · monitor de integrações · auditoria. Ferramenta de erros: decisão na Fase 1.

## 2. Backups e recuperação
**Objetivos propostos (MVP):** RPO ≤ 24 h · RTO ≤ 8 h.
| Item | Plano |
|---|---|
| Postgres | Backups/PITR do provedor + **dump lógico diário** cifrado para R2 (bucket separado, retenção 30 dias, versionamento) |
| R2 (anexos) | Versionamento/replicação conforme disponível; inventário semanal |
| Config/IaC | Git + secrets documentados (sem valores) |
| **Teste de restauração** | Drill na Fase 10 e **trimestral**; medir RPO/RTO reais; registrar em KNOWN_ISSUES/CHANGELOG |
Validação de suporte: planos gratuitos podem **não** sustentar RPO 24 h sozinhos → dump próprio obrigatório. **Nenhum backup é considerado válido até restaurar com sucesso.**

## 3. Ambientes e deploy
Wrangler + GitHub Actions: PR → CI (lint/tipos/testes/isolamento) → staging automático → produção com aprovação manual. Migrations com `expand/contract`, executadas antes do deploy; rollback documentado. Feature flags para recursos incompletos.

## 4. Incidentes
Severidade P0–P3 (PRD/SECURITY). P0: contenção imediata (kill-switch do tenant/rota), rotação de credenciais, comunicação aos afetados e avaliação de notificação à ANPD (jurídico), post-mortem sem culpa em até 5 dias úteis.

## 5. Metering e limites
Coleta diária via Cron (usuários ativos, unidades, armazenamento, OS, mensagens, uso de integrações). Alertas a 80%/100%. **Excedeu cota:** bloquear criação de novos recursos conforme política do plano e sugerir upgrade; **nunca apagar dados automaticamente**.

## 6. Rotinas (Cron)
Expiração de links/sessões · fim de acesso excepcional · metering · dump diário · limpeza de rascunhos órfãos · lembretes de renovação · alerta de OS atrasadas.

## 7. Custos
Painel interno de custo por tenant (armazenamento, mensagens, transformações) para precificação dos planos.

## Fase 10 — Operação (runbook)
> Procedimentos escritos e, quando indicado, ensaiados localmente. Nenhum foi exercitado em produção (não existe).

### Endpoints operacionais
- `GET /health` (vivo) · `GET /ready` (200 com banco acessível; 503 se não) · `GET /metrics` (Bearer `METRICS_TOKEN`; sem token configurado responde 404).
- Log de acesso estruturado (JSON, sem PII: rota por padrão, status, duração, requestId). Cabeçalhos de segurança em todas as respostas.

### API fora
1. `/ready`: se `db:"down"`, checar Postgres/conexões (`autoflow_db_pool_*`). 2. Se `/health` falha, reiniciar o processo e ver logs por `requestId`. 3. Se persistir após deploy, seguir `ROLLBACK.md`.

### Erros 5xx
Filtrar o log de acesso por `status>=500`, agrupar por `route`; correlacionar com o último deploy; rollback se começou após ele.

### Outbox
`autoflow_outbox_pending/failed/oldest_pending_seconds`. Parado = o processador não está agendado (KI-024) ou o provedor externo falhou. Reprocessar com o job; falhas permanentes ficam visíveis para o Super Admin (policy `outbox_ops_read`).

### Direitos do titular (LGPD)
Atendimento pelo dono da oficina com permissão `lgpd:manage`: `GET /customers/:id/export` e `POST /customers/:id/anonymize` (exige motivo; evidência append-only em `lgpd_requests`). Registros fiscais/financeiros com obrigação de retenção são **mantidos** (ver LEGAL_RETENTION.md); só dados pessoais de contato/cadastro são anonimizados. Prazo legal de resposta: acompanhar manualmente.

### Backup e restauração
`ops/restore-drill.sh` (ver RPO_RTO.md). Backup automatizado: **não implantado**.

### Alertas
`ops/alerts.yml` (não ativo). Painéis: **não criados** (KI-089).
