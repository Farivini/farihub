# Coluna calculada na base grande

05/11/2026. **Resultado: na base grande, uma fórmula digitada numa coluna vazia (ou proposta pela IA)
preenche a coluna inteira, calculada pelo motor sobre todas as linhas. O CSV salvo bateu com um
cálculo independente em Python em 15.728.520 campos, com 0 divergências.**

## O que a pessoa faz

1. Escreve o cabeçalho (ex.: `J1` = `Imposto`).
2. Digita a fórmula na linha 2 da coluna vazia (ex.: `J2` = `=I2*0.18`) e aperta Enter.
3. O motor calcula a coluna de `J2` até a última linha, como a coluna calculada de uma tabela do
   Excel. Um aviso diz quantas linhas foram calculadas, em quanto tempo e se alguma linha deu erro
   (`#DIV/0!`, `#N/D`…).

**Desfazer e refazer** apagam e devolvem a coluna inteira. **Editar uma célula** que a fórmula usa
(ex.: `I3`) recalcula sozinho:
- as fórmulas por linha atualizam na hora;
- acumulado, `SOMASE` e `PROCV` vêm logo depois, com aviso na barra de status.

**Digitar um valor** numa célula da coluna calculada vale como no Excel: aquela célula fica com o
valor digitado. **Salvar** grava os resultados no CSV ou no XLSX.

### O que já calcula na base inteira

As funções têm o nome em inglês, como a planilha do Fariv aceita hoje em qualquer idioma (`SUM` em
vez de `SOMA`); entre parênteses, o nome do Excel em português.

| Tipo | Exemplos |
| --- | --- |
| Conta por linha | `=I2*0.18`, `=IF(I2>F2,"acima","ok")` (SE), `=ROUND(I2/3,2)` (ARRED), textos (`LEFT`, `MID`, `TRIM`, `&`…) |
| **Acumulado** | `=SUM($I$2:I2)` (SOMA); saldo com a linha de cima: `=K1+I2` |
| Totais da coluna | `=I2/SUM(I:I)` (participação no total) |
| **Por grupo** | `=SUMIF(E:E,E2,I:I)` (SOMASE), `=COUNTIF(E:E,E2)` (CONT.SE), `SUMIFS`, `COUNTIFS`, `AVERAGEIF` |
| **Contagem acumulada por grupo** | `=COUNTIF($B$2:B2,B2)` (1ª, 2ª, 3ª compra do cliente) |
| **PROCV exato** | `=VLOOKUP(B2,$B$2:$I$N,8,FALSE)` (PROCV), `XLOOKUP` (PROCX), `MATCH(…,0)` (CORRESP), `INDEX` (ÍNDICE) |

Funções: `IF`, `IFERROR`, `IFNA`, `AND`, `OR`, `NOT`, `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`,
`COUNTA`, `COUNTBLANK`, `PRODUCT`, `ROUND`, `ROUNDUP`, `ROUNDDOWN`, `INT`, `TRUNC`, `ABS`, `MOD`,
`POWER`, `SQRT`, `SIGN`, `SUMIF`, `SUMIFS`, `COUNTIF`, `COUNTIFS`, `AVERAGEIF`, `AVERAGEIFS`,
`VLOOKUP` (exato), `XLOOKUP`, `MATCH` (exato), `INDEX`, `LEN`, `LEFT`, `RIGHT`, `MID`, `UPPER`,
`LOWER`, `TRIM`, `CONCATENATE`, `CONCAT`, `SUBSTITUTE`, `REPLACE`, `REPT`, `EXACT`, `FIND`, `SEARCH`,
`VALUE` e os testes `IS…`.

**Regras do Excel seguidas à risca** (conferidas pelo oráculo):
- números com 15 algarismos significativos, como o Excel mostra e grava;
- arredondamento decimal (`ROUND(2.675,2)` = 2,68, como o Excel);
- `0,1+0,2=0,3` dá VERDADEIRO;
- texto comparado sem diferença de maiúsculas;
- critério vazio do `SUMIF` vale 0, como diz a documentação do Excel (sua base tem 151 linhas sem
  cidade);
- `VLOOKUP` pega a primeira ocorrência;
- `SUM` ignora texto.

**Recusado com aviso, sem calcular diferente do Excel:**
- funções ainda não suportadas (ex.: `TEXT`; o aviso diz qual);
- `VLOOKUP` aproximado (sem `FALSE`);
- referência a outra planilha ou a nome;
- referência circular;
- coluna que já tem valores.

