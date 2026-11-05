# Abrir uma base de 1 milhão de linhas pelo menu normal

> Atualização de 05/11/2026: a base grande passou a aceitar edição e gravação. Ver
> [editar, desfazer e salvar](editar-salvar-base-grande-2026-11-05.md).

04/11/2026. **Resultado: CSV acima de 32 MB agora abre pelo menu Abrir, com a rolagem e os atalhos de
sempre, e cada célula igual à importação de hoje. Nesta etapa a base grande abre só para leitura.**

## O que mudou para quem usa

- **Abrir** aceita CSV e TSV de qualquer tamanho. Até 32 MB nada muda: o arquivo segue o caminho de
  hoje e pode ser editado e salvo. Acima disso, o arquivo vai para o motor de bases grandes (DuckDB).
- A grade mostra a base inteira: barra de rolagem, roda do mouse, Ctrl+End, Ctrl+Home, Ctrl+↓,
  Ctrl+↑, Ctrl+Shift+↓/↑ e a caixa de nome, com o número de linha verdadeiro.
- **Localizar** (Ctrl+F) procura na base inteira.
- Um aviso diz quantas linhas foram abertas e que a base está **só para leitura**. Editar, formatar e
  salvar mostram esse aviso e não fazem nada. A gravação também é recusada no processo principal, para
  nunca escrever um arquivo com só o trecho que estava na tela.

## Como funciona

1. O processo principal lê o primeiro 1 MB do arquivo e decide codificação e separador com as **mesmas
   funções** da importação de hoje (`csv-import.ts`).
2. O motor (`native/data-engine`, Rust + DuckDB, processo próprio) lê o arquivo inteiro com uma **cópia
   linha por linha do leitor de CSV de hoje** (`parseCsv`). Na mesma passada, ele conta o formato dos
   valores de cada coluna sobre **todas as linhas**: inteiro, vírgula decimal, ponto decimal, código
   com zero à esquerda ou texto.
3. Com essas contagens, a decisão de cada coluna é a mesma função da importação de hoje
   (`decideCsvColumns`, separada de `analyzeCsvColumns` sem mudar o comportamento). Um código com zero
   à esquerda na linha 900 mil decide a coluna como decidiria num arquivo pequeno.
4. O DuckDB guarda a base em memória, com teto em 25% da RAM (até 4 GB). Acima do teto, ele usa o
   disco na pasta temporária da importação.
5. A grade usa o modo que já existia para planilhas grandes, em que só a parte visível é carregada.
   Cada trecho pedido vem do motor (4–9 ms por tela).

## Teste com a base enviada (`bank_transactions.csv`)

1.048.567 transações mais o cabeçalho, 9 colunas, 64 MB. Linux, 4 núcleos, 15 GB, Electron 43.8.3 (a
versão do produto), aplicativo real aberto pelo menu. Roteiro: `suite/bench/abrir-milhao/verify-large.mjs`.

| Verificação | Resultado |
| --- | --- |
| Leitor independente (Python `csv`) e importação de hoje leem o mesmo texto | Sim, 1.048.568 linhas |
| Linhas na grade | 1.048.568 |
| **Todas as 9.437.112 células, lidas pelo mesmo canal da grade, iguais à importação de hoje** | **0 divergências** |
| Ctrl+End, Ctrl+Home, Ctrl+↓, caixa de nome no meio, tela do meio | Corretos |
| Localizar "MUMBAI" | 135.113 resultados, igual à contagem independente |
| Editar e salvar | Recusados, com o aviso |

| Medida | Resultado |
| --- | --- |
| Do clique em Abrir até a primeira tela | 2,3–3,0 s (3 rodadas) |
| Maior pausa da tela ao abrir | 200–233 ms |
| Maior pausa navegando e rolando | 117 ms |
| Ctrl+End / Ctrl+↓ / caixa de nome | 18 ms / 103 ms / 16 ms |
| Memória do aplicativo inteiro (janela, processos, motor) | 724 MB depois de abrir; pico de 867 MB no uso |
| Memória do motor | 135 MB |

