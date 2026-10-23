import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AccessError } from './accounts';
import { parseLosslessJson } from './lossless-json';
import { xingkongBaseUrl, type XingkongKind, type XingkongOrganization, type XingkongProbe, type XingkongSettings } from './kingdee-xingkong-types';
import { classifySalesRow, excludedCustomer, type SalesRow } from './kingdee-sales-source';
import { mapPriceRows, priceKeys, priceRequest, readPriceSchema } from './kingdee-price-source';

// Ported from 金蝶/scripts/kingdee-report.mjs and kingdee-stock-report.mjs.
// The destination and four read-only service paths cannot be supplied by a browser.
const services = {
  login: 'Kingdee.BOS.WebApi.ServicesStub.AuthService.ValidateUser.common.kdsvc',
  organizations: 'Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.ExecuteBillQuery.common.kdsvc',
  prices: 'Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.BillQuery.common.kdsvc',
  sales: 'Kingdee.BOS.WebApi.ServicesStub.DynamicFormService.GetSysReportData.common.kdsvc',
  stock: 'Kingdee.K3.SCM.WebApi.ServicesStub.StockReportQueryService.GetReportData,Kingdee.K3.SCM.WebApi.ServicesStub.common.kdsvc',
} as const;
export const salesColumns = [
  ['结算组织','FSETTLEORGNAME'], ['销售组织','FSALEORGNAME'], ['客户编码','FCUSTOMERNUMBER'], ['客户名称','FCUSTOMERNAME'],
  ['物料编码','FMATERIALNUMBER'], ['物料名称','FMATERIALNAME'], ['物料分组','FMATERIALGROUP'], ['物料属性','FERPCLSID'],
  ['存货类别','FCATEGORYID'], ['产品系列','F_ora_BaseProperty1'], ['产品类别','F_ora_BaseProperty2'], ['批号','FLot'],
  ['规格型号','FMATERIALMODEL'], ['单位','FUNITNAME'], ['币别','FCURRENCYNAME'], ['辅助属性','FMATERIALAUXID'],
  ['出库数量','FOUTSTOCKQTY'], ['出库含税单价','FOUTSTOCKPRICE_TAX'], ['出库价税合计','FOUTSTOCKAMOUNT_TAX'],
  ['出库成本','FOUTSTOCKCOST'], ['出库总成本','FOUTSTOCKTOTALCOST'], ['应收数量','FRECQTY'], ['应收价税合计','FRECAMOUNT_TAX'],
  ['差异数量','FDIFFQTY'], ['差异价税合计','FDIFFAMOUNT_TAX'], ['计价单位','FSALEPRICEUNITID'],
  ['出库数量（计价单位）','FOUTSTOCKQTY_PRICE'], ['差异数量（计价单位）','FDIFFQTY_PRICE'], ['应收数量（计价单位）','FRECQTY_PRICE'],
  ['是否赠品','FISFREE'], ['物料','FMATERIALID'], ['客户类别','F_ora_BaseProperty'],
] as const;
type ObjectValue = Record<string, unknown>;
function ensure(value: unknown, message: string, status = 400): asserts value { if (!value) throw new AccessError(message, status); }
function object(value: unknown): ObjectValue { ensure(value && typeof value === 'object' && !Array.isArray(value), '接口响应结构异常', 502); return value as ObjectValue; }
const success = (value: unknown) => value === true || value === 'true';
function count(value: unknown, name: string) { ensure((typeof value === 'string' && /^\d+$/.test(value)) || (typeof value === 'number' && Number.isSafeInteger(value)), `响应缺少有效${name}`, 502); const n = Number(value); ensure(Number.isSafeInteger(n) && n >= 0, `${name}超出范围`, 502); return n; }
function text(value: unknown, name: string, max = 100) { ensure(typeof value === 'string' && value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value), `请填写有效${name}`); return value.trim(); }
function fields(value: unknown, names: string[]) { ensure(value && typeof value === 'object' && !Array.isArray(value), '请求必须是JSON对象'); const record = value as ObjectValue; ensure(Object.keys(record).every(key => names.includes(key)), '请求包含不支持的参数'); return record; }
export function readXingkongCredentials(value: unknown) {
  const data = fields(value, ['accountId', 'username', 'password']);
  const accountId = text(data.accountId, '账套ID'); ensure(/^[\w-]+$/.test(accountId), '账套ID格式无效');
  const username = text(data.username, '用户名');
  ensure(typeof data.password === 'string' && data.password.length > 0 && data.password.length <= 1024, '请填写密码');
  return { accountId, username, password: data.password };
}
export function readXingkongSettings(value: unknown): { kind: XingkongKind; settings: XingkongSettings } {
  const data = fields(value, ['kind', 'start', 'end', 'salesOrganization', 'settleOrganization', 'schemeId', 'priceListNumber']);
  ensure(data.kind === 'companySales' || data.kind === 'companyStock' || data.kind === 'prices', '不支持该星空采集类型');
  const settings: XingkongSettings = { start: text(data.start, '开始日期', 10), end: text(data.end, '截止日期', 10), salesOrganization: '', settleOrganization: '', schemeId: '' };
  for (const date of [settings.start, settings.end]) ensure(/^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date, '日期必须为有效YYYY-MM-DD');
  ensure(settings.start <= settings.end, '开始日期不能晚于截止日期');
  if (data.kind === 'prices') {
    settings.salesOrganization = text(data.salesOrganization, '价目表组织编码或名称');
    settings.priceListNumber = text(data.priceListNumber || 'XSJMB1110', '价目表编号');
  } else if (data.kind === 'companySales') {
    settings.salesOrganization = text(data.salesOrganization, '销售组织编码或名称');
    settings.settleOrganization = text(data.settleOrganization, '结算组织编码或名称');
  } else {
    settings.schemeId = text(data.schemeId, '库存方案内码');
    ensure(/^[a-zA-Z0-9_-]{6,128}$/.test(settings.schemeId) && !/^default$/i.test(settings.schemeId), '请填写真实非默认FSCHEMEID，不能使用方案名称');
  }
  return { kind: data.kind, settings };
}

