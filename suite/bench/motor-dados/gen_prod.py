import sys, duckdb
con = duckdb.connect(); con.execute("select setseed(0.7)")
con.execute(f"""copy (select lpad(cast(i as varchar),6,'0') as codigo_produto,
  ['Alimentos','Bebidas','Limpeza','Higiene','Eletro','Casa','Papelaria','Pet'][1+cast(floor(random()*8) as int)] as categoria,
  replace(printf('%.2f', 0.05 + floor(random()*100000)/100.0), '.', ',') as custo_unitario
  from range(50000) t(i)) to '{sys.argv[1]}' (header, delimiter ';', quote '')""")
