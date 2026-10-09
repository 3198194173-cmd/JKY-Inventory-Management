import base from "@/data/xlsx-base.json";
import { zipTextFiles } from "./zip";
import { normalizeQuantity } from "./decimal";
import type { InventoryView, StockRow } from "./inventory-types";
import type { InboundReconciliation } from "./inbound";
import type { InventoryMetrics } from "./inventory-metrics";
import { recentSalesDates } from "./inventory-metrics";

const headers=["物料编码","物料名称","库存现有","近7天销量均值（估算）","均值日期范围","库存周转（天·估算）","在途","建议补货库存数量（30天）"];
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

export function inventoryWorkbook(view:InventoryView,rows:(StockRow & {metrics?: InventoryMetrics; inbound?: Record<string, InboundReconciliation>; currentInbound?: InboundReconciliation})[]):Uint8Array {
  const files:Record<string,string>={...base.files};
  let data=`<row r="1" ht="30" customHeight="1">${headers.map((label,i)=>cell(`${String.fromCharCode(65+i)}1`,label,base.styles[`${String.fromCharCode(65+i)}1` as keyof typeof base.styles]||0)).join("")}</row>`;
  const dates = view.snapshot ? recentSalesDates(view.snapshot.date) : [];
  rows.forEach((row,index)=>{ const r=index+2;
    const metricCell = (column:"D"|"F"|"G"|"H",value:string|null|undefined) => value == null ? `<c r="${column}${r}" s="${base.styles[`${column}2` as keyof typeof base.styles] || base.styles.C2}"/>` : numericCell(`${column}${r}`,value,base.styles.C2,base.styles.A2);
    const blanks=metricCell("G",row.transit?.quantity)+metricCell("H",row.transit?.replenishment);
    data+=`<row r="${r}" ht="23" customHeight="1">${cell(`A${r}`,row.goodsNo,base.styles.A2)}${cell(`B${r}`,row.goodsName,base.styles.B2)}${numericCell(`C${r}`,row.quantity,base.styles.C2,base.styles.A2)}${metricCell("D",row.metrics?.average7)}${cell(`E${r}`,dates.length ? `${dates[6]} ~ ${dates[0]}` : "",base.styles.A2)}${metricCell("F",row.metrics?.turnoverDays)}${blanks}</row>`;
  });
  for(const [i,g] of (view.transitOnly||[]).entries()){const r=rows.length+i+2;data+=`<row r="${r}">${cell(`A${r}`,g.goodsNo,base.styles.A2)}${cell(`B${r}`,g.goodsName,base.styles.B2)}${numericCell(`G${r}`,g.quantity,base.styles.C2,base.styles.A2)}</row>`;}
  files["xl/worksheets/sheet1.xml"]=replaceData(files["xl/worksheets/sheet1.xml"],data,rows.length+(view.transitOnly?.length||0)+1,"H");
  const sourceLink="https://open.jackyun.com/developer/refactored/apidocinfo.html?id=erp-stock.stock.skulist&name=true";
  const notes=[
    ["数据性质",view.source === "sample" ? "用户提供的 12 条历史测试样本，非全仓数据；测试应用 22914895。" : "erp.stockquantity.get 游标取得仓库 SKU，erp-stock.stock.skulist 按条码或货品编码查询并核验可购数量。仅统计规格齐全的已核验货品；未返回可购库存的组合编码跳过；其他未取得库存的记录另列，不填零。"],
    ["自动 SKU 清单",view.snapshot?.scope ? `${view.snapshot.scope.label}，${view.snapshot.scope.count} 个 SKU。` : "历史测试样本，范围未确认。"],
    ["未取得库存的 SKU",`${view.unavailableSkus?.length || 0} 个；不计入库存或销售差额，含缺失规格的货品不展示部分合计。`],
    ["仓库",`${view.warehouseName}（${view.warehouseCode}）`],
    ["采集日期",view.snapshot?.capturedAt||"未记录"],
    ["原始记录 / 汇总货品",`${view.snapshot?.recordCount||0} 条规格记录 / ${rows.length} 个货品；请求 ${view.snapshot?.pageCount||0} 页。`],
    ["库存口径","库存现有 = orderAbleQuantity（可订购量）；按 goodsNo 合并同单位规格，保留小数、负数与零。"],
    ["网页销售口径","上次每日基准库存 + 两次采集区间内入库 − 本次每日基准库存，记在上次基准日期；按仓库和采集区间分页获取全部入库（含归档），按货品编码汇总；负销量按退货/回补计入净销量；未完成入库核验的日期不算销量。"],
    ["单位合计",Object.entries(view.totalsByUnit).map(([u,q])=>`${q} ${u}`).join("；")],
    ["近7天销量均值","固定为最近采集日期之前7个完整日期的净销量总和÷7，包含负值退货/回补；缺日、缺货品、单位变化或入库未核验不计算。不随网页日期范围改变。"],
    ["库存周转","当前库存÷近7天未四舍五入的均值；结果保留2位小数。均值为零或负数、数据不足或待核验入库时为空。负库存保留负周转。此值为预计库存可支撑天数。"],
    ["指标性质","均值和周转为库存消耗估算；全部可比较日期已核验区间实际入库。销售出库、退货、调拨及可订购量变动仍可能影响结果，不等同准确订单销量或销售金额。"],
    ["在途与补货","在途仅统计调拨入库（inType=102），取已核验申请单剩余数量；部分入库保留剩余，完成/关闭单不计。仅（库存+在途）÷未舍入销售均值<30天时，补货=（库存+在途）÷该均值×30，最低0，四舍五入为整数；达到30天为0；未核验或均值无效留空。只有在途、未取得库存的商品保留行，库存和补货留空。"],
    ["在途采集状态",`${view.transitStatus?.status||"未接入"} · ${view.transitStatus?.checkedAt||""} · ${view.transitStatus?.error||""}`],
    ["数值精度","数量超过 Excel 的 15 位有效数字限制时存为文本，以保留原始精度。"],
    ["原始来源",view.source === "sample" ? "资料/响应样本/库存查询_原始样本.json" : "吉客云官方 erp-stock.stock.skulist 实时采集"],
    ["接口文档",sourceLink],
  ];
  for (const [index,row] of (view.unavailableSkus || []).entries()) notes.push([`未取得库存 ${index + 1}`,`${row.goodsNo} | ${row.goodsName} | SKU ${row.skuId} | ${row.skuBarcode || "无条码"} | ${row.reason}`]);
  for (const row of rows) {
    const items = [...Object.values(row.inbound || {}), ...(row.currentInbound ? [row.currentInbound] : [])];
    for (const item of items) {
      notes.push([`入库核验 ${row.goodsNo} ${item.date}`, `${item.windowStart} ~ ${item.windowEnd} | 原始差额 ${item.rawDifference} | 入库 ${item.inboundQuantity ?? '未取得'} | 修正 ${item.status === 'verified' ? item.correctedQuantity : '待核验'} | ${item.error || item.status}`]);
      for (const record of item.records) notes.push([`入库单 ${record.documentNo}`, `${row.goodsNo} | ${record.typeName} | ${record.quantity} ${record.unitName} | ${record.inOutDate} | 明细 ${record.recId}`]);
    }
  }
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

// Immutable card export: use the same rows and seven dates that were delivered.
export function alertWorkbook(card: import("./dingtalk-card-data").TurnoverCard): Uint8Array {
  const labels=["商品编码","商品名称","库存","销售均值","库存周转（天）",...card.dates];
  const column=(i:number)=>String.fromCharCode(65+i);
  let rows=`<row r="1" ht="26" customHeight="1">${labels.map((label,i)=>cell(`${column(i)}1`,label,1)).join("")}</row>`;
  card.rows.forEach((row,index)=>{
    const r=index+2,values=[row.quantity,row.average,row.turnover,...row.sales];
    rows+=`<row r="${r}" ht="44" customHeight="1">${cell(`A${r}`,row.goodsNo,3)}${cell(`B${r}`,row.goodsName,3)}${values.map((v,i)=>v==null||v==="—"?cell(`${column(i+2)}${r}`,"",3):numericCell(`${column(i+2)}${r}`,v,2,3)).join("")}</row>`;
  });
  const ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const metadata=[["报告",card.title],["采集与仓库",card.summary],["商品数",String(card.rows.length)],["规则与口径",card.footer],["日期范围",`${card.dates[0]} ~ ${card.dates.at(-1)}`],["说明","数据固定于报告生成时，已应用发送名称排除；缺失销量留空。"]];
  return zipTextFiles({
    "[Content_Types].xml":`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    "_rels/.rels":`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml":`<workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="预警明细" sheetId="1" r:id="rId1"/><sheet name="报告说明" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels":`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml":`<styleSheet xmlns="${ns}"><fonts count="2"><font><sz val="11"/><name val="等线"/></font><font><b/><sz val="11"/><color rgb="FF334155"/><name val="等线"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF0F4FC"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" applyAlignment="1"><alignment vertical="center" horizontal="right"/></xf><xf numFmtId="49" fontId="0" fillId="0" borderId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    "xl/worksheets/sheet1.xml":`<worksheet xmlns="${ns}"><dimension ref="A1:L${card.rows.length+1}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="25" customWidth="1"/><col min="2" max="2" width="62" customWidth="1"/><col min="3" max="12" width="15" customWidth="1"/></cols><sheetData>${rows}</sheetData><autoFilter ref="A1:L${card.rows.length+1}"/></worksheet>`,
    "xl/worksheets/sheet2.xml":`<worksheet xmlns="${ns}"><cols><col min="1" max="1" width="22" customWidth="1"/><col min="2" max="2" width="100" customWidth="1"/></cols><sheetData>${metadata.map(([label,value],i)=>`<row r="${i+1}" ht="35" customHeight="1">${cell(`A${i+1}`,label,1)}${cell(`B${i+1}`,value,3)}</row>`).join("")}</sheetData></worksheet>`
  });
}
