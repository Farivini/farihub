# Comparativo DuckDB × Polars (motor de dados do Fariv)

Scripts do teste que decidiu o motor das bases grandes. A decisão e os números estão em
[`docs/decisoes/2026-11-04-motor-de-dados.md`](../../../docs/decisoes/2026-11-04-motor-de-dados.md).

Os dois motores rodam pela interface Python, que usa o mesmo núcleo nativo que seria
embutido no processo Rust do Fariv.

## Rodar

```sh
cd suite/bench/motor-dados
python3 -m venv venv
./venv/bin/pip install duckdb polars psutil

# bases pt-BR (';', vírgula decimal, BOM, data dd/mm/aaaa, códigos com zeros à esquerda)
./venv/bin/python gen.py 1000000 vendas_1M.csv
./venv/bin/python gen.py 5000000 vendas_5M.csv
./venv/bin/python gen_prod.py produtos.csv

mkdir -p res
./run.sh    # 3 execuções com 1M e 2 com 5M, alternando os motores; resultados em res/

# memória apertada, direto do Parquet gravado pela execução acima
./venv/bin/python bench_lowmem.py duckdb work/duckdb_vendas_5M.csv/base.parquet 512 res/low_duckdb_512.json
./venv/bin/python bench_lowmem.py polars work/duckdb_vendas_5M.csv/base.parquet 0 res/low_polars.json
```

As bases geradas (68 MB e 343 MB) e a pasta `work/` não vão para o repositório.

| Arquivo | O que faz |
| --- | --- |
| `gen.py`, `gen_prod.py` | Geram as vendas e a tabela de 50 mil produtos (para o PROCV) |
| `bench.py` | Tarefas do Fariv: importar CSV pt-BR, gravar e abrir Parquet, tela no meio da base, coluna calculada, dinâmica, acumulado por regional, Pareto ABC, PROCV, filtrar, ordenar, perfil para a IA, exportar CSV pt-BR. Mede tempo e pico de memória por tarefa e guarda conferências numéricas |
| `bench_lowmem.py` | As tarefas pesadas direto do Parquet, com o DuckDB limitado por `memory_limit` e o Polars no motor de fluxo |
| `run.sh` | A série completa |
| `resultados/` | Resultados medidos em 04/11/2026 (Linux, 4 núcleos, 15 GB; DuckDB 2.0.0, Polars 2.1.0) |
