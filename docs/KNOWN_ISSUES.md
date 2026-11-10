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
