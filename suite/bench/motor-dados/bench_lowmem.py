"""Memoria apertada: tarefas pesadas direto do Parquet, sem carregar a base.
Uso: bench_lowmem.py duckdb|polars PARQUET LIMITE_MB SAIDA.json
DuckDB: memory_limit + temp_directory (usa o disco quando falta RAM).
Polars: LazyFrame no motor de fluxo (engine='streaming'), gravando em Parquet.
"""
import gc, json, os, shutil, sys, threading, time

import psutil

ENGINE, PARQ, LIMIT_MB, OUT = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.join(HERE, 'work', f'lowmem_{ENGINE}_{LIMIT_MB}')
shutil.rmtree(WORK, ignore_errors=True)
os.makedirs(WORK)
PROD = os.path.join(HERE, 'produtos.csv')
proc = psutil.Process()
peak = {'v': 0}
stop = False


def sampler():
    while not stop:
        r = proc.memory_info().rss
        if r > peak['v']:
            peak['v'] = r
        time.sleep(0.005)


threading.Thread(target=sampler, daemon=True).start()
results = {}


def step(name, fn):
    gc.collect()
    peak['v'] = proc.memory_info().rss
    t = time.perf_counter()
    try:
        out = fn()
        ok = True
    except Exception as e:  # registra a falha em vez de parar
        out, ok = str(e)[:200], False
    results[name] = {'s': round(time.perf_counter() - t, 3), 'pico_mb': round(peak['v'] / 2**20), 'ok': ok}
    if not ok:
        results[name]['erro'] = out
    return out


if ENGINE == 'duckdb':
    import duckdb

    con = duckdb.connect()
    con.execute(f"set memory_limit='{LIMIT_MB}MB'")
    con.execute(f"set temp_directory='{WORK}/tmp'")
    con.execute('set preserve_insertion_order=false')
    src = f"read_parquet('{PARQ}')"
    step('acumulado_por_regional', lambda: con.execute(f"""copy (select *, sum(quantidade*preco_unitario) over
        (partition by regional order by data rows between unbounded preceding and current row) acumulado
        from {src}) to '{WORK}/a.parquet' (format parquet)"""))
    step('ordenar_base_inteira', lambda: con.execute(
        f"copy (select * from {src} order by preco_unitario desc) to '{WORK}/s.parquet' (format parquet)"))
    step('procv_50mil_produtos', lambda: con.execute(f"""copy (select v.*, p.categoria from {src} v left join
        read_csv('{PROD}', delim=';', decimal_separator=',', types={{'codigo_produto':'VARCHAR'}}) p
        using (codigo_produto)) to '{WORK}/j.parquet' (format parquet)"""))
    step('dinamica_regional_mes', lambda: con.execute(f"""select regional, date_trunc('month', data),
        sum(quantidade*preco_unitario) from {src} group by all""").fetchall())
else:
    import polars as pl

    lf = pl.scan_parquet(PARQ)
    step('acumulado_por_regional', lambda: lf.sort('data').with_columns(
        acumulado=(pl.col('quantidade') * pl.col('preco_unitario')).cum_sum().over('regional'))
         .sink_parquet(f'{WORK}/a.parquet', engine='streaming'))
    step('ordenar_base_inteira', lambda: lf.sort('preco_unitario', descending=True)
         .sink_parquet(f'{WORK}/s.parquet', engine='streaming'))
    p = pl.scan_csv(PROD, separator=';', decimal_comma=True, schema_overrides={'codigo_produto': pl.String})
    step('procv_50mil_produtos', lambda: lf.join(p, on='codigo_produto', how='left')
         .sink_parquet(f'{WORK}/j.parquet', engine='streaming'))
    step('dinamica_regional_mes', lambda: lf.group_by('regional', pl.col('data').dt.truncate('1mo'))
         .agg((pl.col('quantidade') * pl.col('preco_unitario')).sum()).collect(engine='streaming'))

stop = True
json.dump({'engine': ENGINE, 'limit_mb': LIMIT_MB, 'results': results}, open(OUT, 'w'), indent=1)
print(ENGINE, LIMIT_MB, json.dumps(results))
shutil.rmtree(WORK, ignore_errors=True)
