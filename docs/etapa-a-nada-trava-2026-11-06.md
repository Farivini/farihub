# Etapa A — nada trava na base grande

06/11/2026. **Resultado: as ações que travavam no teste do Windows agora respondem em décimos de
segundo na base de 1 milhão de linhas. A pior pausa da tela no roteiro caiu de 64 s para 0,3 s, e
os arquivos salvos conferem com o original.**

Plano: [plano-2026-11-06](plano-2026-11-06.md). Teste no Windows: [anotações](teste-windows-2026-11-05.md).

## O que travava e por quê

Medido aqui, com o `bank_transactions.csv`, antes da correção:

| Ação | Antes | Causa |
| --- | --- | --- |
| Apagar a coluna inteira (Delete) | 5 s travado | A tela escrevia 1 milhão de células vazias, uma a uma, e o diário guardava 1 milhão de entradas |
| Desfazer esse apagar | **64 s travado** (no Windows, ~1min30) | A tela reescrevia as células, e o desfazer só conhecia os valores das linhas carregadas: **ao salvar, o resto da coluna sairia vazio** |
| Copiar a base inteira | 0,8 s travado, e mais pausas depois | A tela lia a base em pedaços e montava 66 MB de texto |
| Barra de status com a base selecionada | Somava só o trecho da tela | O teto de 1 milhão de células fazia o app desistir e mostrar o número errado |

A seleção até o fim (Ctrl+Shift+→ e ↓) não travou aqui, nem antes da correção. A soma errada da
barra de status era a parte visível do problema.

## O que mudou

- **Apagar (Delete, limpar conteúdo) na base grande** vira um comando só.
  - Cada área apagada vira um preenchimento vazio no diário de edições, sem escrever célula por
    célula na tela.
  - Uma **coluna calculada** inteira selecionada é desligada como um todo, como apagar a coluna
    calculada de uma tabela do Excel. Células digitadas por cima da fórmula (salvas ou não) saem
    junto.
  - Uma **coluna nova** digitada à direita da base também é apagada, na tela e no arquivo; apagar
    uma coluna que nunca foi salva não acrescenta coluna vazia ao arquivo.
  - **Desfazer** traz tudo de volta num passo, e o arquivo salvo depois fica idêntico ao original.
- **Barra de status e `aggregate_range` da IA:** a conta (contagem, soma, mínimo, máximo, média,
  valores distintos, valores mais frequentes) é feita **pelo motor**, numa passada, sem teto de
  células, com as edições ainda não salvas por cima.
  - A pergunta da IA "quantos / quanto soma / quantos distintos" não lê mais a base em pedaços.
- **Copiar a base inteira:** o motor monta o texto e o processo principal o põe na área de
  transferência, sem passar pela tela.
- **Salvar com só uma coluna calculada:** o Salvar não gravava quando a única mudança era uma coluna
  calculada (sem cabeçalho digitado). Agora o diário conta as mudanças feitas no motor.

## Teste com a base enviada (1.048.567 transações)

App real, base aberta pelo menu (numa cópia). Roteiro:
`suite/bench/abrir-milhao/verify-etapa-a.mjs`.

| Verificação | Resultado |
| --- | --- |
| Ctrl+Shift+→ e ↓: barra de status | **Contagem 9.433.492, igual às células preenchidas da base** |
| Copiar a base inteira | 1.048.568 linhas na área de transferência; primeira e última iguais ao arquivo |
| Apagar a coluna C inteira, desfazer e salvar | **Arquivo idêntico ao original** (mesmo SHA-256) |
| Apagar a coluna C e salvar | Só a coluna C vazia; as outras 8 iguais ao original em todas as linhas |
| Apagar uma coluna calculada inteira e desfazer | Some e volta; o arquivo salvo traz a coluna certa em todas as linhas |
| Apagar a coluna calculada com células digitadas por cima (uma salva, uma não) | As duas somem; o arquivo salvo fica com a coluna vazia e o resto igual |
| Apagar uma coluna nova digitada à direita, desfazer e refazer | Some, volta e some na tela; o arquivo salvo não ganha coluna |

| Ação | Responde em | Maior pausa da tela |
| --- | --- | --- |
| Ctrl+Shift+→ / ↓ | 0,05 s / 0,06 s | 0,3 s |
| Copiar a base inteira (66 MB) | 0,03 s | 0,02 s |
| Apagar a coluna inteira / desfazer | 0,05 s / 0,06 s | 0,1 s |
| Apagar a coluna calculada / desfazer | 0,02 s / 0,04 s | 0,1 s |

## Testes

| Teste | Resultado |
| --- | --- |
| Motor (Rust), com os testes novos da conta por intervalo e de edições vazias fora da base | 17/17 |
| Etapa A (este roteiro) | 8/8 |
| Coluna calculada (`verify-calc`) | 7/7 (CSV salvo igual ao oráculo em 15.728.520 campos) |
| Editar e salvar (`verify-edit-save`) | 7/7 |
| IA criando coluna calculada, modelo simulado (`verify-ai-calc`) | 5/5 |
| Planilha (vitest) | 3.908 aprovados; as 3 falhas de `promote-file-atomically` são as de sempre (usuário root) |

## Limites

- **Desfazer um apagar depois de salvar** não está disponível: o Salvar grava as células vazias e o
  histórico de desfazer desse tipo de passo é cortado no Salvar, como já acontecia com os
  preenchimentos da IA.
- **Colar** um bloco enorme (centenas de milhares de linhas) sobre a base ainda passa pela tela.
  Copiar já foi resolvido; colar grande fica para a próxima etapa.
- **Recortar (Ctrl+X)** uma área maior que a tela continua recusado com aviso, como antes.
- Sem teste no Windows desta etapa ainda: o instalador sai pelo CI desta PR.
