# Plano de rollback

Princípio: **migrações são forward-only**. Reverter código sem reverter o banco só é seguro se a migração nova for **compatível com a versão anterior** (aditiva). Toda migração deve ser escrita assim (expand → migrate → contract em releases separados).

## Cenário A — bug no código, sem migração nova (ou só aditiva)
1. Redeploy da **versão anterior** (imagem/tag anterior). Banco permanece.
2. Smoke (`/ready`, login, abrir OS). Tempo estimado: minutos.

## Cenário B — migração aditiva problemática
1. Reverter código (A). A coluna/tabela nova fica ociosa.
2. Corrigir por nova migração (forward). Nunca editar a aplicada.

## Cenário C — dado corrompido / migração destrutiva errada
1. **Parar escrita** (modo manutenção/desligar API).
2. Restaurar o **backup tirado no passo 2 do deploy** em um banco novo (`pg_restore`), validar invariantes (`ops/restore-drill.sh` mostra quais), apontar `DATABASE_URL` para ele.
3. Perdas: tudo escrito após o backup (RPO do deploy = tempo desde o backup). Com PITR, restaurar até o instante anterior ao deploy.
4. Comunicar clientes afetados; registrar incidente.

## Teste
- Ensaio local do Cenário C: `ops/restore-drill.sh` (medido: RTO técnico ≈ 2 s para ~650 KB; **não extrapolável** para produção).
- Cenários A/B: **não ensaiados** em ambiente real (não há ambiente).
