# Política de Privacidade — AUTOFLOW 2.0

> ⚠️ **RASCUNHO — REVISÃO JURÍDICA PENDENTE.** Não é aconselhamento jurídico e não foi revisado por advogado. **Não publicar** antes da revisão (inclui definir encarregado/DPO, bases legais finais e prazos de retenção — REM-003).

## 1. Quem é o controlador
- Dados de **cadastro e cobrança dos Clientes** (oficinas): AUTOFLOW [razão social/CNPJ] — controlador.
- Dados dos **clientes finais das oficinas** (nome, telefone, e-mail, veículo/placa, histórico de serviços): a oficina é controladora; a AUTOFLOW é operadora.
- Encarregado (DPO): [nome/contato — pendente].

## 2. Dados tratados e finalidades (mapa técnico)
| Dado | Finalidade | Base legal sugerida (a validar) |
|---|---|---|
| Identificação e contato do cliente final | Prestar o serviço, orçamento, aprovação e comunicação sobre a OS | Execução de contrato / procedimentos preliminares (art. 7º, V) |
| Veículo/placa, itens, valores | Execução e histórico do serviço, garantia | Execução de contrato; exercício de direitos |
| Documentos e lançamentos financeiros/fiscais | Obrigações legais e contábeis | Cumprimento de obrigação legal (art. 7º, II) |
| Aprovações (versão, IP com hash, horário, user-agent) | Prova de consentimento/aprovação do orçamento | Exercício regular de direitos (art. 7º, VI) |
| Mensagens de marketing/campanhas | Comunicação promocional | **Consentimento** (art. 7º, I) — base de marketing a confirmar com jurídico |
| Logs de segurança e auditoria (sem conteúdo pessoal sensível) | Segurança e prevenção a fraude | Legítimo interesse (art. 7º, IX) |

## 3. Compartilhamento
Provedores de infraestrutura/banco, e-mail, mensageria (ex.: Meta/WhatsApp), pagamentos [a definir — ADR-0005] e antifraude (Turnstile). Lista final e transferências internacionais: [a preencher após escolha dos fornecedores].

## 4. Retenção
Conforme `docs/LEGAL_RETENTION.md` (proposta; **prazos pendentes de revisão jurídica**). Dados com obrigação legal são mantidos; os demais são eliminados ou anonimizados a pedido, observadas as exceções do art. 16 da LGPD.

## 5. Direitos do titular (art. 18)
Confirmação, acesso, correção, anonimização/eliminação, portabilidade, informação sobre compartilhamento, revogação de consentimento. **Implementado na plataforma:** exportação de dados e anonimização por cliente, com registro de evidência (permissão `lgpd:manage`). Canal de atendimento do titular: [e-mail — pendente]. Prazo de resposta: [definir].

## 6. Segurança
Isolamento por oficina em banco (RLS), senhas com hash forte, cookies seguros, auditoria, minimização de PII em logs. Nenhum sistema é infalível; incidentes relevantes serão comunicados à ANPD e aos titulares conforme a lei [procedimento a formalizar].

## 7. Cookies
Sessão estritamente necessária (HttpOnly). Sem cookies de publicidade. [Confirmar após definir analytics.]

## 8. Atualizações
Publicaremos a versão vigente com data. Versão: rascunho 0.1 — 2026-11-18.
