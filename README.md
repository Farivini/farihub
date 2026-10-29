# Farihub

Ambiente de trabalho Fariv: **Farcel** (planilhas), **Fardoc** (documentos) e **Farcanvas** (apresentações), com IA integrada.

## Decisões do produto

- Windows primeiro; núcleo compartilhável com web e mobile.
- Arquivos locais e edição offline; IA conectada.
- Interface minimalista com seletor lateral, abas e assistente contextual. Referência visual aprovada na conversa de 29/10/2026.
- Farcel: tabela dinâmica, gráficos, fórmulas familiares ao Excel em português e objetivo de 1.000.000 de linhas por aba.
- Implementação própria com componentes reutilizáveis sem licença paga de motor.
- Contas, sincronização e colaboração ficam para depois.

## Estado

Prova técnica inicial. **Não há aplicativo, instalador, IA conectada ou compatibilidade Excel validada.** Os testes abaixo não comprovam que um editor completo suporta um milhão de linhas.

## Executar a prova

Requer Node.js 24.22.1 ou superior. Sem dependências para a agregação; candidato IronCalc fixado no lockfile para os testes do motor.

```sh
npm ci --ignore-scripts
npm test
npm run bench
npm run probe:ironcalc
npm run bench:ironcalc
```

O benchmark gera uma base sintética de um milhão de linhas em memória e agrega valores em um worker. O relatório registra o ambiente, tempos e memória do processo. Não mede renderização, XLSX, cálculo de fórmulas nem desempenho em Windows.

O probe verifica sete fórmulas básicas, uma ida e volta XLSX de duas células e tenta três identificadores de idioma português. O benchmark do motor preenche três colunas numéricas por um milhão de linhas, calcula uma soma e repete após uma edição. Ainda não há tradução de fórmulas para português, tabela dinâmica visual ou comparação com o Microsoft Excel.

Consulte [o escopo](docs/prova-tecnica.md) e [o relatório inicial](docs/resultados-iniciais.md).