## A IA

A IA pode criar a mesma coluna calculada. Quando ela escreve uma fórmula numa linha e a preenche na
própria coluna (`set_formula` + `fill_range`, em uma ou várias partes por causa do limite de 200 mil
células por operação), o app cria **uma** coluna calculada sobre a base inteira. A IA recebe de volta
a extensão real (`J2:J1048568`) e os valores da primeira e da última linha, lidos do motor.

Valores digitados pela IA também passam. Fica **recusado, com o motivo**:
- formatação;
- mudanças de estrutura;
- fórmula solta numa célula (para totais, a IA usa `aggregate_range`).

A descrição da base que a IA recebe explica isso e lista as funções aceitas.

## Como funciona

- **Motor (Rust):** `formula.rs` lê a fórmula uma vez e avalia linha por linha, com as regras do Excel
  para valores, conversão e erros.
  - O acumulado avança junto com as linhas e soma na mesma ordem de uma soma refeita do zero, então o
    resultado é o mesmo número do Excel.
  - `SUMIF`, `COUNTIF` e `VLOOKUP` montam um índice uma vez só.
- **A coluna mora na base:** `calc.rs` grava os resultados na própria coluna. Por isso a tela,
  Localizar, Ctrl+↓ e o Salvar funcionam sem nada especial. Desfazer esvazia a coluna; refazer
  recalcula.
- **Edições ainda não salvas valem:** cada pedido leva as edições do diário da tela, então a fórmula lê
  o que você vê, não a base como estava no último Salvar.
- **Recálculo:**
  - uma fórmula só com a própria linha recalcula só as linhas editadas;
  - as demais recalculam a coluna, gravando só o que mudou;
  - uma fórmula que lê outra coluna calculada vem em seguida.
- **Salvar:** as colunas calculadas alcançam o diário (sem refazer o que já estava em dia), o diário é
  gravado, e uma célula digitada por cima da fórmula fica sendo sua.
- **Tela:** a leitura da tela não espera o recálculo, que roda com uma trava só de escrita.

## Teste com a sua base (1.048.567 transações)

App real, aberto pelo menu, Linux com 4 núcleos e 15 GB. Roteiro
`suite/bench/abrir-milhao/verify-calc.mjs`; oráculo `oraculo-coluna-calculada.py`, que refaz as seis
fórmulas sobre o original com o leitor `csv` do Python.

| Verificação | Resultado |
| --- | --- |
| 6 colunas digitadas: `=I2*0.18`, `=SUM($I$2:I2)`, `=SUMIF(E:E,E2,I:I)`, `=COUNTIF($B$2:B2,B2)`, `=IF(I2>F2,"acima","ok")`, `=VLOOKUP(B2,$B$2:$I$1048568,8,FALSE)` | Calculadas |
| Na tela: primeira linha, meio e última linha das 6 colunas | Iguais ao oráculo |
| `=TEXT(I2,"0")` | Recusada com aviso; célula vazia |
| Editar `I3` para 1000 | `J3` = 180 e o acumulado de `K3` em diante refeitos |
| Desfazer a edição | `J3` volta ao valor original |
| Desfazer e refazer a coluna `O` (`PROCV`) | Some e volta |
| Edição que fica (`I5` = 2000) e Salvar | **CSV salvo igual ao oráculo em 15.728.520 campos (0 divergências)** |

| Medida no app (inclui digitar e esperar o aviso) | Resultado |
| --- | --- |
| Criar coluna por linha (`=I2*0.18`) | 3,2 s |
| Acumulado / `SUMIF` / `COUNTIF` acumulado / `IF` / `VLOOKUP` | 4,4 / 5,2 / 5,4 / 4,8 / 7,2 s |
| Editar `I3` até `J3` mudar na tela | 2,5 s (inclui ~1 s do roteiro navegando) |
| Até o acumulado (`K3`) mudar, com 6 colunas para refazer | 9,4 s |
| Salvar o CSV com 15 colunas (114 MB) | 6,4 s |
| Maior pausa da tela em todo o roteiro | 1,5 s numa rodada, ao criar o `COUNTIF` acumulado (0,3 s na rodada anterior; o perfil dessa criação não mostra trabalho pesado na tela). Nas demais etapas, até 0,77 s |
| Pico de memória do app inteiro | 1.635 MB (era ~1 GB sem colunas calculadas) |

O motor sozinho, sem a tela, com a mesma base:

