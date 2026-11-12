# Problemas conhecidos, lacunas e pendências

| ID | Item | Sev. | Estado |
|---|---|---|---|
| KI-001 | Preços e limites vigentes (Postgres gerenciado, Workers, Queues, Images, R2) **não foram verificados** nesta sessão; valores do ADR-0001 são ordem de grandeza | P2 | Validar antes da aprovação do ADR-0001 |
| KI-002 | Push para `https://github.com/corretoresdabahiacom-create/autoflow.git` **não realizado**: sem credencial/remoto configurado nesta sessão e o prompt manda parar para aprovação | P3 | Aguardando aprovação e credenciais Git |
| KI-003 | Canal padrão de OTP do portal: WhatsApp fica para depois (REM-001). Proposto até lá: **e-mail + aprovação assistida**; SMS só se o usuário aprovar o custo | P1 | Proposta aguardando confirmação (decidir antes da Fase 3) |
| KI-004 | Retenções: pesquisa feita e política proposta em `LEGAL_RETENTION.md`. Texto oficial da LGPD e do Marco Civil **não foi acessado** (Planalto bloqueou); parte dos prazos veio de fontes secundárias. Exige revisão jurídica/contábil | P1 | Parcialmente tratado; revisão pendente (REM-003) |
| KI-005 | Custo de hash em Workers não medido. Medido só em **Node** (2 vCPU, scrypt N=2^15,r=8,p=1: ~160 ms hash / ~160 ms verify; N=2^16: ~300 ms). Limite de CPU/memória de Workers para scrypt **não verificado** | P1 | **Parcial**: Node medido; validar em Workers (staging) antes de produção. Alternativa: hash em serviço Node (ver ADR-0003) |
| KI-006 | Contas/credenciais externas não configuradas (Cloudflare, Postgres, e-mail, Meta, gateway) | — | Bloqueio externo |
| KI-007 | Região do banco vs latência (idealmente São Paulo) não verificada | P2 | Validar na Fase 1 |
| KI-008 | Inconsistência no prompt: "Agenda avançada" fora do MVP, mas "Produção básica" e "Agendamentos" no dashboard MVP → adotada agenda **básica** na Fase 4 | P3 | **Resolvido** — confirmado pelo usuário em 2026-11-09 |
| KI-009 | Integração do WhatsApp adiada por decisão do usuário; ver REM-001 | — | Planejado (Fase 8) |
| KI-010 | Provedor de e-mail **não escolhido**: convites e reset funcionam na API, mas em produção `UnconfiguredEmailProvider` responde 503 e nenhum e-mail é enviado. Fora de produção os tokens são devolvidos na resposta (`exposeDevTokens`) | P1 | Aguardando decisão do usuário (bloqueia uso real de convite/reset) |
| KI-011 | RLS depende de GUCs (`SET LOCAL`) definidos pela camada de acesso: uma **SQL injection** que alcance `app_rw` poderia forjar o contexto. Mitigação: consultas 100% parametrizadas, `assertUuid`, sem SQL dinâmico com entrada externa (único SQL dinâmico usa tabela de lista fechada) | P2 | Risco residual aceito e documentado (SECURITY.md) |
| KI-012 | Workers/Hyperdrive **não validados**: a API roda em Node (Hono, `pg`). Não há deploy em dev/staging nesta fase (sem conta Cloudflare). Ambientes dev/test/staging estão definidos só como configuração/CI | P1 | Bloqueio externo (KI-006) |
| KI-013 | Frontend limitado a casca estática + design tokens (`apps/web`); sem React/Vite/PWA ainda | P3 | Planejado (Fase 2) |
| KI-014 | Teste de RLS roda com superusuário apenas para fixtures; produção usa `app_rw`. Testes não cobrem Hyperdrive/pooling (SET LOCAL é por transação, compatível com pooling em modo transaction, não exercitado) | P2 | Validar em staging |
| KI-015 | Anexos: adaptador **R2 privado não implementado/validado**; há `LocalDiskStorage` (dev) e `MemoryStorage` (teste); em produção o storage responde 503 até existir adaptador. URLs assinadas são HMAC próprias (300 s), não presigned do R2 | P1 | Bloqueio externo (conta Cloudflare) |
| KI-016 | UI da Fase 2 é mínima: login, busca, nova OS, orçamento (itens/publicar/aprovação assistida). **Faltam na UI**: vistoria (marcações, fotos, termo), upload, diff entre versões, execução/exceção. Decisão assistida usa `prompt()` do navegador (provisório) | P2 | Pendente (Fase 2b) |
| KI-017 | Teste de ponta a ponta da UI foi **manual/scriptado uma vez** (Playwright local, 390 px); não está na CI. Sem teste de acessibilidade automatizado nem Lighthouse | P2 | Planejado |
| KI-018 | Busca p95 medida na API local com 10k clientes/3k veículos (~25 ms); não representa Hyperdrive/rede/Postgres gerenciado | P2 | Reavaliar em staging |
| KI-019 | Sem `Idempotency-Key` em mutações (ARCHITECTURE); duplicidade é contida por constraints (aprovação única por item, execução única por item), não por chave | P2 | Planejado (Fase 3, antes do portal) |
| KI-020 | CPF/CNPJ do cliente (`doc_enc`/`doc_hash`) **não implementado** (opcional no modelo) | P3 | Planejado |
| KI-021 | Portal acessa o banco com ator `tenant` + escopo `unit_ids=[unidade da OS]` e consultas filtradas por `os_id` derivado da sessão; **não há ator RLS dedicado `portal`** (isolamento por OS depende do código, coberto por testes de IDOR) | P2 | Risco residual aceito; avaliar ator `portal` com policy por `os_id` |
| KI-022 | **OTP real não validado**: canais existentes são `Memory` (simulado, testes), `Unconfigured` (503 em produção) e e-mail provisório (prova e-mail, não telefone). Nenhum SMS/WhatsApp. Ver KI-003/KI-010 | P1 | Bloqueio externo (decisão do usuário + provedor) |
| KI-023 | Não existe Service Worker; quando houver (PWA), **deve excluir `/portal` e `/api/portal`** do cache. Respostas já saem `Cache-Control: no-store` | P2 | Regra registrada |
| KI-024 | Processador do outbox (`processOutbox`) existe e é testado, mas **não está agendado** (sem infraestrutura de fila/cron). Notificações só saem e-mail e dependem de KI-010 | P1 | Bloqueio externo |
| KI-025 | Renovação de link só pela equipe (autoatendimento do cliente com nova verificação não implementado) | P3 | Planejado |
| KI-026 | UI do portal é mínima (aprovar/recusar, OTP, timeline, chat texto). Faltam: upload de fotos/documentos pelo cliente na UI, editor visual do tema (API pronta), QR/links na tela da equipe, teste E2E/Lighthouse. Contraste AA validado só para a cor primária do tema | P2 | Pendente |
| KI-027 | `Idempotency-Key` (KI-019) continua não implementado; aprovação do portal é protegida por OTP de uso único + unicidade por item | P2 | Planejado |
| KI-028 | UI de produção mínima: Kanban com arrastar/teclado/seletor; **faltam na UI** tarefas (criar/atribuir/iniciar/pausar), agenda (dia/semana/mês), config de etapas/boxes e fotos de tarefa. API completa e testada. Acessibilidade do Kanban verificada apenas por revisão (sem teste automatizado/leitor de tela) | P2 | Pendente |
| KI-029 | Conflito de box usa janela **planejada** (`planned_start/end`); tempo real excedendo o planejado não bloqueia o box seguinte. Lista de espera e conflitos avançados: Fase 9 | P3 | Planejado |
| KI-030 | Custo/hora (`employee_rates`) por funcionário sem histórico de vigência; `labor` usa a taxa atual. Fase 5 deve versionar | P2 | Planejado (Fase 5) |
| KI-031 | Mecânico restrito à própria tarefa é regra da **API** (não RLS); isolamento de unidade e tenant segue por RLS | P2 | Risco residual aceito |
| KI-032 | **Sem UI financeira**: Fase 5 entrega só API (faturar, receber, pagar, caixa, DRE, conciliação, lucro por OS). Nenhum gráfico/tela de dashboard foi feito (e gráficos não contariam como "financeiro pronto") | P2 | Pendente |
| KI-033 | Valores em **centavos (bigint)** em vez de `numeric(14,2)` de FINANCIAL_RULES §1 (decisão D-004; consistente com Fase 2). Arredondamento HALF_EVEN só nas regras de juros/multa/overhead | P3 | Documentado |
| KI-034 | Juros/multa: regra **v1** simples (multa única % + juros simples pro rata die, mês de 30 dias), parâmetros por tenant sem histórico de vigência; desconto na quitação, abatimentos e renegociação **não implementados** | P2 | Planejado |
| KI-035 | Estorno de recebimento libera a parcela, mas **não estorna** o vínculo com documentos fiscais (fora de escopo). Competência de estorno = data do estorno (não retroage o mês original) | P3 | Documentado |
| KI-036 | Mão de obra no lucro por OS é **estimada** (tempo apontado × custo/hora atual) e não gera lançamento no ledger (evita duplicar folha). DRE de competência não inclui mão de obra a menos que a folha seja lançada como despesa/custo | P2 | Documentado |
| KI-037 | Conciliação básica: importação de extrato via JSON (sem OFX/CSV), sugestão por valor + janela de ±3 dias; sem conciliação de lote (1 linha = 1 lançamento) | P3 | Planejado |
| KI-038 | Comprovantes (anexos) de contas a pagar e "compromisso comercial" informativo na aprovação **não implementados** (anexos hoje exigem OS) | P3 | Planejado |
| KI-039 | Recebimento manual apenas (gateway só na Fase 8). Concorrência validada com bloqueio por documento + advisory lock de idempotência, **não** sob carga real nem com pooling (Hyperdrive) — KI-014 | P2 | Validar em staging |
| KI-040 | Alçadas (desconto/estorno) são por **permissão + limite do tenant**; fluxo de aprovação em duas pessoas (solicitar → aprovar) não existe | P3 | Planejado |
| KI-041 | **Lighthouse não medido** (critério 1 é meta). Verificado apenas: HTML completo sem JS (testes via `app.request`), sem JS/imagens externas, CSS inline mínimo, ETag/304. Medir em staging com CDN | P1 | Planejado |
| KI-042 | **Turnstile não validado** contra o serviço real (sem chaves/rede). Testado com `MemoryCaptcha`; sem `TURNSTILE_SECRET` em produção o formulário falha fechado (503) | P1 | Bloqueado (credenciais) |
| KI-043 | Estatísticas contam só requisições que chegam à API: páginas servidas por cache de borda/CDN não são contadas (subcontagem). Sem purge de CDN: invalidação é por ETag + `s-maxage=300` (propagação até ~5 min) | P2 | Planejado |
| KI-044 | Páginas públicas são servidas pela própria API (Node), não por hospedagem SSR/CDN dedicada; deploy/Workers não validados (ver KI-012) | P2 | Planejado |
| KI-045 | Sem "converter lead em cliente/OS" e sem deduplicação de leads (mesmo telefone gera novo lead); CRM é o funil básico | P2 | Planejado (Fase 7) |
| KI-046 | "Copiar endereço" e Web Share exigem JS e **não foram implementados** (o site é zero-JS); endereço é texto selecionável e o compartilhamento é link `wa.me` | P3 | Decisão de projeto |
| KI-047 | UI de Presença Digital é **mínima**: edição do site por JSON validado (não há editor visual WYSIWYG, nem upload de mídia/histórico/restauração na UI — API pronta e testada). Leads: lista + troca de status | P2 | Planejado |
| KI-048 | Ator RLS `public` (leitura sem sessão) tem políticas estreitas (tenant ativo/trial, versão publicada, mídia), mas a **gravação do lead** muda para contexto de tenant após buscar o slug (mesmo risco residual de KI-011/KI-021) | P2 | Risco residual aceito |
| KI-049 | Imagens servidas como enviadas (≤5 MB, validadas por magic bytes): **sem redimensionamento/srcset/WebP** automáticos; pode afetar Performance no Lighthouse | P2 | Planejado |
| KI-050 | Compra (entrada de estoque) lança D Estoque / C "Compras a faturar (GRNI)"; **não gera contas a pagar/parcelas** nem concilia com NF do fornecedor — o pagamento ao fornecedor segue o fluxo de payables da Fase 5 separadamente (risco de lançamento em duplicidade se o usuário lançar a NF também como despesa) | P1 | Planejado |
| KI-051 | Compras são imutáveis (append-only): correção por ajuste de inventário; sem cancelamento/estorno de compra nem devolução ao fornecedor | P2 | Planejado |
| KI-052 | Sem transferência entre unidades, sem lote/validade, sem leitor de código de barras na UI (a API busca por código) | P2 | Planejado |
| KI-053 | Consumo/reserva exigem OS `open`; estoque da unidade da OS. `stock:consume` limitado a estoquista/gerência (mecânico não consome pelo app ainda) | P2 | Decisão de projeto |
| KI-054 | Cupom **não é aplicado automaticamente** na fatura: `/crm/coupons/redeem` registra o uso e devolve o desconto; o operador informa o desconto na fatura (sujeito à alçada). Pontos resgatados também não viram desconto automático | P1 | Planejado |
| KI-055 | Campanhas só por e-mail (WhatsApp na Fase 8 — REM-001); provedor de e-mail real pendente (KI-010). Link de opt-out no e-mail depende de o template "notification" renderizar `optOutUrl` (variável enviada, template real não validado) | P1 | Bloqueado (KI-010) |
| KI-056 | Satisfação registrada pela equipe (sem pesquisa automática ao cliente/portal); NPS simples | P2 | Planejado |
| KI-057 | Recuperação de orçamento/inativos são consultas on-demand (sem agendador automático de campanhas/lembretes); lembretes não geram envio sozinhos | P2 | Planejado (Fase 8/9) |
| KI-058 | UI de Estoque e CRM mínima (só leitura de saldos/métricas/lembretes e prévia/disparo de campanha); cadastro e movimentos via API | P2 | Planejado |
| KI-059 | `stock_levels` recebe `UPDATE(updated_at)` para `SELECT … FOR UPDATE`; saldo só muda via trigger SECURITY DEFINER (testado: UPDATE direto falha) | P3 | Risco residual aceito |
| KI-060 | Pontos/lembretes/indicação: regras simples (1 pt/R$ configurável; bônus fixo de indicação na 1ª OS faturada); sem expiração de pontos nem antifraude de indicação | P2 | Planejado |
| KI-061 | WhatsApp real **não validado**: adaptador Cloud API sem credenciais/app aprovado; templates sem aprovação; Embedded Signup não implementado (conexão manual por token via API) | P0 | Bloqueado (Meta) |
| KI-062 | Gateway de pagamentos real **não integrado** (ADR-0005 proposto, aguardando aprovação); só sandbox. Taxas de Mercado Pago/Stripe BR/Pagar.me **não verificadas** | P0 | Bloqueado (decisão + credenciais) |
| KI-063 | Valores em R$ por mensagem da Meta não verificados (tabela BRL não lida) | P2 | Planejado |
| KI-064 | Planos têm preço R$ 0 no seed: billing só foi testado com preços definidos pelo teste. **Defina os preços** | P1 | Decisão pendente do usuário |
| KI-065 | `runBilling` e `retryDue` não têm agendador (precisam de cron externo chamando `/platform/billing/run`); sem alertas/notificações de fatura/inadimplência ao dono | P1 | Planejado |
| KI-066 | Proração do upgrade assume período de 30 dias (plano anual não proporcional corretamente) e não cobre downgrade com crédito | P2 | Planejado |
| KI-067 | Web Push: sem chaves VAPID nem biblioteca de envio; produção usa `UnconfiguredPush` (503). Teste com `MemoryPush` | P2 | Bloqueado (chaves) |
| KI-068 | Cobrança online quota juros/multa na criação; se o pagamento chegar em dia diferente, o valor recebido é o cotado (`quoted_on`); divergência de valor vai para DLQ e exige tratamento manual | P2 | Aceito |
| KI-069 | Webhook de pagamento aceita um único provedor ativo (`deps.payments.name`); sem rotação do segredo de webhook por tenant | P2 | Planejado |
| KI-070 | WhatsApp: sem janela de 24h/mensagem livre, sem tratamento de mídia, sem fila de atendimento (só templates + status + "PARAR") | P2 | Planejado |
| KI-071 | `wa_lookup_by_definer` (política RLS por `current_user`) e `af.wa_tenant_for_phone` são o único acesso cruzado de tenants para webhooks (risco residual como KI-011/021) | P2 | Risco residual aceito |
| KI-072 | UI de Integrações/Assinatura mínima (leitura, desconectar, cancelar); conexão/rotação/troca de plano/cobrança só via API | P2 | Planejado |
