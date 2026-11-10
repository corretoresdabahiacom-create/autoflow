# Relatório — Fase 4 (Produção e agenda básica)

## Implementado
Etapas configuráveis (padrão criado no primeiro uso), Kanban, mudança de etapa notificando o portal por outbox, tarefas simultâneas por OS com responsável/box/prazo, iniciar/pausar (motivo obrigatório)/retomar/concluir/cancelar, tempo apontado, atraso calculado, fotos por tarefa, funcionários + custo/hora, cálculo de mão de obra, agenda básica.

## Testado (automatizado; 90+ testes API passando)
| Critério | Teste |
|---|---|
| 1 concluir tarefa não conclui a OS | D1 |
| 2 simultâneas em boxes distintos; box sem sobreposição (EXCLUDE; 10 requisições concorrentes → 1 sucesso) | D2 |
| 3 mecânico vê só suas tarefas/unidade; sem rotas de gestão; isolamento entre tenants | D3 |
| 4 pausa/atraso calculados; motivo obrigatório (API e CHECK) | D4 |
| 5 etapa → histórico + timeline + outbox atômicos; etapa inválida sem rastro | D5 |
| 6 tempo apontado → minutos × custo/hora (centavos) | D6 |
| 7 DnD acessível por teclado, mobile | **implementado, não testado automaticamente** (KI-028) |
Agenda: dia/semana, filtro por box, reagendar, cancelar com motivo, conflito de box.

## Validado em produção
Nada (sem ambiente).

## Bloqueado por dependência externa
OTP real, provedor de e-mail e agendamento do outbox (KI-003/010/022/024); Workers/R2 (KI-012/015). A notificação de etapa só chega ao cliente quando esses itens existirem.

## Planejado
UI de tarefas/agenda/config (KI-028), versionar custo/hora (KI-030, Fase 5), lista de espera e conflitos avançados (Fase 9).

## Lembretes
- **REM-001 — integrar WhatsApp**: pendente (Fase 8; abertura obrigatória lá).
- Decisões suas pendentes: canal de OTP, provedor de e-mail, revisão jurídica das retenções (REM-003).
