"""Independent ZIP/XML read-back of the actual HTTP-generated 92-column workbook."""
import json
import xml.etree.ElementTree as ET
import zipfile
from decimal import Decimal
from pathlib import Path

folder = Path(__file__).resolve().parents[1]
report = json.loads((folder / '.sites-runtime/tests/kingdee-real-files/report.json').read_text(encoding='utf-8'))
expected = {row['code']: row for row in report['rows']}
ns = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
output = folder / 'outputs/kingdee-prototype-20261020'
path = output / '金蝶存销明细_雏形.xlsx'
keys = ['companySales', 'storeSales', 'combinedSales', 'inner', 'outer', 'companyStock', 'storeStock', 'price', 'companyAmount', 'storeAmount', 'totalAmount']
columns = [c['key'] for c in report['template']['columns']]
totals = {key: Decimal(0) for key in ['companySales', 'storeSales', 'inner', 'outer', 'companyStock', 'storeStock']}
count = checked = 0
seen = set()
with zipfile.ZipFile(path) as source:
    assert source.testzip() is None
    for name in source.namelist():
        if name != 'xl/worksheets/sheet1.xml':
            ET.fromstring(source.read(name))
    for _, node in ET.iterparse(source.open('xl/worksheets/sheet1.xml'), events=['end']):
        if node.tag == ns + 'pane':
            assert node.get('xSplit') == '6' and node.get('ySplit') == '1'
        if node.tag == ns + 'autoFilter':
            assert node.get('ref') == 'A1:CN43928'
        assert node.tag != ns + 'f', 'Unexpected executable formula'
        if node.tag != ns + 'row':
            continue
        cells = {}
        for cell in node:
            col = ''.join(c for c in cell.get('r') if c.isalpha())
            value, text = cell.find(ns + 'v'), cell.find(ns + 'is/' + ns + 't')
            cells[col] = value.text if value is not None else text.text if text is not None else None
        assert len(cells) == 92
        if node.get('r') == '1':
            assert cells['CD'] == '本批公司销量' and cells['CI'] == '本批公司结存'
        else:
            code = cells['E'].strip()
            assert code not in seen
            seen.add(code)
            original = expected[code]
            for index, column in enumerate(columns):
                if index >= 81:
                    value = original[keys[index - 81]]
                elif original.get('legacy'):
                    value = original['legacy']['values'][index]
                else:
                    value = original[['category', 'model', 'pod', 'ip', 'code', 'name'][index]] if index < 6 else None
                assert cells[column] == value, f'{code}: {column} differs'
                checked += 1
            for i, key in enumerate(keys):
                if key in totals:
                    totals[key] += Decimal(cells[columns[81 + i]] or '0')
            count += 1
        node.clear()
assert count == len(expected) == 43927
assert totals['companyStock'] == Decimal('1369275')
result = {'status': 'passed', 'rows': count, 'columns': 92, 'allCellsCompared': checked, 'totals': {k: str(v) for k, v in totals.items()}, 'frozenColumns': 6, 'frozenRows': 1}
(output / 'export-check.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result))
