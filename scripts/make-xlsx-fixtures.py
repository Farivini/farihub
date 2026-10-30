"""Builds the XLSX test files in tests/fixtures/xlsx with openpyxl (an XLSX writer independent
from IronCalc) plus one package edited by hand to use Excel's shared formulas.

    python3 scripts/make-xlsx-fixtures.py

Requires openpyxl (3.1.5 used). The files are committed; rerun only to change them. Timestamps
in docProps are fixed so reruns produce the same cell content.
"""
import datetime
import io
import pathlib
import zipfile

from openpyxl import Workbook
from openpyxl.chart import BarChart, Reference
from openpyxl.comments import Comment
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.worksheet.table import Table

OUT = pathlib.Path(__file__).resolve().parent.parent / 'tests' / 'fixtures' / 'xlsx'
FIXED = datetime.datetime(2026, 1, 1)


def finish(wb: Workbook, name: str) -> None:
    wb.properties.created = FIXED
    wb.properties.modified = FIXED
    wb.properties.creator = 'farihub fixtures'
    OUT.mkdir(parents=True, exist_ok=True)
    wb.save(OUT / name)


def basic() -> None:
    """Only what Farcel shows: values, types, formulas, several sheets, bold, alignment, number formats."""
    wb = Workbook()
    ws = wb.active
    ws.title = 'Vendas'
    ws.append(['Região', 'Código', 'Data', 'Quantidade', 'Preço', 'Total', 'Ativo'])
    rows = [
        ('Sudeste', '00123', datetime.date(2024, 3, 15), 3, 19.9, True),
        ('Nordeste', '00456', datetime.date(2024, 12, 1), 10, 2.5, False),
        ('São Paulo – Capital', '07890', datetime.date(2025, 1, 31), 1, 1234.56, True),
    ]
    for i, (region, code, date, qty, price, active) in enumerate(rows, start=2):
        ws.append([region, code, date, qty, price, f'=D{i}*E{i}', active])
    ws['A6'] = 'Total'
    ws['D6'] = '=SUM(D2:D4)'
    ws['F6'] = '=SUM(F2:F4)'
    ws['A7'] = 'Média preço'
    ws['E7'] = '=AVERAGE(E2:E4)'
    ws['A8'] = 'Maior que 10?'
    ws['F8'] = '=IF(F6>10,"sim","não")'
    ws['A9'] = 'Procura'
    ws['F9'] = '=VLOOKUP("Nordeste",A2:F4,6,FALSE)'
    ws['A10'] = 'Texto'
    ws['F10'] = '=CONCATENATE(A2," / ",B2)'
    for cell in ws[1]:
        cell.font = Font(bold=True)
        cell.alignment = Alignment(horizontal='center')
    for row in range(2, 5):
        ws[f'C{row}'].number_format = 'dd/mm/yyyy'
        ws[f'E{row}'].number_format = '"R$" #,##0.00'
        ws[f'F{row}'].number_format = '"R$" #,##0.00'
    ws['F6'].number_format = '"R$" #,##0.00'
    ws['A6'].font = Font(bold=True)
    ws['A6'].alignment = Alignment(horizontal='right')

    other = wb.create_sheet('Resumo Geral')
    other['A1'] = 'Total de vendas'
    other['B1'] = "='Vendas'!F6"
    other['A2'] = 'Participação Sudeste'
    other['B2'] = "=Vendas!F2/Vendas!F6"
    other['B2'].number_format = '0.0%'
    other['A3'] = 'Linhas'
    other['B3'] = '=COUNTA(Vendas!A2:A4)'
    other['A4'] = 'Decimal'
    other['B4'] = 1234.5678
    other['A5'] = 'Negativo'
    other['B5'] = -0.25
    other['A6'] = 'Erro'
    other['B6'] = '=1/0'
    finish(wb, 'openpyxl-basico.xlsx')


def unsupported() -> None:
    """Features IronCalc 0.9.1 does not import (or Farcel does not show) next to plain data."""
    wb = Workbook()
    ws = wb.active
    ws.title = 'Dados'
    ws.append(['Produto', 'Valor'])
    for i, (name, value) in enumerate([('A', 10), ('B', 20), ('C', 30)], start=2):
        ws.append([name, value])
    ws['C1'] = 'Soma'
    ws['C2'] = '=SUM(B2:B4)'
    # Not imported by IronCalc: chart, data validation, autofilter, table definition, comment.
    chart = BarChart()
    chart.add_data(Reference(ws, min_col=2, min_row=1, max_row=4), titles_from_data=True)
    ws.add_chart(chart, 'E2')
    validation = DataValidation(type='list', formula1='"A,B,C"')
    ws.add_data_validation(validation)
    validation.add('A2:A4')
    ws['B2'].comment = Comment('Conferir com o financeiro', 'Ana')
    table_sheet = wb.create_sheet('Tabela')
    table_sheet.append(['Nome', 'Idade'])
    table_sheet.append(['Ana', 30])
    table_sheet.append(['Rui', 41])
    table_sheet.add_table(Table(displayName='Pessoas', ref='A1:B3'))
    filtered = wb.create_sheet('Filtro')
    filtered.append(['Cidade', 'Total'])
    filtered.append(['Recife', 5])
    filtered.auto_filter.ref = 'A1:B2'
    # Kept by IronCalc and written back on export, not displayed by Farcel yet.
    ws['A6'] = 'Mesclado'
    ws.merge_cells('A6:C6')
    ws['A7'] = 'Vermelho'
    ws['A7'].font = Font(color='FFC00000')
    ws['A7'].fill = PatternFill('solid', fgColor='FFFFF2CC')
    ws['A7'].border = Border(bottom=Side(style='thin'))
    ws.column_dimensions['A'].width = 30
    ws.freeze_panes = 'A2'
    finish(wb, 'openpyxl-recursos.xlsx')


def shared_formulas() -> None:
    """Excel writes a column of similar formulas once (t="shared") and references it below.
    openpyxl does not, so the sheet XML is rewritten by hand the way Excel stores it."""
    wb = Workbook()
    ws = wb.active
    ws.title = 'Plan1'
    ws.append(['A', 'B', 'Produto'])
    for i, (a, b) in enumerate([(2, 3), (4, 5), (6, 7)], start=2):
        ws.append([a, b, f'=A{i}*B{i}'])
    buffer = io.BytesIO()
    wb.save(buffer)
    source = zipfile.ZipFile(io.BytesIO(buffer.getvalue()))
    target = OUT / 'excel-formulas-compartilhadas.xlsx'
    OUT.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as out:
        for item in source.infolist():
            data = source.read(item.filename)
            if item.filename == 'xl/worksheets/sheet1.xml':
                xml = data.decode()
                xml = xml.replace('<c r="C2"><f>A2*B2</f><v></v></c>', '<c r="C2"><f t="shared" ref="C2:C4" si="0">A2*B2</f><v>6</v></c>')
                xml = xml.replace('<c r="C3"><f>A3*B3</f><v></v></c>', '<c r="C3"><f t="shared" si="0"/><v>20</v></c>')
                xml = xml.replace('<c r="C4"><f>A4*B4</f><v></v></c>', '<c r="C4"><f t="shared" si="0"/><v>42</v></c>')
                assert xml.count('t="shared"') == 3, xml
                data = xml.encode()
            info = zipfile.ZipInfo(item.filename, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            out.writestr(info, data)


if __name__ == '__main__':
    basic()
    unsupported()
    shared_formulas()
    print('fixtures in', OUT)
