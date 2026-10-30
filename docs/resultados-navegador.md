# Resultados no navegador — 29/10/2026

Medições da interface Farcel com a base sintética de **1.000.000 de linhas preenchidas**. Fonte bruta: [`results/browser-million.json`](results/browser-million.json) (gerado por `npm run bench:browser`). Uma execução registrada; uma execução anterior no mesmo ambiente deu valores na mesma faixa (geração 24,5 s, edição 380 ms, primeira dinâmica 6,8 s).

## Ambiente

- Chromium 153 headless (Playwright 1.63), build de produção servida por `vite preview`.
- Linux x64 em contêiner, Intel Xeon 2,80 GHz, 4 CPUs lógicas, 16 GB de RAM.
- **Não é Windows, não é executável empacotado, não tem GPU real.** Os números do Node (prova técnica anterior) não se aplicam a este caso e vice-versa.

## Base

- Planilha **Dados**: cabeçalho + 1.000.000 de linhas × 5 colunas preenchidas (Região, Canal, Categoria — texto; Quantidade — inteiro; Receita — decimal com vírgula). 5.000.005 células.
- Planilha **Resumo**: 3 fórmulas sobre a base inteira — `=SOMA(Dados!E2:E1000001)`, `=SOMASE(Dados!A2:A1000001;"Sul";Dados!E2:E1000001)`, `=CONT.VALORES(Dados!A2:A1000001)`.
- Semente 20261029. Os três resultados conferem com o total calculado independentemente pelo gerador.

## Tempos

| Operação | Tempo |
| --- | --- |
| Gerar a base no worker (5 M entradas via `setUserInput`) | 22,6 s (preenchimento 13,3 s, limpeza do histórico de desfazer 7,6 s, cálculo inicial 0,64 s) |
| Tarefas longas na thread principal durante a geração | 0 |
| Saltar até a linha 1.000.001 (caixa de nome) até a grade desenhada | 65 ms |
| Saltar até o meio da planilha | 177 ms |
| Rolagem (60 eventos de roda): desenho de quadro | média 2,6 ms, p95 5,2 ms, máx. 9,5 ms |
| Rolagem: ida e volta de um bloco 64 × 16 ao worker | média 3,5 ms, p95 4,3 ms |
| Editar `Dados!E2` com recálculo das 3 fórmulas | 387 ms no motor; 420 ms até a grade atualizada |
| Dinâmica, 1ª execução (Linhas: Região; Valores: Soma de Receita) | 6,6 s (leitura de 2 colunas do IronCalc 6,4 s + agregação 0,1 s) |
| Dinâmica, adicionar Canal em Colunas | 1,7 s (leitura da coluna nova 1,5 s + agregação 0,19 s) |
| Dinâmica após editar `Dados!E3` | 0,26 s (correção de 1 célula + agregação; 0,12 s na execução anterior) |
| Salvar `.farcel` | 0,55 s, 24,2 MB |
| Abrir o `.farcel` em página nova | 1,0 s (inclui 0,46 s de recálculo) |

Leitura por coluna para a dinâmica: Região 1,2 s, Canal 1,5 s, Receita 5,2 s (números exigem conversão do texto do motor).

## Memória

| Momento | Memória linear WASM do worker | Heap JS da página | RSS de todos os processos Chromium |
| --- | --- | --- | --- |
| Pasta vazia | 1,3 MiB | 3,1 MiB | 463 MiB |
| Após gerar 1 M linhas | 595 MiB (pico; WASM não devolve memória) | 4,8 MiB | 1.168 MiB |
| Após a dinâmica | 595 MiB | 6,9 MiB | 1.322 MiB |
| Após reabrir o arquivo em página nova | 349 MiB | 4,7 MiB | 900 MiB |

O heap JS da página vem do protocolo DevTools (`Performance.getMetrics`); `performance.memory` do Chromium é arredondado e não serve. O RSS soma todos os processos Chromium encontrados por `ps`, inclusive o processo do navegador. A projeção colunar da dinâmica (3 colunas × 1 M de `Uint32Array`) fica no heap do worker, não medida separadamente (≈ 12 MB pelo tamanho dos arrays).

## Fórmulas por linha (WASM sob Node, não navegador)

Fonte: [`results/wasm-row-formulas.json`](results/wasm-row-formulas.json) (`node scripts/bench-wasm-formulas.ts`). Mesmo `wasm_bg.wasm`, executado no Node para isolar o motor: 1.000.000 de linhas × (2 valores + `=A{n}*B{n}`).

- Preenchimento 21,5 s + limpeza de histórico 5,0 s; primeiro cálculo 1,5 s.
- **Editar uma célula: 1,6 s**, porque o IronCalc 0.9.1 reavalia a pasta inteira a cada entrada.
- Memória linear WASM: 403 MiB.

Conclusão: com fórmulas em todas as linhas, a edição continua sem travar a interface (o cálculo está no worker), mas o valor novo demora mais de um segundo. É o principal ponto a resolver no motor (recálculo incremental) antes de prometer essa carga.

## O que estes números não dizem

- Nada sobre Windows, Tauri/Electron ou máquinas de clientes.
- Uma execução por cenário; sem metas de desempenho aprovadas.
- Cinco colunas de tipos simples; sem estilos, datas como datas, colunas largas ou muitos grupos distintos.
- Geração e primeira leitura da dinâmica dominam o tempo e dependem de chamadas célula a célula ao WASM. Uma API em lote no IronCalc (ou compilada por nós) deve reduzir ambas; não testado.

## Após a mudança visual — 30/10/2026

Mesmo benchmark, mesma máquina, depois da nova identidade visual. A grade passou a ler também o estilo de cada célula visível (negrito, alinhamento). Fonte: [`results/browser-million-2026-10-30.json`](results/browser-million-2026-10-30.json).

| Operação | 29/10 | 30/10 |
| --- | --- | --- |
| Gerar a base | 22,6 s | 23,3 s |
| Saltar até a última linha | 65 ms | 59 ms |
| Desenho de quadro na rolagem (p95) | 5,2 ms | 4,1 ms |
| Ida e volta de um bloco 64 × 16 (média / p95) | 3,5 / 4,3 ms | 4,2 / 6,7 ms |
| Editar com recálculo das 3 fórmulas | 387 ms | 344 ms |
| Dinâmica, 1ª execução | 6,6 s | 6,3 s |
| Dinâmica após editar a origem | 0,26 s | 0,20 s |
| Abrir o arquivo | 1,0 s | 0,97 s |
| Memória WASM após gerar | 595 MiB | 595 MiB |

Uma execução por data; variações de algumas dezenas de milissegundos estão dentro do ruído deste ambiente. O custo da leitura de estilos aparece só na ida e volta dos blocos.
