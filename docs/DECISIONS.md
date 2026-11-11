# Registro de decisões

| ID | Decisão | Status | Data | Observação |
|---|---|---|---|---|
| ADR-0001 | PostgreSQL gerenciado via Hyperdrive (não D1) | Aprovado (implícito: início da Fase 1, 2026-11-09) | 2026-11-09 | Requer aprovação (custo/arquitetura) |
| ADR-0002 | React+Vite PWA (painéis/portal) + Astro SSR (site/cartão) + Hono API | Aprovado (implícito: início da Fase 1, 2026-11-09) | 2026-11-09 | |
| ADR-0003 | Auth própria, sessão opaca, MFA p/ Super Admin | Aprovado (implícito: início da Fase 1, 2026-11-09) | 2026-11-09 | Benchmark de hash na Fase 1 |
| ADR-0004 | Banco único, `tenant_id` + RLS + FK composta | Aprovado (implícito: início da Fase 1, 2026-11-09) | 2026-11-09 | |
| ADR-0005 | Gateway/billing | Adiado (Fase 8) | 2026-11-09 | Mercado Pago/Stripe/Asaas a comparar |
| ADR-0006 | WhatsApp | Adiado (Fase 8) | 2026-11-09 | Meta; `wa.me` até lá |
| ADR-0007 | Custo médio móvel; R2 privado+URL assinada; Images/PDF a validar | Proposto | 2026-11-09 | |

| D-001 | WhatsApp oficial integrado depois (Fase 8); `wa.me` até lá | **Aprovado pelo usuário** | 2026-11-09 | Lembrete REM-001 |
| D-002 | Agenda **básica** na Fase 4; avançada na Fase 9 | **Aprovado pelo usuário** | 2026-11-09 | |
| D-003 | Política de retenção baseada em legislação (`LEGAL_RETENTION.md`): pisos legais, `legal_holds`, anonimização, papéis controlador/operador | Proposto (pesquisa feita; revisão jurídica pendente) | 2026-11-09 | Esquema entra na Fase 1 |

Decisões do prompt tratadas como fixas: stack de referência (React/TS/Tailwind/Cloudflare), hierarquia Plataforma→Tenant→Unidade, regras de unicidade (placa única por tenant, slug global, usuário global com memberships, número da OS único por tenant/unidade), ledger append-only, sem fiscal no MVP.

## D-004 — Dinheiro em centavos (bigint) no financeiro (Fase 5)
Mantém o padrão da Fase 2 (orçamento) em vez de `numeric(14,2)`; evita ponto flutuante e facilita reconciliar com o ledger. Arredondamento HALF_EVEN nas regras percentuais (juros, multa, overhead).
## D-005 — Status de parcela derivado; liquidação/estorno por fatos
Parcelas e documentos são imutáveis; saldo e status são calculados das alocações de liquidações não estornadas. Estorno de liquidação marca `reversed_at` (coluna de fato) e posta txn de estorno.
