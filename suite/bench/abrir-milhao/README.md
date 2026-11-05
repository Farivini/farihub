# Abrir bases grandes pelo menu normal

Roteiros que abrem um arquivo no Planilhas real (Electron, sidecar XLSX, motor de dados) e medem o
que a pessoa vê. Relatório: [`docs/abrir-base-grande-2026-11-04.md`](../../../docs/abrir-base-grande-2026-11-04.md).

| Arquivo                | O que faz                                                                                                                                                                                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify-large.mjs`     | Prova completa: abrir pelo menu, tempo até a primeira tela, pausas entre quadros, memória somada do app, Ctrl+End/Home/↓, caixa de nome, tela do meio, **cada célula** igual à importação de hoje (e o texto bruto igual ao do leitor Python `csv`), busca com a mesma contagem                           |
| `verify-edit-save.mjs` | Editar, desfazer e salvar: edições no início, meio e fim, apagar, preencher, fórmula recusada, desfazer e refazer, salvar, desfazer depois de salvar e salvar de novo, Salvar como .xlsx; o CSV salvo é conferido **campo a campo** contra o original (leitor Python `csv`): só as células editadas mudam |
| `medir-abertura.mjs`   | Medida rápida de qualquer arquivo (CSV ou XLSX): tempo, pausas, memória, Ctrl+End                                                                                                                                                                                                                         |
| `perfil-abertura.mjs`  | Perfil de CPU da janela durante a abertura e tarefas longas (> 50 ms)                                                                                                                                                                                                                                     |
| `resultados/`          | Medidas de 04/11/2026; a base enviada aparece só com hash, posições, contagens e tempos                                                                                                                                                                                                                   |

Rodar a partir de `suite/`, com `apps/sheets` construído (`npm run build -w @genoffice/sheets`):

```sh
xvfb-run -a node --import tsx bench/abrir-milhao/verify-large.mjs base.csv saida.json MUMBAI
xvfb-run -a node bench/abrir-milhao/verify-edit-save.mjs base.csv saida.json   # trabalha numa cópia
xvfb-run -a node bench/abrir-milhao/medir-abertura.mjs base.xlsx saida.json
```

O último argumento de `verify-large.mjs` é um texto para a busca. A conferência célula por célula usa
o leitor de hoje, que para em 1.048.576 linhas como o Excel; acima disso, use `medir-abertura.mjs`.
Não rodar compiladores ou outros testes ao mesmo tempo que as medições.
