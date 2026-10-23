"""Independent OOXML verification; reads source and runtime export without modifying either."""
import json
import re
import zipfile
import xml.etree.ElementTree as E
from decimal import Decimal
from pathlib import Path

root = Path(__file__).resolve().parents[2]
folder = root / 'web-app/.sites-runtime/verification/inheritance-20261023'
batch = json.loads((folder / 'batch.json').read_text(encoding='utf-8'))
ns = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'

def rows(path):
    with zipfile.ZipFile(path) as z:
        strings = []
        if 'xl/sharedStrings.xml' in z.namelist():
            for _, node in E.iterparse(z.open('xl/sharedStrings.xml'), events=['end']):
                if node.tag == ns + 'si':
                    strings.append(''.join(t.text or '' for t in node.iter(ns + 't')))
                    node.clear()
        for _, row in E.iterparse(z.open('xl/worksheets/sheet1.xml'), events=['end']):
            if row.tag != ns + 'row':
                continue
            cells = {}
            for c in row:
                key = re.match(r'[A-Z]+', c.get('r')).group()
                v, f = c.find(ns+'v'), c.find(ns+'f')
                value = None if v is None else v.text
                if c.get('t') == 's': value = strings[int(value)]
                if c.get('t') == 'inlineStr': value = ''.join(t.text or '' for t in c.iter(ns+'t'))
                cells[key] = (value, int(c.get('s','0')), f.text if f is not None else None)
            yield int(row.get('r')), cells
            row.clear()

original = rows(root / '资料/金蝶/目标模板/casebang 存销明细 2026.10.09.xlsx')
current = rows(folder / 'inherited.xlsx')
_, old_head = next(original)
_, new_head = next(current)
assert len(new_head) == 99
assert new_head['C'][0] == '停止采购'
assert new_head['CK'][0] == '10.1-31公司销量'
assert new_head['CN'][0] == '10.23内仓结存'
assert new_head['CR'][0] == '结算价'
columns = [c['key'] for c in batch['template']['columns'][:88] if c['key'] != 'C']
checked, originals, all_rows, formula_checks = 0, 0, 0, 0
old = next(original)
excluded = {'123456','1234560','2020040101'}
numeric_sales = []
for index, cells in current:
    assert cells.get('C',(None,))[0] in (None,'是','否')
    all_rows += 1
    assert index == all_rows + 1, 'new codes must follow original last row without a gap'
    if old is not None and old[1].get('E',(None,))[0]:
        assert index == old[0]
        for col in columns:
            a, b = old[1].get(col,(None,0,None)), cells.get(col,(None,0,None))
            assert a[0] == b[0], f'{col}{index}: original value changed'
            # All explicit source cell styles must retain their original index.
            if col in old[1]: assert a[1] == b[1], f'{col}{index}: source style changed'
            checked += 1
        originals += 1
        old = next(original,None)
    value = lambda col: cells.get(col,(None,))[0]
    num = lambda col: Decimal(value(col) or '0')
    code = value('E')
    assert cells['CM'][2] == f'CK{index}+CL{index}'
    assert num('CM') == num('CK') + num('CL')
    formula_checks += 1
    if code in excluded:
        assert value('CN') is None and value('CO') is None and value('CP') is None
        numeric_sales.append({'code':code,'sales':value('CK')})
    else:
        assert cells['CP'][2] == f'CN{index}+CO{index}'
        assert num('CP') == num('CN') + num('CO')
        formula_checks += 1
    if value('CR') is not None:
        for col, expected, formula in [('CS',num('CP')*num('CR'),f'CP{index}*CR{index}'),('CT',num('CQ')*num('CR'),f'CQ{index}*CR{index}'),('CU',num('CS')+num('CT'),f'CS{index}+CT{index}')]:
            assert num(col) == expected, f'{col}{index}: incorrect amount'
            assert cells[col][2] == formula
            formula_checks += 1
    else:
        assert all(value(c) is None for c in ['CS','CT','CU'])
assert originals == 40578
assert all_rows == batch['summary']['goods']
result = {'status':'passed','originalRows':originals,'historicalCellsAndStyles':checked,'rows':all_rows,'columns':99,'formulaChecks':formula_checks,'numericSalesRetained':numeric_sales}
(folder/'verification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result,ensure_ascii=True))
