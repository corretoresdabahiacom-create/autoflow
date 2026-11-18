# Desempenho — Fase 10

## Metas (p95)
Leituras de lista/relatório ≤ **300 ms**; escritas ≤ **600 ms**; `/health` ≤ 50 ms. Definidas por mim como ponto de partida; **você pode ajustar** conforme SLA comercial.

## Medição (local, `LOAD=1 npx vitest run test/load.test.ts`; dados em `docs/perf-results.json`)
Condições: 1 processo, handler chamado **em processo** (sem rede/TLS/proxy), Postgres local na mesma máquina, ~150 clientes, concorrência 10–25, 100–500 requisições por endpoint, 0 erros.

| Endpoint | p50 ms | p95 ms | p99 ms | Meta p95 |
|---|---|---|---|---|
| GET /customers | 41,8 | 68,9 | 78,1 | 300 ✔ |
| GET /orders | 45,3 | 64,2 | 72,5 | 300 ✔ |
| GET /finance/receivables | 47,1 | 62,2 | 68,5 | 300 ✔ |
| GET /finance/dre | 24,1 | 38,4 | 40,6 | 300 ✔ |
| GET /reports/consolidated | 27,0 | 34,8 | 39,0 | 300 ✔ |
| POST /orders | 41,1 | 60,9 | 67,8 | 600 ✔ |
| GET /health | 2,4 | 5,1 | 5,5 | 50 ✔ |

## Limites desta medição (não é validação de produção)
- Máquina de desenvolvimento, não a infraestrutura-alvo; sem latência de rede nem TLS.
- Volume pequeno (centenas de linhas). Com milhões de linhas/tenants reais, planos de consulta podem mudar — **sem teste de volume**.
- Teste não simula mistura realista de uso, picos, nem portal público/site SSR sob carga.
- Hash de senha (scrypt) pesa ~160 ms por login (KI-005): login em rajada é o ponto de CPU a observar.
- Lighthouse e Web Vitals **não medidos** (KI-041).
