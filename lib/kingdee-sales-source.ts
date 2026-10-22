import { deflateRawSync } from 'node:zlib';
import { addQuantity, normalizeQuantity } from './decimal';
import { zipTextFiles } from './zip';
import type { XingkongProbe } from './kingdee-xingkong-types';
export type SalesRow = XingkongProbe['rows'][number];
export function salesQuantity(value: unknown): string {
  if (value == null || value === '') return '0';
  if (typeof value !== 'string' || value.length > 256) throw new Error('出库数量类型或长度异常');
  const raw = value.trim();
  if (raw.includes(',') && !/^-?[1-9]\d{0,2}(?:,\d{3})+(?:\.\d+)?$/.test(raw)) throw new Error('出库数量千分位格式异常');
  return normalizeQuantity(raw.replaceAll(',', ''));
}
// Verified against real 2026-10-22 pairs. A product name alone must not discard a business row.
export function classifySalesRow(row: SalesRow): 'business' | 'subtotal' | 'grandTotal' {
  const blank = (field: string) => row[field] == null || row[field] === '';
  const markers = ['FMATERIALID','FMATERIALNAME','FCUSTOMERNAME','FSETTLEORGNAME','FSALEORGNAME'].flatMap(field => {
    const value = row[field]; if (typeof value !== 'string') return [];
    const found = value.trim().match(/(?:[（(](小计|合计|总计|汇总)[）)]\s*$)|^(小计|合计|总计|汇总)$/);
    return found ? [found[1] || found[2]] : [];
  });
  if (markers.length && blank('FCUSTOMERNUMBER') && blank('FISFREE') && ['FSETTLEORGNAME','FCUSTOMERNUMBER','FUNITNAME','FCURRENCYNAME'].filter(blank).length >= 2) return markers.includes('小计') ? 'subtotal' : 'grandTotal';
  return 'business';
}
export function excludedCustomer(row: SalesRow, names: string[]) {
  return names.some(name => typeof row.FCUSTOMERNAME === 'string' && row.FCUSTOMERNAME.toLowerCase().includes(name.toLowerCase()));
}
const escape = (value: string) => value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const column = (index: number): string => index < 26 ? String.fromCharCode(65 + index) : column(Math.floor(index / 26) - 1) + String.fromCharCode(65 + index % 26);
// Runtime source adapter for the existing import pipeline, not an authored replacement for user's Excel.
// Includes every business row before customer exclusion so later rule revisions can be recomputed.
export function salesSourceWorkbook(rows: SalesRow[], columns: { field: string; label: string }[], conditions: string) {
  let total = '0';
  const cell = (at: string, value: unknown) => `<c r="${at}" t="inlineStr"><is><t xml:space="preserve">${escape(value == null ? '' : String(value))}</t></is></c>`;
  const lines = [`<row r="1">${cell('A1', conditions)}</row>`, '<row r="2"></row>', `<row r="3">${columns.map((item,index) => cell(column(index)+'3',item.label)).join('')}</row>`];
  for (const [index,row] of rows.entries()) {
    total = addQuantity(total, salesQuantity(row.FOUTSTOCKQTY));
    lines.push(`<row r="${index+4}">${columns.map((item,col) => cell(column(col)+(index+4),item.field==='FOUTSTOCKQTY' ? row[item.field] == null || row[item.field] === '' ? '' : salesQuantity(row[item.field]) : row[item.field])).join('')}</row>`);
  }
  const end = rows.length+4, qtyCol = column(columns.findIndex(item => item.field === 'FOUTSTOCKQTY'));
  lines.push(`<row r="${end}">${cell('A'+end,'合计')}${cell(qtyCol+end,total)}</row>`);
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  return Buffer.from(zipTextFiles({
    '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml':`<workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="销售完整业务来源" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>',
    'xl/worksheets/sheet1.xml':`<worksheet xmlns="${ns}"><sheetData>${lines.join('')}</sheetData></worksheet>`,
  }, bytes => deflateRawSync(bytes,{level:6})));
}