| Fórmula | Tempo |
| --- | --- |
| `=I2*0.18` | 1,5 s |
| `=SUM($I$2:I2)` | 1,9 s |
| `=SUMIF(E:E,E2,I:I)` | 3,0 s |
| `=COUNTIF($B$2:B2,B2)` | 4,0 s |
| `=I2/SUM(I:I)` | 2,3 s |
| `=IF(I2>F2,"acima","ok")` | 2,3 s |
| `=VLOOKUP(B2,$B$2:$I$1048568,8,FALSE)` | 3,6 s |
| Desfazer uma coluna | 0,6 s |

No Excel, preencher `=SOMASE(E:E;E2;I:I)` em 1 milhão de linhas faz 1 milhão de somas sobre 1 milhão
de linhas cada uma; aqui é uma passada com índice.

### A IA (modelo simulado)

Roteiro `verify-ai-calc.mjs`. O modelo é um servidor simulado com um roteiro fixo, **não um modelo de
verdade**. O roteiro lê o contexto, escreve o cabeçalho e a fórmula em `J2`, e preenche a coluna em 6
partes de até 200 mil células.

| Verificação | Resultado |
| --- | --- |
| A coluna `J` inteira na tela (primeira linha, meio, última) | Certa |
| Aviso devolvido à IA | `J2:J1048568`, com os valores de `J2` e da última linha |
| Rejeitar a tarefa | Cabeçalho e coluna somem |
| Pedir de novo e aceitar | Coluna mantida |
| CSV salvo, conferido em Python linha a linha | 0 divergências em 1.048.568 linhas |

## Correções no caminho

- **Travamento de 30 s ao digitar o `PROCV`:** antes de rodar o comando, o Univer conferia a permissão
  de cada uma das 8 milhões de células citadas na fórmula. Na base grande, que não tem proteção, essa
  conferência é pulada; a tela não trava mais.
- **Colunas novas sumiam fora da tela:** a grade não sabia que a base tinha ganhado colunas. Agora a
  largura acompanha a coluna calculada, inclusive depois de salvar.
- **Releitura da IA apagava a célula de origem da tela:** na base grande, os resultados para a IA vêm
  do motor.

## Testes

| Teste | Resultado |
| --- | --- |
| Motor (Rust): fórmulas (contas, erros, `SE`, textos, acumulado, grupos, `PROCV`/`PROCX`/`CORRESP`/`ÍNDICE`, arredondamento do Excel, recusas) e coluna calculada (criar, editar, desfazer, refazer, salvar com célula digitada por cima) | 15/15 |
| Planilha (vitest), com testes novos da coluna calculada e da IA | 3.904 aprovados. Falham 4 que já falhavam antes, com o código anterior: as 3 de `promote-file-atomically` (usuário root) e `table-design` (tempo-limite de 5 s ao importar o módulo nesta máquina) |
| Ponta a ponta do Fariv | 23/24. A que falha (`.xlsx` vazio salvo no próprio caminho) também falha 3 de 3 vezes com o código anterior nesta máquina |
| Coluna calculada pela IA no CSV de 10 mil linhas (caminho comum) | 11/11 |
| Editar, desfazer e salvar a base grande (`verify-edit-save`) | 7/7 (a fórmula numa coluna com dados agora é recusada com o aviso de coluna vazia) |

## Limites desta etapa

- **Nomes das funções em inglês**, como no resto da planilha do Fariv hoje.
- **Barra de fórmulas:** a célula da coluna calculada mostra o valor, não a fórmula. A fórmula fica no
  aviso e no histórico de desfazer.
- **A fórmula vai numa coluna vazia, da linha 2 em diante.** Colar ou arrastar fórmulas por várias
  células ainda é recusado.
- **Pareto ABC pronto** (classe A/B/C por produto) não entrou: depende de ordenar pelo total, o que não
  cabe numa fórmula de linha. É a próxima peça, junto com a dinâmica nativa.
- **`PROCV` em outro arquivo** (tabela de produtos separada) ainda não. O `PROCV` funciona dentro da
  própria base.
- **XLSX salvo grava os valores**, não as fórmulas.
- **Recálculo das colunas que leem a coluna inteira** leva segundos depois de cada edição, em segundo
  plano. As fórmulas por linha são imediatas.
- **Memória:** cada coluna calculada fica na base do motor; com 6 colunas o app chegou a 1,6 GB.
- **Windows:** sem teste e sem `.exe`. É o próximo passo combinado.
