# Pacote Fariv: integração da base GenOffice OSS

Este documento acompanha a integração do pacote Fariv (Planilhas, Documentos e Apresentações num só aplicativo desktop) sobre a base **GenOffice OSS**, escolhida no [mapa de reaproveitamento](https://github.com/Farivini/farihub/pull/9) (PR #9). Ele é atualizado a cada etapa: o que veio pronto, o que foi adaptado e o que ainda falta.

## Onde está cada coisa

| Caminho | O que é |
| --- | --- |
| `suite/` | O pacote Fariv. Começou como cópia do GenOffice no commit `36a509e8` (Apache-2.0); origem, licença e exclusões em [`suite/UPSTREAM.md`](../suite/UPSTREAM.md). |
| `src/`, `native/`, `vendor/`, `tests/` (raiz) | O Farihub web atual (Planilhas com IronCalc, agregação colunar, operações de tabela). **Fica como referência** e continua com o próprio CI (`.github/workflows/technical-proof.yml`). As decisões aprovadas dele são portadas para `suite/` nas próximas etapas, sem apagar o original. |
| `.github/workflows/suite.yml` | CI do pacote: testes e e2e Electron no Linux, instalador Windows. |

## Etapas

As etapas seguem a ordem do pedido; cada uma é uma PR.

| # | Etapa | Estado |
| --- | --- | --- |
| 1 | Branch de integração, importação com proveniência, os três editores no mesmo app, dev com recarga, build Windows no CI | **Esta PR** |
| 2 | Identidade Fariv: nome, ícones, tema, seletor central Planilhas · Documentos · Apresentações, barra enxuta com ações por contexto; retirar a marca e os serviços de nuvem do produto de origem | Próxima |
| 3 | Assistente ligado aos arquivos abertos com as ferramentas existentes, pelo Codex local (app-server); alterações em rascunho com prévia, aceitar/rejeitar, desfazer a tarefa, conflito e nada parcial no original | Planejada |
| 4 | Claude local no mesmo contrato de ferramentas (transporte extraído do Nimbalyst) | Planejada |
| 5 | Tarefas recorrentes: scheduler do Nimbalyst ligado ao mesmo executor | Planejada |
| 6 | Portar do Farihub o que a base não tem: agregação para bases grandes, fórmulas e importação pt-BR, salvamento | Planejada (diferenças já registradas abaixo) |

## Etapa 1: o que existe agora

**Os três editores no mesmo aplicativo.** Isso já vinha pronto na base: um shell Electron (`suite/apps/shell`) hospeda cada documento numa aba (`tab-manager.ts`), com os editores de planilha (`apps/sheets`, grade Univer + sidecar Rust com IronCalc 0.9.1 para XLSX), documento (`apps/docs`, motor DOCX próprio) e apresentação (`apps/slides`, motor PPTX próprio). O pacote também traz PDF, Markdown e HTML; eles continuam presentes e serão avaliados na etapa 2 (mostrar ou esconder).

**Verificado neste ambiente (Linux, Electron 43.8.3, Xvfb):**

| Verificação | Resultado |
| --- | --- |
| `npm ci` + `npm run build:all` (inclui o sidecar Rust) | ok, 6 min 40 s na primeira vez |
| `npm run typecheck` (26 workspaces) | ok |
| `npm run licenses` (dependências npm de produção dentro da lista permitida) | ok |
| e2e Fariv `e2e/fariv-roundtrip.spec.ts`: abrir, editar pelo teclado, salvar no mesmo caminho e reabrir em outra execução do app — `.xlsx` (célula com acentos; célula vizinha intacta no XML), `.docx` (texto no `word/document.xml` e no editor reaberto), `.pptx` (texto da caixa no `slide1.xml`, salva de novo sem perder) | 3 de 3 |
| e2e da base usados como fumaça: tela inicial, novo arquivo, arquivo vazio dos três formatos salva no próprio caminho, edição e reabertura de planilha | 5 de 5 |
| Modo de desenvolvimento com recarga (`npm run dev`): seis servidores Vite (um por editor) + `electron-vite dev --watch` para o processo principal | ok: servidores prontos em < 1 s, Electron abre, mudança num CSS do shell chega por HMR (`hmr update /src/tabbar.css`) |

Capturas do e2e ficam em `suite/e2e/artifacts/screenshots/fariv-*.png` (não versionadas; o CI publica as de falha).

## Como rodar no Windows

Pré-requisitos: Node.js 22 (≥ 22.12), Git, **Rust** (`rustup`, toolchain estável MSVC) e as **Build Tools do Visual Studio** com "Desenvolvimento para desktop com C++" (o sidecar de planilhas é compilado com cargo). O instalador também compila um auxiliar de OCR com o compilador .NET que já vem no Windows.

```powershell
git clone https://github.com/Farivini/farihub
cd farihub
npm run suite:install      # npm ci dentro de suite/ (baixa o Electron)
npm run suite:dev          # desenvolvimento com recarga: renderers Vite com HMR, processo principal com watch
npm run suite:start        # build completo e abre o app
npm run suite:e2e          # e2e Fariv (Electron)
npm run suite:dist:win     # instalador NSIS em suite/apps/shell/release/ (sem assinatura)
```

Observações:

- No `npm run suite:dev`, mudanças nos renderers (React) recarregam na hora; mudanças no código `src/main` de qualquer app são compiladas no processo principal do shell e reiniciam o Electron; mudanças em `src/preload` exigem `npm run build:all` (regra da base, em `suite/CLAUDE.md`).
- Neste contêiner de nuvem o usuário é root e o Electron só abre com `--noSandbox` (`npm run dev -w @genoffice/shell -- --noSandbox`); no Windows isso não é necessário.
- O instalador do CI **não é assinado** (precisa do certificado da Fariv) e nesta etapa ainda se chama GenOffice; a identidade entra na etapa 2.
- Atualização automática e analytics da base ficam **desligados**: só existem quando as variáveis `GENOFFICE_UPDATE_URL` e `GENOFFICE_GA4_*` são definidas no build, e o CI do Fariv não as define.

## Licenças e o que foi excluído

- GenOffice é Apache-2.0; `LICENSE`, `NOTICE` e `LICENSE-UNICODE.txt` ficam em `suite/` sem alteração. O aviso de terceiros do instalador é gerado por `tools/gen-third-party-notices.mjs` no `dist:win`.
- Excluído na importação: `ee/` (licença empresarial) e `.github/` (CI e CODEOWNERS da origem).
- O CI roda `npm run licenses` (npm) e `cargo-deny check licenses` (Rust) a cada mudança.
- A ser retirado na etapa 2: integrações com a nuvem Genspark (login `gsk`, ferramentas de nuvem, marca "Genspark AI" nos painéis). A dependência `@genspark/cli` é MIT, mas não faz parte do produto Fariv.
- Ainda não feito: inventário completo dos assets incluídos no instalador (fontes, ícones, imagens) antes de distribuir; ver "Pendências".

## Diferenças em relação ao Farihub (para não regredir)

Registradas antes de qualquer porte. Nada do Farihub foi removido; a base é usada como está até cada porte.

| Tema | Farihub (raiz) | Base GenOffice (`suite/`) | Decisão |
| --- | --- | --- | --- |
| Motor de fórmulas | IronCalc 0.9.1 em WASM, no worker | IronCalc 0.9.1 no sidecar Rust (leitura/escrita XLSX) + motor de fórmulas do Univer na grade | Não migrar motor nesta etapa. A PR #9 mostrou vantagens e desvantagens conforme as dependências das fórmulas; trocar exige medir a grade da base com dependências densas. |
| Nomes de funções | Português (`SOMA`, `PROCV`, `;` e vírgula decimal) via camada de tokens (`src/core/formula-locale.ts`) | Nomes em inglês na barra de fórmulas | Portar a camada pt-BR (etapa 6). Até lá, registrado como regressão conhecida da base. |
| Dinâmica | Agregação colunar no worker; medida com 1 milhão de linhas | Fonte da dinâmica limitada a **10.000 linhas** (`appPivotSourceRowLimit`) | Portar a agregação do Farihub (etapa 6); não aceitar o limite como definitivo. |
| Importar CSV | Prévia com codificação (UTF-8/Windows-1252), separador, **vírgula decimal**, cabeçalho e tipo por coluna; datas dd/mm/aaaa; nada vira fórmula | Converte direto em XLSX; números só no formato com **ponto decimal** (`1.234,56` vira texto); detecta codificações (incluindo UTF-16 e asiáticas) | Portar a prévia e as regras pt-BR (etapa 6), mantendo a detecção de codificação da base. |
| Exportar CSV | `;`, BOM, modo "para abrir em planilhas" (texto que viraria fórmula ganha `'`) ou "dados originais" | Valores calculados com formatos aplicados, BOM | Comparar a proteção contra fórmulas e portar o modo protegido (etapa 6). |
| Salvamento | Ctrl+S mantém o formato; perdas explicadas; gravação em fila; edição durante a gravação fica pendente | Escrita atômica (`atomic-write.ts`), cópia de recuperação, observação do arquivo em disco, salvamento cirúrgico do XLSX (partes intocadas ficam idênticas) | Base mais completa no desktop; conferir os avisos de perda e a regra "editar durante a gravação" (etapa 6). |
| Operações de tabela | Filtros, ordenação, inserir/excluir com API tipada (PR #8) | Filtros, ordenação, inserir/excluir do Univer + operações do DSL da IA | Usar as da base; comparar desempenho em bases grandes antes de portar algo. |
| IA | Painel não conectado; contexto limitado | Loop de agente, ferramentas por editor, Codex app-server, provedores; aplica alterações direto (com desfazer) | Etapa 3: revisão antes de aplicar. |

## Pendências conhecidas

- Identidade Fariv (etapa 2): o app ainda se chama GenOffice, com ícones e textos da origem.
- Validação no Windows real (instalar, abrir, salvar): o CI produz o instalador; falta rodá-lo numa máquina Windows.
- Inventário de assets e licenças do instalador final.
- Os demais e2e da base (139 especificações) não fazem parte do CI do Fariv nesta etapa; o CI roda o conjunto Fariv + fumaça da base. Os testes unitários da base rodam todos (`npm test`).
