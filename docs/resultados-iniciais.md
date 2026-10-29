# Resultados iniciais — 29/10/2026

Execução local em Linux x64, Node v24.22.1, CPU reportada AMD EPYC 9V74. Uma amostra por benchmark; carga e hardware diferentes dos computadores de clientes. Fontes completas em `docs/results/`.

## Agregação de snapshot

Um milhão de linhas, três colunas tipadas (região numérica, receita e custo em centavos), cinco grupos. Snapshot: 17 MB de buffers. Agregação no worker: 17,05 ms; incluindo inicialização do worker: 192,37 ms. Totais conferidos por expectativa independente. Quatro testes passaram.

Esse resultado não valida uma tabela dinâmica completa. O esquema é fixo, não há strings, subtotais configuráveis ou interação visual.

## IronCalc 0.9.1 — binding nativo Node

- Preenchimento real de 1.000.000 de linhas × 3 colunas numéricas: 769,01 ms.
- Uma fórmula `SUM(B1:B1000000)`: 218,13 ms; resultado 30.000.000.000 centavos.
- Alteração na última linha e novo cálculo: 224,10 ms; resultado 30.000.000.001 centavos.
- RSS do processo ao final: 188.653.568 bytes (aproximadamente 180 MiB). Não é pico de memória nem memória isolada do motor.
- Sete casos básicos em inglês passaram contra resultados calculados manualmente: SUM, AVERAGE, IF, SUMIF, COUNTIF, referência absoluta e divisão por zero.
- XLSX sintético com duas células foi salvo e reaberto no mesmo motor preservando `=A1*2` e o resultado 246. Não foi aberto no Microsoft Excel.

## Lacuna encontrada: português

`=SOMA(A1:A3)` no modo inglês devolveu `#NAME?`. Os identificadores de linguagem `pt`, `pt-BR` e `pt-PT` foram rejeitados pelo construtor. Isso não constitui levantamento completo dos idiomas disponíveis, mas mostra que não podemos presumir suporte PT-BR pronto nessa API.

Decisão pendente: verificar o código e idiomas suportados; avaliar extensão do motor ou camada de localização estruturada. Não traduzir fórmulas por substituição ingênua de texto: nomes de funções podem aparecer dentro de strings, nomes definidos e referências.

## O que permanece sem validação

Renderização/edição de grade, dinâmica completa, gráficos, famílias amplas de fórmulas, comparação com Excel, WASM no navegador, copiar/colar, idioma completo, XLSX de clientes, salvamento resistente a falhas e executável Windows. Não há IA implementada.

O workflow proposto repete esses testes em runners Windows e Linux; sua existência no repositório não significa que já passou em ambos. Nenhum empacotador foi escolhido.

## Licenças observadas

O pacote instalado `@ironcalc/nodejs@0.9.1` declara `MIT OR Apache-2.0` e inclui os dois arquivos de licença. O pacote binário opcional Linux instalado declara MIT em seu manifesto. Não é uma auditoria de futuras dependências nem de todos os binários/plataformas.