class XingkongClient {
  private cookies = new Map<string, string>();
  private sessionHeaders: Record<string, string> = {};
  readonly abort = new AbortController();
  constructor(private fetcher: typeof fetch) {}
  dispose() { this.abort.abort(); this.cookies.clear(); this.sessionHeaders = {}; }
  async post(service: keyof typeof services, payload: unknown, signal?: AbortSignal, full = false) {
    const signals = [this.abort.signal, AbortSignal.timeout(service === 'login' ? 25000 : service === 'organizations' ? 25000 : full ? 300000 : 120000), ...(signal ? [signal] : [])];
    let response: Response;
    try {
      response = await this.fetcher(new URL(services[service], xingkongBaseUrl), { method: 'POST', redirect: 'error', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', ...this.sessionHeaders, ...(this.cookies.size ? { Cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ') } : {}) },
        body: JSON.stringify(payload), signal: AbortSignal.any(signals) });
    } catch { throw new AccessError(this.abort.signal.aborted || signal?.aborted ? '请求已取消，请重新测试连接' : '金蝶连接失败或超时，请检查云端网络和金蝶服务；未自动重试', 502); }
    ensure(response.ok, `金蝶HTTP请求失败（${response.status}），请检查服务和访问权限`, 502);
    for (const entry of response.headers.getSetCookie?.() || []) {
      const pair = entry.split(';', 1)[0], at = pair.indexOf('=');
      if (at > 0) this.cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    for (const key of ['kdservice-sessionid', 'kdservice-userpk']) { const value = response.headers.get(key); if (value) this.sessionHeaders[key] = value; }
    const reader = response.body?.getReader(); ensure(reader, '金蝶返回空响应', 502);
    const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > (full ? 32 : 4) * 1024 * 1024) { await reader.cancel(); throw new Error(); } chunks.push(value); } }
    catch { throw new AccessError('金蝶响应过大或读取失败，探测已停止', 502); }
    let body: unknown;
    try { body = parseLosslessJson(Buffer.concat(chunks).toString('utf8')); if (typeof body === 'string') body = parseLosslessJson(body); }
    catch { throw new AccessError('金蝶未返回有效JSON，请检查服务地址和接口版本', 502); }
    return body;
  }
  async login(credentials: ReturnType<typeof readXingkongCredentials>, signal?: AbortSignal) {
    const body = object(await this.post('login', { acctID: credentials.accountId, username: credentials.username, password: credentials.password, lcid: 2052 }, signal));
    // Never return remote login messages/context: they can echo passwords or tokens.
    ensure(String(body.LoginResultType) === '1', '金蝶登录未通过，请核对账套、用户名、密码及账号登录策略', 401);
    ensure(this.cookies.size || this.sessionHeaders['kdservice-sessionid'], '金蝶登录返回成功但没有可复用会话，请检查服务版本', 502);
  }
  async organization(value: string, signal?: AbortSignal): Promise<XingkongOrganization> {
    const escaped = value.replaceAll("'", "''");
    const query = { FormId: 'ORG_Organizations', FieldKeys: 'FORGID,FNumber,FName', FilterString: `(FNumber='${escaped}' OR FName='${escaped}')`, OrderString: 'FORGID ASC', TopRowCount: 0, StartRow: 0, Limit: 2 };
    const body = await this.post('organizations', { data: JSON.stringify(query) }, signal);
    ensure(Array.isArray(body) && body.length === 1 && Array.isArray(body[0]) && body[0].length === 3, '组织未查到、存在重名或缺少组织查询权限，请使用准确组织编码', 422);
    const [id, code, name] = body[0];
    ensure(typeof id === 'string' && /^\d+$/.test(id) && typeof code === 'string' && typeof name === 'string' && [code, name].some(item => item.toUpperCase() === value.toUpperCase()), '组织查询返回值与所填组织不一致', 422);
    return { id, code, name };
  }
}
type Binding = { actor: string; owner: string };
type Session = Binding & { client: XingkongClient; accountId: string; expiresAt: number; busy: boolean; expiry: ReturnType<typeof setTimeout> };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
type ProbeOptions = { signal?: AbortSignal; excludeCustomers: string[] };
export type SalesCollectionLease = {
  kind: XingkongKind; accountId: string; settings: XingkongSettings; signal: AbortSignal;
  prepare: () => Promise<void>;
  page: (startRow: number, limit: number) => Promise<{ request: Record<string, unknown>; organizations: XingkongOrganization[]; rows: SalesRow[]; total: number }>;
  dispose: () => void;
  cancel?: () => void;
};

