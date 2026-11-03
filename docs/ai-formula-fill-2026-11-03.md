# Coluna calculada pela IA — reprodução, correção e validação

03/11/2026. Base: `6dec1dbbd1be756dd47517fd2dab90a45b1d76c3`.
Escopo: edição de planilhas em `suite/apps/sheets`. Sem alterações de dashboards,
Apresentações, configurações comerciais, provedores ou dependências. Sem merge.

## Resultado e reprodução

O registro `Fariv_feedback_teste_Windows_2026-11-02.md` foi consultado, assim como
`COMECE_AQUI.md`, `ORIGEM.json`, `PROMPTS.md` e `GABARITO.json` do pacote
`Fariv_teste_varejo_validado.zip`. O gabarito não foi enviado ao provedor simulado.

Arquivo original: `01_varejo_10000.csv`, 881.050 bytes, UTF-8 BOM, `;`, preço com
vírgula decimal. SHA-256: `821645ea516d51ca6afef527095954c0efc004931f200565edf675cf3cfd4368`. São 10.000 registros e
10.001 linhas com cabeçalho; 80.008 células na fonte. Este volume excede o limite
atual de 50.000 células para abertura integral em modo de fórmulas, então o app
usa streaming. Não é evidência de importação incompleta.

No app original, um pedido válido com `set_cell I1`, `set_formula I2 =D2*F2` e
`fill_range I2:I10001` criou 10.000 fórmulas, mas **9.838 resultados estavam errados**.
A primeira linha dava 15,30, enquanto a última ficava em zero em vez de 0,78.
A soma observada era 1.562,79 em vez de 170.444,87 GBP. Rejeitar deixava a fórmula
inicial em I2. A análise por agregação do arquivo podia estar correta porque esse
leitor usa a fonte completa, enquanto as fórmulas usavam a grade parcial.

Depois: **zero divergências nas 10.000 linhas**, inclusive após rolagem, recálculo,
salvar e reabrir. `I2 =D2*F2` resulta em 15,30; `I10001 =D10001*F10001`, em 0,78.
Todas as referências foram conferidas, não apenas as pontas. Quantidades e preços
da fonte permaneceram iguais. A soma é **170.444,87 GBP, de todas as linhas**,
incluindo cancelamentos/negativos; não é o total de vendas válidas (189.713,40 no
gabarito) nem receita da empresa inteira.

Oráculo independente: Python `csv` + `Decimal`, comparado célula por célula. Os
preços desta amostra têm no máximo duas casas decimais. A soma binária em JS pode
aparecer como 170444.87000000064; isso é representação de ponto flutuante, não uma
divergência monetária no centavo.

## Causas e mudanças

1. **Referências não residentes.** `fill_range` carregava as colunas vizinhas por
   janela, mas não as mantinha disponíveis, ao contrário de `set_formula`.
   A próxima leitura/rolagem podia expulsá-las, e a fórmula calculava sobre vazios.
   Planejamento e aplicação agora coletam todas as referências deslocadas,
   verificam o orçamento compartilhado e carregam/protegem os precedentes antes
   da primeira escrita. O limite existente de 50.000 referências não foi elevado.
   A escrita em bloco carrega apenas seu destino para o histórico.
2. **Fonte criada no mesmo lote.** Validação, custo e preenchimento usam a fórmula
   proposta para a origem, não uma célula ainda vazia. Não há 10.000 operações no
   prompt. A semente não é reescrita depois do preenchimento; essa escrita dupla
   fazia o histórico ressuscitar I2 ao rejeitar/desfazer.
3. **Valores salvos.** Só a ponte MCP lembrava resultados calculados para o cache
   do XLSX, e somente de fórmulas explícitas. A IA interna agora verifica localmente
   todo o preenchimento e usa o mesmo caminho. O arquivo foi inspecionado: contém
   10.000 fórmulas editáveis **e 10.000 resultados numéricos conferidos**, mantendo
   `<f>` e `<v>` separados.
4. **Reabertura/cache.** As proteções dos trechos são publicadas durante a carga;
   um recálculo nativo atrasado não pode substituir células já pertencentes ao
   motor ao vivo. Na edição de uma dessas células, o texto conhecido da fórmula
   é hidratado no modelo antes do editor capturar o estado de desfazer, sem
   reiniciar o editor com um comando reentrante.
