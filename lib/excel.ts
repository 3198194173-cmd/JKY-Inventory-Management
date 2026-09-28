import base from "@/data/xlsx-base.json";
import { zipTextFiles } from "./zip";
import { normalizeQuantity } from "./decimal";
import type { InventoryView, StockRow } from "./inventory-types";

const headers=["物料编码","物料名称","库存现有","均值","日期","现有库存周转/天","在途","建议补货库存数量（30天）","单位"];
const escape=(value:string) => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const cell=(address:string,value:string,style:number) => `<c r="${address}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escape(value)}</t></is></c>`;
function numericCell(address:string,value:string,style:number,textStyle:number) {
  const significant=value.replace(/[-.]/g,"").replace(/^0+/,"").replace(/0+$/,"");
  const number=Number(value);
  // Excel stores at most 15 significant digits; preserve larger quantities as text.
  if(significant.length>15 || !Number.isFinite(number) || Math.abs(number)>Number.MAX_SAFE_INTEGER || normalizeQuantity(number)!==value) return cell(address,value,textStyle);
  return `<c r="${address}" s="${style}" t="n"><v>${value}</v></c>`;
}
function replaceData(xml:string,data:string,lastRow:number,lastColumn:string) {
  return xml.replace(/<((?:\w+:)?sheetData)(?:\s[^>]*)?>[\s\S]*?<\/\1>/,`<sheetData xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${data}</sheetData>`).replace(/<((?:\w+:)?dimension)\b[^>]*\/>/,`<$1 ref="A1:${lastColumn}${lastRow}"/>`);
}

export function inventoryWorkbook(view:InventoryView,rows:StockRow[]):Uint8Array {
  const files:Record<string,string>={...base.files};
  let data=`<row r="1" ht="30" customHeight="1">${headers.map((label,i)=>cell(`${String.fromCharCode(65+i)}1`,label,base.styles[`${String.fromCharCode(65+i)}1` as keyof typeof base.styles]||0)).join("")}</row>`;
  rows.forEach((row,index)=>{ const r=index+2; const blanks=["D","E","F","G","H"].map(c=>`<c r="${c}${r}" s="${base.styles[`${c}2` as keyof typeof base.styles] || base.styles.C2}"/>`).join(""); data+=`<row r="${r}" ht="23" customHeight="1">${cell(`A${r}`,row.goodsNo,base.styles.A2)}${cell(`B${r}`,row.goodsName,base.styles.B2)}${numericCell(`C${r}`,row.quantity,base.styles.C2,base.styles.A2)}${blanks}${cell(`I${r}`,row.unitName,base.styles.I2)}</row>`; });
  files["xl/worksheets/sheet1.xml"]=replaceData(files["xl/worksheets/sheet1.xml"],data,rows.length+1,"I");
  const sourceLink="https://open.jackyun.com/developer/refactored/apidocinfo.html?id=erp-stock.stock.skulist&name=true";
  const notes=[
    ["数据性质",view.source === "sample" ? "用户提供的 12 条历史测试样本，非全仓数据；测试应用 22914895。" : "应用 92058521 按指定条码清单采集；逐项核对与分页结束后发布。是否覆盖全仓取决于清单完整性。"],
    ["采集范围",view.snapshot?.scope ? `${view.snapshot.scope.label}，${view.snapshot.scope.count} 个条码。` : "历史测试样本，范围未确认。"],
    ["仓库",`${view.warehouseName}（${view.warehouseCode}）`],
    ["采集日期",view.snapshot?.capturedAt||"未记录"],
    ["原始记录 / 汇总货品",`${view.snapshot?.recordCount||0} 条规格记录 / ${rows.length} 个货品；请求 ${view.snapshot?.pageCount||0} 页。`],
    ["库存口径","库存现有 = orderAbleQuantity（可订购量）；按 goodsNo 合并同单位规格，保留小数、负数与零。"],
    ["单位合计",Object.entries(view.totalsByUnit).map(([u,q])=>`${q} ${u}`).join("；")],
    ["未接入的字段","均值、日期业务列、库存周转、在途、建议补货保持为空；不把缺失数据填成 0。"],
    ["数值精度","数量超过 Excel 的 15 位有效数字限制时存为文本，以保留原始精度。"],
    ["原始来源",view.source === "sample" ? "资料/响应样本/库存查询_原始样本.json" : "吉客云官方 erp-stock.stock.skulist 实时采集"],
    ["接口文档",sourceLink],
  ];
  let noteData=`<row r="1">${cell("A1","采集项目",base.noteStyles.A1)}${cell("B1","说明",base.noteStyles.B1)}</row>`;
  notes.forEach(([label,value],i)=>{const r=i+2;noteData+=`<row r="${r}" ht="24" customHeight="1">${cell(`A${r}`,label,base.noteStyles.A2)}${cell(`B${r}`,value,base.noteStyles.B2)}</row>`;});
  files["xl/worksheets/sheet2.xml"]=replaceData(files["xl/worksheets/sheet2.xml"],noteData,notes.length+1,"B");
  if(files["xl/sharedStrings.xml"]) {
    delete files["xl/sharedStrings.xml"];
    files["[Content_Types].xml"]=files["[Content_Types].xml"].replace(/<(?:\w+:)?Override[^>]*PartName="\/xl\/sharedStrings.xml"[^>]*\/>/,"");
    files["xl/_rels/workbook.xml.rels"]=files["xl/_rels/workbook.xml.rels"].replace(/<(?:\w+:)?Relationship[^>]*Type="[^"]*\/sharedStrings"[^>]*\/>/,"");
  }
  return zipTextFiles(files);
}
