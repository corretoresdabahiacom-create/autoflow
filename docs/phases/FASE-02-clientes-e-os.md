# Fase 2 — Clientes e OS

## Escopo
Clientes e veículos (busca por placa/telefone/nome/OS); OS com numeração por tenant+unidade; vistoria com fotos, marcações de dano, km/combustível, confirmação e termo de entrada (PDF); orçamento versionado (versões imutáveis após publicação, diff entre versões); **modelo de aprovações** vinculado a versão+item+hash, aprovação/recusa parcial e fluxo **assistido** pela oficina (o canal do cliente vem na Fase 3); bloqueio de execução não autorizada; anexos em R2 privado com URLs assinadas.

## Critérios de aceite
1. `UNIQUE(tenant_id, plate)`; mesma placa em tenants diferentes permitida e isolada.
2. Numeração de OS sem duplicidade sob 50 criações concorrentes (teste).
3. Versão publicada não pode ser editada/apagada (trigger + teste); alteração cria v+1 e mostra diff.
4. Item aprovado na v1 **não** é herdado na v2 se quantidade/preço/escopo mudou (hash diferente); se idêntico, regra explícita documentada e testada.
5. Aprovação ≠ pagamento: aprovar não cria recebimento.
6. Serviço adicional sem aprovação é bloqueado no backend; exceção só por procedimento específico configurado, com justificativa e evidência.
7. Upload valida tamanho/MIME/magic bytes; arquivo nunca público; URL assinada expira.
8. Termo de entrada gerado e armazenado.
9. Busca por placa/telefone/nome/nº OS < 300 ms p95 em dataset de teste (10k clientes).
10. Responsivo mobile-first; estados loading/erro/vazio/offline. Sem P0/P1.
