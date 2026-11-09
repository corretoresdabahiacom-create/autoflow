# AutoFlow — Base legal e política de retenção (LGPD, consumidor, fiscal)

Pesquisa realizada em 2026-11-09. **Não é parecer jurídico.** Os prazos abaixo são *padrões configuráveis*; a validação final é de advogado/contador (KI-004 permanece aberto até essa revisão).

Legenda de verificação: ✅ conferido em fonte consultada nesta sessão · ⚠️ conhecimento geral, **não** conferido em fonte (texto oficial do Planalto bloqueou o acesso) · ❓ divergência entre fontes.

## 1. Papéis (decisão de arquitetura jurídica)
- **Oficina (tenant) = controlador** dos dados de seus clientes, veículos, OS, leads. **AutoFlow = operador** desses dados (trata por instrução da oficina) ⚠️ — a classificação deve constar no contrato/DPA.
- **AutoFlow = controlador** dos dados da conta da oficina, usuários, faturamento e logs de segurança da plataforma.
- Consequência: retenção, atendimento a titulares e comunicação de incidente têm **duas camadas** (oficina e plataforma). O sistema entrega as ferramentas; a oficina decide dentro de pisos legais.

## 2. Fontes e o que dizem
| Norma | Regra relevante | Status |
|---|---|---|
| **CDC art. 26** | Decadência para vícios aparentes: **30 dias** (não durável) / **90 dias** (durável), contados da entrega ou do **término da execução do serviço**; reclamação comprovada obsta o prazo até resposta negativa inequívoca; vício oculto conta da evidenciação | ✅ |
| **CDC art. 27** | Prescrição da reparação por fato do serviço: **5 anos**, do conhecimento do dano e da autoria | ✅ |
| **CC art. 206 §3º V** | Reparação civil: **3 anos** | ✅ |
| **CC art. 206 §5º I** | Cobrança de dívidas líquidas em instrumento público/particular: **5 anos** | ✅ |
| **CC art. 205** | Regra geral: **10 anos** | ⚠️ |
| **CC art. 1.194** | Empresário deve conservar escrituração, correspondência e documentos enquanto não prescritos/decaídos os atos registrados | ❓ citado por fonte secundária; texto não obtido |
| **CTN art. 195 par. único** | Livros e documentos conservados **até a prescrição dos créditos tributários** | ✅ (via artigo doutrinário) |
| **CTN art. 174** | Cobrança do crédito tributário prescreve em **5 anos** da constituição definitiva | ✅ |
| **CTN art. 173 I / 150 §4** | Decadência 5 anos (lançamento de ofício / homologação tácita) | ✅ (via artigo doutrinário) |
| **Lei 9.430/1996 art. 37** | Guarda de documentos até a decadência | ✅ (via fonte secundária) |
| **Marco Civil art. 15** | Provedor de aplicações guarda **registros de acesso por 6 meses**, sob sigilo e em ambiente controlado; prazo maior só por ordem específica. A norma restringe a obrigação a provedor pessoa jurídica que exerce a atividade de forma organizada, profissional e com fins econômicos (AutoFlow se enquadra) | ✅ prazo · ❓ a fonte consultada omitiu a qualificação; texto oficial não obtido |
| **Marco Civil art. 13** | Provedor de conexão: 1 ano (não se aplica ao AutoFlow) | ✅ |
| **LGPD art. 15–16** | Dados são eliminados ao fim do tratamento (finalidade atingida, fim do prazo, revogação do consentimento, ordem da ANPD); conservação permitida para **cumprimento de obrigação legal ou regulatória**, estudo (anonimizado), transferência a terceiro nos termos da lei, uso exclusivo do controlador anonimizado | ⚠️ (confirmado por fontes secundárias nos resultados, texto oficial não obtido) |
| **LGPD art. 18–19** | Direitos do titular (confirmação, acesso, correção, anonimização/bloqueio/eliminação, portabilidade, informação sobre compartilhamento, revogação). Resposta simplificada imediata; **declaração completa em até 15 dias** (art. 19, II) | ⚠️ |
| **LGPD art. 37, 41, 46–48** | Registro das operações; encarregado; medidas de segurança; comunicação de incidente | ⚠️ |
| **Res. CD/ANPD 15/2024** | Incidente com risco/dano relevante: comunicar ANPD e titulares em **3 dias úteis** do conhecimento (art. 6º, 9º); **dobro** para agentes de pequeno porte; critérios de relevância: dados sensíveis, crianças/adolescentes/idosos, financeiros, autenticação, sigilo legal, larga escala; complemento em 20 dias úteis; **registro de todos os incidentes por no mínimo 5 anos** (art. 10) | ✅ |
| **Trabalhista (se houver apontamento de horas/comissões/adiantamentos)** | Créditos trabalhistas: 5 anos (limitado a 2 após o fim do contrato); FGTS: 5 anos após cada contrato; prontuário ocupacional 20 anos (fora do escopo do AutoFlow) | ✅ (fonte secundária) |
| **XML de NF-e (futuro, fase fiscal)** | Maioria lê **5 anos**; há leitura de **11 anos** após Ajuste SINIEF 2/2025 | ❓ decidir na fase fiscal; adotar o maior até parecer |

## 3. Tabela de temporalidade proposta (padrões configuráveis)
`Piso` = mínimo que a oficina **não** pode reduzir no sistema. Prazos contados do `gatilho`.

