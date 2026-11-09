# AutoFlow — Roadmap, riscos e dependências

## 1. Fases
| Fase | Entrega | Depende de | Observação |
|---|---|---|---|
| 0 | Diagnóstico e planejamento (este pacote) | — | **Aguardando aprovação** |
| 1 | Fundação: monorepo, banco+RLS, auth, RBAC, unidades, tenants, Super Admin básico, auditoria, entitlements (estrutura), CI | 0 + decisões ADR-0001/0003/0004 + contas Cloudflare/Postgres | Subdividir: 1A (projeto/CI/banco), 1B (auth/RBAC), 1C (tenancy/Super Admin/auditoria) |
| 2 | Clientes, veículos, OS, vistoria, orçamentos versionados, aprovações (modelo + fluxo assistido), anexos | 1 | PDF e upload (ADR-0007) |
| 3 | Portal: token, QR, acompanhamento, chat, fotos, notificações, personalização | 2 | OTP exige canal (decisão) |
| 4 | Produção: Kanban, tarefas, boxes, funcionários, agenda **básica** | 2 | |
| 5 | Financeiro: plano de contas, caixa, contas, recebimentos, ledger, DRE, lucro/OS | 2 (4 para mão de obra) | Integridade crítica |
| 6 | Presença digital: cartão, QR, site SSR, SEO, galeria, formulário, CRM **básico**, editor | 1 (2 opcional) | Pode ser antecipada em paralelo à 4/5 se o negócio priorizar aquisição |
| 7 | Estoque, compras, fornecedores, CRM completo, fidelização | 2,5 | |
| 8 | Integrações: WhatsApp, e-mail, push, pagamentos, billing, mapas | provedores/credenciais | **Bloqueios externos** |
| 9 | Seguradoras, múltiplas unidades (UI/planos), relatórios, automação, premium | 5,7,8 | |
| 10 | Lançamento: testes finais, pentest, backups testados, monitoramento, performance, deploy | todas | |

## 2. Riscos
| ID | Risco | Sev. | Prob. | Mitigação |
|---|---|---|---|---|
| R1 | Vazamento entre tenants | P0 | M | RLS + FK composta + testes de 2 tenants + revisão |
| R2 | Aprovação indevida/fraude no portal | P0 | M | OTP, evidência, versão+item+hash, rate limit |
| R3 | Corrupção financeira | P0 | M | Ledger append-only, partida dobrada, testes |
| R4 | Custo de CPU de hash de senha no Worker | P1 | M | Benchmark na Fase 1; plano B de parâmetros |
| R5 | Limites/custos dos planos gratuitos (Postgres, Queues, Images) | P1 | A | Validar preços; orçamento; monitorar uso |
| R6 | Bloqueio Meta/WhatsApp | P1 | A | Adaptador + `wa.me`; cronograma independente |
| R7 | Escopo MVP muito amplo | P1 | A | Entrega por fase, cortes explícitos |
| R8 | Backup sem teste de restauração | P0 | M | Drill obrigatório na Fase 10 e a cada trimestre |
| R9 | Upload malicioso/vazamento de documentos | P0 | M | Bucket privado, URLs assinadas, scan |
| R10 | Requisitos legais (LGPD, consumidor, fiscal) mal interpretados | P1 | M | Revisão jurídica das retenções e termos |
| R11 | SEO insuficiente por SPA | P2 | B | Astro SSR + validação |
| R12 | Editor visual permitir XSS | P0 | B | Schema JSON, sem HTML bruto, CSP |

## 3. Decisões pendentes do usuário (resumo; ver relatório)
Aprovar ADR-0001 (PostgreSQL), ADR-0002 (Astro+React), ADR-0003 (auth própria); fornecer contas/credenciais; definir canal padrão do OTP; confirmar escopo "agenda básica" na Fase 4; confirmar nome/domínio e região.
