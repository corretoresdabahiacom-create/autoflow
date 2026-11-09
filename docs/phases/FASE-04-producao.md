# Fase 4 — Produção

## Escopo
Etapas configuráveis por tenant/unidade; Kanban; múltiplas tarefas simultâneas por OS; responsáveis, boxes, prazo, tempo apontado, atrasos, paralisação com motivo, fotos; funcionários e papéis; **agenda básica** (dia/semana/mês, por unidade/box/funcionário, reagendar, cancelar). Lista de espera e conflitos avançados ficam na Fase 9.

## Critérios de aceite
1. Concluir tarefa **não** conclui a OS.
2. Tarefas simultâneas em boxes diferentes; um box não recebe duas tarefas sobrepostas (constraint/EXCLUDE).
3. Mecânico vê apenas suas tarefas/unidade; testes de escopo.
4. Pausas e atrasos calculados; motivo obrigatório.
5. Mudança de etapa notifica portal (via outbox) sem perda.
6. Tempo apontado alimenta custo de mão de obra (preparação para Fase 5).
7. Drag-and-drop acessível por teclado; mobile utilizável.
