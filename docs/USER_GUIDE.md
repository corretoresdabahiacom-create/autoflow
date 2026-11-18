# Guia do usuário — AUTOFLOW 2.0 (rascunho)

> Baseado nas funções implementadas e testadas na API. A interface web cobre só parte dos fluxos (ver KI-085 e relatórios); onde indicado "via API", ainda não há tela. Revisar com usuários reais antes de publicar.

## 1. Primeiros passos (dono da oficina)
1. Aceite o convite recebido por e-mail e defina sua senha; ative a verificação em duas etapas se solicitada.
2. Cadastre unidades, equipe (convide mecânicos/atendentes com o papel adequado) e a conta financeira (caixa/banco).
3. Cadastre o catálogo de serviços e peças (estoque, com custo médio).

## 2. Atendimento diário
- **Cliente e veículo:** cadastre nome, telefone e placa. Marcar consentimento de marketing é opcional e separado.
- **Ordem de Serviço (OS):** crie a OS, monte o **orçamento** (serviços e peças) e **publique**.
- **Aprovação pelo cliente:** gere o **link do portal**; o cliente confirma por código (OTP) e aprova/recusa item a item. Cada aprovação é registrada com versão e evidência.
- **Produção:** atribua tarefas ao mecânico; ele inicia e conclui (o tempo é apontado).
- **Entrega e cobrança:** marque a OS como entregue, gere a fatura (à vista ou em parcelas) e registre o recebimento (PIX, dinheiro etc.). Recebimentos repetidos por engano não duplicam (idempotência).

## 3. Financeiro
Contas a receber, recebimentos, DRE por competência/caixa e razão contábil de dupla entrada. Valores em reais; tudo conciliado com o razão.

## 4. Recursos Premium
Seguradoras e sinistros, transferência de estoque entre unidades, comissões e adiantamentos, agenda e lista de espera, automações (WhatsApp de utilidade), relatórios consolidados. **Comissões/adiantamentos não substituem folha de pagamento** (consulte seu contador).

## 5. Privacidade dos clientes (LGPD)
Quando um cliente pedir seus dados: use **Exportar dados** (permissão `lgpd:manage`). Para pedido de eliminação use **Anonimizar** (exige motivo). Documentos fiscais e financeiros que a lei manda guardar permanecem; apenas os dados pessoais de cadastro são anonimizados. Tudo fica registrado.

## 6. Perguntas frequentes
- *O cliente não recebeu o código:* confirme o telefone/e-mail; o envio real por WhatsApp/e-mail depende de integrações ainda não ativas em produção.
- *Posso desfazer um lançamento financeiro?* Não se apaga; faz-se estorno (registro novo), por regra de auditoria.
