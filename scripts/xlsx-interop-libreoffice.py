"""Opens .xlsx files exported by Farcel in LibreOffice Calc (headless, through UNO), makes it
recalculate every formula, and compares each result with the value Farcel wrote in the file.

    node scripts/xlsx-interop.ts
    python3 scripts/xlsx-interop-libreoffice.py reports/interop/*.xlsx

Writes reports/interop-libreoffice.json. Requires LibreOffice with Python UNO (python3-uno).
A formula LibreOffice cannot read shows up as a mismatch (its result becomes Err:5xx or #NAME?).
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import zipfile
from html import unescape

import uno
from com.sun.star.beans import PropertyValue

CELL = re.compile(r'<c r="([A-Z]+)(\d+)"([^>]*)>(.*?)</c>', re.S)


def cached_formulas(path):
    """Formula cells per sheet name: cell -> (formula, cached value, type) as written by Farcel."""
    z = zipfile.ZipFile(path)
    workbook = z.read('xl/workbook.xml').decode()
    rels = z.read('xl/_rels/workbook.xml.rels').decode()
    targets = {}
    for element in re.findall(r'<Relationship [^>]*>', rels):
        targets[re.search(r'Id="([^"]+)"', element).group(1)] = re.search(r'Target="([^"]+)"', element).group(1)
    sheets = {}
    for name, rid in re.findall(r'<sheet name="([^"]+)"[^>]*r:id="([^"]+)"', workbook):
        target = targets[rid].lstrip('/')
        part = target if target.startswith('xl/') else 'xl/' + target
        xml = z.read(part).decode()
        cells = {}
        for col, row, attrs, body in CELL.findall(xml):
            f = re.search(r'<f(?: [^>]*)?>(.*?)</f>', body, re.S)
            if not f:
                continue
            v = re.search(r'<v>(.*?)</v>', body, re.S)
            kind = re.search(r't="(\w+)"', attrs)
            cells[f'{col}{row}'] = (unescape(f.group(1)), unescape(v.group(1)) if v else '', kind.group(1) if kind else 'n')
        sheets[unescape(name)] = cells
    return sheets


def connect():
    profile = tempfile.mkdtemp(prefix='lo-profile-')
    process = subprocess.Popen(['soffice', '--headless', '--invisible', '--nologo', '--norestore',
                                f'-env:UserInstallation=file://{profile}',
                                '--accept=socket,host=127.0.0.1,port=2002;urp;'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver', local)
    for _ in range(60):
        try:
            context = resolver.resolve('uno:socket,host=127.0.0.1,port=2002;urp;StarOffice.ComponentContext')
            desktop = context.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop', context)
            return process, desktop
        except Exception:
            time.sleep(0.5)
    raise RuntimeError('LibreOffice did not start')


def prop(name, value):
    p = PropertyValue()
    p.Name, p.Value = name, value
    return p


def same(cached, kind, cell):
    error = cell.getError()
    if kind == 'e':
        return error != 0 or cell.getString().startswith('#'), cell.getString() or f'Err:{error}'
    if error:
        return False, f'Err:{error}'
    if kind in ('str', 's'):
        return cell.getString() == cached, cell.getString()
    if kind == 'b':
        return float(cell.getValue()) == float(cached), cell.getValue()
    value = cell.getValue()
    expected = float(cached)
    return abs(value - expected) <= 1e-9 * max(1.0, abs(expected)), value


def main(paths):
    version = subprocess.run(['soffice', '--version'], capture_output=True, text=True).stdout.strip()
    process, desktop = connect()
    results = []
    try:
        for path in paths:
            doc = desktop.loadComponentFromURL(uno.systemPathToFileUrl(os.path.abspath(path)), '_blank', 0, (prop('Hidden', True),))
            doc.calculateAll()
            checked = 0
            mismatches = []
            for sheet_name, cells in cached_formulas(path).items():
                sheet = doc.Sheets.getByName(sheet_name)
                for ref, (formula, cached, kind) in cells.items():
                    cell = sheet.getCellRangeByName(ref)
                    ok, got = same(cached, kind, cell)
                    checked += 1
                    if not ok or not cell.getFormula():
                        mismatches.append({'sheet': sheet_name, 'cell': ref, 'formula': formula, 'farcel': cached, 'libreoffice': got, 'libreofficeFormula': cell.getFormula()})
            doc.close(True)
            results.append({'file': os.path.basename(path), 'formulas': checked, 'mismatches': mismatches})
            print(f"{os.path.basename(path)}: {checked} fórmulas recalculadas, {len(mismatches)} divergências")
            for m in mismatches:
                print('   ', m)
    finally:
        try:
            desktop.terminate()
        except Exception:
            pass
        process.wait(timeout=30)
    report = {'application': version, 'generatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'files': results}
    os.makedirs('reports', exist_ok=True)
    with open('reports/interop-libreoffice.json', 'w') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    return 1 if any(r['mismatches'] for r in results) else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
