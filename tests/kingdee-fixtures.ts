import { zipTextFiles } from '../lib/zip';
export function xlsx(rows: Record<string, string>[], sheet = 'Sheet1') {
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return Buffer.from(zipTextFiles({
    'xl/workbook.xml': `<workbook><sheets><sheet name="${sheet}" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${rows.map((row, index) => `<row r="${index + 1}">${Object.entries(row).map(([key, value]) => `<c r="${key}${index + 1}" t="inlineStr"><is><t>${escape(value)}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`,
  }));
}
export const headers = { A: '物料编码', B: '物料名称' };
export const fixture = {
  companySales: xlsx([{}, {}, { ...headers, C: '出库数量', D: '客户名称', E: '是否赠品' }, { A: 'A', B: '商品甲', C: '5', E: '是' }, { A: 'A', B: '商品甲', C: '-1', E: '否' }, { A: 'B', B: '商品乙', C: '0' }, { A: '合计', C: '4' }]),
  companyStock: xlsx([{}, {}, {}, { ...headers, C: '仓库名称', J: '结存' }, { J: '数量' }, { A: 'A', B: '商品甲', C: '内仓', J: '2' }, { A: 'A', B: '商品甲', C: '外仓', J: '3' }, { A: 'A', B: '商品甲', C: '名单外仓', J: '100' }, { A: 'B', B: '商品乙', C: '内仓', J: '10' }, { A: '合计', J: '115' }]),
  storeSales: xlsx([{}, {}, { A: '商品编码', B: '商品名称', C: '基本数量' }, { A: 'A', B: '商品甲', C: '2' }, { A: 'A', B: '商品甲', C: '-1' }, { A: 'B', B: '商品乙', C: '0' }, { A: '合计', C: '1' }]),
  storeStock: xlsx([{}, {}, { A: '商品编码', B: '商品名称', C: '即时库存（基本）' }, { A: 'A', B: '商品甲', C: '7' }, { A: 'B', B: '商品乙', C: '0' }, { A: '合计', C: '7' }]),
  prices: xlsx([{ A: '物料编码', B: '价格', C: '编号', D: '币别', E: '含税', F: '价目对象', G: '整单状态', H: '销售组织' }, ...['A', 'B'].map(code => ({ A: code, B: code === 'A' ? '2.5' : '0', C: 'P1', D: '人民币', E: '是', F: '按物料', G: '已审核', H: 'CASEBANG事业部' }))]),
};
