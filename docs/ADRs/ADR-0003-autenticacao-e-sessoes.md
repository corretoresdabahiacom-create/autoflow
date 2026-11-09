# ADR-0003 — Autenticação, sessões e MFA

Status: **PROPOSTO — requer aprovação** (impacto em segurança)

## Contexto
Identidade global de usuário com memberships por tenant; Super Admin separado; cliente do portal sem conta.

## Decisão recomendada
- **Auth própria** no Worker (sem dependência de SaaS de identidade no MVP), com biblioteca auditada onde possível.
- Senhas: Argon2id (WASM) ou scrypt/PBKDF2 com parâmetros fortes via WebCrypto se WASM inviável; parâmetros documentados. *Teste de custo de CPU no Worker é pré-requisito da Fase 1.*
- Sessões: ID opaco aleatório em cookie `HttpOnly; Secure; SameSite=Lax`, hash armazenado no banco, rotação no login/elevação de privilégio, expiração absoluta + inatividade; revogação por dispositivo.
- CSRF: SameSite + token duplo para mutações em cookies; Origin check.
- MFA TOTP: **obrigatório para Super Admin**, opcional/forçável por tenant para owner/admin/financeiro.
- Rate limiting + lockout progressivo no login/reset (Durable Object ou tabela com janela).
- Reset de senha e convites: token aleatório, hash armazenado, expiração curta, uso único.
- Super Admin: pool de usuários **separado** (`platform_users`) e host/rota distinta; sem token compartilhável.

## Alternativas
Provedor de identidade externo (Clerk/Auth0/Neon Auth etc.): acelera, mas adiciona custo por MAU e acoplamento; reavaliar se o custo de manter auth própria superar o benefício.

## Consequências
Mais responsabilidade de segurança interna → exige suíte de testes de auth (ver TEST_STRATEGY) e revisão antes de produção.