function salesRequest(settings: XingkongSettings, organizations: XingkongOrganization[], startRow: number, limit: number) {
  return { FieldKeys: salesColumns.map(column => column[1]).join(','), SchemeId: '', StartRow: startRow, Limit: limit, IsVerifyBaseDataField: true, FilterString: [], Model: {
    FStartDate: settings.start, FEndDate: settings.end, FStartMaterial: { FNUMBER: '' }, FEndMaterial: { FNUMBER: '' }, FStartCustomer: { FNumber: '' }, FEndCustomer: { FNumber: '' }, FStartDepartment: { FNUMBER: '' }, FEndDepartment: { FNUMBER: '' },
    FBillStatus: 'ALL', FIsIncludeInnerExchangeBill: false, FIsIncludeSerMat: true, FSaleOrgId: organizations[0].id, FSettleOrgId: organizations[1].id, FSuite: 'All', FIsGroupCust: false, FOnlyOutReturnData: false, FIncludeRefundNoGoods: false, FIsIncludeGift: true,
  } };
}
function mapSalesRows(raw: unknown, maxRows: number): SalesRow[] {
  ensure(Array.isArray(raw) && raw.length <= maxRows, '销售成功响应缺少Rows数组或超过本页上限', 502);
  return raw.map(value => {
    let row: Record<string, unknown>;
    if (Array.isArray(value)) { ensure(value.length === salesColumns.length, '销售列数与FieldKeys不一致', 502); row = Object.fromEntries(salesColumns.map(([,field],index)=>[field,value[index]])); }
    else { const original = object(value), keys = new Map(Object.keys(original).map(key=>[key.toLowerCase(),key])); ensure(keys.size === salesColumns.length && salesColumns.every(([,field])=>keys.has(field.toLowerCase())), '销售返回字段不一致', 502); row=Object.fromEntries(salesColumns.map(([,field])=>[field,original[keys.get(field.toLowerCase())!]])); }
    ensure(Object.values(row).every(value=> value == null || typeof value === 'boolean' || typeof value === 'string' && value.length <= 50000), '销售返回单元格格式异常', 502);
    return row as SalesRow;
  });
}

