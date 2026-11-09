# AutoFlow — Estratégia de testes

## 1. Pirâmide e ferramentas (propostas)
Vitest (unidade/integração) · Postgres real em container/branch efêmero (sem mocks de banco) · Miniflare/Workers test pool · Playwright (E2E) · axe (acessibilidade) · k6 (carga básica, Fase 10) · OWASP ZAP baseline (segurança, Fase 10).

## 2. Ambientes e dados
`development`, `test`, `staging`, `production` separados. Fixtures **fictícias**; CPFs/telefones sintéticos; proibido copiar produção. Todo teste de integração cria **≥2 tenants** e **≥2 unidades**.

## 3. Suítes obrigatórias
- **Unitários:** cálculos financeiros, validações (placa, telefone, CPF/CNPJ), aprovações, permissões, entitlements.
- **Integração:** banco/constraints, API, autenticação, transações, provedores (mocks/sandbox).
- **E2E:** cadastro → OS → orçamento → aprovação → produção → pagamento → website → lead → portal.
- **Segurança:** IDOR, SQLi, XSS, CSRF, rate limit, acesso cruzado, escalada de privilégio, tokens (entropia, hash, expiração), uploads (MIME, tamanho, polyglot).
- **Multi-tenant:** A×B; funcionário × unidade não autorizada; cliente × OS de terceiros; Super Admin sem grant → negado; entitlement aplicado no backend (frontend adulterado não burla).
- **Financeiro:** parcial, estorno, parcelas, cancelamento, competência×caixa, conciliação, margem/lucro, concorrência.
- **Portal:** aprovação da versão correta, itens herdados indevidamente, revogação, expiração, reautenticação/OTP, renovação, histórico.
- **Meta-testes:** toda tabela de tenant tem RLS; toda rota declara permissão/entitlement; migrations aplicam e revertem em banco limpo.

## 4. Gates
Merge exige lint+tipos+unit+integração+isolamento verdes. Fase só conclui sem P0/P1 abertos nos fluxos essenciais. Falha crítica **não** é declarada como concluída.

## 5. Relatório por fase
Executado/resultado por teste; separar Implementado / Testado / Validado em produção / Bloqueado / Planejado.
