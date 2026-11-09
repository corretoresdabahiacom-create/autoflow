# ADR-0001 — Banco de dados: PostgreSQL vs Cloudflare D1

Status: **PROPOSTO — requer aprovação** · Impacto: custo, segurança, arquitetura

## Contexto
SaaS multi-tenant com financeiro append-only, aprovações juridicamente sensíveis, relatórios (DRE, fluxo de caixa) e crescimento esperado. D1 e PostgreSQL **não** são intercambiáveis.

## Comparação
| Critério | PostgreSQL (gerenciado, ex.: Neon/Supabase) via Hyperdrive | Cloudflare D1 (SQLite) |
|---|---|---|
| Integridade relacional / constraints | Completa: FKs, CHECK, UNIQUE parciais, EXCLUDE, tipos numeric/uuid/timestamptz, triggers | FKs e CHECK existem; sem EXCLUDE, tipos limitados, `numeric` inexistente (dinheiro = inteiro em centavos) |
| Transações | Multi-statement interativas, níveis de isolamento, `SELECT … FOR UPDATE` | Sem transações interativas através do Worker; apenas `batch()` atômico. Difícil garantir saldos/numeração sob concorrência |
| Isolamento multi-tenant | **RLS nativa** + `tenant_id` + roles; defesa em profundidade | Sem RLS: só filtro no código; um esquecimento = vazamento P0 |
| Append-only do ledger | Triggers/REVOKE UPDATE/DELETE no role da aplicação | Só por convenção/trigger SQLite; sem separação de roles |
| Concorrência | MVCC, múltiplas conexões | Escritor único por banco; limites de tamanho por DB |
| Relatórios | Window functions, CTEs, materialized views, `generate_series`, JSONB | Suficiente para básico; evolução mais limitada |
| Backups / PITR | PITR e branching nos provedores (retenção do plano grátis é curta — **validar no provedor**) | Time Travel (PITR de ~30 dias) e exportações; pouco controle de restauração para staging |
| Custo inicial | Plano grátis existe, com limites de armazenamento, compute e suspensão por inatividade (**validar valores vigentes antes de contratar**) | Plano grátis generoso e integrado ao Workers |
| Latência | Worker→Postgres via Hyperdrive (pooling + cache); latência regional adicional | Colocalizado ao Worker, baixa |
| Complexidade operacional | Um serviço extra, secrets, pooling | Menor |
| Migração futura | Padrão de mercado; portável entre provedores | Migrar de SQLite para Postgres exige reescrita de tipos/queries |

## Decisão recomendada
**PostgreSQL gerenciado, acessado por Hyperdrive**, com:
- `tenant_id` em toda tabela de tenant + **RLS** (`SET LOCAL app.tenant_id`, `app.unit_ids`, `app.user_id` por transação);
- dois roles: `app_owner` (migrations) e `app_rw` (sem BYPASSRLS, sem UPDATE/DELETE em tabelas append-only);
- dinheiro em `numeric(14,2)` (ou bigint centavos, definir em FINANCIAL_RULES);
- migrations versionadas (Drizzle Kit ou SQL puro).

**Por quê:** integridade financeira e isolamento são as maiores prioridades do projeto; transações interativas e RLS não têm equivalente em D1. O custo adicional é pequeno no início.

**D1 permanece útil** para dados não críticos/baixo risco (cache de configuração publicada de sites, rate limiting auxiliar) — opcional, não no MVP.

## Custo inicial estimado (a validar com preços vigentes)
- Cloudflare Workers/R2/Queues/Cron: plano gratuito cobre o desenvolvimento e primeiros tenants; planos pagos de baixo custo quando exceder limites (Queues pode exigir plano pago — validar).
- PostgreSQL gerenciado: plano grátis para dev/staging; **produção recomenda plano pago de entrada** (backups/PITR mais longos, sem suspensão). Estimativa de ordem de grandeza: dezenas de USD/mês. *Não tenho preços verificados nesta sessão; confirmar nas páginas oficiais antes de aprovar.*
- Gateway: sem mensalidade típica; taxa por transação.

## Limitações das opções gratuitas (a confirmar)
Armazenamento pequeno; suspensão por inatividade (cold start); PITR curto ou ausente; limite de conexões; sem SLA. **Consequência:** o RPO de 24 h exige rotina própria de dump para R2 (ver OPERATIONS) até haver plano pago.

## Consequências
+ RLS e transações reais; relatórios ricos; portabilidade.
− Serviço externo adicional; latência Worker→DB; dependência de Hyperdrive.
Mitigação: região do DB próxima ao Worker (ex.: São Paulo se disponível; **validar regiões**), cache de leituras públicas, filas para tarefas assíncronas.

## Alternativas rejeitadas
- D1 puro: risco de P0 (vazamento) e dificuldade de garantir consistência financeira.
- D1 + Postgres híbrido no MVP: complexidade desnecessária.

## Plano de reversão
Camada de acesso via Drizzle com SQL padrão; evitar extensões proprietárias do provedor.
