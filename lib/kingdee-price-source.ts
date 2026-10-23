import { flatSourceWorkbook } from './kingdee-goods-source';
import { normalizeQuantity } from './decimal';

// Real field identifiers must come from this tenant's BOS metadata. There is no
// fallback to guessed fields or any write/delete operation.
export const priceKeys = ['id','entryId','number','organizationCode','organizationName','materialCode','materialName','price','currency','taxIncluded','priceObject','documentStatus','disabled','unit','effectiveDate','expiryDate'] as const;
export type PriceKey = typeof priceKeys[number];
export type PriceSchema = { fields: Record<PriceKey,string>; values: { taxIncluded: string; byMaterial: string; approved: string; disabledNo: string } };
export function readPriceSchema(raw = process.env.KINGDEE_PRICE_SCHEMA || ''): PriceSchema {
  if (!raw) throw new Error('销售价目表完整字段尚未核验：已确认编号、物料编码、物料名称、价格，仍需核验组织、失效状态及分录等字段并配置KINGDEE_PRICE_SCHEMA；请暂用Excel来源。');
  let schema: PriceSchema;
  try { schema=JSON.parse(raw) as PriceSchema; } catch { throw new Error('价目表字段配置不是有效JSON'); }
  if (!schema?.fields || priceKeys.some(key=>typeof schema.fields[key]!=='string'||!/^F[\w.]{0,150}$/.test(schema.fields[key])) || new Set(Object.values(schema.fields)).size!==priceKeys.length) throw new Error('价目表字段映射不完整或重复');
  if (!schema.values || ['taxIncluded','byMaterial','approved','disabledNo'].some(key=>typeof schema.values[key as keyof typeof schema.values]!=='string'||schema.values[key as keyof typeof schema.values].length>100)) throw new Error('价目表枚举值映射不完整');
  return schema;
}
export type PriceRow = Record<PriceKey,string|null>;
export function priceRequest(schema:PriceSchema,orgId:string,number:string,start:number,limit:number) {
  return {FormId:'BD_SAL_PriceList',FieldKeys:priceKeys.map(key=>schema.fields[key]).join(','),
    FilterString:[{FieldName:schema.fields.organizationCode,Compare:'67',Value:orgId,Left:'',Right:'',Logic:0},{FieldName:schema.fields.number,Compare:'67',Value:number,Left:'',Right:'',Logic:0}],
    OrderString:`${schema.fields.id} ASC,${schema.fields.entryId} ASC`,TopRowCount:0,StartRow:start,Limit:Math.min(limit,2000),SubSystemId:''};
}
export function mapPriceRows(raw:unknown,schema:PriceSchema,org:string,number:string):PriceRow[] {
  if(!Array.isArray(raw)||raw.length>2000)throw new Error('价目表响应不是有效分页数组');
  return raw.map(value=>{
    let cells:unknown[];
    if(Array.isArray(value)){if(value.length!==priceKeys.length)throw new Error('价目表返回列数与FieldKeys不一致');cells=value;}
    else if(value&&typeof value==='object'){
      const entries=Object.entries(value),keys=new Map(entries.map(([k,v])=>[k.toLowerCase(),v]));
      if(!priceKeys.every(key=>keys.has(schema.fields[key].toLowerCase())))throw new Error('价目表返回缺少已配置字段，请核验当前账套字段标识');
      cells=priceKeys.map(key=>keys.get(schema.fields[key].toLowerCase()));
    }else throw new Error('价目表返回行格式异常');
    if(cells.some(cell=>cell!=null&&typeof cell!=='string'&&typeof cell!=='boolean'&&typeof cell!=='number'))throw new Error('价目表单元格包含未知结构');
    const row=Object.fromEntries(priceKeys.map((key,i)=>[key,cells[i]==null?null:String(cells[i])])) as PriceRow;
    if(!/^\d+$/.test(row.id||'')||!/^\d+$/.test(row.entryId||'')||!row.materialCode?.trim()||row.organizationCode!==org||row.number!==number)throw new Error('价目表返回内码、物料、组织或编号不符合请求，未发布');
    if(row.price==null||row.price==='')throw new Error('价目表价格字段为空，需核验字段映射');
    normalizeQuantity(row.price);
    return row;
  });
}
export function priceSourceWorkbook(rows:PriceRow[],schema:PriceSchema) {
  return flatSourceWorkbook(['物料编码','物料名称','价格','编号','币别','含税','价目对象','整单状态','销售组织','失效','单位','生效日期','失效日期','单据内码','分录内码'], rows.map(row=>[
    row.materialCode,row.materialName,row.price,row.number,row.currency,row.taxIncluded===schema.values.taxIncluded?'是':row.taxIncluded,
    row.priceObject===schema.values.byMaterial?'按物料':row.priceObject,row.documentStatus===schema.values.approved?'已审核':row.documentStatus,
    row.organizationName,row.disabled===schema.values.disabledNo?'否':row.disabled,row.unit,row.effectiveDate,row.expiryDate,row.id,row.entryId,
  ]),'价目表完整来源');
}