5. **Contexto e divergências de leitura.** Abas/intervalos passam a incluir as
   novas linhas/colunas da sessão. O leitor recupera o texto indexado de fórmulas
   que o streaming mantém só como valor na grade, respeitando sobrescritas.
   A IA vê também o valor numérico integral quando a exibição arredonda ou usa
   formato local. A verificação de uma coluna contígua usa leitura em bloco,
   mantendo a ocultação de células marcada pelo usuário.
6. **Custo evitável.** Preenchimentos sem estilo com fórmulas aritméticas preservam
   as alturas importadas, evitando milhares de medições de texto/canvas. Fórmulas
   de texto e preenchimentos com estilo mantêm a medição normal.

## O que a IA realmente vê

| Fonte | Visão e limite |
| --- | --- |
| `get_workbook_context` | Pasta de trabalho aberta, IDs/nomes das abas, extensão dos dados, seleção capturada no envio, janela carregada, gráficos e notas de importação CSV. Extensão dos dados e janela são coisas diferentes. |
| `read_range` / `read_cells` | Leitura dirigida por aba e intervalo; valores e fórmulas, com carregamento quando necessário. `read_range` limita 2.000 células por chamada. Não recebe a base inteira automaticamente. |
| `aggregate_range` | Agregação local da fonte em blocos; não precisa colocar todas as linhas no contexto do modelo. |
| Anexos | Somente os anexos explicitamente ligados ao chat, lidos em páginas. Não é acesso automático a todos os arquivos do workspace. |
| Escrita/revisão | Ferramentas estruturadas; prévia no documento aberto. O usuário aceita ou rejeita a tarefa antes de salvá-la. Não é um rascunho isolado. |

## Evidências e limites da medição

Ensaio em **Electron real + renderer de produção + sidecar Rust real**, no Linux,
modo standalone de Planilhas (mesmos caminhos do editor). O **provedor é simulado**
por HTTP compatível com OpenAI; os seletores nativos de arquivos devolvem caminhos
de teste, mas a leitura/gravação dos arquivos, as ferramentas, a grade, os botões e
as operações de desfazer são reais. Não comprova que um modelo real escolherá
essas ferramentas corretamente. Executável de teste Electron 38.0.0; a dependência
de produção 43.8.3 não foi alterada. Não houve teste do instalador nem do Windows.

As execuções antes/depois usam o mesmo CSV e a mesma sequência inicial, sem outro
benchmark ou suíte concorrente. Uma amostra por versão; não são medianas nem SLA.

| Medida da primeira tarefa | Antes (incorreto) | Depois (correto) |
| --- | ---: | ---: |
| Importação até primeira exibição | 0.745 s | 0.812 s |
| Envio no chat até cartão de revisão | 2.343 s | 4.527 s |
| Proposta até retorno da ferramenta | 1.790 s | 3.840 s |
| Heap JS antes da tarefa | 45.67 MiB | 48.11 MiB |
| Maior amostra de heap JS durante a primeira operação | 163.84 MiB | 140.13 MiB |
| Divergências em 10.000 linhas | 9.838 | 0 |

O caminho corrigido inclui a conferência local de todos os resultados e preparação
para cache; o anterior terminava com resultados inválidos. Não se declara ganho de
velocidade ou RAM total a partir desta comparação. O comando manual nativo de
preencher para baixo levou 261.1 ms,
**com precedentes já residentes pela tarefa anterior**; mede o comando, não a espera
pelo recálculo, leitura da fonte ou latência de um modelo. Seus 10.000 resultados
foram conferidos depois.

Salvar o XLSX levou aproximadamente 1.007 s. No ensaio corrigido completo
(três tarefas, manual, salvar/reabrir/editar), a maior amostra de heap foi
291.42 MiB. Não comparar esse número ao ensaio anterior de
uma tarefa. O máximo RSS do processo principal foi
351.48 MiB; **exclui renderer e sidecar**.
`getAppMetrics` devolveu RSS zero neste host. Portanto, **o consumo total próximo de
1 GB relatado no Windows não foi reproduzido nem considerado resolvido**.

Resultados brutos (incluem respostas das ferramentas e falhas esperadas do original):
[antes](results/ai-formula-fill-2026-11-03/before.json) e
[depois](results/ai-formula-fill-2026-11-03/after.json).

## Validação

- 172 testes focados em oito arquivos: planejamento, leitor/contexto, orçamento,
  fórmulas, cache, corrida de carregamento e transporte do histórico ao salvar.
