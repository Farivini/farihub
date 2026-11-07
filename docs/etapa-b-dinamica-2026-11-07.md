# Etapa B — tabela dinâmica da base inteira, no motor

07/11/2026. **Resultado: Inserir → Tabela dinâmica numa base grande abre a dinâmica calculada pelo
motor sobre as 1.048.567 linhas. Nas dez trocas de campo do roteiro, a pior resposta foi 0,63 s e a
pior pausa da tela, 0,17 s. Os números conferem com um cálculo independente em Python, linha a linha.**

Plano: [plano-2026-11-06](plano-2026-11-06.md) (itens T3 e T4 do [teste no Windows](teste-windows-2026-11-05.md)).

## O que travava

A dinâmica de hoje é a da planilha: lê a fonte pela grade, que na base grande só tem a parte visível, e
recalcula tudo na tela a cada troca de campo. No Windows ela travou sobre a base inteira e também numa
dinâmica pequena ao trocar um campo.

## O que mudou

- **Motor (`pivot.rs`):** linhas (até 4 campos), colunas (até 2), filtros e valores numa passada sobre a
  base, com as edições ainda não salvas por cima.
  - Resumos: soma, contagem, **contagem distinta**, média, mínimo e máximo.
  - Totais por linha, por coluna e geral, calculados das próprias linhas: a contagem distinta e a média
    do total não são soma das células.
  - **Datas** agrupadas por ano, trimestre, mês ou dia, lidas do texto da base (`dd/mm/aaaa`, `d/m/aa`,
    `aaaa-mm-dd`, com ou sem hora). A ordem dia/mês de cada coluna é descoberta pelos próprios valores
    (um primeiro número acima de 12 indica dia primeiro).
  - Ordem do Excel nos rótulos: números, datas, texto sem diferenciar maiúsculas e o vazio por último.
  - Para ficar rápido, cada coluna é lida uma vez e guardada codificada (um número por linha). Os
    rótulos e a ordem de cada campo também ficam guardados. Ao abrir a dinâmica, o motor já lê as
    colunas em segundo plano. Qualquer gravação na base invalida o que foi guardado.
- **Tela (`LargePivotView`):** o mesmo painel "Campos da Tabela Dinâmica" do Excel, à direita.
  - O resultado aparece numa tela própria, com cabeçalhos, totais e "Mostrar valores como": % do total
    geral, da linha e da coluna.
  - **Pareto ABC:** linhas pela maior, com % do total, % acumulado e classe (A até 80%, B até 95%, C no
    resto). O % divide pela soma das linhas, então o acumulado termina em 100% também na contagem
    distinta.
  - **Gráfico:** as 20 maiores categorias em barras horizontais; quando o campo é data, colunas em
    ordem de tempo; o valor aparece ao passar o mouse.
  - **Copiar** (para colar e editar numa planilha) e **Salvar CSV** levam todas as linhas. A tela
    desenha as primeiras 2.000.
  - "Voltar para a base" fecha a tela; reabrir traz os mesmos campos.
- **Painel de campos:** na base grande oferece a contagem distinta e marca como "ainda não disponível"
  o que o motor não faz. Corrigido também um defeito do painel: um nome de valor longo empurrava as
  áreas para fora dele.

## Teste com a base enviada (1.048.567 transações)

App real, base aberta pelo menu (numa cópia). Roteiro: `suite/bench/abrir-milhao/verify-pivot.mjs`.

| Verificação | Resultado |
| --- | --- |
| Inserir → Tabela dinâmica | Abre a dinâmica do motor com os 9 campos |
| Soma do valor por cidade | **9.356 cidades, todas iguais ao Python** |
| Contagem distinta de clientes por gênero (pela janela do campo de valor) | **4 grupos, iguais ao Python** |
| Pareto ABC com todas as linhas (pela dinâmica copiada) | 9.356 linhas, classes em ordem A→B→C, acumulado termina em 100% |
| Gráfico | 20 barras |
| Voltar e reabrir | Mesma dinâmica |

No motor, sem a tela: cidade × mês (soma), gênero × ano (clientes distintos e média) e dias com
filtro de gênero conferem com o Python em todos os grupos (15.578, 4 e 55).

| Troca de campo | Responde em | Maior pausa da tela |
| --- | --- | --- |
| Cidade em Linhas | 0,08 s | 0,02 s |
| Soma do valor | 0,36 s | 0,17 s |
| Gênero em Linhas (cidade × gênero, 10.982 linhas) | 0,32 s | 0,17 s |
| Tira cidade | 0,37 s | 0,02 s |
| Data em Linhas (por dia) | 0,10 s | 0,02 s |
| Tira gênero | 0,11 s | 0,02 s |
| Cliente em Linhas (dia × cliente, **1.044.855 linhas**) | 0,63 s | 0,12 s |
| Tira cliente | 0,15 s | 0,05 s |
| Saldo em Valores | 0,11 s | 0,02 s |
| Tira o valor | 0,08 s | 0,02 s |
| Contagem distinta de clientes | 0,19 s | 0,06 s |

## Testes

| Teste | Resultado |
| --- | --- |
| Motor (Rust), com os testes novos da dinâmica (agrupar, distintos, datas, filtro, edições, ordem pelo valor) | 19/19 |
| Etapa B (este roteiro) | 6/6 |
| Etapa A (`verify-etapa-a`) | 8/8 |
| Coluna calculada (`verify-calc`) | 7/7 |
| Planilha (vitest), com os testes novos da dinâmica | 3.914 aprovados; as 3 falhas de `promote-file-atomically` são as de sempre (usuário root) |

## Limites

- **O resultado não é uma aba da planilha:** aparece numa tela própria. Para editar, use Copiar e cole
  numa planilha, ou Salvar CSV. A dinâmica não é gravada junto com o arquivo da base.
- **Ainda não disponível** na dinâmica da base grande (o painel avisa): agrupar números por faixa,
  filtro de rótulo e de valor, campo calculado, desvio padrão, variância, produto e os outros
  "Mostrar valores como" (diferença, acumulado, classificação…).
- O filtro escolhe um valor por campo, como no painel de hoje.
- Um campo em Colunas aceita até 2.000 valores; acima disso o app pede para usá-lo em Linhas.
- Datas só são reconhecidas quando escritas como texto de data. Números de série do Excel (XLSX) entram
  com a Etapa C.
- A primeira consulta de uma coluna com quase 1 milhão de valores distintos, logo ao abrir, pode levar
  1 a 2 s se o motor ainda estiver lendo em segundo plano.
- A IA ainda não usa a dinâmica do motor (Etapa D).
- Sem teste no Windows desta etapa ainda: o instalador sai pelo CI da PR.
