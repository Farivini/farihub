# Farcel — primeira versão funcional no navegador

> Na interface o espaço se chama **Planilhas** (Documentos e Apresentações para Fardoc e Farcanvas). Os nomes internos e a extensão `.farcel` não mudaram.

Este documento descreve o que foi implementado, como as peças se ligam e o que ainda falta. Resultados medidos estão em [resultados-navegador.md](resultados-navegador.md).

## Visão geral

```
 Thread principal (React)                     Web Worker (motor)
 ┌──────────────────────────────┐   postMessage   ┌──────────────────────────────────────┐
 │ Shell: seletor lateral,      │ ─────────────▶  │ WorkbookEngine                       │
 │ abas, assistente (recolhível)│                 │  └ IronCalc 0.9.1 (WASM) ← única     │
 │ Farcel:                      │                 │     fonte da verdade: células,       │
 │  - grade canvas + cache de   │ ◀─────────────  │     fórmulas, referências, planilhas │
 │    blocos (só leitura)       │  viewport,      │ Camada pt-BR (tokens)                │
 │  - editor DOM (textarea)     │  eventos        │ PivotSource: projeção colunar        │
 │  - barra de fórmulas         │  "changed"      │  derivada, corrigida após edições    │
 │  - dinâmica + gráfico SVG    │                 │ computePivot (núcleo puro)           │
 └──────────────────────────────┘                 │ .farcel: toBytes + cabeçalho + CRC32 │
                                                  └──────────────────────────────────────┘
```

- `src/core/` — TypeScript puro, sem DOM, Node, Tauri ou Electron: localização de fórmulas, TSV, endereços, tabela dinâmica, formato `.farcel`, base sintética, contexto limitado da IA.
- `src/engine/` — `WorkbookEngine` (envolve o modelo IronCalc), `PivotSource`, protocolo, worker e cliente. O `WorkbookEngine` roda igual no worker do navegador e no Node (testes usam o mesmo `wasm_bg.wasm` via `initSync`).
- `src/app/` — interface React. Nenhuma célula é componente React; a grade desenha em um `<canvas>` só a região visível.

## Fonte única da verdade

O modelo IronCalc no worker guarda células, fórmulas, referências e planilhas. A interface não mantém outro modelo:

- A grade guarda apenas um **cache de visualização** em blocos de 64 linhas × 16 colunas com valores já formatados. Cada bloco carrega a revisão do motor em que foi lido; um evento `changed` do worker invalida os blocos e só os visíveis são relidos.
- A barra de fórmulas lê o conteúdo da célula ativa do motor a cada mudança de seleção ou revisão.
- A tabela dinâmica usa uma **projeção colunar derivada** (`PivotSource`), descrita abaixo. Ela nunca é editada nem salva.

## Grade

- Canvas com `devicePixelRatio`; desenha cabeçalhos, linhas de grade, textos (números à direita, textos à esquerda, booleanos/erros centralizados) e seleção.
- Rolagem nativa sobre um espaçador. A planilha tem 1.048.576 linhas (24 px cada = 25 M px), acima do limite de altura de elementos de alguns navegadores; acima de 15 M px a rolagem é proporcional.
- Editor DOM: um `textarea` sempre focado na célula ativa. Invisível fora de edição, recebe digitação, teclas mortas e composição IME, por isso acentos funcionam como em qualquer campo de texto. Ao começar a digitar, vira o editor visível.
- Teclado: setas, Shift+setas, Ctrl+setas (bordas de bloco como no Excel, calculadas no motor), Enter/Shift+Enter, Tab/Shift+Tab, F2, Esc, Delete/Backspace, PageUp/PageDown, Home, Ctrl+Home, Ctrl+A, Ctrl+Z/Ctrl+Y, Alt+Enter (quebra de linha na célula).
- Copiar: o texto que vai para outros aplicativos é TSV com os **valores exibidos**, como o Excel. Ao mesmo tempo o motor guarda sua área de transferência interna; se o texto colado for o mesmo copiado, a colagem usa `pasteFromClipboard` do IronCalc e as referências relativas se deslocam (`=B2*2` copiado de B4 para C4 vira `=C2*2`).
- Colar texto externo: TSV com aspas, tabulações e quebras de linha dentro de aspas. Cada célula é tratada como entrada pt-BR e a área inteira entra com `pasteCsvText` — um único passo de desfazer.
- Recortar, nesta versão, é copiar e limpar (o Excel move na colagem; ainda não implementado).

