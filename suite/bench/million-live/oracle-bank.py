"""Read-only, independent streaming oracle for the supplied bank CSV.
The x2 column is a technical workload, not a business/financial interpretation.
Usage: oracle-bank.py SOURCE.csv AUDIT.csv OUTPUT.json
"""
import csv
import hashlib
import json
import sys
from decimal import Decimal
from pathlib import Path

source, audit, output = map(Path, sys.argv[1:])
numeric = {'CustAccountBalance', 'TransactionAmount (INR)'}
errors = count = cells = 0
source_blanks = {c: 0 for c in numeric}
blank_mismatches = 0
columns_with_errors = {}
with source.open(encoding='utf-8-sig', newline='') as left, audit.open(encoding='utf-8-sig', newline='') as right:
    src = csv.DictReader(left)
    result = csv.DictReader(right, delimiter=';')
    for count, expected in enumerate(src, start=1):
        actual = next(result, None)
        if actual is None:
            errors += 1
            continue
        wrong = False
        for key, value in expected.items():
            cells += 1
            got = actual.get(key)
            if key in numeric and value != '':
                different = got in ('', None) or abs(Decimal(got) - Decimal(value)) > Decimal('0.00000001')
            else:
                different = got != value
                if key in numeric and value == '':
                    source_blanks[key] += 1
                    blank_mismatches += different
            if different:
                wrong = True
                columns_with_errors[key] = columns_with_errors.get(key, 0) + 1
        amount = expected['TransactionAmount (INR)']
        got = actual.get('ensaio_valor_x2')
        different = (got != '') if amount == '' else (got in ('', None) or abs(Decimal(got) - Decimal(amount) * 2) > Decimal('0.00000001'))
        if different:
            wrong = True
            columns_with_errors['ensaio_valor_x2'] = columns_with_errors.get('ensaio_valor_x2', 0) + 1
        cells += 1
        if wrong:
            errors += 1
    extra = next(result, None) is not None
result = {'rows': count, 'rowsWithErrors': errors, 'cellsChecked': cells,
          'columnsWithErrors': columns_with_errors, 'extraRows': extra,
          'sourceNumericBlanks': source_blanks, 'numericBlankMismatches': blank_mismatches,
          'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest()}
output.write_text(json.dumps(result, indent=2))
print(json.dumps(result))
assert errors == 0 and not extra and blank_mismatches == 0
