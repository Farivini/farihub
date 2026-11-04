# Fluidez com 1 milhão de linhas — experimento, não migração pronta

Este diretório testa a hipótese de manter a base no DuckDB nativo e entregar à grade somente um trecho. O aplicativo de produção não foi modificado. Abrir um CSV grande pelo menu normal ainda tem os limites anteriores; o experimento não deve ser apresentado como uma versão pronta ou como equivalência com Excel.

Relatório: [fluidez-milhao-2026-11-04.md](../../../docs/fluidez-milhao-2026-11-04.md). Evidências sem linhas da base em [results/2026-11-04](results/2026-11-04).

## O que roda

- `src/main.rs`: processo Rust persistente; importa o CSV, mantém tabela no DuckDB, devolve até 200 linhas por leitura, define quantidade × preço, salva Parquet mais definição e reabre. O cálculo não é um milhão de fórmulas no Univer. Não implementa XLSX, edição, desfazer, IA ou compatibilidade geral de tipos/fórmulas.
- `live.mjs`: inicia o Electron real de Planilhas e o processo candidato como filho de seu processo principal. Uma aba de ensaio mantém 201 linhas físicas; um controle dedicado busca trechos de 100 linhas da fonte, mostrando seu número absoluto. Não substitui a rolagem, a abertura ou o salvamento normais do produto. Conferências comparam todas as células dos trechos pintados com o resultado nativo, inclusive strings e zeros à esquerda.
- `univer-full-axis.mjs`: tentativa anterior, mantida para reproduzir o gargalo de criar a aba com 1 milhão de linhas físicas. É diagnóstico histórico, anterior ao controle dedicado e às conferências de tipos da janela final. Não é o candidato final nem um comparativo controlado de velocidade.
- `responsive-baseline.mjs`: fluxo existente da PR #12 com IA simulada; mede pausas de frames/timers e tarefas longas durante abrir, navegar, calcular e salvar as 10 mil linhas.
- `oracle.py`: confere, independentemente e linha a linha, código do produto, quantidade, preço e resultado com `csv`/`Decimal`.
- `generate-varied.py`: gera 1 milhão de registros variados determinísticos, incluindo identificadores com zeros e quantidades negativas.

Os experimentos principais usam duas colunas numéricas declaradas (`quantidade`, `preco_unitario_gbp`); as demais ficam como texto. O analisador existente informa separador e marca decimal da amostra. Isso **não** comprova que toda a semântica de importação de colunas mistas/formatos do produto foi migrada. Os dados não vão ao repositório nem a um modelo.

## Compilar

O padrão é a configuração planejada para incorporação, com `bundled` e `parquet`:

```bash
CARGO_TARGET_DIR=/tmp/fariv-million-target cargo build --release --manifest-path bench/million-live/Cargo.toml
```

Essa compilação completa **não foi concluída neste ensaio**; foi interrompida intencionalmente devido ao custo de compilação. Para os resultados publicados, Rust foi ligado à biblioteca compartilhada oficial DuckDB 2.0.0, cuja soma SHA-256 foi conferida contra o release:

```bash
curl -fL https://github.com/duckdb/duckdb/releases/download/v2.0.0/duckdb-shared-libs-linux-amd64.tar.gz -o /tmp/duckdb.tar.gz
echo '993ad89e7dfca66cd6da994c2cad090c2fc160ddf9f550498a098ab4bb13cfb1  /tmp/duckdb.tar.gz' | sha256sum -c -
mkdir -p /tmp/fariv-libduckdb
tar -xzf /tmp/duckdb.tar.gz -C /tmp/fariv-libduckdb
DUCKDB_LIB_DIR=/tmp/fariv-libduckdb CARGO_TARGET_DIR=/tmp/fariv-million-linked \
  cargo build --release --no-default-features --manifest-path bench/million-live/Cargo.toml
DUCKDB_LIB_DIR=/tmp/fariv-libduckdb LD_LIBRARY_PATH=/tmp/fariv-libduckdb CARGO_TARGET_DIR=/tmp/fariv-million-linked \
  cargo test --release --no-default-features --manifest-path bench/million-live/Cargo.toml
```

Os comandos assumem execução a partir de `suite/`. Nenhuma etapa valida MSVC, empacotamento, Windows ou funcionamento do instalador offline. No processo ensaiado, instalação automática e carregamento automático de extensões foram desativados; ler e gravar Parquet funcionou com a biblioteca fornecida.

## Ensaiar

Construir previamente o aplicativo de Planilhas e seu sidecar normal. Instalar dependências da suíte e disponibilizar Electron e um display X11. O runtime usado para estes testes foi Electron 38.0.0, diferente da dependência de produção 43.8.3.

```bash
LD_LIBRARY_PATH=/tmp/fariv-libduckdb ELECTRON_TEST_EXECUTABLE=/caminho/electron \
  node --import tsx bench/million-live/live.mjs /caminho/base.csv /tmp/fariv-live-run \
  /tmp/fariv-million-linked/release/fariv-million-live
python3 bench/million-live/oracle.py /caminho/base.csv /tmp/fariv-live-run/audit.csv /tmp/fariv-live-run/oracle.json
```

`FARIV_TEST_XVFB` pode apontar para Xvfb; o driver inicia o display `:113`. Sem essa variável, usa o `DISPLAY` existente. Configurar `LD_LIBRARY_PATH` também para as dependências de Xvfb se necessário. O diretório de saída e seu banco de trabalho devem ser novos por execução; não apontar para arquivos pessoais.

Para a base variada:

```bash
python3 bench/million-live/generate-varied.py /tmp/varied_1000000.csv
```

Para repetir a base original, preservar o cabeçalho uma vez e repetir os 10 mil registros cem vezes. O SHA-256 esperado está nas evidências. O CSV original e seu pacote não são redistribuídos aqui.

Um resultado positivo exige: processo sem erro, base com 1 milhão de registros, zero divergências no oráculo e zero divergências nos trechos pintados. Isso não basta para aprovar o produto: ainda faltam as integrações e verificações descritas no relatório. Não executar compiladores, oráculos ou outros benchmarks simultaneamente às medições.
