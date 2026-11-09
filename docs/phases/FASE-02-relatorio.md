# Fase 2 — Relatório (Clientes e OS)

Data: 2026-11-09. Cada item aparece em uma única categoria.

## Implementado e testado (API, Postgres 16 local, Node 22)
| Critério | Evidência |
|---|---|
| 1 Placa única por tenant | `phase2.test` C1: mesma placa em 2 tenants OK e isolada; duplicada → 409 |
| 2 Numeração sem duplicidade | C2: 50 criações concorrentes → 1..50; numeração independente por unidade |
| 3 Versão publicada imutável + diff | C3: triggers bloqueiam UPDATE/DELETE (inclusive superusuário); edição cria v2; diff correto |
| 4 Herança por hash | C4 + testes puros: alterado não herda, idêntico herda, recusa não herda (regra em FASE-02) |
| 5 Aprovação ≠ pagamento | C5: só `approvals` e `audit_log` mudam; não existe estrutura financeira ainda |
| 6 Bloqueio de execução | C6: pendente/recusado/fora de versão bloqueados; exceção exige política, permissão, justificativa, evidência e teto |
| 7 Upload/URL assinada | C7: tamanho, MIME, magic bytes; arquivo só por URL assinada (300 s); expirada/adulterada/outro tenant negadas; anexo não removível |
| 8 Termo de entrada | C8: PDF gerado (`%PDF-`), armazenado, vistoria imutável após confirmar |
| 9 Busca < 300 ms | C9: p95 ≈ 25 ms (10k clientes, 3k veículos), **local** |
Resultado: `pnpm typecheck` limpo; 13 testes (shared) + 62 (api) passando.

## Implementado, validação parcial
- **Critério 10 (UI):** casca React mobile-first com estados carregando/erro/vazio/offline; percurso login → nova OS → orçamento → publicar → aprovar → busca → banner offline executado **uma vez** em Chromium 390 px (prints conferidos). Um bug real (crash ao alternar busca/lista) foi achado nesse teste e corrigido. **Não** está na CI; sem auditoria de acessibilidade automatizada.
- UI **não cobre** vistoria, upload, diff, execução/exceção (API pronta e testada) — KI-016. Aprovação assistida usa `prompt()` provisório.

## Não validado / bloqueado
- R2 privado (KI-015), Workers/Hyperdrive (KI-012), e-mail (KI-010), CI nunca executada (sem runner).
- Sem `Idempotency-Key` (KI-019); CPF/CNPJ opcional não implementado (KI-020).
- Desempenho medido só localmente (KI-018).

## Severidades
P0: nenhum conhecido. P1 abertos: KI-005, KI-010, KI-012, KI-015 (bloqueiam produção, não o desenvolvimento). Sem revisão de segurança independente.

## Lembrete (REM-001)
**WhatsApp**: adiado por sua decisão; será tratado ao fim da Fase 3 (canal do OTP do portal) e na abertura da Fase 8. A Fase 3 **depende** de decidir o canal de OTP (KI-003).
Pendentes de você: canal OTP (KI-003), provedor de e-mail (KI-010), revisão jurídica das retenções (REM-003), aprovação da Fase 3.
