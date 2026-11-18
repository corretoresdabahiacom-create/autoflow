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

## D-006 (ADR-0007) — Estoque: custo médio móvel, movimentos append-only, saldo derivado
Quantidades em milésimos, valores em centavos. Todo movimento é append-only; `stock_levels` só é alterado por trigger (SECURITY DEFINER) a partir dos movimentos, serializado pelo lock da linha; CHECKs impedem saldo/reserva negativos e reserva > saldo. Saída ao custo médio atual (saída total zera o valor, sem resíduo); devolução volta pelo custo da saída original (última devolução fecha a diferença). Cada movimento com valor gera lançamento no ledger (kind `stock`): consumo D custo direto (peças/materiais/outros) / C Estoque; compra D Estoque / C GRNI. Custo de estoque entra no lucro por OS e no DRE pelo ledger. Inventário nunca edita saldo: gera ajustes compensatórios com motivo.

## D-007 — Consentimento de marketing
`customers.marketing_opt_in` é o estado; cada mudança é registrada por trigger em `marketing_consent_log` (append-only). Campanhas só enfileiram clientes com opt-in e e-mail; o consentimento é reverificado no ENVIO, e o opt-out cancela pendências imediatamente. Opt-out público por link assinado (HMAC).

## D-008 — Comissão: regra versionada e histórico preservado
`commission_rules` é append-only: mudar percentual cria nova versão com `valid_from`. O cálculo usa a regra vigente na data de entrega da OS. Recalcular uma OS já calculada mantém a regra do lançamento original e lança apenas a **diferença** como `adjustment` (positivo ou negativo) — nada é editado ou apagado. Acúmulo no ledger: D Comissões (despesa) / C Comissões a pagar; pagamento abate adiantamentos em aberto (D Comissões a pagar / C Adiantamentos + C carteira). Percentuais e bases são configuração do tenant, não regra fixa.

## D-009 — Automações: idempotência, limite e kill-switch
Uma execução por (regra, evento) garantida por chave única; execuções são serializadas por tenant (advisory lock), então limite mensal e idempotência são exatos sob concorrência. Bloqueios (kill-switch da plataforma, interruptor da oficina, limite, plano sem o recurso) **não consomem** o evento: ao liberar, ele é processado uma vez. Regras novas/reativadas só olham eventos posteriores à ativação. Automação envia apenas mensagem de **utilidade**; marketing continua exclusivo de campanhas com consentimento. Todo disparo e todo bloqueio são auditados.
