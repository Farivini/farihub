# Entrada e saída de arquivos: XLSX, CSV, TSV, TXT

## Descoberta técnica

- O pacote `@ironcalc/wasm` 0.9.1, usado pelo motor, **não tem XLSX**: só `Model.fromBytes()`/`toBytes()` (formato interno, `bitcode` da estrutura `Workbook`).
- O crate Rust `ironcalc` 0.9.1 (MIT OU Apache-2.0, mesmo repositório e mesma versão do motor) tem importador e exportador XLSX completos: `load_from_xlsx_bytes` e `save_xlsx_to_writer`. Eles leem e escrevem a mesma estrutura `Workbook` que o motor serializa.
- O crate compila para `wasm32-unknown-unknown` sem mudanças.

**Decisão:** um conversor separado (`native/xlsx-bridge`, ~150 linhas de Rust) compilado para WASM, que só troca **XLSX ↔ bytes do `Model.toBytes()`**. O motor não muda e continua sendo a fonte única da verdade: abrir um XLSX é converter para bytes do motor e carregar com `Model.fromBytes()`, o mesmo caminho do `.farcel`; exportar é pedir `Model.toBytes()` ao motor e converter.

Alternativas consideradas:

| Alternativa | Por que não |
| --- | --- |
| Escrever leitor/gravador XLSX em TypeScript sobre a API do modelo | Reimplementa o que o IronCalc já faz e testa (fórmulas compartilhadas, estilos, temas, matrizes dinâmicas); dois lugares para errar a tradução de fórmulas. |
| SheetJS Community (Apache-2.0) | A edição comunitária não grava estilos; fórmulas teriam de ser traduzidas por nós entre os dois motores. |
| ExcelJS (MIT) | Grande para o navegador e pouco mantido; mesma duplicação de modelo. |
| Recompilar o binding WASM do motor com XLSX | Muda o binário do motor (e seu tamanho para quem não usa XLSX). O conversor separado não toca no motor e só carrega quando um XLSX é aberto ou exportado. |

Todas as dependências do conversor são MIT e/ou Apache-2.0 (`vendor/xlsx-bridge/LICENSES.md`, `native/xlsx-bridge/Cargo.lock`).

### Compatibilidade binária

Os bytes trocados com o motor são `bitcode` da `Workbook` do `ironcalc_base`. O conversor fixa `ironcalc = "=0.9.1"` e `ironcalc_base = "=0.9.1"`, a mesma versão do `@ironcalc/wasm`. **Ao atualizar o IronCalc, as duas versões precisam subir juntas** e o conversor ser recompilado; os testes de ida e volta falham se não subirem.

### Build reproduzível

O WASM e a cola JS ficam versionados em `vendor/xlsx-bridge/` (o `npm ci` não precisa de Rust). `native/xlsx-bridge/build.sh` recompila com Rust 1.97.0 (fixado em `rust-toolchain.toml`), `wasm-bindgen` 0.2.130 (o mesmo do `Cargo.lock`) e caminhos remapeados. O job de CI `xlsx-bridge` recompila e exige saída **idêntica byte a byte** ao que está no repositório; `SHA256SUMS` registra os hashes.

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130 --locked
bash native/xlsx-bridge/build.sh
```

### Defeitos do IronCalc 0.9.1 contornados no conversor

Arquivos válidos de outros programas que o importador lê errado; o conversor corrige o pacote antes de importar (cópia em memória, só quando necessário):

1. **Destinos absolutos de relacionamento** (`Target="/xl/comments/comment1.xml"`, escritos pelo openpyxl): o importador supõe `../comments1.xml` e falha com “specified file not found in archive”. Reescritos para a forma relativa.
2. **`showGridLines="true"`** (xsd:boolean, escrito pelo LibreOffice): só `"1"` é lido como verdadeiro, então a planilha perderia as linhas de grade aqui e no XLSX exportado. Reescrito para `"1"`/`"0"`.

Ambos merecem ser reportados ao IronCalc.

## O que é mantido

**XLSX → Planilhas → XLSX**

| | Importa | Exibe | Exporta |
| --- | --- | --- | --- |
| Valores, tipos (número, texto, booleano, erro, data) | sim | sim | sim |
| Fórmulas (inclusive compartilhadas e matriciais) | sim | em português | como fórmulas do Excel |
| Funções que o IronCalc não calcula | texto preservado | `#NOME?` | texto original |
| Várias planilhas, referências entre planilhas | sim | sim | sim |
| Negrito, itálico, alinhamento horizontal, formatos de número | sim | sim | sim |
| Fontes, tamanhos, cores, preenchimento, bordas, quebra de texto | sim | **não** | sim |
| Mesclagem, painéis congelados, larguras e alturas, ocultas | sim | **não** | sim |
| Formatação condicional, hiperlinks, nomes definidos | sim | **não** | sim |
| Comentários, tabelas formatadas (estrutura) | sim | não | **não** |
| Gráficos, imagens, desenhos, tabelas dinâmicas do Excel, macros, validação de dados, filtros, proteção, minigráficos, segmentações, conexões, configuração de impressão, formatação parcial de texto | **não** | — | — |

