# Fase 9 — Avançado: relatório

Data: 2026-11-18

## Implementado
- **Seguradoras:** cadastro com SLA, sinistro por OS, rodadas de autorização imutáveis (autorizado/parcial/negado derivado dos valores), complemento, franquia, prazos (ok / a vencer / vencido) e transições válidas.
- **Multiunidade:** transferência de estoque (custo médio da origem, mesmo custo no destino, ledger por unidade com conta de transferência líquida zero, idempotente, sem deadlock A→B/B→A) e consolidado que soma apenas as unidades do escopo do usuário.
- **Relatórios:** consolidado, resultado por categoria/unidade, lucro por OS, produtividade, valorização de estoque × ledger.
- **Automações:** regras configuráveis (gatilho = evento da OS; ação = WhatsApp de utilidade ou nota interna), execução idempotente, auditada, limite mensal por plano, interruptor da oficina e kill-switch global.
- **Comissões:** regra versionada por colaborador, cálculo por OS pela regra vigente na entrega, ajustes por diferença, adiantamentos e pagamentos com abatimento, tudo no ledger.
- **Agenda:** conflito (box/profissional/tarefas), horário livre, lista de espera por prioridade com encaixe.
- **Entitlements Premium** no backend (`insurers`, `advanced_reports`, `automation`, `agenda`, `team`).

## Testado (automatizado: API 148 testes, shared 32; typecheck limpo)
| Critério | Resultado |
|---|---|
| 1 Consolidado respeita escopo | Testado: dono vê 2 unidades (80.000 = 30.000 + 50.000); gerente com escopo na unidade 0 vê só ela (30.000) e o estoque dela; estoquista com escopo é negado ao transferir para a unidade 1 |
| 2 Relatórios reconciliam | Testado: DRE por categoria = `/finance/dre`; lucro por OS (por OS + sem OS = ledger = DRE); estoque × ledger por unidade com diferença 0 (inclui transferência e consumo); produtividade = tempo apontado e custo/hora |
| 3 Automações idempotentes, auditadas, com limite e kill-switch | Testado: evento processado uma vez; limite bloqueia sem consumir o evento; interruptor da oficina, kill-switch global e plano sem recurso bloqueiam; evento é processado uma única vez após liberar; auditoria de cada execução, bloqueio e troca do kill-switch; tentativa de apagar execução falha |
| 4 Comissão por regra versionada sem alterar histórico | Testado: v2 (10%) só vale para entregas futuras; OS antiga mantém 5%; recálculo idempotente; cancelamento da fatura gera ajuste −1.500 sem editar o original; UPDATE/DELETE em regras e lançamentos falham; ledger: Comissões a pagar e Adiantamentos zerados após o pagamento |
| 5 Entitlements premium no backend | Testado: Essencial/Profissional negados (`feature_not_in_plan`), override do Super Admin libera, perfil sem permissão negado, assinatura suspensa nega |

## Validado em produção
**Nada.** Todos os resultados acima são de testes automatizados em banco de teste.

## Bloqueado por dependência externa
WhatsApp real por automação continua dependendo da Meta (KI-061); o teste usa o sandbox.

## Planejado
KI-073 a KI-085 (seguradoras sem integração, automações simples, comissão por colaborador, UI mínima etc.).

## Decisões suas pendentes
- **Revisão trabalhista/contábil de comissões e adiantamentos** (KI-079): o sistema não é folha e não calcula reflexos/encargos.
- **Limites e preços Premium** (`automation.monthly`, `units.max`) e **preços dos planos** (KI-064/077).
- Aprovar ADR-0005 (gateway) e ADR-0006 (WhatsApp).
- Pendências antigas: canal de OTP (KI-003), provedor de e-mail (KI-010), revisão jurídica de retenção e base legal de marketing (REM-003), padrões financeiros (multa 2%, juros 1% a.m., desconto 5%, estorno R$ 1.000).

## Lembretes
REM-001 (WhatsApp): adaptador e sandbox prontos; envio real bloqueado pela Meta. Próxima: Fase 10 (lançamento) — só inicio com o seu "Fase 10".
