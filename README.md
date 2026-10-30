# Farihub

Ambiente de trabalho Fariv com três espaços — **Planilhas**, **Documentos** e **Apresentações** — e um assistente integrado.

Nomes internos: no código os espaços continuam `farcel`, `fardoc` e `farcanvas`, e o arquivo de planilha continua com a extensão `.farcel`. Na interface aparecem só os nomes visíveis acima.

## Decisões do produto

- Windows primeiro; núcleo compartilhável com web e mobile.
- Arquivos locais e edição offline; IA conectada.
- Interface minimalista com seletor de espaços, abas e assistente contextual (ver Direção visual).
- Planilhas: tabela dinâmica, gráficos, fórmulas familiares ao Excel em português e objetivo de 1.000.000 de linhas por aba.
- Implementação própria com componentes reutilizáveis sem licença paga de motor.
- Contas, sincronização e colaboração ficam para depois.

## Direção visual

Referências aprovadas em 30/10/2026 para Planilhas, Documentos e Apresentações. A interface aplica:

- aspecto de aplicativo de Mac: três bolinhas de janela à esquerda, barra de título compacta, superfícies grafite em camadas e divisórias discretas;
- assinatura Fariv com o A aberto em laranja (`src/app/shell/Wordmark.tsx`; recurso vetorial sem fundo em `src/app/assets/fariv-assinatura.svg`);
- seletor dos três espaços centralizado no topo; trilho lateral estreito (arquivos e ajustes); abas de pastas; área de trabalho ampla;
- laranja Fariv só em estados ativos e ações principais, com brilho contido;
- assistente à direita, recolhível e com largura ajustável (arraste a borda ou use as setas sobre ela);
- fonte Inter empacotada no app (funciona offline).

No navegador as bolinhas aparecem apagadas e não clicáveis: não existe janela nativa para controlar. O componente `WindowControls` recebe as ações reais quando o executável fornecer `window.farivWindow`.

![Planilhas](docs/screenshots/planilhas.png)

## Estado

Primeira versão funcional de **Planilhas no navegador**:

- grade em canvas com edição, acentos, navegação por teclado, copiar/colar tabular, desfazer, zoom e barra de fórmulas com menu de funções;
- formatação de número (Geral, Número, Moeda R$, Porcentagem, Data), negrito e alinhamento, salvos no arquivo;
- várias pastas abertas em abas, cada uma com seu próprio motor; trocar de espaço não perde nada;
- cálculo real no **IronCalc 0.9.1 (WASM) dentro de um Web Worker**, fonte única da verdade;
- fórmulas em português (`=SOMA(A1:A3)`, `=SE(A1>0;"sim";"não")`, `1,5`) por uma camada de tokens;
- tabela dinâmica com linhas, colunas, valores (soma, contagem) e filtros, e gráfico ligado ao resultado;
- salvar e abrir **`.farcel`** (formato próprio; não é XLSX);
- base sintética reprodutível de 1.000.000 de linhas, medida na interface.

Documentos e Apresentações aparecem como espaços **em preparação** (as referências orientam o design futuro; não há editor). O assistente aparece **não conectado**: mostra o contexto limitado que receberia, sem enviar nada nem simular respostas. Não há executável Windows, importação/exportação XLSX nem comparação com o Microsoft Excel.

![Tabela dinâmica e gráfico](docs/screenshots/planilhas-dinamica.png)

## Executar

Requer Node.js 24.22.1 ou superior (CI). Também testado localmente com Node 22.22.

```sh
npm ci
npm run dev          # http://localhost:5173 — desenvolvimento
npm run build        # gera dist/
npm run preview      # serve dist/ em http://localhost:4173
```

Para experimentar em **Planilhas**:

1. Digite nas células ou na barra de fórmulas (`=SOMA(A1:A3)`, `=SE(A1>0;"sim";"não")`), ou cole dados do Excel (Ctrl+V).
2. Formate pela barra: formato de número (R$, %), **B**, alinhamento. O botão *fx* insere funções em português.
3. **Dinâmica** cria uma tabela dinâmica a partir de A1 da planilha atual; arraste campos para Linhas, Colunas, Valores e Filtros. O gráfico fica abaixo.
4. No trilho à esquerda, o ícone de arquivos tem **Nova planilha**, **Abrir…** (Ctrl+O), **Salvar** (Ctrl+S, grava `.farcel`) e **Base de teste…**, que gera 1.000.000 de linhas em uma aba nova (cerca de 25 s).
5. O ✦ no canto superior direito mostra ou recolhe o assistente (ainda não conectado).

## Testes e medições

```sh
npm run typecheck
npm test                     # núcleo e motor (Node, mesmo WASM do navegador)
npm run build && npm run test:e2e   # fluxos no Chromium (Playwright)
npm run bench:browser        # 1.000.000 de linhas na interface → reports/browser-million.json
node scripts/bench-wasm-formulas.ts  # 1 M fórmulas por linha no WASM (Node)
node scripts/screenshots.ts --million  # capturas em docs/screenshots/
```

`test:e2e` precisa de um Chromium para o Playwright (`npx playwright install chromium` se não houver).

Prova técnica anterior (agregação colunar e IronCalc nativo no Node), ainda disponível:

```sh
npm run bench
npm run probe:ironcalc
npm run bench:ironcalc
```

## Documentos

- [Arquitetura e escolhas do Farcel](docs/farcel-arquitetura.md) — fonte da verdade, worker, grade, fórmulas pt-BR, dinâmica, arquivo, limitações.
- [Resultados no navegador](docs/resultados-navegador.md) — 1.000.000 de linhas: tempos, memória, ambiente.
- [Escopo da prova técnica](docs/prova-tecnica.md) e [resultados iniciais](docs/resultados-iniciais.md).
