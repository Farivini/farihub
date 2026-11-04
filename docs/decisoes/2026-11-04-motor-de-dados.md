# Decisão: motor de dados das bases grandes (DuckDB) e Parquet interno

Data: 04/11/2026. Situação: **aprovada**.

## Contexto

O Fariv precisa fazer o que o Excel faz, e melhor, com bases de 1 a 5 milhões de linhas. Hoje a
grade (Univer) guarda cada célula como objeto JavaScript e, acima de 50 mil células, só mantém a
parte visível; a dinâmica para em 10.001 linhas; a importação de CSV aceita até 32 MB; e o `.xlsx`
tem o teto de 1.048.576 linhas por aba. Os produtos que passam desse teto (Row Zero, Gigasheet,
Power Pivot) guardam a base **por coluna** e mostram só a parte visível.

Máquina mínima de referência: **8 a 16 GB de RAM**.

## Decisão

1. **Motor: DuckDB**, embutido no processo Rust que o Fariv já tem (sidecar), com SQL por baixo
   dos panos. A IA consulta a base por SQL e recebe só resultados agregados, nunca linhas em massa.
2. **Formato interno: Parquet.** A pessoa continua importando **TXT, CSV e XLSX**; o Parquet é o
   formato de trabalho do Fariv, invisível para ela. Até 1.048.576 linhas, salvar em `.xlsx`
   continua sendo o padrão; acima disso, o app explica e oferece formas de exportar.
3. **Depois, quando o básico com IA estiver funcionando:** XML de nota fiscal eletrônica (NF-e),
   com API.

## O teste que embasou a decisão

Bases de varejo pt-BR geradas para o teste (`;`, vírgula decimal, BOM, data `dd/mm/aaaa`, código
de produto com zeros à esquerda, 3% de quantidades negativas) com 1, 5 e 20 milhões de linhas,
mais 50 mil produtos para o PROCV. Linux, 4 núcleos, 15 GB; DuckDB 2.0.0 e Polars 2.1.0; cada
execução num processo novo; mediana de 3 execuções (1M) e 2 (5M). Os dois motores chegaram
exatamente aos mesmos números em todas as tarefas. Scripts e resultados:
[`suite/bench/motor-dados/`](../../suite/bench/motor-dados/).

### 5 milhões de linhas, memória livre (segundos; pico de memória do processo)

| Tarefa | DuckDB | Polars |
| --- | --- | --- |
| Importar o CSV pt-BR (343 MB) | 1,15 | 0,70 |
| Abrir o Parquet e mostrar uma tela no meio | 0,018 | 0,007 |
| Coluna calculada `quantidade × preço` | 0,38 | 0,013 |
| Dinâmica regional × mês | **0,09** | 1,19 |
| Acumulado por regional e valor anterior | 2,38 | 1,69 |
| Pareto ABC por produto | **0,09** | 0,18 |
| PROCV com 50 mil produtos | 0,48 | 0,31 |
| Ordenar a base inteira | 0,81 | 0,69 |
| Perfil das colunas para a IA | 0,62 | 0,45 |
| Exportar CSV pt-BR | 2,40 | 1,03 |
| Pico de memória | 1,1–1,7 GB | 1,1–1,9 GB |
| Parquet gravado (CSV de 343 MB) | 81 MB | 82 MB |

### Memória apertada (tarefas pesadas direto do Parquet)

| | DuckDB, teto 512 MB | DuckDB, teto 1 GB | Polars, motor de fluxo (sem teto) |
| --- | --- | --- | --- |
| 5 milhões | pico ≈ 0,6 GB, 1–3,4 s | pico ≈ 1,06 GB | pico 1,6 GB, 1–2 s |
| 20 milhões | — | pico ≈ 1,15 GB, até 17,5 s | pico 3,6 GB, até 6,6 s |

O pico inclui de 60 a 100 MB do próprio Python. O ponto decisivo: o DuckDB **respeita um teto de
memória** e usa o disco quando ele acaba; o Polars não tem teto. Numa máquina de 8 GB com o Fariv,
o navegador e o resto abertos, previsibilidade vale mais que alguns segundos.

### Custo de embutir no Rust

| | DuckDB (`bundled` + `parquet`) | Polars (`lazy`, `parquet`, `csv`, `temporal`) |
| --- | --- | --- |
| Compilação do zero, 4 núcleos | 12–13,5 min | ~7 min |
| Binário sem símbolos | 55 MB | 65 MB |
| Ler 5 milhões do Parquet e somar | 0,07 s, 66 MB | 0,11 s, 186 MB |

## Consequências e cuidados

- **Parquet embutido:** sem o recurso `parquet` do crate `duckdb`, o leitor de Parquet tenta baixar
  a extensão pela internet na hora de usar. O app precisa funcionar offline: o recurso entra na
  compilação.
- **Teto de memória:** começar com `memory_limit` em 25% da RAM, até 4 GB (2 GB numa máquina de
  8 GB, 4 GB numa de 16 GB), e `temp_directory` na pasta de dados do app. Medir no Windows.
- **CSV pt-BR:** nenhum dos dois reconhece vírgula decimal sozinho, e o Polars ainda transformaria
  o código de produto em número, perdendo os zeros. O analisador de colunas da importação
  (`csv-number-format.ts`) continua decidindo os tipos; o motor executa.
- **Exportar CSV pt-BR:** o DuckDB só **lê** vírgula decimal; para gravar, a conversão é feita na
  consulta.
- **Compilação mais lenta no CI** (o DuckDB é C++): depende do cache de Rust.
- **Fórmulas:** a grade comum continua no Univer; nas tabelas grandes, a coluna calculada vira uma
  expressão SQL executada pelo DuckDB, e operações como acumulado por grupo, Pareto e PROCV viram
  operações prontas para a IA.

## Alternativas consideradas

- **Polars:** mais rápido em importar, gravar e calcular colunas com memória sobrando, mas sem teto
  de memória e com SQL menos completo. Embutir os dois não compensa (+65 MB por décimos de segundo).
- **DataFusion:** feito para construir outros motores; mais trabalho para o mesmo resultado.
- **Arquivo nativo do DuckDB como formato do usuário:** só o DuckDB lê; serve como cache, não como
  arquivo da pessoa.
- **HyperFormula:** licença GPL ou comercial paga. **IronCalc** como motor principal: 192 funções na
  versão 0.5, sem matrizes dinâmicas.
