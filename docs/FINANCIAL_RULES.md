# AutoFlow — Regras financeiras (Fase 0)

Documento **gerencial**. Não é contabilidade fiscal nem emissão de documento fiscal (ver ESCOPO FISCAL em INTEGRATIONS).

## 1. Princípios
1. **Ledger append-only**: nunca UPDATE/DELETE. Correção = estorno + novo lançamento (`reversal_of`).
2. **Partida dobrada** por transação contábil (`txn_id`): Σ débitos = Σ créditos, validado por constraint/trigger deferido.
3. Dois olhares: **competência** (quando o fato ocorre) e **caixa** (quando o dinheiro se move). Cada lançamento tem `competence_date` e, quando aplicável, `cash_date`.
4. Valores em `numeric(14,2)`, arredondamento HALF_EVEN documentado, rateios com tratamento de resto (centavo final na última parcela).
5. Aprovação de orçamento **não** gera recebimento. Pagamento ≠ aprovação.
6. Lucro estimado é sempre rotulado "gerencial estimado", nunca "lucro contábil/fiscal".

## 2. Estruturas
Plano de contas (receita, custo direto, despesa operacional, financeiras, ativo/passivo simples) · centros de custo (unidade, setor) · contas financeiras (caixa, banco, maquininha, carteira digital) · contas a pagar/receber · parcelas · pagamentos/recebimentos · **alocações** (um recebimento pode quitar várias parcelas e vice-versa) · conciliação (extrato × lançamentos) · fluxo de caixa (realizado e projetado).

## 3. Ciclo da OS
| Evento | Efeito financeiro |
|---|---|
| Orçamento aprovado (itens aprovados) | **Compromisso comercial** (registro informativo, sem receita) |
| Execução/consumo | Registra custo (peças/materiais/terceiros/mão de obra direta) |
| Conclusão/entrega | Permite **faturar**: cria conta a receber + parcelas; reconhece **receita por competência** |
| Pagamento | Cria recebimento + alocação nas parcelas; movimenta conta financeira (caixa) |
| Cancelamento | Ajustes documentados via estorno; motivo obrigatório; aprovação conforme alçada |

Itens não aprovados **não** entram no faturamento.

## 4. Contas a receber
Parcelas com vencimento; recebimentos parciais; descontos (com motivo/alçada); juros e multa configuráveis (calculados por regra versionada, não por UPDATE de saldo); status derivado (aberta, parcial, quitada, vencida, cancelada) — **calculado**, não armazenado como verdade.

## 5. Contas a pagar
Fornecedores, peças, materiais, funcionários, aluguel, energia, água, terceirizados, impostos, outros; recorrências; parcelamento; anexos de comprovantes; baixa gera lançamento de caixa.

## 6. DRE gerencial
Por **competência** e por **caixa**, separadamente: Receita bruta → (−) descontos → Receita líquida → (−) Custos diretos → **Margem de contribuição** → (−) Despesas operacionais → **Resultado operacional** → (±) Resultado financeiro → Resultado gerencial. "Receita recebida" é indicador de caixa. Impostos sobre receita só quando configurados.

## 7. Lucro por OS
Receita aprovada/faturada − peças − materiais − mão de obra direta (custo/hora × tempo apontado) − terceirizados − descontos − custos adicionais = **margem de contribuição**; **resultado operacional estimado** = margem − rateio configurável de despesas fixas (por horas, por faturamento ou fixo). Ambos exibidos separados.

## 8. Concorrência e consistência
Operações financeiras em transação única com `SERIALIZABLE` ou travas por conta/parcela; `Idempotency-Key` em recebimentos; reprocessamento de webhook não duplica lançamento (`UNIQUE(provider_event_id)`).

## 9. LGPD × imutabilidade
Ledger guarda IDs; dados pessoais ficam em tabelas relacionadas, que podem ser **anonimizadas** sem alterar valores/datas.

## 10. Casos de teste obrigatórios (Fase 5)
Recebimento parcial · quitação por múltiplas parcelas · estorno de recebimento · cancelamento de OS faturada · competência vs caixa em meses diferentes · rateio com centavos · juros/multa · desconto acima da alçada · conciliação · margem e resultado · idempotência · concorrência de dois recebimentos na mesma parcela.
