# Fase 3 — Portal do cliente

## Escopo
Link/token por OS (hash), troca por sessão curta, QR de acompanhamento, linha do tempo, fotos, orçamento por versão, aprovação/recusa por item com **OTP**, chat por OS (texto/fotos/documentos), notificações (conforme canal/consentimento), revogação/renovação/expiração (90 dias pós-entrega, configurável), log de acesso, personalização do portal com rascunho/publicação/restauração e **informações obrigatórias não ocultáveis**.

## Critérios de aceite
1. Token com ≥256 bits; só hash armazenado; token removido da URL após troca.
2. Token de uma OS nunca acessa outra (teste de enumeração/IDOR).
3. Rate limit e atraso progressivo em tentativas inválidas.
4. Aprovação exige OTP do telefone cadastrado; evidência completa (versão, itens, valores, hash, data/hora, IP hash).
5. Aprovação da **versão correta**; versão obsoleta não aprovável.
6. Revogação imediata e expiração efetivas; renovação exige verificação.
7. Portal fora do cache do SW; `no-store`.
8. Editor de tema não consegue ocultar campos obrigatórios (teste).
9. Contraste WCAG AA validado; mobile-first.
10. Sem exposição de custo/margem/dados de terceiros. Sem P0/P1.

## Dependência externa
Canal de OTP (KI-003). Sem credencial: mocks + fluxo assistido; **não** declarar OTP real validado.
