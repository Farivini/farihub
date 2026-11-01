# Roadmap do produto

Atualizado em 30/10/2026, com o estado conferido no código da `main` (até a PR #7: arquivos por formato, CSV protegido, ressalvas persistentes) e nesta entrega: **operações de tabela** — filtros, ordenação, inserir e excluir linhas e colunas, com desfazer, por uma API tipada que a IA vai usar. A próxima frente é a IA contextual sobre essas operações.

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

- **Implementado:** planilha funcional com IronCalc 0.9.1 (WASM) em Web Worker, fonte única da verdade; fórmulas em português; formatação básica (número, moeda R$, porcentagem, data, negrito, alinhamento); várias pastas em abas, cada uma com seu motor; filtros, ordenação e inserir/excluir linhas e colunas com desfazer ([operações de tabela](tabela.md)); tabela dinâmica e gráfico ligado a ela; abrir e salvar `.xlsx` (padrão) e `.farcel` (nativo), com Salvar como e perdas explicadas; importar CSV/TSV/TXT com prévia e exportar CSV/TSV protegido ou original; base sintética de 1.000.000 de linhas medida no navegador.
- **Parcial:** assistente (painel existe, **não conectado**).
- **Placeholders:** Documentos e Apresentações aparecem como “em preparação”; não há editor.
- **Atenção:** o painel do assistente monta um contexto limitado (até 20 linhas de amostra, 30 colunas, 50 linhas de dinâmica). Isso **não** é capacidade de analisar a base inteira; ver “Execução da IA”.

## Pacote Fariv sobre a base GenOffice OSS (`suite/`)

Em andamento: o pacote desktop com os três editores no mesmo aplicativo usa a base GenOffice OSS escolhida no mapa de reaproveitamento (PR #9). O Farihub web desta página continua como referência; as decisões aprovadas dele são portadas sem apagar o original. Detalhes, verificações e diferenças em [suite-integracao.md](suite-integracao.md).

| Item | Estado | Observação |
| --- | --- | --- |
| Base importada com origem, versão e licença rastreáveis | **Incorporado** | GenOffice `36a509e8`, Apache-2.0, sem `ee/`; `suite/UPSTREAM.md`. |
| Planilhas, Documentos e Apresentações no mesmo app (XLSX, DOCX, PPTX) | **Incorporado** | Shell com abas da base; e2e Fariv abre, edita, salva e reabre os três formatos. |
| Desenvolvimento com recarga e instalador Windows no CI | **Incorporado** | `npm run suite:dev`; `suite.yml` gera o instalador (sem assinatura). Falta validar num Windows real. |
| Identidade Fariv, seletor central, barra enxuta | **Adaptado** | Nome, ícone, linha de título com seletor Planilhas · Documentos · Apresentações, faixas compactas por padrão, convites da origem retirados. Falta: textos da conta/créditos da nuvem de origem (fora do padrão desde a etapa 3), manual de ajuda descrevendo telas da origem, ícones de tipo de arquivo. |
| Assistente nos arquivos abertos (Codex local), com prévia, aceitar/rejeitar, desfazer e conflito | **Adaptado** | Codex local por padrão (só leitura); ferramentas e loop da base. Prévia **no próprio documento aberto** (ainda não um rascunho isolado): o arquivo só muda depois de uma decisão explícita; aceitar ou rejeitar a tarefa inteira numa ação; reversão só conta depois de confirmada; falha com edição manual preserva a edição; nova conversa ou novo pedido não decidem pendências. e2e com modelo simulado nos três editores. Falta: rascunho isolado; validar o Codex real no Windows; levar o MCP externo e o conflito por mudança no disco para o mesmo fluxo. |
| Claude local no mesmo contrato; tarefas recorrentes | Planejado | Componentes identificados no Nimbalyst. |
| Fórmulas em português, CSV pt-BR, agregação para bases grandes | Planejado | Existem no Farihub; a base usa nomes em inglês, ponto decimal no CSV e limita a dinâmica a 10 mil linhas. |

## Planilhas

| Item | Estado | Observação |
| --- | --- | --- |
| Fórmulas familiares ao Excel, em português | **Implementado** | 166 funções traduzidas (`=SOMA`, `=PROCV`, `;` e vírgula decimal). Funções que o IronCalc não calcula mostram `#NOME?` e o texto da fórmula é preservado. |
| Formatação | **Parcial** | Número, moeda R$, porcentagem, data, negrito, itálico (exibição), alinhamento. Faltam fontes, cores, bordas, preenchimento, quebra de texto (o motor já guarda quando vêm de um XLSX). |
| Filtros na grade | **Implementado** | Um filtro por planilha, botões no cabeçalho com valores, contagem, busca e `(Vazias)`; linhas ocultas sem apagar dados, marcadas na grade; copiar, Delete e a soma da barra de status pegam só as visíveis. Gravado no `.farcel`; no XLSX ficam as linhas ocultas e o app avisa que o filtro não vai. Faltam: filtros por condição (maior que, contém, entre datas), por cor, reaplicar automaticamente depois de editar, filtro em mais de uma tabela por planilha. Ver [operações de tabela](tabela.md). |
| Ordenação | **Implementado** | Crescente/decrescente, várias colunas, com ou sem cabeçalho; registros inteiros (valores, fórmulas, estilos); números/datas, texto pt-BR, booleanos, erros, vazias no fim; pergunta “tabela inteira?” quando a seleção corta a tabela. Recusa intervalos com células mescladas ou fórmulas matriciais. Faltam: ordenar por cor, lista personalizada, ordenar colunas (da esquerda para a direita). |
| Inserir/excluir linhas e colunas | **Implementado** | Pela seleção, pelo menu dos cabeçalhos, várias de uma vez; referências atualizadas em todas as planilhas pelo IronCalc; desfazer devolve fórmulas que viraram `#REF!`. Em bases grandes inserir perto do topo é lento (o motor move célula a célula): acima de ~3 s o app mostra a estimativa e pede confirmação. Excluir linhas com linhas ocultas na seleção fica desabilitado. |
| Desfazer/refazer de operações de tabela | **Implementado** | Cada operação é um passo. Ordenação, filtro e exclusão guardam o modelo anterior (até 4; 1 em pastas grandes) e o app avisa quando os passos mais antigos são descartados. |
| Ocultar/reexibir linhas e colunas manualmente | **Parcial** | Linhas ocultas de arquivos aparecem ocultas e podem ser reexibidas pelo menu; falta “Ocultar” e todo o tratamento de colunas ocultas (guardadas e exportadas, não exibidas). |
| Congelar painéis | Planejado | O motor guarda e exporta painéis congelados de um XLSX; a grade não exibe. |
| Larguras de coluna e alturas de linha | Planejado | Mesma situação: guardadas e exportadas, não exibidas. |
| Validação de dados | Planejado | Também não é importada de XLSX (o IronCalc 0.9.1 não lê). |
| Busca (localizar/substituir) | Planejado | |
| Tabela dinâmica | **Implementado** | Linhas, colunas, valores (soma, contagem), filtros; atualiza após edição e após ordenar, filtrar, inserir ou excluir. Usa **a base inteira**, inclusive linhas ocultas pelo filtro da grade (dito na própria dinâmica). Faltam média, mínimo, máximo, campos calculados, ordenação. |
| Gráficos | **Parcial** | Colunas e linhas ligados a uma dinâmica. Faltam gráficos sobre intervalos, outros tipos e exportação para XLSX. |

## Desempenho

Objetivo: **1.000.000 de linhas por aba** com a interface responsiva.

| Medição | Estado | Observação |
| --- | --- | --- |
| Geração e cálculo de 1 M linhas no navegador | **Implementado** | `npm run bench:browser`, resultados em `docs/resultados-navegador.md`. |
| Dinâmica sobre 1 M linhas | **Implementado** (medido) | Extração colunar com invalidação por região. |
| Memória (WASM) | **Parcial** | Medida no gerador e na dinâmica; falta perfil por operação. |
| Edição e recálculo em base grande | Planejado | Medir tempo de uma edição com dependentes em 1 M linhas. |
| Filtros e ordenação em base grande | **Implementado** (medido) | 100 mil e 1 milhão de linhas, no Node e no navegador, tempo e memória: ver [operações de tabela](tabela.md#medições). Em 1 milhão: filtrar e ordenar levam segundos (com a interface livre, no worker); a primeira operação grande da sessão é mais lenta porque o WASM aloca memória para a cópia do modelo. Falta medir no Windows e em arquivos reais. |
| Inserir/excluir no topo de base grande | **Parcial** | Medido: ~18 s para inserir uma linha acima de 1 milhão de linhas (o IronCalc move cada célula). O app estima e pede confirmação; uma implementação mais rápida dependeria do motor. |
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
| Operações de tabela tipadas (ordenar, filtrar, inserir, excluir) | **Implementado** | `tableOp`/`tableQuery`/`rowLayout` no worker, com tipos em `src/core/table-ops.ts`; a interface usa a mesma API. Cada chamada é um passo de desfazer e as lentas pedem confirmação. Ver [operações de tabela](tabela.md#api-tipada). |
| Ferramentas tipadas para consultar e calcular sobre a **base completa** | **Parcial** | Já existem consultas sobre a base inteira no worker (valores distintos com contagem de uma coluna, região da tabela, dinâmica). Faltam agregações e amostras sob demanda para o modelo. A base inteira não vai para o modelo; o contexto de 20 linhas de hoje é só amostra. |
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