Ao abrir, o app mostra um **relatório** com os itens das duas últimas categorias que o arquivo tem (“Não importados” e “Mantidos, ainda não exibidos”), com base na inspeção do pacote e da estrutura importada. Ao exportar, lista de novo o que não volta e **pede confirmação**. As dinâmicas e gráficos do Planilhas não existem no XLSX e também entram na lista; só o `.farcel` as guarda.

### Fórmulas em português

O IronCalc guarda fórmulas como árvore, não como texto. A digitação passa pela camada `formula-locale.ts` (pt-BR → nomes em inglês, `;` e vírgula decimal no locale `es` do motor); a exportação escreve a forma canônica do Excel (`SUM(A1:A2,2.25)`, `VLOOKUP(…,FALSE)`, `_xlfn.XLOOKUP`), e a importação faz o caminho inverso. Os testes conferem o XML gerado e a ida e volta de cada fórmula.

### Estado de salvo

- Abrir XLSX ou CSV cria uma pasta **importada** (“Importado de XLSX”): fechar sem editar não pede confirmação; Ctrl+S grava `.farcel`.
- Exportar XLSX marca a pasta como salva **somente** se nada mudou durante a exportação e se não há dinâmicas (que o XLSX não guarda). É a mesma regra do salvamento concorrente da PR #5, com teste próprio.
- Abrir nunca substitui trabalho: o arquivo entra na aba atual apenas se ela está vazia e sem arquivo; senão abre aba nova. Um arquivo recusado (corrompido, não-XLSX) não altera nada.

## CSV, TSV e TXT

- **Prévia** antes de importar: codificação (UTF-8, ou Windows-1252 detectado quando o arquivo não é UTF-8 válido), separador (`;`, `,`, tabulação, `|`, detectado pela consistência das primeiras linhas), decimal (vírgula ou ponto), primeira linha como cabeçalho e tipo de cada coluna (Automático ou Texto). Cada valor aparece como será lido.
- **Números** são reescritos explicitamente (sem depender de como o motor interpreta texto digitado): `1.234,56` com decimal vírgula, `1,234.56` com decimal ponto.
- **Códigos**: colunas com zeros à esquerda (`00123`) ou com 11 dígitos ou mais sem separadores (CPF, CNPJ, telefones, códigos de barras) são sugeridas como Texto, e nenhum desses valores vira número mesmo em coluna Automática. Números com mais de 15 dígitos significativos (o que um número de ponto flutuante guarda) também ficam texto.
- **Datas**: `dd/mm/aaaa` e `aaaa-mm-dd` viram datas; datas impossíveis (31/02) ficam texto. `mm/dd/aaaa`, data e hora e horários ficam como texto nesta versão.
- **Segurança**: nenhum valor vira fórmula. Texto que o motor leria como outra coisa (`=…`, `+…`, `VERDADEIRO`, `12/ab`) entra com o prefixo de texto (`'`).
- Arquivos acima de 1.048.576 linhas ou 16.384 colunas são **recusados**, não cortados.
- **Exportação**: a planilha ativa, valores como exibidos, separador `;` (CSV, padrão do Excel em português) ou tabulação (TSV), UTF-8 com BOM, aspas quando necessário. O app avisa antes que fórmulas viram resultados, formatação não vai e as outras planilhas ficam de fora.

## Evidências

### Testes automatizados

