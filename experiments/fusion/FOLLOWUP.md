# Segunda investigação: limites e correções

Esta rodada amplia a prova curta e substitui qualquer leitura de que o GridPath já foi escolhido como motor vencedor. Nada foi migrado no produto.

## O teste que mudou a recomendação

O benchmark anterior editava uma entrada com uma única fórmula dependente. Nesta rodada, 100 mil fórmulas dependem da mesma entrada (`=$A$1*r`). Resultados da execução registrada em `results/adversarial-100000.json`:

- IronCalc 0.9.1 usado no Farihub: 84,3 / 104,3 / 113,1 ms.
- GridPath 0.5.2 WASM: 1.028,8 / 1.168,6 / 904,6 ms.
- Todos os resultados numéricos conferidos. Delta GridPath: 100.001 células.

**Limite da comparação:** o tempo do GridPath inclui serialização e parse do delta completo; o método antigo do IronCalc não entrega esse mesmo delta. Não é um teste isolado da aritmética dos motores nem comparação de UI. É o custo dos caminhos que consumimos no experimento. O runner de 10 mil dependentes registra a decomposição retornada pelo GridPath: cálculo 30,8–54,3 ms e serialização 42,3–47,8 ms, além de tracking/parse. Portanto há custo real tanto no cálculo quanto no volume devolvido. Uma integração melhor pode solicitar apenas a janela visível e minimizar deltas; isso ainda não foi implementado/testado.

Uma execução anterior de 100 mil observada em stdout deu 108–128 ms versus 880–927 ms; seu JSON foi sobrescrito pela rodada de 10 mil. Ela não é usada como evidência primária: a repetição acima foi salva separadamente. Não contamos três edições no mesmo processo como três benchmarks independentes.

## Seis casos adicionais executados

`adversarial.ts` executado em 10 mil e 100 mil dependentes. Ambos com seis casos aprovados:

1. Edição de uma entrada que afeta todas as fórmulas, conferindo o resultado.
2. Referência entre abas e inserção de linha: fórmula mudou para `=Dados!A2*2`, mantendo 42. Alteração estrutural exige snapshot completo.
3. Busca em base de 100 mil linhas: o registro-alvo estava na linha 100.001, fora de qualquer amostra inicial; foi encontrado e `rows_scanned` informou 100 mil. Limites de resposta não significam limite de base lida.
4. Gravar caches de fórmulas recalculadas e reabrir sem recalcular: valor 42 preservado.
5. Função desconhecida com valor armazenado 99: GridPath mostrou 99 e a API `fileSavedCells` sinalizou função não suportada. **A UI/IA precisa consumir esse aviso; mostrar o número não prova que foi recalculado.**
6. Escrita na linha 5 milhões rejeitada com `Invalid row`. Código CSV também limita a 1.048.576 linhas. Essa base não entrega 5 milhões de linhas por adoção direta.

## Compatibilidade não é contagem de funções

13 sondagens sintéticas em `formula-probe.ts`. SUM, IF, ROUND, DATE, SUMIF com intervalos, XLOOKUP com intervalos, LET, FILTER, SEQUENCE, LAMBDA, TEXTJOIN e IFERROR produziram os resultados esperados nos dois motores.

