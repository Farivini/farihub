# Teste no Windows — anotações de 05/11/2026

Instalador do CI (`fariv-windows-installer`, execução 42043359156, commit `fc75704`). Base:
`bank_transactions.csv` (1.048.567 transações) e um `teste.xlsx` salvo a partir dela.
**Só anotações — nada corrigido ainda.**

## O que funcionou

- Todos os testes manuais da coluna calculada na base grande (CSV): criar, recalcular, desfazer,
  refazer, salvar, Salvar como.
- IA: criou colunas e, depois da primeira, fez bem e rápido.
- Memória ficou estável o tempo todo, mesmo nos travamentos.

## Problemas encontrados

### Travamentos

1. **Apagar a coluna calculada inteira** (selecionar a coluna e Delete): travou um pouco, voltou,
   depois travou ~1min30.
2. **Ctrl+Shift+→ e depois ↓** (selecionar até o fim): travou.
3. **Dinâmica sobre a base inteira** (A1:M1048576, terceiro print): travou de vez. O diálogo avisa
   que a origem é limitada a 10.000 linhas.
4. **Dinâmica com intervalo menor:** criou, mas ao **trocar um campo de linha** travou tudo.

### XLSX grande não usa o motor

5. `teste.xlsx` (1.048.560 linhas) abre pelo caminho antigo, "por streaming" (rodapé do primeiro
   print), não pelo motor: **Ctrl+↓ não funciona** e tudo é mais lento. Pedido: sempre o motor
   potente, para qualquer arquivo grande ("não se troca de motor para ir à padaria").

### IA

6. **Primeira coluna pela IA não apareceu** (primeiro print): a IA disse que aplicou `=I2*18%` em
   `J1:J1048568` e que `J2` deu 4,5, mas a coluna J ficou vazia na tela. Arquivo aberto era o
   `teste.xlsx` (caminho antigo, não o motor). As seguintes funcionaram.
7. **Resumo por dia em outra aba** (segundo print, "soma do saldo acumulado por dia"): 17 etapas,
   demorou uma eternidade; criou duas abas, uma com resultado e outra em branco. No Excel seria
   selecionar e inserir dinâmica.
8. **Botão de cancelar** tem que estar sempre ativo; na tarefa acima não deixou cancelar.
9. **Erro de autenticação cru** do provedor:
   `unexpected status 401 Unauthorized: Missing bearer or basic authentication in header,
   url: https://api.openai.com/v1/responses ...`. Precisa ser tratado com mensagem amigável.
10. **Detectar a IA que a pessoa já tem no terminal (CLI)** e orientar a configuração, ou abstrair
    o terminal no executável de forma amigável, sem a pessoa mexer em linha de comando.
11. **A experiência com a IA está arcaica e penosa:** tem que ser fluida, leve e inteligente no que
    faz.

### Pedidos de produto

12. **Inserir dinâmica nativa e rápida** sobre a base grande: soma, contagem, **contagem distinta**
    e as demais agregações do Excel; trocar campos sem travar.
13. **Gráficos** a partir da dinâmica e **gráficos e análises sugeridos pela IA**.
14. **Uma "skill" forte para a IA da pessoa:** instruções e ferramentas para a IA fazer dinâmica,
    resumo, gráfico e análise do jeito certo (pelo motor, sem 17 etapas lendo trechos).
