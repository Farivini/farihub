"""Gera as bases de teste (pt-BR: ';', virgula decimal, BOM, data dd/mm/aaaa)."""
import sys, duckdb
n = int(sys.argv[1]); out = sys.argv[2]
con = duckdb.connect()
con.execute("select setseed(0.42)")
con.execute(f"""
create table v as
select
  cast(500000 + i // 7 as varchar) as nota,
  strftime(timestamp '2024-01-01' + to_minutes(cast(floor(random()*1051200) as bigint)), '%d/%m/%Y %H:%M') as data,
  ['Sul','Sudeste','Centro-Oeste','Nordeste','Norte','SP Capital','RJ Capital','Interior'][1 + cast(floor(random()*8) as int)] as regional,
  'V' || lpad(cast(cast(floor(random()*400) as int) as varchar), 3, '0') as vendedor,
  lpad(cast(cast(floor(random()*50000) as int) as varchar), 6, '0') as codigo_produto,
  (case when random() < 0.03 then -1 else 1 end) * [1,2,3,4,6,12,24,48][1 + cast(floor(random()*8) as int)] as quantidade,
  replace(printf('%.2f', 0.10 + floor(random()*150000)/100.0), '.', ',') as preco_unitario,
  12346 + cast(floor(random()*6000) as int) as id_cliente,
  ['Brasil','Portugal','Argentina','Chile','Uruguai','Paraguai','Mexico','Colombia','Peru','Espanha'][1 + cast(floor(random()*10) as int)] as pais
from range({n}) t(i)
""")
con.execute(f"copy v to '{out}' (header, delimiter ';', quote '')")
# BOM como numa exportacao do Excel pt-BR
data = open(out, 'rb').read()
open(out, 'wb').write(b'\xef\xbb\xbf' + data)
print(out, n)