| Categoria | Gatilho | Padrão | Piso | Fundamento | Ao fim |
|---|---|---|---|---|---|
| Ledger, recebimentos, contas a pagar/receber, conciliação | fato gerador / baixa | **5 anos** | 5 anos | CTN 195/174, L.9.430 art. 37, CC 1.194, CC 206 §5º I | Manter valores; **anonimizar** dados pessoais vinculados |
| OS, orçamentos (todas as versões), aprovações e evidências, termo de entrada | entrega ou cancelamento da OS | **5 anos** | 5 anos | CDC 26/27, CC 206 §3º V e §5º I (cobre o maior prazo) | Anonimizar cliente; remover anexos |
| Fotos de vistoria e de produção | entrega/cancelamento | **5 anos** | 5 anos | Evidência de estado do veículo (CDC 26–27) | Excluir do R2 |
| Mensagens do chat por OS | entrega/cancelamento | **5 anos** | 3 anos | Prova da relação de consumo | Excluir |
| Clientes e veículos sem OS aberta | último vínculo/OS | enquanto houver OS retida; depois **anonimizar** | — | LGPD 15–16 | Anonimizar |
| Leads não convertidos | último contato | **12 meses** | — | Necessidade/finalidade (LGPD 6º, 15) | Excluir |
| Consentimentos e opt-outs | revogação/vigência | vigência + **5 anos**; lista de supressão mantém só o mínimo para respeitar o opt-out | 5 anos | Prova (LGPD 8º §2º ⚠️) | — |
| Logs de acesso à aplicação (incl. portal, login) | evento | **6 meses** | 6 meses | Marco Civil art. 15 | Excluir (salvo ordem judicial/legal hold) |
| Audit log de ações de negócio (pseudonimizado) | evento | **5 anos** | 5 anos | Alinha ao ledger/OS | Manter pseudonimizado |
| Acessos excepcionais do Super Admin | evento | **5 anos** | 5 anos | Accountability | Manter |
| Registro de incidentes de segurança | registro | **5 anos** | 5 anos | Res. ANPD 15/2024 art. 10 | Manter |
| Apontamento de horas/comissões de funcionários | fim do vínculo | **5 anos** | 5 anos | CF art. 7º XXIX; L.8.036 art. 23 §3º | Anonimizar |
| Tokens e sessões do portal expirados | expiração | hash purgado em **6 meses** | — | Minimização | Excluir |
| Backups | criação | **30 dias** (rotativo) | — | Operacional | Dado já eliminado some do backup ao expirar (documentar na política de privacidade) |
| Conta cancelada (tenant) | cancelamento | **90 dias** para exportação; depois aplica-se a tabela acima | — | Contrato | Eliminação só após aviso e confirmação; **nada é apagado automaticamente por excesso de cota** |

## 4. Implementação prevista no código (entra na Fase 1 como esquema; varredura nas fases seguintes)
**Tabelas (globais, `packages/db`):**
- `retention_policies(category, trigger, default_period, floor_period, legal_basis, action: anonymize|delete|archive, reviewed_by_legal_at)`.
- `tenant_retention_overrides(tenant_id, category, period)` com `CHECK` em nível de serviço: **nunca abaixo do piso**; só pode aumentar ou manter.
- `legal_holds(tenant_id, scope, reason, created_by, released_at)` — suspende qualquer expurgo (litígio, fiscalização, ordem judicial).
- `retention_runs(id, category, mode: dry_run|apply, counts, started_at, finished_at, approved_by)`.
- `privacy_requests(tenant_id, subject_ref, type, received_at, due_at, status, handled_by, outcome)` — `due_at` calculado (declaração completa: 15 dias).
- `consents(subject, purpose, channel, granted_at, revoked_at, evidence)`.

**Rotina `retention-sweeper` (Cron + Queue):** `dry_run` por padrão; `apply` exige flag do tenant e, na primeira execução, aprovação humana; idempotente; respeita `legal_holds`; **nunca** altera valores do ledger; registra em `retention_runs` e `audit_log`; falha fechada (dúvida = não apagar).

**Anonimização (contrato):** em `customers`/`vehicle_owners`/`leads`/mensagens: nome → `Cliente anonimizado #id`, telefone/e-mail/documento → `NULL`, hashes cegos removidos; **mantém `id`** para integridade referencial e relatórios agregados. Anexos pessoais removidos do R2.

**Direitos do titular:** a oficina (controlador) recebe a solicitação pelo painel; o sistema monta pacote de exportação (acesso/portabilidade), aplica correção, bloqueio ou anonimização **exceto** onde há retenção legal, e responde com justificativa da retenção (art. 16). Prazo e responsável visíveis.

**Incidentes:** runbook em OPERATIONS: AutoFlow (operador) notifica as oficinas afetadas sem demora indevida — **meta interna proposta: 24 h do conhecimento** (decisão nossa, não legal; constará no DPA); oficina (controlador) avalia comunicação à ANPD/titulares em **3 dias úteis** (dobro se pequeno porte). Modelos de comunicação seguem o conteúdo mínimo dos arts. 6º e 9º da Res. 15/2024.

## 5. Pendências para o jurídico/contador
1. Confirmar papéis (controlador/operador) e redigir DPA e termos de uso.
2. Confirmar o gatilho exato dos 5 anos fiscais (fato gerador × 1º de janeiro seguinte) e o prazo para XML de NF-e.
3. Confirmar o piso de 3 anos para mensagens de chat.
4. Conferir o texto oficial dos arts. 15–16, 18–19 da LGPD e do art. 15 do Marco Civil (fonte oficial não acessível nesta sessão).
5. Definir encarregado (DPO) da plataforma e canal do titular.
6. Avaliar se a oficina típica se enquadra como agente de pequeno porte (prazos em dobro).
