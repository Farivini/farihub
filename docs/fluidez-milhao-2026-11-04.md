# Farihub — fluidez com 1 milhão de linhas

04/11/2026. **Veredito: a combinação DuckDB nativo + janela pequena na grade mostrou viabilidade no ensaio. O aplicativo normal ainda não está pronto para esse marco.** Não houve merge, alteração do editor de produção, instalador, teste Windows ou uso de modelo real no candidato.

## O que mudou na investigação

O critério passou a ser conseguir usar a aplicação enquanto ela trabalha. Memória é medida como apoio; não é tratada como prova de congelamento nem de fluidez.

O ensaio do caminho atual usa a correção da PR #12, commit `24dafbd81376cfc5af51cb315fbb7fe55b523eff`. Os 387 arquivos de `apps/sheets/src` e os 39 arquivos nativos foram conferidos por hash contra esse commit e não foram modificados nesta etapa. A #13 registra decisões/CI; ela não havia incorporado o DuckDB ao aplicativo medido.

## O que foi efetivamente executado

1. Caminho existente com 10 mil linhas: Electron, renderer e sidecar reais; provedor de IA simulado; cálculo, aceite e XLSX salvos. Zero divergências nas 10 mil fórmulas/resultados lidos da grade. Não foi repetido o roteiro inteiro de rejeitar/desfazer/salvar/reabrir da PR #12.
2. Experimento com 1 milhão: DuckDB 2.0.0 chamado por Rust, como processo filho do processo principal do Electron. Importação direta do CSV, leituras pequenas, cálculo da coluna por definição, salvar Parquet mais definição, reabrir e exportar resultados para conferência independente.
3. Grade real do Farihub/Univer: primeiro com 1 milhão de linhas físicas; depois com uma aba de 201 linhas, mostrando 100 registros por vez. Um controle experimental de navegação busca começo, meio e fim da base e identifica os números absolutos das linhas. Essa navegação é dirigida pelo controle do experimento; **a rolagem e a abertura normais do produto não foram integradas**.

Nada foi simulado no cálculo do DuckDB ou nas leituras de arquivos. No candidato não houve chamada de IA: o driver enviou as operações explicitamente. Isso não valida que um modelo real escolherá as ferramentas certas.

## Resultado funcional

| Verificação                                           | Base original repetida — 1 milhão | Base variada — 1 milhão |
| ----------------------------------------------------- | --------------------------------: | ----------------------: |
| Registros conferidos independentemente                |                         1.000.000 |               1.000.000 |
| Divergências em código, quantidade, preço e cálculo   |                             **0** |                   **0** |
| Células comparadas no renderer com os trechos nativos |                             6.500 |                   6.500 |
| Divergências nos trechos exibidos                     |                             **0** |                   **0** |
| Salvar e reabrir a definição no formato interno       |                            Passou |                  Passou |
| Soma independente de todas as linhas                  |                     17.044.487,00 |       23.117.857.519,49 |

O oráculo é Python `csv`/`Decimal`, independente do DuckDB. A tolerância numérica de `1e-8` por célula contempla representação binária; não aceita erros de centavos. Não se usa apenas a soma para aprovar: cada registro é conferido. O oráculo roda após reabrir o arquivo interno e exportar os resultados. A soma é de todas as linhas, com negativos; não é “vendas válidas”.

A base original é repetida, não uma nova população de registros. A segunda base foi gerada com diversidade de códigos, descrições com delimitador/aspas, preços com milhares e vírgula decimal e quantidades negativas. Também foram conferidos identificadores com zeros à esquerda no renderer, preservando explicitamente o tipo texto.

## O gargalo adicional encontrado

Com DuckDB funcionando, criar a grade com 1 milhão de linhas físicas ainda produziu **3.399,8 ms entre frames** e uma tarefa longa de 3.211 ms na primeira exibição. Portanto, substituir somente o motor não resolve a espera da interface.

Com a janela pequena, a base continua inteira no processo nativo, mas o renderer mantém uma janela de 100 registros. Isso retirou a necessidade de criar a estrutura visual inteira e preencher milhões de objetos na grade. Nos dois ensaios finais, a maior distância entre frames foi **333,2 ms** (original repetida) e **200 ms** (variada). Ainda existem pausas curtas; não se afirma fluidez perfeita ou ausência de qualquer travamento em outro computador.

No caminho atual da PR #12, a repetição válida de 10 mil linhas registrou até **666,6 ms entre frames** durante a operação de IA. Uma tentativa anterior registrou 1.916,5 ms, mas o roteiro confundiu a resposta de sucesso com recusa e não concluiu o salvamento; esse ensaio não é usado como comparativo principal. O detector foi corrigido e a repetição completou cálculo e salvamento.

São observações, não medianas/SLA nem prova de ganho geral em relação ao Excel. O caminho candidato, o salvamento e a representação das fórmulas são diferentes do editor atual. Não comparar suas durações como se fossem operações idênticas.

## Tempos observados nos ensaios finais

| Operação                                                | Original repetida — 1 milhão | Variada — 1 milhão |
| ------------------------------------------------------- | ---------------------------: | -----------------: |
| Importação nativa até retorno do resultado              |                       3,54 s |             4,91 s |
| Cálculo por definição, incluindo retorno ao controlador |                      0,030 s |            0,032 s |
| Navegação por controle até trecho exibido               |                  0,54–1,32 s |        0,30–0,37 s |
| Salvar Parquet mais definição                           |                       0,61 s |             0,90 s |
| Reabrir no motor                                        |                       0,52 s |             1,48 s |

