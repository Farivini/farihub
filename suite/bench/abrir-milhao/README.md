# Abrir bases grandes pelo menu normal

Roteiros que abrem um arquivo no Planilhas real (Electron, sidecar XLSX, motor de dados) e medem o
que a pessoa vê. Relatório: [`docs/abrir-base-grande-2026-11-04.md`](../../../docs/abrir-base-grande-2026-11-04.md).

| Arquivo                | O que faz                                                                                                                                                                                                                                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify-large.mjs`     | Prova completa: abrir pelo menu, tempo até a primeira tela, pausas entre quadros, memória somada do app, Ctrl+End/Home/↓, caixa de nome, tela do meio, **cada célula** igual à importação de hoje (e o texto bruto igual ao do leitor Python `csv`), busca com a mesma contagem                                         |
| `verify-edit-save.mjs` | Editar, desfazer e salvar: edições no início, meio e fim, apagar, preencher, fórmula recusada, desfazer e refazer, salvar, desfazer depois de salvar e salvar de novo, Salvar como .xlsx; o CSV salvo é conferido **campo a campo** contra o original (leitor Python `csv`): só as células editadas mudam               |
| `verify-calc.mjs`      | Coluna calculada: seis fórmulas digitadas (conta por linha, acumulado, SOMASE, CONT.SE acumulado, SE, PROCV), valores na tela no início, meio e fim, função não suportada recusada, recálculo depois de editar, desfazer e refazer, salvar; o CSV salvo é conferido **campo a campo** por `oraculo-coluna-calculada.py` |
| `verify-ai-calc.mjs`   | A IA (modelo **simulado**) cria a coluna calculada: tela, aviso devolvido à IA, rejeitar, aceitar, salvar e conferir o CSV em Python                                                                                                                                                                                    |
| `verify-etapa-a.mjs`   | Etapa A (nada trava): seleção até o fim com a barra de status pelo motor, copiar a base inteira, apagar coluna e desfazer, apagar e salvar, apagar coluna calculada e desfazer; pausas da tela e arquivos salvos conferidos em Python                                                                                   |
| `verify-pivot.mjs`     | Etapa B (dinâmica no motor): Inserir → Tabela dinâmica, dez trocas de campo medidas, soma por cidade e contagem distinta conferidas em Python **linha a linha** (pela dinâmica copiada), Pareto ABC com todas as linhas, gráfico, voltar e reabrir                                                                      |
| `medir-abertura.mjs`   | Medida rápida de qualquer arquivo (CSV ou XLSX): tempo, pausas, memória, Ctrl+End                                                                                                                                                                                                                                       |
| `perfil-abertura.mjs`  | Perfil de CPU da janela durante a abertura e tarefas longas (> 50 ms)                                                                                                                                                                                                                                                   |
| `resultados/`          | Medidas de 04/11/2026; a base enviada aparece só com hash, posições, contagens e tempos                                                                                                                                                                                                                                 |

Rodar a partir de `suite/`, com `apps/sheets` construído (`npm run build -w @genoffice/sheets`):

```sh
xvfb-run -a node --import tsx bench/abrir-milhao/verify-large.mjs base.csv saida.json MUMBAI
xvfb-run -a node bench/abrir-milhao/verify-edit-save.mjs base.csv saida.json   # trabalha numa cópia
xvfb-run -a node bench/abrir-milhao/verify-calc.mjs base.csv saida.json        # bank_transactions.csv
xvfb-run -a node --import tsx bench/abrir-milhao/verify-ai-calc.mjs base.csv saida.json
xvfb-run -a node bench/abrir-milhao/verify-etapa-a.mjs base.csv saida.json
xvfb-run -a node bench/abrir-milhao/verify-pivot.mjs base.csv saida.json       # bank_transactions.csv
xvfb-run -a node bench/abrir-milhao/medir-abertura.mjs base.xlsx saida.json
```

O último argumento de `verify-large.mjs` é um texto para a busca. A conferência célula por célula usa
o leitor de hoje, que para em 1.048.576 linhas como o Excel; acima disso, use `medir-abertura.mjs`.
Não rodar compiladores ou outros testes ao mesmo tempo que as medições.