- `tsc --noEmit` de Planilhas e build `electron-vite build`: aprovados.
- No aplicativo: 10.000 fórmulas e valores; primeira/última referência; fonte
  preservada; rolagem/recálculo; rejeitar; aceitar; desfazer tarefa; comando manual
  equivalente com dados residentes; salvar XLSX; inspeção de 10.000 `<f>`/`<v>`;
  reabrir; editar a última fórmula pela interface e desfazer essa edição.
- Não foi executada a suíte inteira do monorepo, o instalador Windows ou um modelo
  real. Não houve merge.

## Revisão: correções e validação independente

Os dois apontamentos P1 da revisão automática foram corrigidos:

- **Fórmula fixada não volta sobre uma edição da sessão.** Ao editar uma célula,
  a fórmula guardada da abertura só é restaurada se a sessão não alterou aquela
  célula. Um literal, uma célula apagada ou um preenchimento constante em bloco
  registrado no diário de edições vence (`pinnedFormulaForEdit`). Sem isso, a
  célula reabria o editor com a fórmula antiga, e o Desfazer da edição seguinte a
  restaurava no lugar do valor digitado.
- **Recálculo nativo atualiza as precedentes fixadas só pelo valor.** O filtro
  novo de `applyPinnedOverlay` protege apenas as células com fórmula viva. Uma
  precedente fixada pelo valor em cache (`pinStreamedPrecedents`) volta a receber
  o resultado recalculado. Sem isso, editar a entrada dessa precedente deixava a
  própria célula e as fórmulas que dependem dela com o valor antigo.

O roteiro de verificação também deixou de depender do arquivo original:

- o valor esperado da última linha sai do oráculo, em vez de `0.78`/`1.78` fixos;
- a conferência do preenchimento manual espera o recálculo terminar, em vez de
  aguardar 1,5 s fixo, curto demais em máquinas mais lentas.

Validação independente, com um CSV **sintético** de 10.000 linhas no mesmo formato
(`;`, BOM, vírgula decimal, 3% de quantidades negativas), diferente do arquivo
original:

- na `main`, 9.887 fórmulas erradas, fonte alterada e Rejeitar deixando uma fórmula;
- com esta PR, as 11 verificações do roteiro passam.

Também passam: o typecheck da suíte, os testes da planilha (3.887; as 3 falhas de
`promote-file-atomically` acontecem também na `main` com usuário root) e o e2e
Fariv.

## Reproduzir

Com Node e dependências da `suite/` instalados e o sidecar compilado:

```sh
cd suite
npm ci
npm run build -w @genoffice/sheets
node --import tsx scripts/verify-ai-formula-fill.mjs /caminho/01_varejo_10000.csv /tmp/fariv-formula-evidence
```

Requer Python 3 para o oráculo independente. No Linux, execute sob Xvfb. O driver
aceita `ELECTRON_TEST_EXECUTABLE` e `FARIV_TEST_XVFB` para ambientes de teste;
`FARIV_BASELINE=1` permite registrar falhas do app original sem interromper o relatório.
O próprio driver cria cópia do CSV, perfil descartável e salva `evidence.json`,
capturas e XLSX na pasta de saída. Nunca aponta para credenciais pessoais.

## Pendências para revisão

1. Repetir no Windows com a conexão real `gpt-5.6-sol` usada por Vinicius e observar
   a escolha de ferramentas, tempo do provedor e memória total da árvore de processos.
2. Usar o CSV original, pedir apenas a coluna calculada, rejeitar; pedir de novo,
   aceitar, desfazer; pedir novamente, salvar XLSX e reabrir. Conferir I2 e I10001
   na barra de fórmulas e total 170.444,87, sem chamá-lo de vendas válidas.
3. Não extrapolar para 100 mil/541.909 registros, outras funções, tabelas/refs
   estruturadas, outros módulos ou shell completo: não foram validados neste ensaio.
   O limite de referências e o histórico de 100.000 células continuam valendo.
4. O aviso visual de streaming/nome temporário ainda pode permanecer; esta etapa
   comprova fonte íntegra e contexto de dados, não redesenha esse indicador.

Dados: Chen, D. (2015), Online Retail, UCI Machine Learning Repository,
[DOI 10.24432/C5BW33](https://doi.org/10.24432/C5BW33), CC BY 4.0. Amostra sistemática
do pacote fornecido pelo usuário; CSV e gabarito não foram adicionados ao repositório.
