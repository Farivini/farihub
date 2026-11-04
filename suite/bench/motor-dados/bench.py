"""DuckDB x Polars nas tarefas do Fariv. Uso: bench.py duckdb|polars ARQUIVO.csv SAIDA.json

Cada execucao e um processo novo. Mede tempo e pico de memoria (RSS) por tarefa,
com um amostrador a cada 5 ms, e guarda conferencias numericas para comparar os
dois motores.
"""
import gc, json, os, sys, threading, time

import psutil

ENGINE, CSV, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
HERE = os.path.dirname(os.path.abspath(__file__))
PROD = os.path.join(HERE, 'produtos.csv')
WORK = os.path.join(HERE, 'work', f'{ENGINE}_{os.path.basename(CSV)}')
os.makedirs(WORK, exist_ok=True)
PARQ = os.path.join(WORK, 'base.parquet')

proc = psutil.Process()
peak = {'v': 0}
stop = False


def sampler():
    while not stop:
        rss = proc.memory_info().rss
        if rss > peak['v']:
            peak['v'] = rss
        time.sleep(0.005)


threading.Thread(target=sampler, daemon=True).start()
results, checks = {}, {}


def step(name, fn):
    gc.collect()
    time.sleep(0.05)
    peak['v'] = proc.memory_info().rss
    t = time.perf_counter()
    out = fn()
    dt = time.perf_counter() - t
    time.sleep(0.02)
    results[name] = {'s': round(dt, 3), 'pico_mb': round(peak['v'] / 2**20)}
    return out


MB = 2**20