`=XLOOKUP(2,{1;2;3},{10;20;30})` retornou `#N/A` em ambos; resultado esperado por semântica da busca em arrays: 20. Microsoft documenta busca em intervalo ou array (https://support.microsoft.com/en-us/excel/functions/xlookup-function). É uma incompatibilidade candidata nesse formato, não demonstra que XLOOKUP inteiro esteja ausente. Excel real não foi executado. DATE foi comparada respeitando o display de data do IronCalc, sem classificá-lo erroneamente como falha por mostrar data em vez de serial.

## Código compartilhado: nomes não são motores independentes

- Farihub: IronCalc 0.9.1.
- GenOffice: `apps/sheets/native/xlsx-engine/Cargo.toml` declara IronCalc 0.9.1; UI usa Univer OSS. Seus recursos de gateway e UI não significam um motor de fórmulas inteiramente novo.
- GridPath: fork vendorizado do IronCalc com recálculo incremental e camada própria de XLSX.
- GridCraft: motor próprio Rust; testes adicionais de XLSX executados.
- OpenCalc: motor próprio Rust, transações, import/export, colaboração e SDK; não usa IronCalc no caminho inspecionado.
- LogiSheets: motor próprio Rust/WASM, estrutura em blocos e ferramentas de agente; pacote Node foi carregado e testes de RPC/plano de dinâmica executados.
- Univer Workspace: aplicação sobre Univer e módulos `@univerjs-pro/*`. A licença Apache do repositório da aplicação não elimina a dependência de runtime Pro. README documenta credencial de desenvolvimento rotativa em 90 dias. Não foi feito bypass nem uso da credencial.

Não contamos forks que só renomeiam GenOffice como invenções independentes. Isso também não elimina a possibilidade de alterações úteis em forks específicos.

## Novos checkouts fixados

- OpenCalc https://github.com/CasualOffice/opencalc @ `22cb302f811f78c37a26ff3b4c6ce4d6dc5a62e5`; Apache-2.0 declarada. API 0.0.x ainda preview segundo docs. AGENTS registra pendência de convergência em edição concorrente de insert/delete com intervalo. Testes de cálculo passaram, mas isso não valida colaboração nem os números de marketing.
- LogiSheets https://github.com/logisky/LogiSheets @ `6405fd6236ddfc205104d9d7bdc599ff86e815d6`; MIT declarada nos manifests e LICENSE (o link para docs/LICENSE-MIT não existe neste checkout; revisar texto/avisos antes de redistribuir). Executado WASM publicado em npm `logisheets@1.16.1`, não build desse commit.
- Univer Workspace https://github.com/dream-num/univer-workspace @ `870d8d05665d89dc68f020a30c75b70c1a0d8c25`; inspeção de dependências e fronteira de runtime, sem executar aplicação.

Pesquisa adicional cruzou o levantamento https://github.com/OpenSoftwareAlliance/sheet/issues/1 e voltou a encontrar principalmente Luckysheet/FortuneSheet, Univer, ONLYOFFICE, Collabora, Grist e grids de banco. Isso reduz duplicação da lista; não certifica exaustividade da internet. Os termos desse levantamento não substituem inspeção primária de licença.

## Testes adicionais efetivamente executados

| Projeto | Comando/caminho | Resultado |
|---|---|---|
| GridPath | vitest `src/engine.test.ts src/charts.test.ts`, usando WASM npm 0.5.2 | 9 passaram |
| GenOffice DOCX | vitest `roundtrip`, `text-patch`, `blank-template` | 20 passaram |
| GenOffice PPTX | vitest `patch`, `blank`, `redaction-roundtrip`, `schema-safe-patches` | 45 passaram |
| GridCraft | `cargo +stable test -p gridcraft-xlsx --lib --locked --quiet` | 270 passaram |
| OpenCalc | `cargo test -p casual-calc-eval --lib --locked --quiet`, Rust 1.96.0 | 311 passaram |
| LogiSheets | vitest `__tests__/rpc.test.ts __tests__/pivot-plan.test.ts`, WASM npm 1.16.1 | 62 passaram |

Não somar esses números como uma única suíte de compatibilidade. São testes dos próprios projetos, por vezes com fixtures deles. Os primeiros runs DOCX/PPTX falharam por dependências ausentes, corrigidas antes das execuções acima. No LogiSheets duas outras suítes não carregaram por pacotes de workspace ausentes; não foram chamadas de aprovadas. Não houve teste visual dos editores, Excel instalado, Windows nem login real dos providers.

## Decisão após esta rodada

Não substituir o motor atual inteiro apenas com o primeiro benchmark. A fusão continua tecnicamente possível (compose.ts), mas a decisão é por capacidade:

- Preservar grade, pt-BR, fluxo de arquivos e agregação colunar do Farihub enquanto integramos.
- Candidato GridPath: recálculo localizado, consultas limitadas sobre base inteira, preservação de partes XLSX. Medir dependências densas e delta antes de adotá-lo.
- Candidato GenOffice: gateway XLSX e motores DOCX/PPTX, com adaptadores; não copiar seu limite de dinâmica nem confundir Node sem Electron com núcleo pronto para web.
- OpenCalc/LogiSheets entram no comparativo de API/arquivos antes de declarar vencedor. Passar testes de cálculo é condição inicial, não justificativa para trocar toda a stack.
- Cinco milhões de linhas exigem outra camada de dados ou alteração relevante dos motores; não estão resolvidos por nenhum dos testes desta PR.

Reproduzir novos testes após o setup existente: `node --import ./node_modules/tsx/dist/loader.mjs adversarial.ts 10000` (ou 100000) e `node --import ./node_modules/tsx/dist/loader.mjs formula-probe.ts`. Os resultados vão para `results/`.