export class XingkongService {
  private sessions = new Map<string, Session>();
  private attempts = new Map<string, { start: number; count: number; busy: boolean }>();
  constructor(private fetcher: typeof fetch = fetch, private now: () => number = Date.now) {}
  private prune() {
    for (const [key, session] of this.sessions) if (session.expiresAt <= this.now()) { clearTimeout(session.expiry); session.client.dispose(); this.sessions.delete(key); }
    for (const [key, attempt] of this.attempts) if (!attempt.busy && attempt.start + 60000 <= this.now()) this.attempts.delete(key);
  }
  async connect(binding: Binding, input: unknown, signal?: AbortSignal) {
    const credentials = readXingkongCredentials(input); this.prune();
    const key = JSON.stringify([binding.actor, binding.owner]), attempt = this.attempts.get(key) || { start: this.now(), count: 0, busy: false };
    ensure(!attempt.busy && attempt.count < 5, '登录测试过于频繁，请一分钟后重试；不会自动重试密码', 429);
    ensure(this.sessions.size < 128 && this.attempts.size < 256, '当前连接测试较多，请稍后重试', 429);
    attempt.count++; attempt.busy = true; this.attempts.set(key, attempt);
    const client = new XingkongClient(this.fetcher);
    try {
      await client.login(credentials, signal);
      for (const [id, old] of this.sessions) if (old.actor === binding.actor && old.owner === binding.owner) { clearTimeout(old.expiry); old.client.dispose(); this.sessions.delete(id); }
      const token = randomBytes(32).toString('base64url'), expiresAt = this.now() + 15 * 60000;
      const expiry = setTimeout(() => { client.dispose(); this.sessions.delete(digest(token)); }, 15 * 60000);
      expiry.unref();
      this.sessions.set(digest(token), { ...binding, client, accountId: credentials.accountId, expiresAt, busy: false, expiry });
      return { token, expiresAt: new Date(expiresAt).toISOString(), accountId: credentials.accountId, endpoint: xingkongBaseUrl };
    } catch (error) { client.dispose(); throw error; }
    finally { credentials.password = ''; attempt.busy = false; }
  }
  private session(binding: Binding, token: string) {
    this.prune(); ensure(/^[\w-]{43}$/.test(token), '连接会话已失效，请重新测试连接', 401);
    const session = this.sessions.get(digest(token));
    ensure(session && session.actor === binding.actor && session.owner === binding.owner, '连接会话已失效或不属于当前账户，请重新测试连接', 401);
    return session;
  }
  disconnect(binding: Binding, token: string) { const session = this.session(binding, token); clearTimeout(session.expiry); session.client.dispose(); this.sessions.delete(digest(token)); }
  leaseSalesCollection(binding: Binding, token: string, input: unknown): SalesCollectionLease {
    ensure(readXingkongSettings(input).kind === 'companySales', '该入口仅用于销售采集', 422);
    return this.leaseCollection(binding,token,input);
  }
  leaseCollection(binding: Binding, token: string, input: unknown, retainSession = false): SalesCollectionLease {
    const {kind, settings} = readXingkongSettings(input);
    const session = this.session(binding, token);
    ensure(!session.busy, '连接正在探测，请等待当前请求结束', 409);
    // Transfer the memory-only connection to a bounded background job. Closing the browser cannot cancel it.
    clearTimeout(session.expiry);
    if (retainSession) {
      session.busy=true; session.expiresAt=this.now()+120*60000;
      session.expiry=setTimeout(()=>{session.client.dispose();this.sessions.delete(digest(token));},120*60000);session.expiry.unref();
    } else this.sessions.delete(digest(token));
    const expiry = setTimeout(()=>session.client.dispose(), 45*60000); expiry.unref();
    let organizations: XingkongOrganization[] = [], queryId = '', stockFields = '';
    return { kind, accountId: session.accountId, settings, signal: session.client.abort.signal,
      prepare: async () => { if(kind==='companyStock')return;if(kind==='prices')readPriceSchema();const sale = await session.client.organization(settings.salesOrganization); if(kind==='prices'){organizations=[sale];return;} const settle = settings.salesOrganization === settings.settleOrganization ? sale : await session.client.organization(settings.settleOrganization); organizations = [sale,settle]; },
      page: async (startRow, limit) => {
        ensure((kind==='companyStock'||organizations.length === (kind==='prices'?1:2)) && Number.isInteger(startRow) && startRow >= 0 && Number.isInteger(limit) && limit > 0 && limit <= 10000, '分页参数或组织初始化无效');
        if(kind==='prices'){
          const schema=readPriceSchema(), request=priceRequest(schema,organizations[0].code,settings.priceListNumber!,startRow,limit);
          const raw=await session.client.post('prices',{data:JSON.stringify(request)},undefined,true);
          const rows=mapPriceRows(raw,schema,organizations[0].code,settings.priceListNumber!);
          return {request,organizations,rows:rows as unknown as SalesRow[],total:rows.length===0?startRow:-1};
        }
        if(kind==='companyStock'){
          ensure(startRow===0||!!queryId,'库存翻页缺少CurQueryId，不重新生成另一份报表',502);
          const request={FORMID:'STK_StockSummaryRpt',FSCHEMEID:settings.schemeId,QuicklyCondition:[],MoreCondition:[],StartRow:startRow,Limit:limit,CurQueryId:queryId,FieldKeys:''};
          const body=object(await session.client.post('stock',{parameters:[JSON.stringify(request)]},undefined,true));
          ensure(success(body.success),'库存全量查询失败，请检查保存方案与报表权限；没有自动重试',422);
          let raw=body.data;if(typeof raw==='string'){try{raw=parseLosslessJson(raw);}catch{throw new AccessError('库存data不是有效JSON',502);}}
          ensure(Array.isArray(raw)&&raw.length<=limit,'库存成功响应缺少data数组或超出本页上限',502);
          const nextId=body.CurQueryId??'';ensure(typeof nextId==='string'&&nextId.length<=4096,'库存查询标识格式异常',502);
          if(startRow===0)queryId=nextId;else ensure(!!nextId&&nextId===queryId,'CurQueryId缺失或发生变化，停止拼接库存分页',502);
          const rows=raw.map(value=>{const original=object(value),entries=Object.entries(original),keys=entries.map(([key])=>key.toUpperCase()).sort();
            ensure(keys.length>0&&keys.length<=200&&new Set(keys).size===keys.length,'库存字段为空、过多或重名',502);
            const signature=JSON.stringify(keys);if(!stockFields)stockFields=signature;ensure(stockFields===signature,'库存分页字段集合发生变化',502);
            ensure(entries.every(([,value])=>value==null||typeof value==='boolean'||typeof value==='string'&&value.length<=50000),'库存单元格格式异常',502);
            return Object.fromEntries(entries.map(([key,value])=>[key.toUpperCase(),value])) as SalesRow;
          });
          const total=count(body.TotalCount,'TotalCount');ensure(startRow+rows.length>=total||!!queryId.trim(),'需要翻页但库存未返回CurQueryId',502);
          // Query identifier remains memory-only, including in saved request/audit files.
          return {request:{...request,CurQueryId:'',queryIdReused:startRow>0},organizations:[],rows,total};
        }
        const request = salesRequest(settings, organizations, startRow, limit);
        const body = object(await session.client.post('sales',{formid:'SAL_OutStockSummaryRpt',data:JSON.stringify(request)},undefined,true));
        const result = object(body.Result), status = result.ResponseStatus == null ? null : object(result.ResponseStatus);
        ensure(success(result.IsSuccess) && (!status || status.IsSuccess == null || success(status.IsSuccess)), '销售全量查询失败，请检查报表权限与条件；没有自动重试', 422);
        return { request, organizations, rows:mapSalesRows(result.Rows,limit+1), total:count(result.RowCount,'RowCount') };
      },
      cancel: () => { clearTimeout(expiry); session.client.dispose(); },
      dispose: () => { clearTimeout(expiry); if(retainSession)session.busy=false;else session.client.dispose(); },
    };
  }
  async probe(binding: Binding, token: string, input: unknown, options: ProbeOptions): Promise<XingkongProbe> {
    const { kind, settings } = readXingkongSettings(input), session = this.session(binding, token);
    ensure(!session.busy, '该连接正在探测，请等待当前请求结束', 409); session.busy = true;
    const createdAt = new Date(this.now()).toISOString(), started = this.now();
    try {
      let request: Record<string, unknown>, rawRows: unknown, total: number, queryIdReceived = false;
      let columns: XingkongProbe['columns'], organizations: XingkongOrganization[] = [];
      if (kind === 'prices') {
        const schema=readPriceSchema(),org=await session.client.organization(settings.salesOrganization,options.signal);organizations=[org];
        request=priceRequest(schema,org.code,settings.priceListNumber!,0,20);
        rawRows=mapPriceRows(await session.client.post('prices',{data:JSON.stringify(request)},options.signal),schema,org.code,settings.priceListNumber!);
        total=(rawRows as unknown[]).length;
        columns=priceKeys.map(field=>({field,label:field}));
      } else if (kind === 'companySales') {
        const sale = await session.client.organization(settings.salesOrganization, options.signal);
        const settle = settings.salesOrganization === settings.settleOrganization ? sale : await session.client.organization(settings.settleOrganization, options.signal);
        organizations = [sale, settle];
        request = salesRequest(settings, organizations, 0, 20);
        const body = object(await session.client.post('sales', { formid: 'SAL_OutStockSummaryRpt', data: JSON.stringify(request) }, options.signal));
        const result = object(body.Result), status = result.ResponseStatus == null ? null : object(result.ResponseStatus);
        ensure(success(result.IsSuccess) && (!status || status.IsSuccess == null || success(status.IsSuccess)), '销售汇总查询未成功，请检查报表权限、组织、日期和接口版本', 422);
        total = count(result.RowCount, 'RowCount'); rawRows = result.Rows;
        columns = salesColumns.map(([label, field]) => ({ field, label }));
      } else {
        request = { FORMID: 'STK_StockSummaryRpt', FSCHEMEID: settings.schemeId, QuicklyCondition: [], MoreCondition: [], StartRow: 0, Limit: 20, CurQueryId: '', FieldKeys: '' };
        const body = object(await session.client.post('stock', { parameters: [JSON.stringify(request)] }, options.signal));
        ensure(success(body.success), '库存汇总查询未成功，请检查非默认方案内码、方案可见性、报表权限和接口版本', 422);
        total = count(body.TotalCount, 'TotalCount'); rawRows = body.data;
        if (typeof rawRows === 'string') { try { rawRows = parseLosslessJson(rawRows); } catch { throw new AccessError('库存data不是有效JSON', 502); } }
        ensure(body.CurQueryId == null || typeof body.CurQueryId === 'string', '库存查询标识格式异常', 502);
        queryIdReceived = typeof body.CurQueryId === 'string' && !!body.CurQueryId.trim();
        ensure(Array.isArray(rawRows), '库存成功响应缺少data数组，不能当作0行', 502);
        columns = rawRows.length ? Object.keys(object(rawRows[0])).map(field => ({ field, label: field })) : [];
      }
      ensure(Array.isArray(rawRows) && rawRows.length <= 20, '接口缺少行数组或返回超过20行，探测已停止', 502);
      ensure(total > 0 || rawRows.length === 0, '接口总数为0但仍返回行，需核对接口版本', 502);
      ensure(columns.length <= 200, '返回列数异常，探测已停止', 502);
      const rows = rawRows.map(raw => {
        let record: ObjectValue;
        if (kind === 'companySales' && Array.isArray(raw)) { ensure(raw.length === columns.length, '销售返回列数与FieldKeys不一致，停止映射', 502); record = Object.fromEntries(columns.map((column, index) => [column.field, raw[index]])); }
        else {
          const original = object(raw), keys = new Map(Object.keys(original).map(key => [key.toLowerCase(), key]));
          ensure(keys.size === Object.keys(original).length && columns.every(column => keys.has(column.field.toLowerCase())) && keys.size === columns.length && keys.size > 0, '返回字段集合不一致，停止映射', 502);
          record = Object.fromEntries(columns.map(column => [column.field, original[keys.get(column.field.toLowerCase())!]]));
        }
        ensure(Object.values(record).every(value => value == null || typeof value === 'string' || typeof value === 'boolean'), '返回单元格包含未知结构，停止映射', 502);
        ensure(Object.values(record).every(value => typeof value !== 'string' || value.length <= 50000), '返回单元格过大，探测已停止', 502);
        return record as XingkongProbe['rows'][number];
      });
      const rowNotes = rows.map((row, index) => {
        const displayTotal = kind === 'companySales' && classifySalesRow(row) !== 'business';
        if (kind === 'companySales' && !displayTotal) ensure(String(row.FSALEORGNAME).toUpperCase() === organizations[0].name.toUpperCase() && String(row.FSETTLEORGNAME).toUpperCase() === organizations[1].name.toUpperCase(), '返回业务行的销售或结算组织与请求不一致，探测未通过', 422);
        return { row: index + 1, displayTotal, excludedCustomer: kind === 'companySales' && !displayTotal && excludedCustomer(row, options.excludeCustomers) };
      });
      this.session(binding, token); ensure(!session.client.abort.signal.aborted, '连接已关闭，探测未保存', 401);
      const warnings = ['仅保留首页最多20行，不是全量数据；不会进入明细生成，不证明与页面报表逐行一致。', '负数、空白和赠品标记保留原始值，不对探测样本计算整表合计。'];
      if (kind === 'companyStock') warnings.push(`库存条件完全取自保存方案${settings.schemeId}；${settings.start}至${settings.end}只是你填写的预期日期，未作为接口条件发送，也未核验方案实际日期、组织或仓库范围。`);
      else if(kind==='prices')warnings.push('价目表按组织、编号查询，状态、整单状态及失效均为全部；样本行数不是全表总数。保留单位和有效期，不自动选择冲突价格。');
      else warnings.push(`销售日期${settings.start}至${settings.end}已作为请求条件发送；返回汇总行不含单据日期，仍需对照同条件页面或Excel。客户排除仅按当前名单标注，不删除原始样本。`);
      if (!rows.length) warnings.push('接口返回0行，仅表示本次请求没有样本，不代表页面数据为0或全部权限已通过。');
      if (kind === 'companyStock' && total > rows.length && !queryIdReceived) warnings.push('未返回CurQueryId，后续全量分页尚不能验收。');
      return { id: randomUUID(), createdAt, kind, accountId: session.accountId, endpoint: new URL(kind === 'companySales' ? services.sales : kind==='prices'?services.prices:services.stock, xingkongBaseUrl).href,
        request, columns, rows, total, returnedRows: rows.length, durationMs: this.now() - started, queryIdReceived, organizations, customerExclusions: kind === 'companySales' ? [...options.excludeCustomers] : [], rowNotes, warnings, sampleOnly: true, apiReadComplete: false, uiEquivalentVerified: false };
    } finally { session.busy = false; }
  }
}

const serviceKey = Symbol.for('casebang.kingdee.xingkong.sessions');
const processState = globalThis as typeof globalThis & { [serviceKey]?: XingkongService };
export function xingkongService() { return processState[serviceKey] ||= new XingkongService(); }

export async function readXingkongJson(request: Request) {
  ensure(request.headers.get('content-type')?.split(';')[0].trim() === 'application/json', '请使用JSON请求', 415);
  ensure(Number(request.headers.get('content-length') || 0) <= 8192, '请求内容过大', 413);
  const reader = request.body?.getReader(); ensure(reader, '没有收到请求内容');
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 8192) { await reader.cancel(); throw new AccessError('请求内容过大', 413); } chunks.push(value); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { throw new AccessError('请求不是有效JSON', 400); }
}
