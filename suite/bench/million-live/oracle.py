"""Independent Decimal oracle; compare every source row, numeric input and result.
Usage: oracle.py SOURCE.csv AUDIT.csv OUTPUT.json
"""
import csv
import hashlib
import json
import sys
from decimal import Decimal
from pathlib import Path

source, audit, output = map(Path, sys.argv[1:])
def price(value):
    return Decimal(value.replace('.', '').replace(',', '.'))

errors, examples, count, cents_total = 0, [], 0, Decimal(0)
with source.open(encoding='utf-8-sig', newline='') as a, audit.open(encoding='utf-8-sig', newline='') as b:
    left, right = csv.DictReader(a, delimiter=';'), csv.DictReader(b, delimiter=';')
    for count, original in enumerate(left, start=1):
        actual = next(right, None)
        expected = Decimal(original['quantidade']) * price(original['preco_unitario_gbp'])
        cents_total += expected
        wrong = actual is None
        if actual is not None:
            wrong = (
                actual['produto_codigo'] != original['produto_codigo']
                or Decimal(actual['quantidade']) != Decimal(original['quantidade'])
                or abs(Decimal(actual['preco_unitario_gbp']) - price(original['preco_unitario_gbp'])) > Decimal('0.00000001')
                or abs(Decimal(actual['valor_linha']) - expected) > Decimal('0.00000001')
            )
        if wrong:
            errors += 1
            if len(examples) < 5:
                examples.append({'row': count + 1, 'expected': str(expected), 'actual': actual})
    extra = next(right, None)
    if extra is not None:
        errors += 1
result = {'rows': count, 'errors': errors, 'examples': examples, 'sumDecimal': str(cents_total), 'extraRows': extra is not None,
          'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest()}
output.write_text(json.dumps(result, indent=2))
print(json.dumps(result))
assert not errors, f'{errors} rows diverged'
