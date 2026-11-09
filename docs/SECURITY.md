# AutoFlow — Segurança (Fase 0)

## 1. Princípios
Falha fechada; defesa em profundidade; menor privilégio; nada de segurança só no frontend; segredos fora do código; sem PII em logs.

## 2. Ameaças prioritárias (P0)
Vazamento entre tenants · IDOR · acesso administrativo indevido · exposição de credenciais/tokens · aprovação indevida · corrupção financeira · takeover de conta · upload malicioso.

## 3. Controles
- **Isolamento:** ADR-0004 (RLS + FK composta + contexto transacional). Teste automático falha se tabela de tenant não tiver RLS.
- **Autenticação:** ADR-0003. MFA obrigatório para Super Admin.
- **Autorização:** pipeline fixo (ARCHITECTURE §4); decorators obrigatórios por rota.
- **Entrada/saída:** Zod em toda borda; queries parametrizadas (ORM); escape/CSP contra XSS; CSP estrita sem `unsafe-inline` onde possível; headers (HSTS, X-Content-Type-Options, frame-ancestors, Referrer-Policy).
- **CSRF:** SameSite + token + Origin.
- **Rate limit/anti-bot:** login, reset, portal, formulários públicos, cliques do cartão (Turnstile + limites + honeypot).
- **Segredos:** Wrangler secrets/Secrets Store; rotação documentada; credenciais de terceiros por tenant **cifradas** (envelope encryption, chave mestra fora do banco).
- **Dados sensíveis:** CPF/CNPJ cifrado em coluna + hash cego para busca; mascaramento na UI.
- **Uploads:** ADR-0007.
- **Dependências:** lockfile, auditoria (`pnpm audit`/Dependabot), CI com SAST básico.

## 4. Portal do cliente — modelo de segurança
| Aspecto | Regra |
|---|---|
| Token | 32 bytes aleatórios (CSPRNG), base64url; apenas **SHA-256** armazenado; 1 token ↔ 1 OS; nunca sequencial |
| Link | `https://…/p/{token}`; ao abrir, troca por **sessão curta** (cookie HttpOnly, ~30 min, renovável por atividade, teto absoluto) e o token é removido da URL (redirect) para evitar vazamento por Referer/histórico |
| Escopo da sessão | somente a OS do token; sem enumeração; respostas 404 uniformes |
| Rate limit | por IP e por token; tentativas inválidas com atraso progressivo e alerta |
| Leitura vs decisão | **ver** status/fotos/orçamento: sessão do link. **Aprovar/recusar/pagar:** exige OTP enviado ao telefone cadastrado (canal configurado; sem canal confiável → aprovação presencial/assistida registrada com procedimento específico) |
| Evidência de aprovação | versão, itens, valores, hash do conteúdo apresentado, data/hora (UTC), IP hash, user-agent, telefone mascarado, ID do OTP, justificativa de recusa; **não** se afirma validade jurídica automática |
| Ciclo de vida | ativo durante a OS; após entrega, consulta por **90 dias (configurável)**; renovação com verificação de identidade (OTP); revogação imediata pelo painel; expirado → página neutra + pedido de renovação |
| Auditoria | `portal_access_log` (hash de IP, UA resumido, ação) com retenção limitada |
| Conteúdo | nunca expor custo interno, margens, dados de outros clientes; obrigatórios não ocultáveis (§Portal do prompt) são renderizados pelo sistema, fora do alcance do editor de tema |
| Cache | `Cache-Control: no-store`; fora do cache do Service Worker |

## 5. Acesso excepcional do Super Admin
Regra: **nenhum acesso padrão** a dados operacionais/pessoais. Suporte via metadados técnicos, logs sem PII e métricas. Acesso excepcional = `support_access_grants`: justificativa obrigatória, escopo (tenant + recursos + somente leitura por padrão), duração máx. (ex.: 60 min, renovável com nova justificativa), identificação do operador, **registro de toda consulta/ação**, encerramento automático (Cron + expiração no token de sessão), notificação ao proprietário do tenant (configurável) e MFA recente.

## 6. Matriz de permissões (proposta inicial)
Legenda: ● total · ◐ restrito (próprios/unidade) · ○ somente leitura · — sem acesso. Entitlement do plano é pré-requisito em todas as linhas.

| Recurso | Owner | Admin | Gerente | Atendente | Mecânico/Funileiro/Pintor/Alinhador | Estoquista | Financeiro |
|---|---|---|---|---|---|---|---|
| Config. empresa/plano | ● | ◐ | — | — | — | — | — |
| Usuários e permissões | ● | ● | ◐ (unidade) | — | — | — | — |
| Clientes/Veículos | ● | ● | ● | ● | ○ (OS atribuídas) | — | ○ |
| OS (criar/editar) | ● | ● | ● | ● | ◐ (status/tarefas) | — | ○ |
| Vistoria | ● | ● | ● | ● | ◐ | — | — |
| Orçamento (criar/publicar) | ● | ● | ● | ● | — | — | ○ |
| Aprovação em nome do cliente (assistida) | ● | ● | ● | ◐ (com procedimento) | — | — | — |
| Produção/Kanban | ● | ● | ● | ◐ | ◐ (suas tarefas) | ○ | — |
| Financeiro (lançar/receber/pagar) | ● | ● | ◐ | — | — | — | ● |
| Estorno/cancelamento financeiro | ● | ◐ | — | — | — | — | ◐ (com dupla confirmação) |
| DRE/relatórios | ● | ● | ◐ (unidade) | — | — | — | ● |
| Estoque | ● | ● | ● | ○ | ◐ (requisição) | ● | ○ |
| CRM/leads | ● | ● | ● | ● | — | — | — |
| Presença digital/editor | ● | ● | ◐ | — | — | — | — |
| Auditoria/exportar LGPD | ● | ● | — | — | — | — | — |
| Dashboard (personalizar) | ● | ● | ● | ● | ● | ● | ● (nunca concede permissão) |

Super Admin: gerencia plataforma (tenants, planos, limites, billing, integrações, métricas, logs técnicos). Dados de tenant: **somente por acesso excepcional**.

## 7. Regras de severidade e bloqueio
Conforme PARTE XIV do prompt: qualquer P0 bloqueia publicação; P1 bloqueia a fase quando afeta fluxo essencial/integridade.

## 8. Resposta a incidentes
Ver OPERATIONS §Incidentes. Notificação à ANPD/titulares conforme LGPD (avaliação jurídica).

## Riscos residuais da Fase 1
- **Contexto de RLS por GUC** (KI-011): protegido por consultas parametrizadas e `assertUuid`; revisar toda nova query dinâmica.
- **CSRF**: cookies `SameSite=Lax` + exigência de `Origin` permitida em métodos mutáveis. Sem token CSRF adicional.
- **Rate limit** em tabela (janela fixa): suficiente como defesa em profundidade; WAF/Cloudflare é a primeira camada em produção.
- **MFA do Super Admin**: TOTP com proteção a replay; sem códigos de recuperação ainda (recuperação via operação manual com dois responsáveis — a definir).
- **E-mail** não configurado (KI-010): convites/reset indisponíveis em produção.
