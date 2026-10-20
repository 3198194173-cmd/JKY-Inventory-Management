"""Read-only independent comparison: every cached source cell, A:CN, by original row."""
import json
import re
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[2]
report = json.loads((root / 'web-app/.sites-runtime/tests/kingdee-real-files/report.json').read_text(encoding='utf-8'))
snapshots = {row['legacy']['row']: row['legacy'] for row in report['rows'] if row.get('legacy')}
namespace = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
path = root / '资料/金蝶/目标模板/casebang 存销明细 2026.10.09.xlsx'
columns = [c['key'] for c in report['template']['columns']]
checked = 0
with zipfile.ZipFile(path) as source:
    strings = []
    for _, node in ET.iterparse(source.open('xl/sharedStrings.xml'), events=['end']):
        if node.tag == namespace + 'si':
            strings.append(''.join(t.text or '' for t in node.iter(namespace + 't')))
            node.clear()
    for _, row in ET.iterparse(source.open('xl/worksheets/sheet1.xml'), events=['end']):
        if row.tag != namespace + 'row':
            continue
        index = int(row.get('r'))
        if index in snapshots:
            cells, styles = {}, {}
            for cell in row:
                column = re.match(r'[A-Z]+', cell.get('r')).group()
                value = cell.find(namespace + 'v')
                if value is not None:
                    cells[column] = strings[int(value.text)] if cell.get('t') == 's' else value.text
                elif cell.get('t') == 'inlineStr':
                    cells[column] = ''.join(t.text or '' for t in cell.iter(namespace + 't'))
                styles[column] = int(cell.get('s', '0'))
            snapshot = snapshots[index]
            for i, column in enumerate(columns):
                assert snapshot['values'][i] == cells.get(column), f'{column}{index}: cached value differs'
                if column in styles:
                    assert snapshot['styles'][i] == styles[column], f'{column}{index}: style differs'
                checked += 1
        row.clear()
assert len(snapshots) == 40578
print(json.dumps({'status': 'passed', 'originalRows': len(snapshots), 'cachedCellsCompared': checked, 'columns': len(columns), 'formulasExecuted': False}))
