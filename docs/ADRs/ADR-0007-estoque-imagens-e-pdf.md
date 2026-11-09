# ADR-0007 — Estoque (custeio), imagens/anexos e PDF

Status: **PROPOSTO — parte "estoque" decidida na Fase 7; imagens/PDF na Fase 2**

## Custeio de estoque
Recomendado **custo médio ponderado móvel** por item+unidade (simples, aceito gerencialmente). Alternativa PEPS fica fora do MVP. Movimentos de estoque são append-only; ajustes por inventário geram movimento compensatório.

## Imagens e anexos
- R2 com **bucket privado**; acesso apenas por **URLs assinadas curtas** emitidas pela API após checagem de tenant/OS/permissão.
- Upload direto via URL pré-assinada com limite de tamanho e `Content-Type` permitido; validação por magic bytes após upload (fila); renomear com UUID; remover EXIF/GPS de fotos expostas ao portal quando configurado.
- Derivados (miniaturas, WebP/AVIF): **Cloudflare Images / Image Transformations** como primeira opção (custo por transformação a validar); alternativa: pipeline em Worker com `wasm` (sharp inviável em Workers).
- Antimalware: scan assíncrono por provedor externo ou ClamAV em serviço próprio — **avaliar custo na Fase 2**; arquivos ficam `quarantined` até aprovados. Documentos (PDF/DOC) de clientes só liberados após scan quando o recurso estiver ativo; sem scanner, restringir tipos a imagens + PDF gerado pelo sistema.
- Conteúdo público do site (galeria) em prefixo/bucket separado e publicável.

## PDF (termo de entrada, orçamento, recibo)
Geração em HTML→PDF por serviço dedicado (Browser Rendering da Cloudflare ou biblioteca em Worker). Escolha final na Fase 2 por custo/limites. PDFs são **documentos operacionais, não fiscais**.