if ENGINE == 'duckdb':
    import duckdb

    con = duckdb.connect()  # banco em memoria, todos os nucleos
    q = lambda sql: con.execute(sql).fetchall()

    # auto-deteccao sem dicas: que tipos o motor adivinha sozinho?
    auto = con.execute(f"describe select * from read_csv('{CSV}')").fetchall()
    checks['auto_tipos'] = {r[0]: r[1] for r in auto if r[0] in ('preco_unitario', 'codigo_produto', 'data')}

    def importar():
        con.execute(f"""create table v as select * from read_csv('{CSV}', delim=';', header=true,
            decimal_separator=',', timestampformat='%d/%m/%Y %H:%M',
            types={{'nota':'VARCHAR','codigo_produto':'VARCHAR','preco_unitario':'DOUBLE'}})""")
        return q('select count(*), sum(quantidade*preco_unitario) from v')[0]

    n, soma = step('importar_csv', importar)
    checks['linhas'] = n
    checks['soma_valor'] = round(soma, 2)
    step('gravar_parquet', lambda: con.execute(f"copy v to '{PARQ}' (format parquet, compression zstd)"))
    results['gravar_parquet']['tamanho_mb'] = round(os.path.getsize(PARQ) / MB, 1)
    con.execute('drop table v')

    # abrir o arquivo e mostrar uma "tela" (100 linhas) sem carregar tudo
    step('abrir_e_tela_inicio', lambda: q(f"select * from read_parquet('{PARQ}') limit 100"))
    step('abrir_e_tela_meio', lambda: q(f"select * from read_parquet('{PARQ}') limit 100 offset {n // 2}"))
    step('direto_no_arquivo_dinamica', lambda: q(f"""select regional, date_trunc('month', data) m,
        sum(quantidade*preco_unitario) from read_parquet('{PARQ}') group by all"""))

    step('carregar_parquet', lambda: con.execute(f"create table v as select * from read_parquet('{PARQ}')"))
    con.execute(f"""create table p as select * from read_csv('{PROD}', delim=';', header=true,
        decimal_separator=',', types={{'codigo_produto':'VARCHAR','custo_unitario':'DOUBLE'}})""")

    def calc():
        con.execute('create table v2 as select *, quantidade*preco_unitario as valor from v')
        con.execute('drop table v'); con.execute('alter table v2 rename to v')
        return q('select sum(valor) from v')[0][0]

    checks['coluna_calculada'] = round(step('coluna_calculada', calc), 2)
    g = step('dinamica_regional_mes', lambda: q("""select regional, date_trunc('month', data) m,
        sum(valor), count(*), avg(valor) from v group by all"""))
    checks['dinamica_grupos'] = len(g)
    checks['dinamica_soma'] = round(sum(r[2] for r in g), 2)

    def acumulado():
        con.execute("""create table a as select *,
            sum(valor) over (partition by regional order by data rows between unbounded preceding and current row) acumulado,
            lag(valor) over (partition by regional order by data) anterior from v""")
        r = q('select regional, max(acumulado) from a group by all')
        con.execute('drop table a')
        return r

    checks['acumulado_regional_total'] = round(sum(r[1] for r in step('acumulado_por_regional', acumulado)), 2)

    def pareto():
        return q("""with t as (select codigo_produto, sum(valor) total from v group by all),
            c as (select *, sum(total) over (order by total desc rows between unbounded preceding and current row)
                  / sum(total) over () as pct from t)
            select case when pct <= 0.8 then 'A' when pct <= 0.95 then 'B' else 'C' end cls, count(*)
            from c group by all order by cls""")

    checks['pareto'] = dict(step('pareto_abc', pareto))

    def procv():
        con.execute("""create table j as select v.*, p.categoria, valor - quantidade*p.custo_unitario margem
            from v left join p using (codigo_produto)""")
        r = q('select sum(margem), count(*) from j')[0]
        con.execute('drop table j')
        return r

    m, cnt = step('procv_50mil_produtos', procv)
    checks['procv_margem'] = round(m, 2)
    step('filtrar_e_ordenar_top1000', lambda: q("""select * from v where pais='Brasil' and valor>100
        order by valor desc limit 1000"""))

    def ordenar():
        con.execute('create table s as select * from v order by valor desc')
        con.execute('drop table s')

    step('ordenar_base_inteira', ordenar)

    def perfil():
        cols = [r[0] for r in con.execute('describe v').fetchall()]
        sel = ', '.join(f'count(distinct "{c}"), count(*) - count("{c}"), min("{c}"), max("{c}")' for c in cols)
        return q(f'select {sel} from v')

    step('perfil_para_ia', perfil)
    step('tela_no_meio_da_memoria', lambda: q(f'select * from v limit 100 offset {n // 2}'))
    out_csv = os.path.join(WORK, 'export.csv')

    def exportar():
        # o DuckDB so le virgula decimal; para gravar, converte as colunas DOUBLE na consulta
        cols = con.execute('describe v').fetchall()
        sel = ', '.join(f"replace(cast(\"{c}\" as varchar), '.', ',') as \"{c}\"" if t == 'DOUBLE' else f'"{c}"'
                        for c, t, *_ in cols)
        con.execute(f"copy (select {sel} from v) to '{out_csv}' (header, delimiter ';')")
        return 'convertido na consulta (sem opcao nativa)'

    checks['export_csv_ptbr'] = step('exportar_csv_ptbr', exportar)