## Fórmulas em português

O IronCalc 0.9.1 não tem idioma português (`pt`, `pt-BR` e `pt-PT` rejeitados; idiomas disponíveis: `en`, `es`, `fr`, `de`, `it`). Investigação:

- O **locale** `es` do IronCalc já usa a sintaxe numérica do pt-BR: vírgula decimal e ponto e vírgula entre argumentos (`=SOMA(1,5;2)`), entende `1.234,56` e `29/10/2026` digitados e exibe `1.234,57`. A fórmula é armazenada internamente em forma canônica e exibida no locale do modelo.
- O **idioma** controla nomes de funções. Usamos `en` no motor e traduzimos apenas os tokens que diferem, com um analisador léxico próprio (`src/core/formula-locale.ts`):
  - nomes de função só quando seguidos de `(` (`SOMA(` → `SUM(`);
  - booleanos `VERDADEIRO`/`FALSO`, inclusive digitados como valor;
  - literais de erro (`#N/D` ↔ `#N/A`, `#VALOR!`, `#NOME?`…), também nos valores exibidos.
  - Strings (`"SOMA(x)"`), nomes de planilha entre aspas (`'SOMA'!A1`) ou não (`SOMA!A1`), referências (`SE1`), referências estruturadas (`Tabela1[Receita]`), constantes de matriz e nomes definidos ficam intactos.
- 166 funções mapeadas; um teste confirma que todas existem no IronCalc 0.9.1 (nenhuma retorna `#NOME?`) e que ida e volta pt → motor → pt é exata. Grafias sem acento (`MEDIA`, `MAXIMO`) são aceitas na digitação e exibidas com acento.
- Pendente: confrontar a tabela de nomes e resultados com o Excel pt-BR real; formatos de moeda/data do locale `es` usam € e nomes de mês em espanhol quando o formato pede (não há locale pt-BR no IronCalc). Caminho definitivo: contribuir um locale/idioma pt-BR ao IronCalc (os dados vêm do CLDR) ou manter um fork. `"a"&1,5` concatena `1.5` com ponto (comportamento do motor).
- O IronCalc mostra até 17 dígitos significativos no formato Geral (`13260750,389999978`); a camada de visualização limita a 15, como o Excel.

## Tabela dinâmica

- Origem: a região a partir de A1 de uma planilha, cabeçalhos na linha 1 (nomes repetidos ganham sufixo), dados até a última linha preenchida em qualquer coluna de campo.
- Configuração: Linhas, Colunas, Valores (Soma ou Contagem, alternável) e Filtros (lista de valores com busca; valores novos entram incluídos). Arrastar e soltar ou clicar no campo.
- Resultado: grupos ordenados (números em ordem numérica, textos em ordem pt-BR, vazio por último), subtotais por linha e coluna e total geral. Soma ignora texto; Contagem conta células não vazias (como `CONT.VALORES`).
- Exibição: o resultado é desenhado na mesma grade canvas, em modo só leitura (Ctrl+A, Ctrl+C copiam a tabela). O gráfico SVG (colunas ou linhas) é gerado do agregado, nunca das linhas de origem; mostra até 24 grupos e 8 séries e informa quando corta.

### Como a agregação recebe os dados e se atualiza

1. Na primeira execução, `PivotSource` lê do IronCalc **só as colunas usadas** pela configuração e monta, por coluna, um dicionário de rótulos e um `Uint32Array` de códigos por linha (mais o valor numérico de cada rótulo). Essa leitura cede o worker a cada 50 mil linhas para a grade continuar respondendo.
2. Toda mutação do motor (`setInput`, `paste`, `clear`, `undo`, `redo`) informa o retângulo alterado:
   - edição literal em coluna sem fórmulas → as células do retângulo são relidas e corrigidas no lugar;
   - coluna que contém fórmulas → descartada e relida na próxima execução, depois de **qualquer** edição em qualquer planilha (a fórmula pode depender de qualquer célula);
   - linha 1 (cabeçalhos) → lista de campos recalculada;
   - linhas novas ao fim → colunas crescem e só as linhas novas são lidas.
   Desfazer/refazer usam um espelho da pilha do IronCalc com o retângulo de cada operação; um teste garante que cada operação é exatamente um passo de desfazer do motor.
