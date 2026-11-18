# Revisão de segurança — Fase 10

> **Escopo e honestidade:** revisão **interna** e testes automatizados. **Não houve pentest independente nem ZAP/scan dinâmico** (sem alvo hospedado, sem ferramenta executável aqui). O critério 3 ("pentest/ZAP baseline sem críticos/altos") **não está atendido**.

## Executado e verificado
| Item | Como | Resultado |
|---|---|---|
| Dependências de produção | `pnpm audit --prod` | Nenhuma vulnerabilidade conhecida (2026-11-18) |
| Cabeçalhos (nosniff, frame, sem X-Powered-By) em sucesso/erro/404 | `test/security.test.ts` | Ok |
| Sem vazamento de stack/SQL/caminhos em erros | idem (entradas malformadas, injeção em path) | Ok |
| Rotas protegidas sem sessão → 401; `/metrics` sem token negado | idem | Ok |
| Cookie de sessão HttpOnly + SameSite, sem Domain | idem | Ok |
| CSRF: Origin hostil em mutação → 403 | idem | Ok |
| Isolamento entre tenants por ID (leitura, escrita, export LGPD) | idem + suíte de isolamento/RLS (meta-testes) | Ok |
| Toda rota não pública exige auth/permissão; toda tabela com tenant_id tem RLS forçada | meta-testes do roteador e do banco | Ok |
| Jornada E2E multi-papel | `test/e2e.test.ts` | Ok; achou 1 defeito (portal bloqueado em tenant `trial`) — **corrigido** |
| RLS preservada após restore | `ops/restore-drill.sh` | Ok |

## Achado desta fase
- **Corrigido:** portal do cliente retornava `403 portal_unavailable` para oficinas em `trial` (equipe funcionava). Agora `trial` e `active` são aceitos; `suspended`/`cancelled` seguem bloqueados.

## Não executado / limites
- Pentest independente, OWASP ZAP baseline, fuzzing, análise estática dedicada (SAST), varredura de imagem/container: **não executados** (KI-087).
- Rate limit/lockout testados em unidade; **não** sob ataque distribuído real e dependem do IP real atrás do proxy (configurar confiança de proxy corretamente na infra).
- Turnstile real, TLS/HSTS efetivo, CSP do site SSR contra o domínio final: **não validados** sem ambiente.
- Gestão de segredos/rotação de `ENCRYPTION_KEY`: processo não ensaiado.
