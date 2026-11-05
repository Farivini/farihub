"""Oráculo independente da coluna calculada (bank_transactions.csv).

Lê o CSV com o leitor `csv` do Python e calcula, linha a linha, o texto que
cada fórmula do roteiro verify-calc.mjs deve gravar, com as regras do Excel:
números com 15 algarismos significativos, texto sem diferença de maiúsculas,
critério vazio do SOMASE valendo 0 (documentação do CONT.SES), PROCV exato
pegando a primeira ocorrência. Compara com o CSV salvo pelo app.

    python3 -I oraculo-coluna-calculada.py original.csv salvo.csv edits.json
"""
import csv
import io
import json
import re
import sys
from decimal import Decimal

PLAIN = re.compile(r"^-?(0|[1-9][0-9]*)(\.[0-9]+)?$")
TEXT_NUMBER = re.compile(r"^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$")


def rows(path):
    data = open(path, "rb").read()
    if data.startswith(b"\xef\xbb\xbf"):
        data = data[3:]
    return list(csv.reader(io.StringIO(data.decode("utf-8"), newline=""), delimiter=","))


def number(text):
    """The grid's value of a number-column field: a number, text, or None."""
    if text == "":
        return None
    if PLAIN.match(text) and len(text.lstrip("-").replace(".", "").lstrip("0")) <= 15:
        return float(text)
    return text


def excel_text(x):
    if x == 0:
        return "0"
    s = repr(float("%.15g" % x))
    if "e" in s or "E" in s:
        s = format(Decimal(s), "f")
    if s.endswith(".0"):
        s = s[:-2]
    return s


def round15(x):
    return float("%.15g" % x) if x != 0 else 0.0


def criteria_key(value):
    if value is None:
        return ("n", 0.0)
    if isinstance(value, float):
        return ("n", round15(value))
    t = value.strip()
    if TEXT_NUMBER.match(t):
        return ("n", round15(float(t)))
    return ("t", value.lower())


def lookup_key(value):
    if value is None:
        return ("e",)
    if isinstance(value, float):
        return ("n", round15(value))
    return ("t", value.lower())


def main():
    original, saved_path, edits = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
    a = rows(original)
    b = rows(saved_path)
    data = [list(r) for r in a]
    for key, value in edits.items():
        r, c = map(int, key.split(":"))
        while len(data[r]) <= c:
            data[r].append("")
        data[r][c] = value
    n = len(data)
    get = lambda r, c: data[r][c] if c < len(data[r]) else ""
    I = [number(get(r, 8)) for r in range(n)]
    F = [number(get(r, 5)) for r in range(n)]
    E = [get(r, 4) or None for r in range(n)]
    B = [get(r, 1) or None for r in range(n)]
    warnings = []
    for r in range(1, n):
        for v in (E[r], B[r]):
            if v and (v[0] in "<>=" or any(ch in v for ch in "*?~")):
                warnings.append([r, v])
    num = lambda v: 0.0 if v is None else v
    # SUMIF(E:E,E2,I:I): sums per key, in row order (the header row counts too)
    sums = {}
    for r in range(n):
        if E[r] is None:
            continue
        k = criteria_key(E[r])
        if isinstance(I[r], float):
            sums[k] = sums.get(k, 0.0) + I[r]
        else:
            sums.setdefault(k, 0.0)
    first = {}
    for r in range(1, n):
        k = lookup_key(B[r])
        first.setdefault(k, r)
    expected = {}
    running = 0.0
    seen = {}
    for r in range(1, n):
        i = I[r]
        cols = {}
        cols[9] = excel_text(num(i) * 0.18) if not isinstance(i, str) else "#VALUE!"
        if isinstance(i, float):
            running += i
        cols[10] = excel_text(running)
        cols[11] = excel_text(sums.get(criteria_key(E[r]), 0.0)) if E[r] is not None else "0"
        if B[r] is None:
            cols[12] = "0"
        else:
            kb = criteria_key(B[r])
            seen[kb] = seen.get(kb, 0) + 1
            cols[12] = str(seen[kb])
        left, right = num(i), num(F[r])
        cols[13] = "acima" if round15(left) > round15(right) else "ok"
        hit = first.get(lookup_key(B[r])) if B[r] is not None else None
        if hit is None:
            cols[14] = "#N/A"
        else:
            v = I[hit]
            cols[14] = "0" if v is None else (excel_text(v) if isinstance(v, float) else v)
        expected[r] = cols
    diffs = []
    fields = 0
    for r in range(max(len(a), len(b))):
        rb = b[r] if r < len(b) else []
        width = max(len(data[r]) if r < n else 0, len(rb), 15)
        for c in range(width):
            got = rb[c] if c < len(rb) else ""
            if c >= 9 and r >= 1 and r < n:
                want = expected[r].get(c, "")
            else:
                want = data[r][c] if r < n and c < len(data[r]) else ""
            fields += 1
            if got != want:
                diffs.append([r, c, want, got])
    print(
        json.dumps(
            {
                "rows_orig": len(a),
                "rows_saved": len(b),
                "fields": fields,
                "diffs": len(diffs),
                "first": diffs[:8],
                "warnings": warnings[:5],
                "sample": {str(r): expected[r] for r in (1, 2, 4, n // 2, n - 1)},
            }
        )
    )


main()
