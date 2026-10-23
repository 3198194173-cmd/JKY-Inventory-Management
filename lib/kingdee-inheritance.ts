import { currentFields } from './kingdee-sheet';
import type { KingdeeGoods, KingdeePeriod, KingdeeReport, KingdeeTemplate } from './kingdee-types';

export function validatePeriod(value: unknown): KingdeePeriod {
  const p = value as Partial<KingdeePeriod> | null;
  const validDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10) === s;
  if (!p || !validDate(p.start) || !validDate(p.end) || !validDate(p.stockDate) || p.start > p.end) throw new Error('请填写有效的销量起止日期和库存列标注日期');
  return { start:p.start, end:p.end, stockDate:p.stockDate, id:`${p.start}_${p.end}_${p.stockDate}` };
}

// Original rows and historical cells are never reconstructed from a business-code union.
// A previous published sheet also contributes its new rows and completed period blocks.
export function inheritKingdeeReport(report: KingdeeReport, period: KingdeePeriod, base?: { rows: KingdeeGoods[]; template: KingdeeTemplate }) {
  if (!report.template || !report.rows.some(row => row.legacy)) throw new Error('请先上传或选择原明细底表，再追加本批数据');
  const periods = base?.template.periods || [];
  const latest = periods.at(-1);
  const samePeriod = latest?.id === period.id;
  if (!samePeriod && periods.some(p => p.id === period.id)) throw new Error('该期间已在历史列中；请选择对应批次重算，避免覆盖中间历史');
  const oldByCode = new Map(base?.rows.map(row => [row.code,row]));
  const currentByCode = new Map(report.rows.map(row => [row.code,row]));
  // Retain appended codes even when absent from every new source.
  for (const old of base?.rows || []) if (!currentByCode.has(old.code)) {
    const row: KingdeeGoods = { ...old, sources: {}, companySales:null,storeSales:null,combinedSales:'0',inner:null,outer:null,companyStock:old.inventoryExcluded?null:'0',storeStock:null,price:null,priceStatus:'missing',companyAmount:null,storeAmount:null,totalAmount:null,stopPurchasing:null,purchaseStatus:'missing' };
    report.rows.push(row); currentByCode.set(row.code,row);
  }
  let nextRow = Math.max(report.rows.reduce((n,row)=>Math.max(n,row.legacy?.row || 1),1),(base?.rows || []).reduce((n,row)=>Math.max(n,row.sheetRow || row.legacy?.row || 1),1)) + 1;
  for (const row of report.rows) {
    const old = oldByCode.get(row.code);
    row.sheetRow = old?.sheetRow ?? row.legacy?.row ?? nextRow++;
    if (old) {
      row.legacy = old.legacy;
      row.category = old.category; row.model = old.model; row.pod = old.pod; row.ip = old.ip;
      row.name = old.name;
      row.periodValues = { ...old.periodValues };
      if (latest && !samePeriod) row.periodValues[latest.id] = currentFields.slice(0,7).map(field=>old[field]);
    }
  }
  report.rows.sort((a,b)=>a.sheetRow! - b.sheetRow!);
  report.template.purchaseColumn=true;
  report.template.periods = samePeriod ? [...periods] : [...periods,period];
  report.summary.goods = report.rows.length;
  report.summary.priced = report.rows.filter(row=>row.priceStatus==='ready').length;
  report.summary.missingPrices = report.rows.filter(row=>row.priceStatus==='missing').length;
  report.summary.pendingClassifications = report.rows.filter(row=>[row.category,row.model,row.ip].some(v=>v===null)).length;
  report.summary.notices.push(`本批销量期间${period.start}至${period.end}；库存列标注${period.stockDate}。列标注不会改变原始来源日期，请以各来源条件为准。`, samePeriod?'相同销量期间和库存标注日期：更新末尾七列，旧批次仍可查看。':'在已保存明细末尾追加七列，已有历史列和原行号保留。');
}
