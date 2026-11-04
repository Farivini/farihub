# Teste da base enviada — 4 de novembro de 2026

**Veredito: o experimento DuckDB com exibição em janela processou esta base de mais de um milhão de linhas, sem divergências nas verificações executadas. O aplicativo pelo fluxo normal ainda não atende ao marco.**

O caminho normal de abertura, na versão da PR #12 usada como referência, recusou o CSV com a mensagem “O arquivo excede o limite de tamanho”. O limite continua em 32 MiB. A PR #13 registra a decisão do motor; a PR #14 contém o ensaio, ainda em rascunho. Nenhum merge, instalador ou alteração de produção foi feito nesta etapa.

## Entrada e trabalho executado

O arquivo enviado contém `bank_transactions.csv`: **1.048.567 registros, 9 colunas e 67.564.190 bytes (64,43 MiB)**. SHA-256: `2a15a0742aa766b797049572d4c56956a259381eab270ea2e7d195d2536ec7b6`.

A base foi usada inteira, sem repetir linhas para atingir o tamanho. Foi importada no processo Rust/DuckDB separado; a interface real de Planilhas recebeu trechos de 100 registros, com indicação da posição absoluta. A aba experimental tem 201 linhas físicas. Isso não significa carregar um milhão de linhas físicas no Univer nem comprova a rolagem normal do produto.

Foram declaradas numéricas somente `CustAccountBalance` e `TransactionAmount (INR)`. Os demais campos, incluindo identificadores, datas e horários, permaneceram texto. A coluna `ensaio_valor_x2` multiplica o valor da transação por dois como carga técnica, sem interpretação financeira. Não houve uso de LLM, real ou simulado, neste ensaio.

A definição do cálculo é SQL sobre a tabela completa; a etapa de cálculo executa contagem, soma, mínimo e máximo sobre o resultado, sem criar um milhão de fórmulas no Univer. Salvamento interno usa Parquet mais JSON da definição. Depois da reabertura, o resultado completo foi exportado para conferência independente. Nenhuma equivalência com XLSX ou fórmulas do Excel foi testada.

## Duas rodadas independentes e sequenciais

| Medida | Rodada 1 | Rodada 2 |
| --- | ---: | ---: |
| Importação | 2,101 s | 2,220 s |
| Primeira exibição, após importar | 0,323 s | 0,447 s |
| Trocas de trecho no controle experimental | 0,193–0,441 s | 0,234–0,388 s |
| Cálculo agregado da coluna SQL | 0,013 s | 0,020 s |
| Salvar Parquet e definição | 0,622 s | 0,700 s |
| Reabrir Parquet e definição | 0,783 s | 0,832 s |
| Exportar resultado completo para auditoria | 0,758 s | 1,020 s |
| Maior intervalo observado entre frames | 150 ms | 167 ms |
| Pico amostrado de PSS da árvore do aplicativo | 991 MiB | 1.008 MiB |
| Células da interface conferidas | 7.200 | 7.200 |
| Células conferidas após salvar/reabrir | 10.485.670 | 10.485.670 |
| Linhas com divergência no oráculo | **0** | **0** |

Importação mais primeira exibição somaram aproximadamente 2,4–2,7 s; os tempos não incluem iniciar o aplicativo. Durante a importação, uma interação de teste na interface respondeu em 21–26 ms, antes de o motor terminar. Não foram observadas pausas de vários segundos nos frames medidos. O maior intervalo de 167 ms ainda representa uma pausa curta: não é garantia de ausência de qualquer travamento em outras operações ou no computador do usuário.

PSS estima memória compartilhada proporcionalmente, somada para a árvore Electron/sidecar/motor; não é apenas o heap JavaScript. O RSS somado atingiu aproximadamente 1.282–1.292 MiB e pode contar páginas compartilhadas mais de uma vez. A medição é amostrada, não uma garantia de teto. Os contadores do ambiente não registraram OOM ou encerramento por falta de memória.

## Correção e campos vazios

Um verificador independente em Python `csv`/`Decimal` comparou os nove campos originais e a coluna calculada em **todas as 1.048.567 linhas**, na ordem, após salvar e reabrir. Nenhuma linha adicional, linha com divergência ou troca de campo numérico vazio foi encontrada em ambas as rodadas.

Campos de texto foram comparados literalmente. Valores numéricos foram comparados com tolerância absoluta de `0,00000001`, explicitamente; não é uma prova de aritmética decimal exata para aplicações financeiras. O candidato usa `DOUBLE`. Os 2.369 saldos vazios permaneceram vazios, e os campos vazios de gênero e localização também passaram pela comparação literal. As 7.200 células visíveis por rodada foram conferidas contra as respostas do motor; o oráculo completo é a verificação independente dos dados, além dessa conferência da interface.

## Ambiente e limites da conclusão

Linux x86_64, limite do ambiente de 8 GiB, quota de CPU equivalente a 8 núcleos; DuckDB com 2 threads e `memory_limit=512MB`. Esse limite é do motor e não limita a memória de todo o aplicativo. Electron 38.0.0 de teste, enquanto a dependência de produção é 43.8.3; tela virtual Xvfb com GPU desativada. Não há equivalência de hardware com o Acer Nitro relatado.

O binário experimental Rust foi compilado localmente em release, ligado à biblioteca compartilhada oficial DuckDB 2.0.0, com hash conferido. Dois testes nativos passaram, incluindo compatibilidade do cenário anterior e reabertura da definição com fator constante e campo vazio. Compiladores e verificadores completos não rodaram simultaneamente às medições. Build bundled completo, MSVC, Windows, antivírus e instalador continuam sem validação.

Os resultados sustentam continuar a integração do DuckDB com exibição em janela. **Ainda não aprovam o aplicativo para uso com um milhão de linhas.** Faltam abertura e navegação pelo fluxo normal, edição, aceitar/rejeitar, desfazer, salvamento suportado pelo produto e os testes de Windows. Configurações de IA, visual e demais funcionalidades permanecem fora desta etapa.

Dados brutos, linhas de clientes, imagens da base e agregados financeiros não foram incluídos no repositório. Roteiros e evidências de desempenho/correção, sem esses dados: `suite/bench/million-live/results/2026-11-04/bank`.
