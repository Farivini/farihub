# Farihub: mapa de código pronto para aproveitar

## Decisão proposta

Usar GenOffice como base do pacote de escritório, mantendo seus editores e módulos que já trabalham juntos. Adaptar a experiência para a identidade e simplicidade Fariv. Extrair do Nimbalyst as peças que faltam de Claude local e agendamento, em vez de reconstruir editores, transportes e rotinas do zero.

Isso substitui a recomendação anterior centrada em trocar nosso motor por GridPath. O objetivo agora é economizar construção do produto inteiro. Os benchmarks anteriores permanecem como evidência de limites, não como a decisão central.

Nesta rodada foram inspecionados arquivos locais, dependências e pontos de ligação; nenhum editor novo foi integrado ao aplicativo. A prova anterior de composição mínima XLSX foi executada separadamente. Não confundir catálogo de código aproveitável com funcionalidade já entregue no Fariv.

## O que já podemos deixar de escrever do zero

- Hospedagem de editores em abas, menus e janelas desktop.
- Editor de documentos e motor DOCX; editor de apresentações e motor PPTX; visualização/renderização e ferramentas de IA desses editores.
- Leitura/escrita XLSX, parte das definições de dinâmica/gráfico e estrutura de planilha.
- Loop de IA, streaming, chamada de ferramentas, cancelamento, compactação de contexto e ganchos de recuperação.
- Protocolos para provedores e gateways próprios, incluindo OpenRouter por endpoint compatível.
- **Integração Codex local: já existe no próprio GenOffice**, em `packages/ai-provider/src/codex-app-server.ts`. A avaliação anterior não tinha identificado essa implementação; não deve ser tratada como recurso ausente. A presença do código não é validação do login real com a conta do usuário.
- Base de automações recorrentes do Nimbalyst: definição, horários, disparo, registros e saída.
- Referência implementada de Claude via SDK no Nimbalyst, com leitura das opções de sessão, interrupção e configuração.

## Mapa rastreável