- `tests/xlsx.test.ts`: arquivos de três autores diferentes (openpyxl, LibreOffice, pacote com fórmulas compartilhadas no formato do Excel), relatório de recursos, digitação pt-BR → XML do Excel → reabertura, importar → editar → exportar → reabrir, funções não calculadas, arquivo inválido.
- `tests/delimited.test.ts`: aspas, quebras de linha, codificações, detecção, interpretação de valores, importação e exportação no motor, limite de colunas.
- `tests/e2e/files.e2e.ts` (Chromium): abrir XLSX pelo app, editar, exportar pelo menu, reabrir; relatório e confirmação de perdas; dinâmica na exportação; CSV Windows-1252 com prévia, tipos e exportação; cancelar a prévia; arquivo inválido; edição durante a exportação.
- Os arquivos de teste ficam em `tests/fixtures/xlsx/`, gerados por `scripts/make-xlsx-fixtures.py` (openpyxl 3.1.5) e pelo LibreOffice Calc 24.2.

### Verificação no LibreOffice Calc

**Não há Microsoft Excel neste ambiente; nenhum arquivo foi aberto no Excel.** Como verificação independente do IronCalc, os arquivos exportados foram abertos no **LibreOffice Calc 24.2.7** (headless, via UNO), que **recalculou todas as fórmulas** e teve cada resultado comparado com o valor que o Farcel gravou:

```sh
node scripts/xlsx-interop.ts
python3 scripts/xlsx-interop-libreoffice.py reports/interop/*.xlsx
```

| Arquivo | Fórmulas recalculadas | Divergências |
| --- | ---: | ---: |
| `farcel-funcoes.xlsx` (32 fórmulas digitadas em português, 2 planilhas, formatos) | 34 | 0 |
| `farcel-base-5000.xlsx` (base sintética) | 3 | 0 |
| `ida-e-volta-*.xlsx` (4 arquivos de teste importados, editados e exportados) | 37 | 0 |

O verificador foi conferido com um arquivo adulterado (um valor gravado trocado): a divergência foi detectada. No mesmo arquivo, o LibreOffice leu negrito, centralizado, `"R$" #,##0.00`, `dd/mm/yyyy`, `#,##0.00`, `0.0%` e os acentos.

### Medições

`node scripts/bench-xlsx.ts` → `reports/xlsx-bench.json`. Node 22, Linux x64, mesmo WASM do navegador, **uma execução**, base sintética (5 colunas). Não é medição no navegador nem no Windows.

| Linhas | XLSX | Exportar XLSX | Importar XLSX | Carregar + recalcular | Exportar CSV | Importar CSV | Pico de memória do conversor |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100.000 | 2,3 MiB | 1,1 s | 1,7 s | 0,06 s | 1,3 s | 2,8 s | 133 MiB |
| 1.000.000 | 22,4 MiB | 29,3 s | 17,5 s | 1,0 s | 14,4 s | 37,6 s | 1.346 MiB |

Em 1 M linhas a conversão funciona e a ida e volta confere, mas é lenta, e o conversor chega a 1,3 GiB de memória WASM (no navegador ela é liberada ao terminar, porque cada conversão roda num worker descartado). A importação CSV de 1 M linhas leva 38 s porque passa célula a célula pela entrada do motor. Otimizar os dois caminhos é trabalho futuro; os números estão no roadmap como base de comparação.

## Limitações conhecidas

- Sem verificação no Microsoft Excel (ver acima).
- Arquivos `.xlsm`, `.xlsb`, `.xls` e `.ods` não abrem.
- O relatório de recursos é baseado em inspeção do pacote; um recurso raro fora da lista pode não aparecer.
- Funções que o IronCalc 0.9.1 não conhece não são detectadas na importação: aparecem como `#NOME?` na célula (o texto da fórmula é preservado e volta no XLSX).
- A exportação CSV usa os valores exibidos (como o Excel faz); números com formato (R$, %) saem formatados.
- Na exportação CSV/TSV, texto que começa com `=`, `+`, `-` ou `@` sai como está (fidelidade aos dados). Ao abrir o CSV, o Excel pode interpretá-lo como fórmula; a importação do Planilhas nunca faz isso. Decidir se a exportação deve proteger esses valores (por exemplo com `'`) fica em aberto.
- Conversões grandes ainda não mostram progresso detalhado nem podem ser canceladas.
