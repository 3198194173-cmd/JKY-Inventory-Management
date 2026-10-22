import { addQuantity } from './decimal';
import { salesQuantity, sourceWorkbook, type SalesRow } from './kingdee-sales-source';

export const stockSourceColumns = [
  ['物料编码','FMATERIALNUMBER'],['物料名称','FMATERIALNAME'],['仓库名称','FSTOCKNAME'],['货主类型','FOWNERTYPENAME'],['货主','FOWNERNAME'],['库存单位','FSTOCKUNITNAME'],
  ['期初','FSTOCKQCQTY'],['收入','FSTOCKINQTY'],['发出','FSTOCKOUTQTY'],['结存','FSTOCKJCQTY'],['库存周转次数','FINVTURNOVERNUM'],['库存周转天数','FINVTURNOVERDAYS'],
] as const;
const blank=(value:unknown)=>value==null||typeof value==='string'&&!value.trim();
export function stockQuantity(value: unknown): string {
  if(blank(value))throw new Error('库存结存数量缺失，不能自动视为0');
  return salesQuantity(value);
}
export function classifyStockRow(row: SalesRow): 'business'|'subtotal'|'grandTotal' {
  const identity=['FMATERIALID','FSTOCKID'].every(field=>typeof row[field]==='string'&&/^[1-9]\d*$/.test(String(row[field])));
  if(identity&&!blank(row.FMATERIALNUMBER)&&!blank(row.FSTOCKNUMBER))return 'business';
  const markers=['FMATERIALID','FMATERIALNUMBER','FMATERIALNAME','FSTOCKNAME','FSTOCKORGNAME'].flatMap(field=>{
    const value=row[field];if(typeof value!=='string')return [];
    const found=value.trim().match(/(?:[（(](小计|合计|总计|汇总)[）)]\s*$)|^(小计|合计|总计|汇总)$/);return found?[found[1]||found[2]]:[];
  });
  if(markers.length&&(blank(row.FMATERIALNUMBER)||blank(row.FSTOCKNUMBER)||!identity))return markers.includes('小计')?'subtotal':'grandTotal';
  return 'business';
}
export function stockSourceWorkbook(rows: SalesRow[],conditions: string) {
  const escape=(value:unknown)=>String(value??'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const cell=(column:number,line:number,value:unknown)=>`<c r="${String.fromCharCode(65+column)}${line}" t="inlineStr"><is><t xml:space="preserve">${escape(value)}</t></is></c>`;
  const lines=[`<row r="1">${cell(0,1,conditions)}</row>`,'<row r="2"></row>','<row r="3"></row>',`<row r="4">${stockSourceColumns.map(([label],index)=>cell(index,4,label)).join('')}</row>`,`<row r="5">${[6,7,8,9].map(index=>cell(index,5,'数量（库存）')).join('')}</row>`];
  let total='0';
  rows.forEach((row,index)=>{total=addQuantity(total,stockQuantity(row.FSTOCKJCQTY));lines.push(`<row r="${index+6}">${stockSourceColumns.map(([,field],column)=>cell(column,index+6,field==='FSTOCKJCQTY'?stockQuantity(row[field]):row[field])).join('')}</row>`);});
  const end=rows.length+6;lines.push(`<row r="${end}">${cell(0,end,'合计')}${cell(9,end,total)}</row>`);
  return sourceWorkbook(lines,'库存完整业务来源');
}