else:
    import polars as pl

    auto = pl.read_csv(CSV, separator=';', n_rows=20000).schema
    checks['auto_tipos'] = {k: str(v) for k, v in auto.items() if k in ('preco_unitario', 'codigo_produto', 'data')}
    if not checks['auto_tipos']:
        checks['auto_tipos'] = {k: str(v) for k, v in list(auto.items())[:3]}

    def importar():
        df = pl.read_csv(CSV, separator=';', decimal_comma=True,
                         schema_overrides={'nota': pl.String, 'codigo_produto': pl.String,
                                           'preco_unitario': pl.Float64})
        df = df.with_columns(pl.col('data').str.strptime(pl.Datetime, '%d/%m/%Y %H:%M'))
        return df

    df = step('importar_csv', importar)
    checks['colunas'] = df.columns[:2]
    checks['linhas'] = df.height
    checks['soma_valor'] = round((df['quantidade'] * df['preco_unitario']).sum(), 2)
    n = df.height
    step('gravar_parquet', lambda: df.write_parquet(PARQ, compression='zstd'))
    results['gravar_parquet']['tamanho_mb'] = round(os.path.getsize(PARQ) / MB, 1)
    del df

    step('abrir_e_tela_inicio', lambda: pl.scan_parquet(PARQ).head(100).collect())
    step('abrir_e_tela_meio', lambda: pl.scan_parquet(PARQ).slice(n // 2, 100).collect())
    step('direto_no_arquivo_dinamica', lambda: pl.scan_parquet(PARQ)
         .group_by('regional', pl.col('data').dt.truncate('1mo'))
         .agg((pl.col('quantidade') * pl.col('preco_unitario')).sum()).collect())

    df = step('carregar_parquet', lambda: pl.read_parquet(PARQ))
    p = pl.read_csv(PROD, separator=';', decimal_comma=True,
                    schema_overrides={'codigo_produto': pl.String, 'custo_unitario': pl.Float64})

    def calc():
        global df
        df = df.with_columns(valor=pl.col('quantidade') * pl.col('preco_unitario'))
        return df['valor'].sum()

    checks['coluna_calculada'] = round(step('coluna_calculada', calc), 2)
    g = step('dinamica_regional_mes', lambda: df.group_by('regional', pl.col('data').dt.truncate('1mo'))
             .agg(pl.col('valor').sum().alias('s'), pl.len(), pl.col('valor').mean()))
    checks['dinamica_grupos'] = g.height
    checks['dinamica_soma'] = round(g['s'].sum(), 2)

    def acumulado():
        a = df.sort('data', maintain_order=True).with_columns(
            acumulado=pl.col('valor').cum_sum().over('regional'),
            anterior=pl.col('valor').shift(1).over('regional'))
        return a.group_by('regional').agg(pl.col('acumulado').max())

    checks['acumulado_regional_total'] = round(step('acumulado_por_regional', acumulado)['acumulado'].sum(), 2)

    def pareto():
        t = df.group_by('codigo_produto').agg(total=pl.col('valor').sum()).sort('total', descending=True)
        t = t.with_columns(pct=pl.col('total').cum_sum() / pl.col('total').sum())
        t = t.with_columns(cls=pl.when(pl.col('pct') <= 0.8).then(pl.lit('A'))
                           .when(pl.col('pct') <= 0.95).then(pl.lit('B')).otherwise(pl.lit('C')))
        return t.group_by('cls').len().sort('cls')

    checks['pareto'] = {r[0]: r[1] for r in step('pareto_abc', pareto).iter_rows()}

    def procv():
        j = df.join(p, on='codigo_produto', how='left').with_columns(
            margem=pl.col('valor') - pl.col('quantidade') * pl.col('custo_unitario'))
        return j['margem'].sum(), j.height

    m, cnt = step('procv_50mil_produtos', procv)
    checks['procv_margem'] = round(m, 2)
    step('filtrar_e_ordenar_top1000', lambda: df.filter((pl.col('pais') == 'Brasil') & (pl.col('valor') > 100))
         .sort('valor', descending=True).head(1000))
    step('ordenar_base_inteira', lambda: df.sort('valor', descending=True))
    step('perfil_para_ia', lambda: df.select(
        [e for c in df.columns for e in (pl.col(c).n_unique().alias(c + '_u'), pl.col(c).null_count().alias(c + '_n'),
                                         pl.col(c).min().alias(c + '_min'), pl.col(c).max().alias(c + '_max'))]))
    step('tela_no_meio_da_memoria', lambda: df.slice(n // 2, 100))
    out_csv = os.path.join(WORK, 'export.csv')

    def exportar():
        try:
            df.write_csv(out_csv, separator=';', decimal_comma=True)
            return 'decimal_comma'
        except Exception as e:
            return f'sem opcao: {e}'

    checks['export_csv_ptbr'] = step('exportar_csv_ptbr', exportar)

stop = True
json.dump({'engine': ENGINE, 'csv': os.path.basename(CSV), 'results': results, 'checks': checks},
          open(OUT, 'w'), indent=1, ensure_ascii=False, default=str)
print(json.dumps(results, ensure_ascii=False))
print(json.dumps(checks, ensure_ascii=False, default=str))
