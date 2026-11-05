# Editar, desfazer e salvar uma base grande

05/11/2026. **Resultado: a base grande deixa de ser só leitura. Dá para editar valores, desfazer e
refazer, e salvar em CSV ou XLSX. O arquivo salvo muda só nas células editadas.**

## O que a pessoa pode fazer

- **Editar valores**: digitar, colar, apagar, preencher várias células (Ctrl+Enter, arrastar).
- **Desfazer e refazer** (Ctrl+Z / Ctrl+Y), inclusive depois de salvar.
- **Salvar** (Ctrl+S): grava de volta no arquivo de origem, no formato dele. O separador, a vírgula
  decimal e a linha `sep=` continuam como no original.
- **Salvar como**: CSV ou XLSX. O XLSX sai com as colunas numéricas como números e só existe até
  1.048.576 linhas, o limite do formato. Acima disso, o diálogo oferece só CSV.

**O que ainda espera, sempre com aviso na tela:**
- **Fórmulas**: chegam com a coluna calculada, na próxima etapa.
- **Formatação** e **inserir ou excluir linhas e colunas**: chegam nas etapas seguintes.
- **Alterações da IA** na base grande: chegam na próxima etapa.
- **Bases com mais de 1.048.576 linhas**: aceitam edição só nessas primeiras linhas.

## Como funciona

1. A tela guarda as edições no mesmo diário de alterações das planilhas grandes de hoje. É dele que
   vêm o desfazer, o refazer e a gravação.
2. Ao salvar, o processo principal converte cada edição no texto que ela teria no arquivo:
   - número com a vírgula ou o ponto do arquivo;
   - data ou número formatado como aparece na tela;
   - texto como foi digitado.

   O motor aplica tudo no DuckDB: 100 mil células em ~0,2 s, numa única transação.
3. O motor grava o arquivo inteiro a partir da base, linha a linha, sem carregar tudo na memória.
   Células não editadas saem **com o mesmo texto de origem**, byte a byte. O Excel, ao contrário,
   reescreve números e datas a seu modo.
4. A gravação vai para um arquivo temporário ao lado do destino e só então substitui o original, numa
   única troca. Se a gravação falhar no meio, o arquivo original continua intacto.
5. Se o arquivo foi alterado fora do Fariv depois de aberto, o Salvar recusa e sugere Salvar como.
6. Depois de salvar, a tela troca para uma sessão nova sobre a **mesma** base no motor, sem
   reimportar nada. O histórico de desfazer vem junto.

## Teste com a base enviada (1.048.567 transações)

App real, aberto pelo menu, Electron 43.8.3, Linux com 4 núcleos e 15 GB. Roteiro:
`suite/bench/abrir-milhao/verify-edit-save.mjs`. O roteiro trabalha numa cópia; o arquivo original não
é tocado.

| Verificação | Resultado |
| --- | --- |
| Edições no início (A2), no meio (C524285) e na última linha; apagar (B10); preencher D100:D120 | Na tela, corretas |
| Fórmula digitada (`=A2`) | Recusada com aviso, célula intacta |
| Desfazer e refazer o preenchimento | Volta ao valor original e reaplica |
| **CSV salvo, conferido campo a campo contra o original com leitor independente (Python `csv`)** | **9.437.112 campos; só os editados mudaram** |
| Desfazer depois de salvar, salvar de novo | Arquivo volta a ter o valor original naquelas células |
| Salvar como XLSX | 1.048.568 linhas, texto e números certos |
| CSV salvo reaberto pelo menu | Todas as 9.437.112 células iguais à importação de hoje; Ctrl+End, Ctrl+↓, caixa de nome e busca corretos |
| XLSX salvo reaberto | Abre pelo caminho de XLSX de hoje (8,2 s) |

| Medida | Resultado |
| --- | --- |
| Salvar CSV (64 MB, 1 milhão de linhas) | **1,8 s** |
| Salvar como XLSX | 11,3 s |
| Maior pausa da tela ao editar, salvar e desfazer | 283 ms |
| Pico de memória do app inteiro | 1.027 MB |

## Testes

| Teste | Resultado |
| --- | --- |
| Motor (Rust): leitor, números, importação, Ctrl+↓/↑, busca, **edições + CSV byte a byte, XLSX, edição fora da base** | 8/8 |
| Planilha (vitest): conversão de valores para o arquivo, datas formatadas, bloqueio de comandos, IA recusada | 3.897 aprovados; as 3 falhas de `promote-file-atomically` são as de sempre (usuário root) |
| Ponta a ponta do Fariv | 24/24 |
| Coluna calculada pela IA, CSV de 10 mil linhas | 11/11 |

## Limites desta etapa

- **Colar fórmulas** copiadas de outro lugar grava o valor calculado. Um CSV guarda valores, como no
  Excel.
- **Preencher uma área maior que a tela** com Ctrl+Enter só alcança as linhas já carregadas. Isso já
  acontece hoje em qualquer planilha grande.
- **Um XLSX salvo pelo Fariv** reabre pelo caminho de XLSX de hoje, que é mais lento que o motor. Abrir
  XLSX grande pelo motor fica para depois.
- **Windows** continua sem teste; o próximo `.exe` de controle cobre abrir, editar e salvar.
