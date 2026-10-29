# Prova técnica 01: Farcel

## Restrições confirmadas

Windows, arquivos locais, edição offline, IA conectada, sem motor comercial pago. Tabela dinâmica é central. Objetivo: um milhão de linhas, gráficos e fórmulas compatíveis com Excel em português. A interface aprovada é minimalista, com módulos laterais Farcel/Fardoc/Farcanvas e assistente integrado.

## Hipóteses, não decisões fechadas

React/TypeScript no produto; canvas + DOM no Farcel; IronCalc para fórmulas; ProseMirror para documentos; DOM/SVG para slides; comparar Tauri e Electron. Este repositório começa por uma prova sem framework, não pela implementação da interface.

## O que esta entrega mede

- Agregação em um worker Node de um snapshot sintético com três colunas tipadas e um milhão de linhas.
- Totais confrontados com um resultado conhecido; filtros e entradas inválidas testados.
- Um probe separado, opcional, do candidato IronCalc para fórmulas básicas e endereçamento esparso.

Essa agregação é uma peça de investigação, não a tabela dinâmica do produto. O fixture tem apenas cinco grupos; cardinalidade alta, strings, valores ausentes, datas e edição incremental precisam de outros corpus.

## Próximos gates

1. Executar IronCalc e verificar APIs, licença do pacote e dependências; evitar dois modelos autoritativos de planilha.
2. Confrontar fórmulas com arquivos calculados pelo Excel. Cobrir SOMA, MÉDIA, SE, SOMASES, CONT.SES, PROCV, PROCX, datas, arredondamento, erros e referências entre abas. Medir recálculo após edição.
3. Carregar um milhão de linhas preenchidas no motor candidato e comparar memória/tempo com o snapshot colunar. Variar quantidade de colunas, fórmulas e grupos.
4. Implementar dinâmica configurável (linhas, colunas, valores, filtros), reconciliação de totais e gráfico ligado ao resultado.
5. Medir renderização, seleção, acentos e copiar/colar no navegador e no executável Windows. Medir Tauri e Electron na mesma máquina/corpus.
6. Salvar e reabrir XLSX; comparar fórmulas, valores e estilos. Testar recuperação de falhas antes de usar arquivos reais de clientes.
7. Integrar comandos de IA com proposta, revisão e desfazer. Reaproveitar resultados no Fardoc e Farcanvas.

## Como julgar

Corretude antes de desempenho; nenhuma perda silenciosa. Registrar ambiente, corpus, contagem de células/fórmulas, memória e tempos por operação. Definir metas de desempenho após conhecer RAM/processador e corpus representativo. Resultados deste container Linux não qualificam uma máquina Windows de cliente.

## Referências para verificar

- https://github.com/ironcalc/IronCalc
- https://www.npmjs.com/package/@ironcalc/nodejs
- https://ironcalc.readthedocs.io/en/latest/usage_examples.html

O probe usa API Node documentada; isso não comprova que os mesmos métodos estarão disponíveis no pacote WASM.
