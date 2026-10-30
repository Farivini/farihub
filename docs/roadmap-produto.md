# Roadmap do produto

Atualizado em 30/10/2026, com o estado conferido no código da `main` (inclui a correção de salvamento concorrente da PR #5, a entrada e saída de arquivos da PR #6) e nesta entrega (salvar por formato, CSV protegido, ressalvas persistentes). Com isso o comportamento de arquivos fica fechado; as próximas frentes são operações de tabela (filtros, ordenação, inserir/excluir linhas e colunas) e IA contextual.

## Visão

Um hub de trabalho com **Planilhas**, **Documentos**, **Apresentações** e, no futuro, **BI**, numa interface minimalista e com **IA contextual opcional**: a IA ajuda quando chamada, trabalha sobre o documento aberto e nunca é obrigatória para usar o produto.

## Como ler

| Marca | Significado |
| --- | --- |
| **Implementado** | Existe no código, tem teste automatizado e funciona na interface. |
| **Parcial** | Existe uma parte; o que falta está escrito ao lado. |
| **Planejado** | Ainda não existe código. A ordem das seções não é compromisso de data. |

Nada aqui é estimativa de prazo.

## Estado atual (resumo)

- **Implementado:** planilha funcional com IronCalc 0.9.1 (WASM) em Web Worker, fonte única da verdade; fórmulas em português; formatação básica (número, moeda R$, porcentagem, data, negrito, alinhamento); várias pastas em abas, cada uma com seu motor; tabela dinâmica e gráfico ligado a ela; abrir e salvar `.xlsx` (padrão) e `.farcel` (nativo), com Salvar como e perdas explicadas; importar CSV/TSV/TXT com prévia e exportar CSV/TSV protegido ou original; base sintética de 1.000.000 de linhas medida no navegador.
- **Parcial:** assistente (painel existe, **não conectado**).
- **Placeholders:** Documentos e Apresentações aparecem como “em preparação”; não há editor.
- **Atenção:** o painel do assistente monta um contexto limitado (até 20 linhas de amostra, 30 colunas, 50 linhas de dinâmica). Isso **não** é capacidade de analisar a base inteira; ver “Execução da IA”.

## Planilhas

| Item | Estado | Observação |
| --- | --- | --- |
| Fórmulas familiares ao Excel, em português | **Implementado** | 166 funções traduzidas (`=SOMA`, `=PROCV`, `;` e vírgula decimal). Funções que o IronCalc não calcula mostram `#NOME?` e o texto da fórmula é preservado. |
| Formatação | **Parcial** | Número, moeda R$, porcentagem, data, negrito, itálico (exibição), alinhamento. Faltam fontes, cores, bordas, preenchimento, quebra de texto (o motor já guarda quando vêm de um XLSX). |
| Filtros na grade | Planejado | Hoje só há filtros dentro da tabela dinâmica. |
| Ordenação | Planejado | |
| Inserir/excluir linhas e colunas | Planejado | O motor tem as operações (`insertRows`, `deleteColumns`…); falta interface e espelho do desfazer. |
| Congelar painéis | Planejado | O motor guarda e exporta painéis congelados de um XLSX; a grade não exibe. |
| Larguras de coluna e alturas de linha | Planejado | Mesma situação: guardadas e exportadas, não exibidas. |
| Validação de dados | Planejado | Também não é importada de XLSX (o IronCalc 0.9.1 não lê). |
| Busca (localizar/substituir) | Planejado | |
| Tabela dinâmica | **Implementado** | Linhas, colunas, valores (soma, contagem), filtros; atualiza após edição. Faltam média, mínimo, máximo, campos calculados, ordenação. |
| Gráficos | **Parcial** | Colunas e linhas ligados a uma dinâmica. Faltam gráficos sobre intervalos, outros tipos e exportação para XLSX. |

## Desempenho

Objetivo: **1.000.000 de linhas por aba** com a interface responsiva.

| Medição | Estado | Observação |
| --- | --- | --- |
| Geração e cálculo de 1 M linhas no navegador | **Implementado** | `npm run bench:browser`, resultados em `docs/resultados-navegador.md`. |
| Dinâmica sobre 1 M linhas | **Implementado** (medido) | Extração colunar com invalidação por região. |
| Memória (WASM) | **Parcial** | Medida no gerador e na dinâmica; falta perfil por operação. |
| Edição e recálculo em base grande | Planejado | Medir tempo de uma edição com dependentes em 1 M linhas. |
| Filtros e ordenação em base grande | Planejado | Depende de existirem. |
| Importação/exportação em base grande | **Parcial** | Medido no Node com o mesmo WASM (`scripts/bench-xlsx.ts`, ver `docs/xlsx.md`); falta medir na interface e no Windows. |
| Arquivos reais | Planejado | Todos os números atuais vêm de **bases sintéticas**. Precisamos de um conjunto de arquivos reais (anonimizados) e de reportar os dois separadamente. |

## Importações

### Iniciais

| Formato | Estado | Observação |
| --- | --- | --- |
| XLSX | **Implementado** | Importador do próprio IronCalc compilado para WASM (`native/xlsx-bridge`). Relatório do que não é mantido. Ver `docs/xlsx.md`. |
| CSV, TSV, TXT delimitado | **Implementado** | Prévia com codificação (UTF-8/Windows-1252), separador, decimal, cabeçalho e tipo por coluna; códigos com zeros à esquerda ficam texto; datas dd/mm/aaaa e aaaa-mm-dd; nenhum valor vira fórmula. |
| Conferência de datas e decimais | **Parcial** | A prévia mostra cada valor como será lido e marca colunas tratadas como texto. Faltam datas mm/dd/aaaa, data e hora, avisos de valores ambíguos por coluna. |

### Posteriores

| Formato | Estado | Observação |
| --- | --- | --- |
| Vários arquivos e pastas de uma vez | Planejado | Empilhar arquivos com o mesmo layout, com coluna de origem. |
| XML de notas fiscais (NF-e) | Planejado | Estrutura própria: uma tabela de notas e uma de itens, ligadas pela chave da nota. |
| XLS (Excel 97–2003) | Planejado | |
| ODS | Planejado | |
| JSON | Planejado | |
| HTML (tabelas) | Planejado | |
| Tabelas de PDF e OCR | Planejado | |
| Parquet | Planejado | |

## Conectores (futuros, conforme demanda)

Google Sheets, Google Drive, OneDrive/SharePoint, bancos SQL, APIs e Databricks. **Planejado**; nenhum existe.

## Exportação

| Formato | Estado | Observação |
| --- | --- | --- |
| XLSX | **Implementado** | Formato essencial de interoperabilidade e **padrão para pasta nova**. Fórmulas saem como fórmulas do Excel. Ctrl+S num arquivo XLSX grava XLSX; Salvar como… escolhe formato e nome. Se o XLSX não teria algo (dinâmicas do Planilhas; recursos do arquivo original que não foram importados), o app explica e deixa escolher. |
| CSV (;) e TSV | **Implementado** | Uma planilha, valores como exibidos, UTF-8 com BOM; o app avisa antes que fórmulas viram resultados e a formatação não vai. Padrão “para abrir em planilhas” (texto que viraria fórmula recebe `'`; números, inclusive negativos, não mudam) ou “dados originais” para integração. |
| `.farcel` | **Implementado** | Formato nativo: guarda dinâmicas, gráficos e a origem com o relatório de importação. Alternativa ao XLSX ao salvar. |
| Gravar no próprio arquivo | **Parcial** | No Chromium desktop (File System Access API) Ctrl+S grava o arquivo aberto ou escolhido. Outros navegadores baixam uma cópia, e o app diz isso. O executável terá acesso nativo. |

## IA

Capacidades desejadas: **analisar, explicar, preparar dados, criar fórmulas, tabelas, dinâmicas e gráficos e executar alterações no documento aberto**. Exemplos como “separar notas fiscais por fornecedor” ou “criar três colunas a partir desta” são ilustrações; não limitam o escopo.

| Item | Estado |
| --- | --- |
| Painel do assistente, recolhível, com contexto visível | **Parcial** (não conectado; não envia nada) |
| Conexão com um modelo | Planejado |
| Explicar fórmula/célula/dinâmica | Planejado |
| Criar fórmulas, tabelas, dinâmicas e gráficos | Planejado |
| Preparar dados (limpar, dividir, unir colunas) | Planejado |

### Execução da IA

| Item | Estado | Observação |
| --- | --- | --- |
| Ferramentas tipadas para consultar e calcular sobre a **base completa** | Planejado | A IA pede agregações, filtros e amostras ao motor; a base inteira não vai para o modelo. O contexto de 20 linhas de hoje é só amostra. |
| Operações verificáveis | Planejado | Cada alteração proposta é uma lista de operações sobre o motor (célula, intervalo, fórmula, dinâmica), validada antes de aplicar. |
| Prévia, aceitar/rejeitar | Planejado | |
| Desfazer a tarefa inteira | Planejado | Um passo de desfazer por tarefa, não por célula. |
| Conflitos | Planejado | Se a pessoa editar durante a tarefa, a proposta é revalidada; nada é aplicado sobre dados que mudaram. |

## Fórmulas sem código

Compor cálculos e cruzamentos visualmente (escolher colunas, condição, agregação), gerando fórmulas normais que continuam editáveis. **Planejado.**

## Documentos e Apresentações

| Item | Estado |
| --- | --- |
| Espaços na interface | **Parcial** (placeholders “em preparação”) |
| Editores funcionais | Planejado |
| Modelos | Planejado |
| Geração assistida | Planejado |
| Conteúdo vinculado às análises (tabela/gráfico que atualiza) | Planejado |
| Importar/exportar DOCX e PPTX | Planejado |

## Relatórios recorrentes

Reaproveitar preparação e análise com dados novos: trocar a fonte, reaplicar os passos, atualizar gráficos e destacar o que mudou em relação ao período anterior. **Planejado.**

## Confiabilidade

| Item | Estado | Observação |
| --- | --- | --- |
| Salvar só o que foi gravado (edição durante gravação fica pendente) | **Implementado** | PR #5; vale para XLSX e `.farcel`. Um XLSX que não guarda as dinâmicas também não marca a pasta como salva. |
| Abrir não destrói trabalho | **Implementado** | Arquivo abre em aba nova quando a atual tem conteúdo; arquivo recusado não altera a pasta aberta. |
| Avisos de compatibilidade | **Parcial** | Relatório na importação XLSX, gravado no `.farcel` e repetido ao salvar em XLSX, inclusive depois de reabrir. Falta aviso ao digitar uma função que o Excel não tem (ou vice-versa). |
| Salvamento automático | Planejado | |
| Recuperação após queda | Planejado | |
| Histórico por arquivo | Planejado | |

## Desktop

| Item | Estado | Observação |
| --- | --- | --- |
| Executável Windows | Planejado | Arquivos nativos, instalação e atualização. |
| Núcleo compartilhável com web e mobile | **Parcial** | Motor, formato, dinâmica, CSV e conversor XLSX são módulos sem dependência de interface. Pontos de injeção já existem: `window.farivWindow` (janela) e `window.farivFiles` (arquivos). |

## BI (futuro)

Dashboards interativos, relações entre tabelas, medidas, filtros, detalhamento (drill-down) e atualização de fontes. **Planejado.**

## Depois

Automações por agendamento ou chegada de arquivo, colaboração, sincronização e uma experiência mobile própria. **Planejado.**
