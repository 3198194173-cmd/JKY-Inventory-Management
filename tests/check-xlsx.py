import json, zipfile, xml.etree.ElementTree as ET
from decimal import Decimal
from pathlib import Path
file=Path('.sites-runtime/test-output/sample-export.xlsx')
with zipfile.ZipFile(file) as z:
    assert z.testzip() is None
    for name in z.namelist():
        if name.endswith('.xml') or name.endswith('.rels'): ET.fromstring(z.read(name))
    ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    root=ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
    rows=root.findall('./s:sheetData/s:row',ns)
    assert len(rows)==13
    quantities=[]
    for row in rows[1:]:
        cells={c.get('r'):c for c in row.findall('s:c',ns)}
        number=row.get('r')
        for col in 'DEFGH':
            cell = cells[col+number]
            assert cell.get('s') is not None
            assert cell.find('s:v',ns) is None and cell.find('s:is',ns) is None
        quantities.append(Decimal(cells['C'+number].find('s:v',ns).text))
    assert sum(quantities)==Decimal('1')
    assert 'sharedStrings.xml' not in z.read('xl/_rels/workbook.xml.rels').decode()
print(json.dumps({'xlsx':'valid ZIP/XML','goods':12,'totalPcs':'1','unavailableColumns':'blank'},ensure_ascii=False))
