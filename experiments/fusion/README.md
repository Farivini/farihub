# Fusão: prova curta executada

Base Farihub: `87665ca443be25724e0869380b377ff0eeb96fe7` (PR #8). Nenhuma alteração no aplicativo ou nas dependências de produção.

## Fontes fixadas

- GenOffice: https://github.com/genspark-ai/genoffice, commit `36a509e8fc16ace85ed7afa3c37acb7b9c441ad1`.
- GridPath: https://github.com/pixelsmasher13/gridpath, commit inspecionado `18ebc71c3424abd962d9a624cb6b2a1f83651d13`. Execução usa o WASM publicado no pacote npm `gridpath@0.5.2`; não foi compilado desse commit. SHA256 do tarball: `ee6e10297791bcd29618bf2975f7683b09882270415f395b032a7062ca32dc0a`.
- GridCraft: https://github.com/storytold/gridcraft, commit `a85b1aea3a8a3369581a749d8da041e4db014504`.

## O que realmente rodou

Linux x64, AMD EPYC 9V74, Node 24.22.1. Dados sintéticos, sem chamadas de IA. Dois processos independentes de benchmark; cinco edições por motor em cada execução. Valores não são de navegador, Windows ou Excel. Ver JSONs em `results/`.

100 mil linhas, duas entradas e uma fórmula independente por linha (`=A{r}*B{r}`):

| Medida | IronCalc 0.9.1 WASM usado pelo Farihub | GridPath 0.5.2 WASM |
|---|---|---|
| Carga por setInput, duas execuções | 1,41–1,42 s | 1,30–1,35 s |
| Cálculo inicial explícito | 151–172 ms | 468–703 ms |
| Primeira edição depois do cálculo | 133–197 ms | 76–101 ms |
| Quatro edições subsequentes | 123–166 ms | 0,021–0,316 ms |

O GridPath informa somente duas células no delta final (entrada e fórmula dependente). Todos os resultados foram conferidos por assert. O custo inicial também importa: a melhoria nas edições não torna tudo mais rápido. É um caso favorável ao recálculo incremental; não extrapolar para fórmulas voláteis, dependências densas, funções diferentes ou 1 milhão de fórmulas.

Dinâmica: soma por cinco regiões, dados já preparados. Farihub usa snapshot colunar; GenOffice usa matriz. Construção e leitura do snapshot, desenho da UI e gravação NÃO entram nesses tempos. Em 10 mil linhas: Farihub 4,3–4,9 ms; GenOffice 12,6–13,9 ms. Em 1 milhão: Farihub 78–228 ms, total conferido. O caminho `buildPivotLayout` do GenOffice recusou 10.001 linhas de dados e 1 milhão com `sourceRowLimit`; constante de 10.001 inclui cabeçalho. Isso também é verificado pelo caller da interface. Não confundir com limite geral de abertura do aplicativo.

Uma tentativa adicional com 1 milhão de fórmulas foi interrompida manualmente para limitar o tempo; sem resultado publicável. O script dessa tentativa não descartava histórico durante a carga, ao contrário do benchmark grande existente no Farihub. Não atribuímos a interrupção a falha de algum motor.

Testes upstream executados:

- GenOffice: 58 testes, quatro arquivos, todos passaram (estatística de dinâmica, ida e volta da definição, persistência de filtro e deslocamento de fórmulas).
- GridCraft: `cargo test -p gridcraft-calc --lib --locked --quiet`: 91 passaram, 1 ignorado. Rust 1.99.1, build debug; não é benchmark nem teste da GUI.

## Combinação real executada

`compose.ts` cria XLSX com fórmulas pelo GridPath, calcula receitas, passa os valores ao layout de dinâmica do GenOffice e usa o gateway deste para gravar células e uma tabela dinâmica OOXML nativa. Reabre pelo motor GridPath e verifica fórmula e resultado, além da presença de `xl/pivotTables/pivotTable1.xml`. Total esperado: 120; fórmula `=B4*C4`, valor 40.

A combinação produziu um XLSX de 9.848 bytes. Isso prova interoperabilidade mínima entre componentes; NÃO valida a tabela dinâmica no Excel, recuperação, aceitar/rejeitar, histórico integrado ou a UI Fariv. Não houve autenticação Codex/Claude nem execução do pacote desktop completo.

## Direção concreta

1. Manter inicialmente a grade, locale pt-BR e dinâmica colunar do Farihub.
2. Experimentar o motor incremental Apache do GridPath atrás da interface do worker atual. Não alterar todas as operações simultaneamente: começar por leitura, setInput, recálculo e XLSX, depois preservar transações, histórico e locale.
3. Aproveitar do GenOffice o gateway XLSX e recursos de escrita/definição de dinâmica. O gateway usa Node fs/crypto/path: sem Electron não significa pronto para navegador; separar planejador puro e I/O. Não substituir nossa agregação de bases grandes pelo layout limitado a 10 mil.
4. GridCraft fica como segunda opção de motor, sem migrar a interface Rust: o próprio docs/gaps.md registra pendências de arquivos reais e grandes bases. Apenas seus testes de cálculo foram executados.
5. Documento/apresentação: GenOffice candidato, ainda sem teste nesta prova.

Apache/MIT permitem componentes comerciais sujeitos às condições. O diretório `ee/` do GenOffice e shell/autenticação FSL do GridPath não foram usados. Manter LICENSE/NOTICE e revisar dependências antes de incorporar arquivos ao produto. Esta branch só referencia checkouts externos, sem vendorização de código de terceiros.

## Reproduzir sem alterar o produto

Na raiz do Farihub, instale suas dependências normalmente (`npm ci`). Em seguida:

```bash
bash experiments/fusion/setup.sh
cd experiments/fusion
node --import ./node_modules/tsx/dist/loader.mjs benchmark.ts 100000
node --import ./node_modules/tsx/dist/loader.mjs compose.ts
```

O setup baixa código fixado e dependências somente em `experiments/fusion/`. Requer git, npm e Node; os dois scripts não exigem Rust. Teste de GridCraft é separado e requer Cargo/Rust. O XLSX de prova é gerado em `results/fusion-proof.xlsx`; não é versionado.
