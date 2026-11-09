# AutoFlow 2.0 — PRD

Status: **Fase 0 — aguardando aprovação** · Data: 2026-11-09 · Projeto: GREENFIELD (nenhum código ou infraestrutura pré-existente)

## 1. Visão
SaaS por assinatura para oficinas automotivas (chaparia, funilaria, pintura, mecânica, elétrica, alinhamento/balanceamento, pneus, centros automotivos, estética, multimarcas). Três componentes comerciais independentes: **Gestão da oficina**, **Relacionamento com o cliente**, **Aquisição de novos clientes**.

## 2. Cinco ambientes
| # | Ambiente | Público | Acesso |
|---|----------|---------|--------|
| 1 | Super Admin | Equipe AutoFlow | Login + MFA, sem acesso automático a dados de oficinas |
| 2 | Painel da oficina | Proprietário/administrador/gerente/financeiro | Login, RBAC + entitlements |
| 3 | Painel operacional | Funcionários (mecânico, pintor etc.) | Login, escopo por unidade, mobile-first |
| 4 | Portal do cliente | Cliente final | Link individual por OS (token), sem conta |
| 5 | Presença digital | Público | `/c/{slug}` (cartão), `/o/{slug}` (site), SSR/SSG |

## 3. Personas
- **Dono da oficina**: quer controle financeiro e confiança do cliente.
- **Atendente**: abre OS, fotografa vistoria, envia orçamento.
- **Funcionário de produção**: vê tarefas, marca início/pausa/fim, anexa fotos pelo celular.
- **Cliente final**: quer saber o status, aprovar/recusar itens, pagar.
- **Operador AutoFlow (Super Admin)**: cadastra oficinas, planos, dá suporte sem ver dados pessoais.

## 4. Escopo do MVP (obrigatório)
Fases 1–6 do roadmap cobrem o MVP: cadastro de oficinas, autenticação, multi-tenancy, usuários/permissões, clientes, veículos, OS, vistorias fotográficas, orçamentos versionados, aprovações individuais, portal do cliente + QR de acompanhamento, produção básica (Kanban), financeiro essencial (contas a pagar/receber, ledger), dashboard básico, cartão virtual, QR comercial, website público, formulário de orçamento, CRM básico de leads, personalização visual, Super Admin básico, auditoria.

**Fora do MVP (fundação prevista, implementação posterior):** estoque avançado, compras, agenda avançada, comissões, seguradoras, WhatsApp oficial, campanhas automatizadas, fidelização, múltiplas unidades (modelo de dados já suporta), billing automatizado, fiscal, BI.

> Observação de coerência: o prompt coloca "Produção básica" e "Dashboard básico" no MVP e "Agenda avançada" fora. A Fase 4 entrega Kanban/tarefas/boxes e agenda **básica**; a agenda avançada (lista de espera, por funcionário/box com conflitos) fica na Fase 9. Estoque (Fase 7) e CRM completo também ficam depois; o **CRM básico de leads** é entregue na Fase 6 junto do formulário do site. Ver ROADMAP.

## 5. Fluxos principais
### 5.1 Onboarding da oficina
Super Admin cria tenant + unidade padrão + assinatura trial → convite ao proprietário → proprietário define senha/MFA opcional → configura identidade visual, serviços, equipe.

### 5.2 Atendimento → entrega (fluxo central)
1. Atendente busca cliente/veículo (placa, telefone, nome, nº OS) ou cria.
2. Cria OS (unidade, responsável, queixa, previsão) → número sequencial por tenant+unidade.
3. Vistoria: fotos por área, marcações de dano, km, combustível, confirmação do cliente → termo de entrada (PDF).
4. Diagnóstico → Orçamento v1 (itens) → publicação (imutável) → link do portal enviado.
5. Cliente aprova/recusa **por item**, com código de verificação no telefone cadastrado → evidência registrada.
6. Execução: tarefas paralelas no Kanban; bloqueio de serviço não aprovado.
7. Escopo muda → nova versão (v2); itens alterados exigem nova aprovação; anteriores preservadas.
8. Pronto → entrega → cobrança/recebimento → portal fica em modo consulta por 90 dias (configurável).

### 5.3 Aquisição
Visitante abre `/o/{slug}` ou escaneia QR do cartão → formulário de orçamento → lead no CRM (origem/campanha) → oficina notificada → converte em cliente/agendamento/OS.

### 5.4 Suporte com acesso excepcional
Operador solicita acesso → justificativa + escopo + duração → (aprovação do proprietário quando exigida) → sessão limitada, tudo auditado → encerra automaticamente.

## 6. Requisitos não funcionais
Segurança P0 como bloqueio; isolamento multi-tenant verificado por testes; RPO ≤ 24 h / RTO ≤ 8 h (MVP) **só válidos após teste de restauração**; WCAG AA; mobile-first; LGPD; custo inicial próximo de zero (ver ADR-0001 e ARCHITECTURE §7).

## 7. Critérios de aceite do MVP (resumo)
Detalhe por fase em `/docs/phases/`. Globais: (a) nenhum teste P0/P1 falhando; (b) suíte de isolamento multi-tenant verde; (c) aprovação sempre vinculada a versão+item; (d) ledger append-only com estorno; (e) portal sem acesso a OS de terceiros; (f) restauração de backup testada; (g) site público com SSR e SEO validado.

## 8. Estimativa qualitativa (esforço relativo)
| Fase | Esforço | Risco |
|------|---------|-------|
| 1 Fundação | Alto | Alto (base de tudo; erros aqui propagam) |
| 2 Clientes e OS | Alto | Médio-alto (versionamento/aprovações) |
| 3 Portal | Médio-alto | Alto (segurança de token/aprovação) |
| 4 Produção | Médio | Médio |
| 5 Financeiro | Alto | Alto (integridade) |
| 6 Presença digital | Médio-alto | Médio (SEO, editor seguro) |
| 7 Estoque/CRM | Médio-alto | Médio |
| 8 Integrações | Alto | Alto (dependência externa/Meta/gateway) |
| 9 Avançado | Alto | Médio |
| 10 Lançamento | Médio | Alto (backup, carga, segurança) |

Sem prazos em dias: dependem de ritmo de aprovação e de credenciais externas.