3. A agregação (`computePivot`) é pura e roda no mesmo worker sobre os códigos. Se uma edição chega durante uma leitura, a leitura recomeça.
4. A interface recalcula a dinâmica visível 150 ms após a última mudança de configuração ou do motor; dinâmicas em abas ocultas são recalculadas ao voltar.

## Arquivo `.farcel`

`Salvar` grava **uma pasta de trabalho Farcel**, não XLSX: `FARCEL01` + cabeçalho JSON (versão do formato, versão do IronCalc, CRC32 e configuração das dinâmicas/gráficos) + `Model.toBytes()` do IronCalc. `Abrir` valida assinatura, versão, tamanho e CRC32 antes de substituir a pasta atual; arquivo corrompido é recusado e a pasta aberta continua intacta.

"Salvo neste dispositivo" descreve o que está no arquivo. O snapshot do motor é tirado quando o worker serializa o modelo, e a lista de dinâmicas quando o pedido de salvar sai. Se houver edição de célula ou mudança de dinâmica depois disso, enquanto a gravação ainda está em andamento (disco ou diálogo lentos), o arquivo é gravado com o snapshot e a pasta continua marcada com alterações não salvas. A gravação passa por `src/app/files.ts`; o executável pode injetar `window.farivFiles` para gravar com acesso nativo a arquivos.

- No Chromium desktop o app usa o seletor nativo de salvar (File System Access API); em outros navegadores (e em automação) faz download. O Chromium descarta nomes com acento passados por download; nesse caminho o nome é gravado sem diacríticos.
- O conteúdo binário é o formato interno da versão do IronCalc indicada no cabeçalho; compatibilidade entre versões do motor não é garantida.
- XLSX: o pacote WASM 0.9.1 não expõe importação/exportação XLSX. Resolvido com um conversor separado compilado do crate Rust `ironcalc` 0.9.1 (`native/xlsx-bridge`), que troca XLSX ↔ `Model.toBytes()` sem mudar o motor; ver [xlsx.md](xlsx.md).

## Base sintética de um milhão de linhas

`Base de teste…` (menu de arquivos no trilho) cria, em uma aba nova com seu próprio worker, uma pasta reprodutível: planilha **Dados** com Região, Canal, Categoria, Quantidade e Receita em todas as linhas pedidas (padrão 1.000.000, semente 20261029) e planilha **Resumo** com `SOMA`, `SOMASE` e `CONT.VALORES` sobre a base. Os totais esperados são calculados independentemente pelo gerador (`syntheticTotals`) e comparados nos testes e no benchmark.

O IronCalc guarda histórico de desfazer para cada entrada de usuário (medido: centenas de bytes por célula). O gerador reconstrói o modelo a partir dos próprios bytes a cada 100 mil linhas para descartá-lo; sem isso a memória WASM passaria de 1 GB.

## Assistente

O painel mostra que a IA **não está conectada** e não envia nem responde nada. Exibe, a partir do estado real, o contexto limitado que uma conexão futura receberia: nome da pasta, planilha, seleção, contagem de linhas, cabeçalhos, até 20 linhas de amostra e até 50 linhas do resultado da dinâmica (`src/core/assistant-context.ts`). Nunca a base inteira.

## Limitações conhecidas desta versão

- Várias pastas podem ficar abertas em abas; cada aba tem seu próprio worker e sua própria memória WASM.
- Formatação disponível: formato de número (Geral, Número, Moeda R$, Porcentagem, Data), negrito e alinhamento horizontal. O IronCalc guarda o estilo por célula: formatar uma coluna inteira formata só as linhas com dados, e outras seleções são limitadas a 200 mil células. Sem bordas, cores, mesclagem, largura de coluna ajustável, congelamento de painéis ou autocompletar fórmulas.
- Recalculo: o IronCalc 0.9.1 reavalia a pasta inteira a cada edição. Com fórmulas que varrem um milhão de linhas cada edição custa centenas de milissegundos (medido); com fórmulas por linha o custo cresce proporcionalmente. A interface continua responsiva porque o cálculo está no worker, mas a célula só mostra o novo valor depois.
- Primeira leitura da dinâmica sobre um milhão de linhas custa segundos por coluna (chamadas célula a célula ao WASM). Edições posteriores corrigem apenas as células alteradas.
- Copiar até 500 mil células por vez.
- Documentos e Apresentações aparecem como espaços em preparação, sem editor.
- Sem executável Windows; nada medido em Windows.
