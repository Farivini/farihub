# Passagem de trabalho para o Codex (04/11/2026)

Resumo do que foi feito, do que já está decidido e da ordem dos próximos passos. Leia antes de
começar qualquer tarefa na suíte (`suite/`).

## Regras de trabalho

- **Sem merge automático.** Abrir PR e parar; quem faz o merge é o Vinicius.
- Uma PR por assunto, com teste. Validar localmente antes de subir: testes de unidade do módulo
  (`npm test` em `suite/apps/sheets`), e2e do Fariv (`suite/e2e`) quando mexer na planilha.
- Os testes da IA usam modelo simulado. Não dizer que um modelo real foi validado se não foi.
- A cota do GitHub Actions do mês acabou (jobs falham em 2–5 s, sem passos). Enquanto isso, a
  validação é local. Não insistir em reexecutar o CI.

## Onde as coisas estão

| PR | O que é | Situação |
| --- | --- | --- |
| #12 `fix/ai-formula-fill-10000` | Coluna calculada pela IA em 10 mil linhas: a fórmula fixada não sobrescreve mais a edição da pessoa (`univer-sync.ts`, `edit-journal.ts`, `App.tsx`), roteiro de verificação lendo o gabarito | Pronta para revisão. Local: 3.887 testes de unidade e 24/24 e2e passando |
| #13 `ccr-8be59076-lbfji1` | CI enxuto (uma execução por mudança; instalador Windows só na `main`, sob demanda ou com o rótulo `instalador`), decisão do motor de dados e o comparativo DuckDB × Polars | Pronta para revisão |

## Decisões tomadas

Detalhes e números em [`docs/decisoes/2026-11-04-motor-de-dados.md`](decisoes/2026-11-04-motor-de-dados.md).

1. **Motor das bases grandes: DuckDB**, embutido no processo Rust que já existe
   (`suite/apps/sheets/native/xlsx-engine`), crate `duckdb` com os recursos `bundled` e `parquet`
   (sem `parquet` ele tenta baixar a extensão na hora; o app tem que funcionar offline).
2. **Parquet é o formato interno**, invisível. A pessoa importa **TXT, CSV e XLSX**. Até
   1.048.576 linhas, salvar em `.xlsx` continua o padrão; acima disso, o app explica e oferece
   exportar.
3. **Máquina mínima: 8 a 16 GB de RAM.** `memory_limit` do DuckDB em 25% da RAM, até 4 GB, e
   `temp_directory` na pasta de dados do app.
4. **Meta:** abrir e trabalhar com 5 milhões de linhas; coluna calculada nunca trava a tela.
5. **IA nunca carrega a base inteira.** Recebe o perfil das colunas e resultados agregados por
   SQL. "Leia toda a base" não é recusado: vira consulta agregada.
6. **Tipos do CSV pt-BR** continuam decididos pelo nosso analisador (`csv-number-format.ts`);
   o DuckDB não reconhece vírgula decimal sozinho e, para exportar, a conversão é feita na consulta.
7. **Fórmulas:** a grade comum continua no Univer (~454 funções, PROCX/PROCV incluídas). Nas
   tabelas grandes, a coluna calculada vira expressão SQL; acumulado por grupo, valor anterior,
   Pareto e PROCV viram operações prontas para a IA.
8. **Futuro, depois do básico com IA funcionando:** XML de NF-e com API; fechamentos recorrentes
   agendados (uma "receita" de operações gravada na primeira execução, não uma macro).

## Limites atuais do código (o que o motor novo substitui)

| Limite | Valor | Onde |
| --- | --- | --- |
| Importar CSV | 32 MB | `MAX_DELIMITED_IMPORT_BYTES` |
| Fórmulas vivas na grade | 50 mil células (acima, modo de fluxo) | `FORMULA_MODE_MAX_CELLS` |
| Dinâmica | 10.001 linhas | `PIVOT_SOURCE_ROW_LIMIT` |
| IA ler intervalo | 2.000 células | ferramenta `read_range` |
| Desfazer da IA | 100 mil células | `AI_UNDO_CELL_BUDGET` |

## Próximos passos, em ordem

Os passos do plano original estão entre parênteses.

1. **Medir o app como está (passo 1).** Roteiro que abre 10 mil, 100 mil e 1 milhão de linhas e
   mede tempo e memória **somada** do app (janela + processo principal + sidecar Rust) ao abrir,
   rolar, criar coluna calculada e salvar. Gravar os resultados em `suite/bench/`. É a régua do
   motor novo.
2. **Configurações de IA mais simples e sem Genspark (passo 4).** Pequeno e independente.
3. **Motor DuckDB (etapa nova), uma PR por fase:**
   1. sidecar com DuckDB; importar TXT/CSV/XLSX por fluxo para Parquet, sem o teto de 32 MB;
   2. a grade lendo do DuckDB só a parte visível;
   3. IA com perfil da base e consultas agregadas;
   4. coluna calculada por definição (SQL), com acumulado, valor anterior, Pareto e PROCV.
4. **Dinâmica nativa sobre o DuckDB e apresentação editável no módulo certo (passo 3).** Vem
   depois do motor para não ser feita duas vezes.
5. **Visual e atalhos do Excel (passo 5).**
6. **Instalador para o teste no Windows (passo 2)**, ver abaixo.

## Até onde dá para ir sem gerar outro `.exe`

Quase tudo. Os passos 1 a 5 acima são desenvolvidos e validados no Linux com os testes de unidade
e o e2e do Electron, sem instalador. O `.exe` só é necessário para o que depende do Windows:

- a memória real no Windows (o ~1 GB observado);
- o teste da pessoa com o CSV de 10 mil linhas e o gabarito;
- **a compilação do DuckDB no Windows (MSVC)**: é o maior risco de deixar para o fim. Por isso,
  ao terminar a fase 3.1, gerar **um** instalador (pelo rótulo `instalador` na PR, quando a cota
  voltar, ou no PC do Vinicius com `npm run suite:dist:win`) só para confirmar que compila e abre.
  Depois disso, o próximo `.exe` pode esperar o fim do passo 4.

Resumindo: **um `.exe` de controle depois da fase 3.1 e um completo depois da dinâmica.** Nada
mais exige instalador.
