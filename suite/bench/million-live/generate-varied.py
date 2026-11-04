"""One million deterministic, varied rows; leading zero codes and negative values.
Usage: generate-varied.py OUTPUT.csv
"""
import csv
import sys
with open(sys.argv[1], 'w', encoding='utf-8-sig', newline='') as f:
    w=csv.writer(f,delimiter=';')
    w.writerow(['nota','produto_codigo','descricao','quantidade','data_hora','preco_unitario_gbp','cliente_codigo','pais'])
    for i in range(1000000):
        cents=(i*17)%200000+1
        whole=cents//100
        p=f'{whole//1000}.{whole%1000:03d}' if whole>=1000 else str(whole)
        quantity=-(i%13+1) if i%17==0 else i%49+1
        w.writerow([7000000+i,f'{i%50000:07d}',f'Produto {i%50000}; série "A"',quantity,f'2026-10-{i%28+1:02d} 08:30',f'{p},{cents%100:02d}',f'{i%99999:08d}','Brasil' if i%3 else 'United Kingdom'])