Cada link abaixo aponta ao commit inspecionado, não a uma branch que muda. Os 25 caminhos foram conferidos no filesystem. O índice estruturado está em [reuse-sources.json](../experiments/fusion/reuse-sources.json).
| Capacidade | Código inspecionado | Adaptação |
|---|---|---|
| Pacote e abas | [genoffice: tab-manager.ts](https://github.com/genspark-ai/genoffice/blob/36a509e8fc16ace85ed7afa3c37acb7b9c441ad1/apps/shell/src/main/tab-manager.ts) | Adotar como base de hospedagem dos editores; trocar navegação e tema. |
| Janela e instalador | [genoffice: electron-builder.cjs](https://github.com/genspark-ai/genoffice/blob/36a509e8fc16ace85ed7afa3c37acb7b9c441ad1/apps/shell/electron-builder.cjs) | Reconfigurar appId, nome, ícones, updater e publicação Fariv; assinatura precisa ser nossa. |
| Abrir e salvar | [genoffice: atomic-write.ts](https://github.com/genspark-ai/genoffice/blob/36a509e8fc16ace85ed7afa3c37acb7b9c441ad1/packages/electron-utils/src/atomic-write.ts) | Reutilizar escrita e adaptar aos contratos de salvamento do Fariv. |
| Recuperação | [genoffice: recovery-copy.ts](https://github.com/genspark-ai/genoffice/blob/36a509e8fc16ace85ed7afa3c37acb7b9c441ad1/packages/electron-utils/src/recovery-copy.ts) | Reutilizar mecanismo; validar recuperação integrada com nossos documentos. |
| Observar arquivo | [genoffice: disk-watch.ts](https://github.com/genspark-ai/genoffice/blob/36a509e8fc16ace85ed7afa3c37acb7b9c441ad1/packages/electron-utils/src/disk-watch.ts) | Sinal para detectar mudança; não é automação analítica pronta. |
| Planilha e ferramentas de IA | [genoffice: tools.ts](https://github.com/genspark-ai/genoffice/blob/36a509e8fc16ace85ed7afa3c37acb7b9c441ad1/apps/sheets/src/renderer/ai/tools.ts) | Reutilizar ferramentas e adaptar execução para rascunho em vez de autoaplicar. |
| Contexto e consulta | [genoffice: aggregate-range.ts](https://github.com/genspark-ai/genoffice/blob/36a509e8fc16ace85ed7afa3c37acb7b9c441ad1/apps/sheets/src/renderer/ai/aggregate-range.ts) | Usar leitura/consulta por necessidade; conectar agregação Fariv para bases grandes. |
| Loop de IA | [genoffice: loop.ts](https://github.com/genspark-ai/genoffice/blob/36a509e8fc16ace85ed7afa3c37acb7b9c441ad1/packages/agent-core/src/loop.ts) | Reutilizar streaming, ferramentas, cancelamento, limites e hooks de snapshot. |
| Codex local | [genoffice: codex-app-server.ts](https://github.com/genspark-ai/genoffice/blob/36a509e8fc16ace85ed7afa3c37acb7b9c441ad1/packages/ai-provider/src/codex-app-server.ts) | Reutilizar descoberta/processo/protocolo. Login real ainda não validado. |
| Gateway próprio | [genoffice: openai-compatible.ts](https://github.com/genspark-ai/genoffice/blob/36a509e8fc16ace85ed7afa3c37acb7b9c441ad1/packages/ai-provider/src/protocols/openai-compatible.ts) | Reutilizar base URL/modelo/chave; não precisa implementar protocolo de novo. |
| Registro de provedores | [genoffice: registry.ts](https://github.com/genspark-ai/genoffice/blob/36a509e8fc16ace85ed7afa3c37acb7b9c441ad1/packages/ai-provider/src/registry.ts) | Reutilizar modalidades; credenciais Genspark não fazem parte do produto Fariv. |
| Documento | [genoffice: index.ts](https://github.com/genspark-ai/genoffice/blob/36a509e8fc16ace85ed7afa3c37acb7b9c441ad1/packages/docx-engine/src/index.ts) | Reutilizar motor junto com apps/docs; motor sozinho não entrega editor paginado. |
| IA no documento | [genoffice: docs-skill.ts](https://github.com/genspark-ai/genoffice/blob/36a509e8fc16ace85ed7afa3c37acb7b9c441ad1/apps/docs/src/renderer/ai/docs-skill.ts) | Reutilizar operações e contexto, adaptando revisão e estilo. |
| Apresentação | [genoffice: index.ts](https://github.com/genspark-ai/genoffice/blob/36a509e8fc16ace85ed7afa3c37acb7b9c441ad1/packages/pptx-engine/src/index.ts) | Reutilizar motor junto com apps/slides e pptx-render, sem reescrever via conversores básicos. |
| IA nos slides | [genoffice: slides-skill.ts](https://github.com/genspark-ai/genoffice/blob/36a509e8fc16ace85ed7afa3c37acb7b9c441ad1/apps/slides/src/renderer/ai/slides-skill.ts) | Reutilizar operações de elementos e composição. |
| Gateway XLSX | [genoffice: xlsx-gateway.ts](https://github.com/genspark-ai/genoffice/blob/36a509e8fc16ace85ed7afa3c37acb7b9c441ad1/packages/xlsx-gateway/src/gateway/xlsx-gateway.ts) | Reutilizar preservação e escrita de recursos; Node fs/crypto não vão diretamente ao navegador. |
| Importação CSV | [genoffice: csv-import.ts](https://github.com/genspark-ai/genoffice/blob/36a509e8fc16ace85ed7afa3c37acb7b9c441ad1/packages/xlsx-gateway/src/gateway/csv-import.ts) | Comparar com importador já aprovado do Fariv; preservar regras pt-BR e segurança CSV. |
| Extração de anexos | [genoffice: parse.ts](https://github.com/genspark-ai/genoffice/blob/36a509e8fc16ace85ed7afa3c37acb7b9c441ad1/packages/file-parse/src/parse.ts) | Reutilizar parsers de anexos; extrair texto não equivale a importar documento fiel. |
| Claude local | [nimbalyst: ClaudeCodeProvider.ts](https://github.com/Nimbalyst/nimbalyst/blob/b01bb2a0f8efe881a03b826844fde7be69f19e42/packages/runtime/src/ai/server/providers/ClaudeCodeProvider.ts) | Fonte de implementação; depende de SDK, armazenamento e serviços Nimbalyst. Desacoplar para AgentTransport, não copiar o runtime inteiro. |
| Configuração do Claude | [nimbalyst: sdkOptionsBuilder.ts](https://github.com/Nimbalyst/nimbalyst/blob/b01bb2a0f8efe881a03b826844fde7be69f19e42/packages/runtime/src/ai/server/providers/claudeCode/sdkOptionsBuilder.ts) | Adaptar opções e ferramentas permitidas à execução Fariv. |
| Tarefas recorrentes | [nimbalyst: AutomationScheduler.ts](https://github.com/Nimbalyst/nimbalyst/blob/b01bb2a0f8efe881a03b826844fde7be69f19e42/packages/extensions/automations/src/scheduler/AutomationScheduler.ts) | Extrair com parser, normalização, tipos e writer; substituir serviços de sessão por chamadas Fariv. |
| Cálculo de horários | [nimbalyst: scheduleUtils.ts](https://github.com/Nimbalyst/nimbalyst/blob/b01bb2a0f8efe881a03b826844fde7be69f19e42/packages/extensions/automations/src/scheduler/scheduleUtils.ts) | Reutilizar diário/semanal/intervalo; três sondagens locais passaram. |
| Registro de saídas | [nimbalyst: OutputWriter.ts](https://github.com/Nimbalyst/nimbalyst/blob/b01bb2a0f8efe881a03b826844fde7be69f19e42/packages/extensions/automations/src/output/OutputWriter.ts) | Adaptar saídas de texto para artefatos e versões de documentos Fariv. |
| CLI alternativo | [officecli: CommandBuilder.Watch.cs](https://github.com/iOfficeAI/OfficeCLI/blob/c56512c8c7b76fe284f09940e4cd492470099d3e/src/officecli/CommandBuilder.Watch.cs) | Reserva para renderização/automação C#; não adicionar um segundo escritor de arquivo por padrão. |
| Agendamentos AionUi | [aionui: cronUtils.ts](https://github.com/iOfficeAI/AionUi/blob/11cd2a9a20d1e033157636efc570b41384c66d85/packages/desktop/src/renderer/pages/cron/cronUtils.ts) | Referência de UI; backend AionCore é outro repositório, ainda não inspecionado. Não é scheduler completo neste arquivo. |

## Quatro diferenças que exigem adaptação nossa

### 1. Revisar antes de escrever

GenOffice tem snapshots e rollback, mas a planilha documenta autoaplicação em `propose_operations`. `apps/sheets/src/renderer/ai/tools.ts` também trata falha parcial de um lote, inclusive a possibilidade de o histórico ser insuficiente para desfazer um lote grande. Portanto, não importar o nome “proposta” como se fosse a garantia de rascunho isolado.

Aproveitar planner, operações e geração de diferença; executar em estado isolado, conferir revisão da pasta e aplicar o conjunto aprovado por um único contrato de transação. Testar rejeição, conflito, falha parcial e desfazer incluindo dinâmica/gráfico. Não há implementação pronta com todas essas garantias comprovadas nesta investigação.

### 2. Claude e Codex dentro do mesmo assistente

Codex: reaproveitar o adaptador app-server do GenOffice e sua descoberta/configuração; manter login no fluxo oficial e expor seus erros no produto. Os testes locais do bridge são unitários/estruturais, sem um Codex autenticado.

Claude: Nimbalyst tem implementação real, mas `ClaudeCodeProvider.ts` importa armazenamento, gerenciador de sessões, MCP, permissões e modelos próprios. Não é uma função que possa ser colada sozinha. Extrair o transporte e o ciclo de vida necessários e adaptá-los ao contrato `AgentTransport`/ferramentas do GenOffice. A execução deve usar os comandos do Fariv, sem escrita livre no arquivo original. Não copiar banco, painel de programação ou infraestrutura de colaboração do Nimbalyst.

Licença do código não garante elegibilidade de qualquer assinatura ou permissão de distribuição do runtime do provedor. Essa integração precisa ser validada com os fluxos oficiais e versões usadas; nenhum token foi extraído e nenhuma autenticação real foi testada nesta sessão.

### 3. Trabalho proativo

Nimbalyst traz execução diária/semanal/por intervalo, controle de tarefa e saídas. Seu `AutomationScheduler` usa timers e roda no renderer enquanto o aplicativo está aberto; não é um serviço que funciona com computador desligado.

Para o Fariv, ligar o disparo à mesma tarefa revisável usada no pedido manual. Um detector de mudança de arquivo pode aproveitar `disk-watch`, mas requer política de repetição, debounce e escolha do que observar. Detecção útil de problemas nos dados e decisão do que sugerir continuam sendo comportamento do produto a implementar; um watcher não faz isso sozinho. O cliente pode permitir execução automática de uma rotina já configurada; aceitação pode ser por tarefa, sem confirmar cada célula.

### 4. Escala e importações brasileiras

Preservar o módulo de agregação colunar do Fariv para bases grandes. A criação de dinâmica do GenOffice inspecionada tem limite de 10 mil linhas. Não copiar essa limitação como regressão.

CSV/TXT já têm código nos dois projetos: preservar as decisões aprovadas de tipos, zeros à esquerda, codificação, decimal e exportação protegida do Fariv. Não substituir importador validado apenas porque apareceu outro.

Extração de texto de DOCX/PPTX/PDF pode aproveitar `file-parse`; edição fiel usa os motores próprios. XML de NF-e não está resolvido por ter um parser XML: falta mapear os campos fiscais/itens, múltiplos documentos e avisos de importação. Nesta rodada não foi identificado um importador NF-e pronto integrado à base.

Cinco milhões de linhas e BI completo não são capacidades entregues pela fusão já demonstrada. Exigem camada analítica própria ou integração adicional. Não atrasar o primeiro fork para redesenhar todo o armazenamento.

## Composição recomendada, sem duplicar aplicativos

| Bloco | Escolha para a primeira integração | Reserva |
|---|---|---|
| Pacote desktop, documentos e slides | GenOffice OSS e seus módulos conectados | OfficeCLI para necessidade concreta de automação/renderização que a base não resolva |
| Planilha | Começar com o editor da base; portar decisões e agregação Fariv que agreguem valor | GridPath, GridCraft, OpenCalc, LogiSheets se um requisito específico justificar troca |
| Codex | Bridge do próprio GenOffice | Outros providers como referência |
| Claude | Adaptador desacoplado a partir do Nimbalyst | AionUi/AionCore: alternativa ainda não validada integralmente |
| Recorrência | Scheduler e tipos do Nimbalyst ligados ao executor Fariv | Serviço em segundo plano/servidor somente quando necessário |
| Identidade e simplicidade | Interface Fariv, seletor central, ações contextuais e sugestões | Não carregar todos os painéis de programação dos projetos de origem |

Não usar dois escritores concorrentes no mesmo documento nem copiar vários shells. O reaproveitamento máximo vem de manter blocos que já funcionam juntos e substituir apenas o necessário.

## Licenças e limites do que foi verificado

GenOffice: Apache-2.0 fora de `ee/`; esse diretório fica excluído. Nimbalyst: texto MIT lido na raiz. OfficeCLI e AionUi: Apache-2.0 lida na raiz. GridPath: utilizar somente partes Apache identificadas, sem shell/autenticação FSL. Marcas, ícones e identidade Fariv substituem a marca do produto original sem apagar LICENSE/NOTICE/atribuição necessária.

Não foi feita auditoria completa de dependências transitivas nem de todos os arquivos/assets. Antes de distribuir a derivação, gerar inventário do código e dos assets realmente incluídos; verificar as respectivas licenças. Não há licença comercial contratada nem chave inserida.

## Busca e ponto de encerramento desta rodada

Nove repositórios foram clonados e inspecionados em diferentes profundidades: GenOffice, GridPath, GridCraft, OpenCalc, LogiSheets, Univer Workspace, Nimbalyst, OfficeCLI e AionUi. A busca cobriu pacote completo, engines, contexto, revisão, agentes locais e recorrência.

As últimas rodadas de busca retornaram principalmente GenOffice e seus forks, as mesmas famílias de planilhas, e hosts de agentes com calendários. Isso é saturação prática deste recorte, não prova de que toda a internet foi esgotada. Não contar forks renomeados e mirrors como novos motores. Não há justificativa para adiar o início da integração esperando uma lista infinita.

AionUi foi inspecionado como alternativa: frontend, cron e documentação. Seu backend AionCore é outro repositório; não foi clonado/testado aqui. Univer Workspace compõe módulos Pro: não escolhido como base sem custo adicional com base apenas na licença Apache do shell.

## Validações específicas desta rodada

- GenOffice ai-provider: 20 testes em `codex-app-server.test.ts` e `codex-stdout-lines.test.ts` passaram. Sem login real.
- GenOffice agent-core: 95 testes de loop e restauração passaram. São testes upstream, sem IA real.
- Nimbalyst: três sondagens de cálculo de horário passaram (diário, semanal e intervalo); não executam agente e não validam scheduler completo.
- As suítes GenOffice de ferramentas da planilha e agregação não carregaram no setup parcial por dependências ausentes de Univer/React; não contadas como aprovadas. O código dessas capacidades foi inspecionado.
- Validações anteriores de motores e arquivos estão em [FOLLOWUP.md](../experiments/fusion/FOLLOWUP.md).
- Nenhum pacote GUI completo foi instalado/validado no Windows. Nenhuma porcentagem de produto pronto nem prazo de integração é inferido desses testes.

## Próxima entrega concreta

Abrir uma branch de integração do pacote GenOffice OSS dentro do trabalho do Farihub, preservando referência e histórico upstream. Primeiro abrir os três editores no mesmo shell, aplicar identidade Fariv e conectar o Codex já disponível na base. Em seguida ligar Claude pelo mesmo contrato de ferramentas, e alterar o modo de escrita para revisão prévia. Portar agregação e decisões de importação Fariv sem regressões. Acrescentar recorrência pelo scheduler identificado.

Critério de entrega: instalar/abrir, trabalhar em XLSX/DOCX/PPTX, fazer uma tarefa com IA, revisar o resultado, desfazer e reabrir o arquivo salvo. Código upstream deve ser reaproveitado, não reimplementado a partir deste documento. Nenhuma migração de motor ou BI completo é pré-requisito dessa primeira entrega.
