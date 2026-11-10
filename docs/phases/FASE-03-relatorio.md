# Relatório — Fase 3 (Portal do cliente)

## Implementado
Links por OS (token 256 bits, só hash), troca por sessão curta (idle 30 min / 4 h), timeline, orçamento por versão, aprovação/recusa por item com OTP, evidência (versão, itens, valores, hash apresentado, hora, hash de IP, canal/destino mascarado), chat, revogação/expiração/renovação, log de acesso, tema com rascunho/publicação/restauração, outbox de notificações com consentimento, página `/portal`.

## Testado (automatizado, 79 testes API + 15 shared passando)
| Critério | Cobertura |
|---|---|
| 1 token ≥256 bits, só hash, fora da URL | P1 |
| 2 IDOR/enumeração | P2 |
| 3 rate limit + atraso progressivo | P3 |
| 4 OTP + evidência completa | P4 |
| 5 versão correta; obsoleta → 409 | P5 |
| 6 revogação imediata, expiração, renovação | P6 |
| 7 `no-store` | P7 (não existe SW; ver KI-023) |
| 8 tema não oculta obrigatórios (API + CHECK no banco) | P8 |
| 9 contraste AA (função + API) | P9; mobile-first sem auditoria automatizada (KI-026) |
| 10 sem custo/margem/dados de terceiros | P10 |

## Validado em produção
Nada. Sem ambiente de produção/staging.

## Bloqueado por dependência externa
- **OTP real** (KI-003/KI-022): usado simulado (`Memory`) nos testes; produção responde 503. **Não declaro OTP validado.**
- Provedor de e-mail (KI-010) e agendamento do outbox (KI-024).
- Workers/R2 (KI-012/KI-015).

## Planejado
Ator RLS `portal` (KI-021), renovação pelo cliente (KI-025), UI completa do portal e editor de tema (KI-026), Idempotency-Key (KI-027), WhatsApp.

## Lembretes
- **REM-001 — integrar WhatsApp**: continua pendente (Fase 8; este é o fim da Fase 3, conforme combinado). WhatsApp seria o canal natural para OTP e notificações.
- Decisões suas pendentes: canal de OTP (e-mail + assistida proposta), provedor de e-mail, revisão jurídica das retenções (REM-003).
