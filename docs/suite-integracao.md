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
| 2 | Identidade Fariv: nome, ícones, tema, seletor central Planilhas · Documentos · Apresentações, barra enxuta com ações por contexto; retirar a marca e os convites do produto de origem | **Feita** (ver abaixo) |
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

## Etapa 2: identidade Fariv

| Mudança | Onde |
| --- | --- |
| Nome do produto **Fariv**, `appId` `com.fariv.app`, executável/pacotes `fariv`, pasta padrão `Documentos/Fariv`, perfil de desenvolvimento `Fariv-Dev`, títulos de janela ("Fariv · Planilhas"…) | `apps/shell/electron-builder.cjs`, `apps/shell/package.json`, `apps/*/src/renderer/index.html`, `packages/electron-utils/src/default-save-dir.ts` |
| Ícone do app gerado do glifo Λ laranja (PNG 16–1024, `.ico`, `.icns`) | `apps/shell/build/fariv-icon.svg` + `tools/gen-fariv-icons.mjs` |
| **Linha de título** acima das abas: marca FARIV à esquerda, **seletor central Planilhas · Documentos · Apresentações**, botões da janela à direita. Escolher um espaço volta à última aba daquele tipo; sem nenhuma aberta, cria um documento novo dele | `apps/shell/src/renderer/src/TitleBar.tsx`, `tabbar.css`, `shared/tab-drag-geometry.ts` (cromo de 36 + 40 px) |
| **Barra enxuta**: as faixas de opções dos editores começam **compactas** (só ícones, mais baixas). A faixa completa fica a um clique na aba ou Ctrl+Alt+K, e a escolha é lembrada. As ações por contexto da base continuam: guias contextuais de tabela no documento, menu de contexto e barra flutuante "Perguntar à IA" na seleção | `packages/ui/src/ribbon-collapse.tsx` (`DEFAULT_RIBBON_DENSITY`) |
| Nome do produto em todos os textos de interface (~1.170 ocorrências em 181 arquivos de idiomas e manual); "Genspark AI" → "Fariv IA" nos botões e painéis de IA; logo do assistente trocado pelo glifo Fariv | `apps/*/src/renderer/i18n/**`, `apps/shell/src/renderer/src/strings.ts`, `GensparkMark` (nome mantido, desenho trocado) |
| Home: logo Fariv; cartões "Documento / Planilha / Apresentação" em português; o botão da conta de nuvem da origem virou **Configurações** | `Home.tsx`, `assets/fariv-logo.svg` |
| Retirados os convites da origem: pedido de Star no GitHub do GenOffice, slide do grupo GenTeam/créditos e o aviso de analytics (que é desligado no Fariv) | `apps/shell/src/main/index.ts` (`FARIV_HIDES_ORIGIN_COMMUNITY`), `Onboarding.tsx` |
| Servidor MCP local se apresenta como **Fariv** para agentes externos | `apps/shell/src/main/mcp/*` |

Nomes técnicos ficaram como estão de propósito: pacotes `@genoffice/*`, variáveis `GENOFFICE_*`, fontes de documento "GenOffice …" (são aliases de renderização gravados nos arquivos), o comando de linha `genoffice` e os namespaces XML. Trocar isso não muda nada para o usuário e mexeria em formatos e testes de fidelidade.

**Ainda com a origem (etapa 3):** os textos e fluxos da conta Genspark (login, créditos, ferramentas de nuvem) continuam no código; o painel de IA ainda oferece o provedor Genspark até a etapa 3 trocar o padrão para o Codex local e esconder a nuvem da origem. O manual de ajuda traz o nome Fariv mas ainda descreve recursos e telas da origem. Os ícones dos tipos de arquivo (Word/Excel/PowerPoint) são os da base.

**Verificado:** e2e `fariv-identity.spec.ts` (seletor em português, cria e volta às abas certas, faixa compacta nos três editores), `onboarding.spec.ts` (dois slides, sem convites), `home.spec.ts` e o ciclo editar/salvar/reabrir dos três formatos. Os 1.157 testes do shell passam.

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
- O instalador do CI **não é assinado** (precisa do certificado da Fariv).
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

- Validação no Windows real (instalar, abrir, salvar): o CI produz o instalador; falta rodá-lo numa máquina Windows.
- Inventário de assets e licenças do instalador final.
- Os demais e2e da base não fazem parte do CI do Fariv nesta etapa; o CI roda o conjunto Fariv + fumaça da base. Os testes unitários da base rodam todos (`npm test`).
- Neste contêiner (usuário root), um teste da base que conta com uma pasta sem permissão de escrita falha (`default-save-dir.test.ts`, "degrades to the fallback…"); falha igual antes das mudanças e passa no CI, que não roda como root.
