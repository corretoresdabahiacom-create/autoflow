# Fase 10 — Lançamento: relatório honesto

**Veredicto: NO-GO para lançamento comercial.** A engenharia local está sólida e testada, mas os critérios de aceite 1, 3, 5 e 7 não podem ser atendidos sem decisões, credenciais e infraestrutura que dependem de você; 2 e 6 estão parciais. Nada foi validado em staging ou produção (não existem).

## Critérios de aceite
| # | Critério | Status | Evidência / pendência |
|---|---|---|---|
| 1 | Zero P0 e zero P1 em fluxos essenciais | **Não atendido** | P0 abertos: KI-061 (WhatsApp Meta), KI-062 (gateway), KI-079 (revisão trabalhista), KI-086 (sem deploy), KI-091 (texto legal). P1 abertos: KI-003, 010, 064, 077, 087–090 etc. |
| 2 | Restore testado com RPO/RTO medidos e documentados | **Parcial** | Restore local medido: 1,8 s p/ 650 KB, invariantes ok (RPO_RTO.md). RPO é afirmação de projeto; sem backup/PITR (KI-090) |
| 3 | Pentest/ZAP sem críticos/altos | **Não atendido** | Não executado (KI-087). Feito: audit sem vulnerabilidades, baseline automatizado (SECURITY_REVIEW_FASE10.md) |
| 4 | Carga: metas definidas e cumpridas (p95) | **Atendido localmente, não validado em ambiente-alvo** | Todas as metas cumpridas em dev (PERFORMANCE.md); ressalvas KI-088 |
| 5 | Alertas e dashboards ativos e testados | **Não atendido** | Regras escritas (`ops/alerts.yml`), métricas testadas; nada ativo (KI-089) |
| 6 | Termos, privacidade e fluxos LGPD revisados | **Parcial** | Fluxos LGPD implementados e testados; textos são rascunho sem revisão jurídica (KI-091) |
| 7 | Checklist de deploy/rollback executado em staging | **Não atendido** | Checklist escrito; só ensaio local de restore (KI-086) |

## Implementado e testado (local)
- Métricas/readiness/cabeçalhos/log sem PII; LGPD exportar/anonimizar com evidência.
- E2E ponta a ponta (provisão → equipe → OS → orçamento → aprovação OTP no portal → produção → entrega → fatura → recebimento idempotente → razão balanceado/DRE → export LGPD → isolamento). **Achou e corrigiu 1 bug real** (portal bloqueado em trial).
- Baseline de segurança (6 testes), `pnpm audit --prod` limpo, axe no login (0 violações).
- Suíte completa: typecheck ok; shared 32 + api 159 testes passando.

## Não validado em produção
Tudo. Nenhum ambiente real, credencial, tráfego ou cliente.

## Bloqueado por dependência externa
WhatsApp real (REM-001/KI-061), gateway (KI-062), e-mail (KI-010), Turnstile (KI-042), infra/staging/PITR/alertas, pentest, revisão jurídica.

## Gate de GO (o que falta, em ordem)
1. Você decidir: runtime/hospedagem (KI-012), e-mail (KI-010), OTP (KI-003), gateway (ADR-0005; recomendação: avaliar Asaas), WhatsApp via Embedded Signup (ADR-0006), preços (KI-064/077), padrões financeiros (multa 2%, juros 1% a.m., desconto 5%, estorno R$ 1.000).
2. Revisão jurídica/contábil: termos, privacidade, retenção (REM-003), base legal de marketing, comissões/adiantamentos (KI-079).
3. Provisionar staging + produção, segredos, backup diário + PITR, Prometheus/alertas; executar DEPLOY_CHECKLIST e ROLLBACK em staging.
4. Pentest/ZAP independente; corrigir críticos/altos.
5. Repetir carga e restore no ambiente-alvo com dados representativos.
6. Integrar Meta e gateway reais e validar com sandbox/credenciais.

## Lembretes permanentes
REM-001 WhatsApp: adaptador + sandbox prontos; produção Meta bloqueada externamente. Demais decisões pendentes listadas no gate acima.