O mesmo roteiro com 1.000.000 de linhas no padrão brasileiro passou em todas as verificações. A base
tem `;`, vírgula decimal, milhar com ponto, códigos com zero à esquerda e textos com `;` e aspas: foram
8.000.008 células com 0 divergências, 2,6 s até a primeira tela e pico de 886 MB.

### Comparação com o caminho de antes

| | Antes (XLSX de 1 milhão, mesmo modo de grade) | Agora (CSV de 1 milhão pelo motor) |
| --- | --- | --- |
| Até a primeira tela | 6,9 s | 2,3–3,0 s |
| Maior pausa | 1.333 ms | 200–233 ms |
| Memória | 669 MB | 724 MB |
| CSV de 64 MB pelo menu | Recusado ("excede o limite de tamanho") | Abre |

Duas correções na grade tiraram a pausa ao abrir, e valem para qualquer planilha grande:

- O controle de filtros de tabela criava um conjunto vazio para cada linha. Agora devolve sempre o
  mesmo conjunto vazio quando não há filtro.
- Na base grande, que não pode ter filtros, o cálculo da altura das linhas não pergunta mais "esta
  linha está filtrada?" um milhão de vezes.

### Além do limite do Excel (observado)

Uma base de **2.000.001 linhas** (186 MB) abriu em 4,7 s, com pausa máxima de 300 ms. O Ctrl+End chegou na
linha 2.000.001 com o valor certo, e a memória ficou em 963 MB. A conferência célula por célula não
foi feita nesse tamanho, porque o leitor de referência para em 1.048.576 linhas, como o Excel.

## O que não está nesta etapa

- **Editar, desfazer e salvar** a base grande, incluindo XLSX com fórmulas. É a próxima etapa.
- **Datas continuam texto**, como na importação de hoje. `2/8/16` é ambíguo entre dia/mês e mês/dia,
  e reconhecer datas é uma decisão de produto à parte.
- **Somas exatas em centavos (DECIMAL):** a grade mostra os mesmos números de hoje. A soma exata entra
  com as agregações para a IA e a dinâmica.
- **Barra de status e IA** ainda leem a base pelo caminho antigo de trechos. Funcionam, mas são lentos
  na base inteira. Vão para o motor nas próximas etapas.
- **Windows:** nada foi testado lá. O motor compila o DuckDB em C++, e o instalador agora o inclui
  (`electron-builder.cjs`, verificado ao empacotar). A primeira compilação com MSVC é o maior risco
  pendente. Ver "Instalador" abaixo.

## Instalador

- `npm run native:build -w @genoffice/sheets` agora compila também o motor. Na primeira vez, o DuckDB
  leva cerca de 14 minutos com 4 núcleos; depois, o cache de Rust do CI (`Swatinem/rust-cache`, agora
  com as duas pastas) evita repetir.
- O motor entra no pacote em `resources/native/data-engine(.exe)`. O empacotamento falha se ele não
  existir.
- As licenças das bibliotecas do motor (DuckDB e as demais, todas permissivas) entram no aviso de
  terceiros do instalador.

## Testes

| Teste | Resultado |
| --- | --- |
| Motor (Rust): 26 CSVs e 50 valores gerados pelo leitor TypeScript; importação com linhas irregulares, quebra de linha entre aspas e linhas vazias; Ctrl+↓/↑; busca paginada | 5/5 |
| Planilha (vitest), com 5 novos testes da base grande | 3.892 aprovados; as 3 falhas de `promote-file-atomically` são as mesmas de antes (usuário root) |
| `xlsx-gateway` | 398/398 |
| Ponta a ponta do Fariv | 24/24 |
| Coluna calculada pela IA, CSV de 10 mil linhas (`verify-ai-formula-fill.mjs`) | 11/11 |
