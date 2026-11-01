# Origem do código em `suite/`

`suite/` é a base do pacote Fariv (Planilhas, Documentos, Apresentações). Começou como cópia do **GenOffice OSS**, e as mudanças do Fariv entram em commits separados, por cima da importação, para que a diferença em relação à origem fique visível no histórico.

| | |
| --- | --- |
| Projeto de origem | GenOffice — https://github.com/genspark-ai/genoffice |
| Commit importado | `36a509e8fc16ace85ed7afa3c37acb7b9c441ad1` ("Sync snapshot (2026-10-30) (#2341)") |
| Licença | Apache-2.0 (`LICENSE`), com `NOTICE` e `LICENSE-UNICODE.txt` mantidos como vieram |
| Como foi importado | `git archive 36a509e8` (só arquivos versionados), extraído em `suite/` sem nenhuma alteração no commit de importação |
| Excluído | `ee/` (diretório de licença empresarial, fora da Apache-2.0; no snapshot só tinha `LICENSE` e `README`); `.github/` (CI, CODEOWNERS e modelos de issue do projeto de origem — o CI do Fariv fica em `/.github/workflows/suite.yml`) |

O mapa de origem de cada bloco reaproveitado e as decisões de adaptação estão em [`docs/mapa-reaproveitamento.md`](https://github.com/Farivini/farihub/pull/9) (PR #9) e em [`docs/suite-integracao.md`](../docs/suite-integracao.md).

## Regras para mudanças

- Não apagar nem reescrever `LICENSE`, `NOTICE` e avisos de terceiros. O aviso de terceiros do pacote final é gerado por `npm run notices` (`tools/gen-third-party-notices.mjs`) e vai dentro do instalador.
- Arquivos modificados pelo Fariv seguem sob Apache-2.0; a seção 4(b) pede aviso de modificação: os commits do Fariv sobre `suite/` são esse registro, e a lista resumida fica em `docs/suite-integracao.md`.
- Marca, nome e ícones do produto de origem são substituídos pelos do Fariv (a Apache-2.0 não concede uso de marca). Nomes internos de pacotes (`@genoffice/*`) ficam como estão nesta etapa, para não espalhar renomeações por milhares de arquivos.
- Para trazer correções do projeto de origem: comparar com um novo commit de lá e aplicar por cima, registrando aqui o novo SHA.