Durante cálculo e salvamento, os intervalos máximos entre frames ficaram próximos de 17 ms nos ensaios finais. A resposta do preenchimento do campo de texto, medida pelo controlador durante a importação, variou de **27 a 660 ms**; nas duas execuções ele concluiu antes de a importação terminar. Esse tempo inclui foco/acionabilidade e ida e volta da automação; não é uma medição isolada do tempo de teclado do Windows. A tela permaneceu redesenhando durante o processamento.

O tempo para uma operação terminar não é a duração de congelamento: a navegação pode estar carregando um trecho enquanto outras partes da interface continuam respondendo. Os arquivos de evidência guardam os intervalos de frames, timers e durações das tarefas longas por etapa.

## Memória e ambiente

- Limite do ambiente: **8 GiB** por cgroup, oito CPUs equivalentes de quota. Não é o Acer Nitro do usuário.
- Motor candidato: dois threads e `memory_limit` configurado em 512 MB; esse parâmetro não é uma garantia de teto de RAM do processo inteiro.
- Pico de PSS somado da árvore do aplicativo: aproximadamente **1.074 MiB** na original repetida e **1.028 MiB** na variada. Inclui Electron, renderers, auxiliares, sidecar original e processo Rust candidato. Não inclui o controlador nem Xvfb. RSS somado e amostras estão nas evidências; RSS conta páginas compartilhadas mais de uma vez.
- Nenhum evento de OOM foi registrado no cgroup. Isso não comprova ausência de engasgos do sistema operacional inteiro; não foram medidos cursor/gerenciador de janelas, antivírus ou aplicativos concorrentes do Windows.
- Linux 6.18.57, Node 24.22.1, Electron **38.0.0** como runtime de teste. A dependência declarada de produção é **43.8.3**, que não foi testada aqui. GPU foi desativada para o ensaio em Xvfb.
- Sem compiladores, oráculos ou benchmarks concorrentes nas execuções medidas. O cache de arquivos do sistema não foi limpo. A aplicação de Planilhas roda standalone; não se mede o shell com outros módulos abertos.

Os números mostram por que reduzir memória isoladamente não é o objetivo: o candidato trabalhou com 100 vezes mais linhas e continuou usando memória relevante, mas o trabalho pesado ficou fora da interface e as pausas longas diminuíram. Isso justifica continuar a integração; não justifica declarar o produto aprovado.

## Limites que impedem aprovar o aplicativo para 1 milhão

1. **Caminho normal:** o menu de abrir ainda usa a importação anterior e o teto de 32 MB. O candidato usa um adaptador de ensaio dentro do renderer real, com uma aba e um controle de navegação próprios.
2. **Grade e identidade das linhas:** rolagem normal, seleção, edição e ferramentas precisam mapear as posições da janela para a base real. O experimento confere esse mapeamento nos trechos navegados, mas não oferece o editor completo.
3. **Edição e revisão:** mudanças de quantidade/preço, alteração da definição da coluna, aceitar/rejeitar e desfazer no novo motor ainda não foram integrados/testados. O teste unitário verifica a persistência da definição, não essas interações do produto.
4. **XLSX:** o salvamento candidato é Parquet com definição. Não foi implementado nem validado salvar/reabrir um XLSX de 1 milhão de linhas com fórmulas editáveis. Ele não deve ser apresentado como equivalente a essa função do Excel.
5. **Contexto da IA:** o leitor atual continua ligado à planilha. É necessário oferecer perfil e agregações da base completa; a IA não pode confundir as 201 linhas físicas da janela com o tamanho dos dados. Não houve modelo real no ensaio.
6. **Importação geral:** somente quantidade/preço foram declarados numéricos no candidato; as demais colunas permanecem texto. A preservação geral dos tipos e valores mistos do importador atual ainda precisa de implementação e testes.
7. **Distribuição:** Rust foi ligado à biblioteca compartilhada oficial DuckDB 2.0.0, com SHA-256 conferido contra o release. A compilação `bundled` completa foi interrompida intencionalmente por custo; não foi comprovada nesta etapa. Compilação MSVC, empacotamento e Windows continuam pendentes. Nenhum `.exe` foi gerado.

O antivírus permanece hipótese não investigada no Windows. Não é usado para explicar ou descartar as pausas encontradas no Linux.

## Evidências e sequência

Os scripts, teste Rust e resultados ficam em `suite/bench/million-live/`. Há um teste de integração nativa passando, com negativos, zeros à esquerda, limites de janela, rejeição de coluna inválida e salvar/reabrir a definição. `cargo fmt`, sintaxe dos drivers e compilação Python foram verificados. Não se declara execução da suíte inteira ou do e2e completo da aplicação, pois o código do produto não foi alterado.

Os JSON publicados omitem linhas da fonte, conversas e capturas de tela; mantêm hashes, medições brutas, oráculos e ambiente. Os dados originais são a amostra fornecida pelo usuário de Online Retail (Chen, UCI, DOI 10.24432/C5BW33, CC BY 4.0); o pacote não é redistribuído.

**Próxima etapa do mesmo marco:** integrar a abertura real e a navegação em janela no produto, depois conectar edição/cálculo/revisão/salvamento e repetir este roteiro. Configurações de IA, Genspark, visual e demais funcionalidades ficam suspensos. Só chamar o marco do aplicativo de concluído quando esse fluxo normal passar; só depois pedir o teste Windows ao usuário.
