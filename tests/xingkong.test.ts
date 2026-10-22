import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { XingkongService, readXingkongCredentials, readXingkongSettings, readXingkongJson, salesColumns } from '../lib/kingdee-xingkong';
import { getXingkongProbe, listXingkongProbes, saveXingkongProbe, kingdeeView, getKingdeeBatch } from '../lib/kingdee-store';
import { parseLosslessJson } from '../lib/lossless-json';
const directory = mkdtempSync(resolve('.sites-runtime/tests/xingkong-'));
process.env.INVENTORY_DB_PATH = join(directory, 'inventory.sqlite');
process.env.KINGDEE_DB_PATH = join(directory, 'kingdee.sqlite');
process.env.KINGDEE_STORAGE_DIR = join(directory, 'files');
const binding = { actor: 'actor-a', owner: 'owner-a' };
const credentials = { accountId: '20200417192138569', username: 'offline-user', password: 'secret-not-persisted' };
const sales = { kind: 'companySales', start: '2026-10-01', end: '2026-10-31', salesOrganization: '103', settleOrganization: '103' };
const stock = { kind: 'companyStock', start: '2026-10-01', end: '2026-10-31', schemeId: '6ad1c8d85e3e71' };
const options = { excludeCustomers: ['排除门店'] };
type Call = { url: string; body: Record<string, unknown>; headers: Headers; init: RequestInit };
function mock(override?: (call: Call) => Response | undefined | Promise<Response | undefined>) {
  const calls: Call[] = [];
  const fetcher = (async (url: URL | string | Request, init: RequestInit = {}) => {
    const call = { url: String(url), body: JSON.parse(String(init.body)), headers: new Headers(init.headers), init }; calls.push(call);
    assert.equal(new URL(call.url).origin, 'https://benks.ik3cloud.com'); assert.equal(init.redirect, 'error');
    const custom = await override?.(call); if (custom) return custom;
    if (call.url.includes('ValidateUser')) return Response.json({ LoginResultType: 1 }, { headers: { 'Set-Cookie': 'ASP.NET_SessionId=private-cookie; HttpOnly; Secure' } });
    assert.match(call.headers.get('cookie') || '', /ASP.NET_SessionId=private-cookie/);
    if (call.url.includes('ExecuteBillQuery')) return new Response('[[9007199254740993123,"103","CASEBANG事业部"]]');
    if (call.url.includes('GetSysReportData')) {
      const row = Object.fromEntries(salesColumns.map(([, field]) => [field, '']));
      Object.assign(row, { FSALEORGNAME: 'CASEBANG事业部', FSETTLEORGNAME: 'CASEBANG事业部', FCUSTOMERNAME: '排除门店', FMATERIALNUMBER: '000123', FMATERIALNAME: '商品', FMATERIALID: '9007199254740993123', FOUTSTOCKQTY: '__decimal__', FISFREE: true });
      return new Response(JSON.stringify({ Result: { IsSuccess: true, RowCount: 100, Rows: [salesColumns.map(([, field]) => row[field])] } }).replace('"__decimal__"', '-12345678901234567890.123456789'));
    }
    return new Response('{"success":true,"TotalCount":38608,"CurQueryId":"private-query-id","data":[{"FMATERIALNUMBER":"000123","FNAME":"商品","FQTY":0.100000000000000001,"ZERO":0,"BLANK":null}]}');
  }) as typeof fetch;
  return { calls, fetcher };
}

test('按旧脚本封装真实只读服务，销售日期、组织内码和32列映射不丢精度', async () => {
  const m = mock(), service = new XingkongService(m.fetcher);
  const connection = await service.connect(binding, credentials);
  assert.ok(connection.token); assert.equal(m.calls[0].body.password, credentials.password);
  const sample = await service.probe(binding, connection.token, sales, options);
  assert.equal(m.calls.length, 3); assert.equal(sample.rows[0].FOUTSTOCKQTY, '-12345678901234567890.123456789');
  assert.equal(sample.rows[0].FMATERIALNUMBER, '000123'); assert.equal(sample.total, 100); assert.equal(sample.columns.length, 32);
  assert.equal(sample.organizations[0].id, '9007199254740993123'); assert.equal(sample.rowNotes[0].excludedCustomer, true);
  assert.equal(sample.rows[0].FISFREE, true); assert.equal(sample.sampleOnly, true); assert.equal(sample.apiReadComplete, false);
  const query = JSON.parse(String(m.calls.at(-1)!.body.data));
  assert.equal(query.Limit, 20); assert.equal(query.StartRow, 0); assert.equal(query.Model.FStartDate, sales.start);
  assert.equal(query.Model.FSaleOrgId, '9007199254740993123'); assert.equal(query.Model.FIsIncludeGift, true);
  assert.equal(query.Model.FSuite, 'All'); assert.equal(query.Model.FBillStatus, 'ALL');
  assert.doesNotMatch(JSON.stringify(sample), /private-cookie|secret-not-persisted|offline-user/);
  service.disconnect(binding, connection.token);
});

test('库存用parameters和真实方案内码，预期日期不冒充已覆盖方案，queryId不泄露', async () => {
  const m = mock(), service = new XingkongService(m.fetcher), connection = await service.connect(binding, credentials);
  const sample = await service.probe(binding, connection.token, stock, options);
  assert.equal(m.calls.length, 2); const request = JSON.parse(String((m.calls[1].body.parameters as string[])[0]));
  assert.deepEqual(request, { FORMID: 'STK_StockSummaryRpt', FSCHEMEID: stock.schemeId, QuicklyCondition: [], MoreCondition: [], StartRow: 0, Limit: 20, CurQueryId: '', FieldKeys: '' });
  assert.equal(sample.rows[0].FQTY, '0.100000000000000001'); assert.equal(sample.rows[0].ZERO, '0'); assert.equal(sample.rows[0].BLANK, null);
  assert.equal(sample.queryIdReceived, true); assert.match(sample.warnings.join(''), /未作为接口条件发送/);
  assert.doesNotMatch(JSON.stringify(sample), /private-query-id|private-cookie|secret-not-persisted/);
  service.disconnect(binding, connection.token);
});

test('拒绝任意地址、非法日期、方案名称和未知参数；组织查询对引号做字面量转义', async () => {
  assert.throws(() => readXingkongCredentials({ ...credentials, baseUrl: 'http://127.0.0.1' }), /不支持/);
  assert.throws(() => readXingkongSettings({ ...sales, start: '2026-02-30' }), /有效/);
  assert.throws(() => readXingkongSettings({ ...sales, end: '2026-09-01' }), /晚于/);
  assert.throws(() => readXingkongSettings({ ...stock, schemeId: 'API物料收发汇总' }), /FSCHEMEID/);
  assert.throws(() => readXingkongSettings({ ...sales, Limit: 10000 }), /不支持/);
  const m = mock(), service = new XingkongService(m.fetcher), connection = await service.connect(binding, credentials);
  await assert.rejects(service.probe(binding, connection.token, { ...sales, salesOrganization: "103' OR 1=1 --" }, options), /不一致/);
  assert.match(JSON.parse(String(m.calls[1].body.data)).FilterString, /103'' OR 1=1 --/);
  service.disconnect(binding, connection.token);
});

test('密码错误、无会话、网络错误不透传登录响应、不重试；登录限速', async () => {
  let now = 100000;
  const m = mock(() => Response.json({ LoginResultType: 0, Message: credentials.password, Context: { token: 'secret-context' } }));
  const service = new XingkongService(m.fetcher, () => now);
  for (let index = 0; index < 5; index++) await assert.rejects(service.connect(binding, credentials), error => /登录未通过/.test(String(error)) && !String(error).includes(credentials.password));
  await assert.rejects(service.connect(binding, credentials), /频繁/); assert.equal(m.calls.length, 5);
  now += 60001; await assert.rejects(service.connect(binding, credentials), /登录未通过/); assert.equal(m.calls.length, 6);
  const noSession = new XingkongService(mock(() => Response.json({ LoginResultType: 1 })).fetcher);
  await assert.rejects(noSession.connect(binding, credentials), /没有可复用会话/);
  const network = new XingkongService(mock(() => { throw new Error(credentials.password); }).fetcher);
  await assert.rejects(network.connect(binding, credentials), error => /连接失败/.test(String(error)) && !String(error).includes(credentials.password));
});

test('连接绑定操作者和目标账户，过期、断开及重新连接后的旧会话不可用', async () => {
  let now = 100000;
  const m = mock(), service = new XingkongService(m.fetcher, () => now), connection = await service.connect(binding, credentials);
  await assert.rejects(service.probe({ ...binding, owner: 'other' }, connection.token, stock, options), /会话已失效/);
  await assert.rejects(service.probe({ ...binding, actor: 'other' }, connection.token, stock, options), /会话已失效/);
  assert.equal(m.calls.length, 1);
  now += 15 * 60000 + 1; await assert.rejects(service.probe(binding, connection.token, stock, options), /会话已失效/);
  const next = await service.connect(binding, credentials), last = await service.connect(binding, credentials);
  await assert.rejects(service.probe(binding, next.token, stock, options), /会话已失效/);
  service.disconnect(binding, last.token); await assert.rejects(service.probe(binding, last.token, stock, options), /会话已失效/);
});

test('业务失败、缺行数组、超过20行、错列、组织不符均不伪装成功或空数据', async () => {
  const cases = [
    { Result: { IsSuccess: false, ResponseStatus: { IsSuccess: false, Errors: [{ Message: credentials.password }] } } },
    { Result: { IsSuccess: true, RowCount: 0 } },
    { Result: { IsSuccess: true, RowCount: 100, Rows: Array.from({ length: 21 }, () => []) } },
    { Result: { IsSuccess: true, RowCount: 1, Rows: [['wrong-column']] } },
    { Result: { IsSuccess: true, RowCount: 1, Rows: [Object.fromEntries(salesColumns.map(([, field]) => [field, 'wrong-org']))] } },
  ];
  for (const body of cases) {
    const m = mock(call => call.url.includes('GetSysReportData') ? Response.json(body) : undefined), service = new XingkongService(m.fetcher), connection = await service.connect(binding, credentials);
    await assert.rejects(service.probe(binding, connection.token, sales, options), error => !String(error).includes(credentials.password));
    service.disconnect(binding, connection.token);
  }
  const m = mock(call => call.url.includes('StockReportQueryService') ? Response.json({ success: true, TotalCount: 0, data: [] }) : undefined), service = new XingkongService(m.fetcher), connection = await service.connect(binding, credentials);
  const zero = await service.probe(binding, connection.token, stock, options); assert.equal(zero.total, 0); assert.equal(zero.returnedRows, 0); assert.match(zero.warnings.join(''), /不代表页面数据为0/);
  service.disconnect(binding, connection.token);
});

test('同一会话只允许一个在途探测，重复点击不重复生成请求', async () => {
  let release!: () => void;
  const gate = new Promise<void>(accept => { release = accept; });
  const m = mock(async call => { if (call.url.includes('StockReportQueryService')) await gate; return undefined; });
  const service = new XingkongService(m.fetcher), connection = await service.connect(binding, credentials);
  const pending = service.probe(binding, connection.token, stock, options);
  await assert.rejects(service.probe(binding, connection.token, stock, options), /正在探测/);
  release(); await pending; assert.equal(m.calls.length, 2); service.disconnect(binding, connection.token);
});

test('样本独立保存且跨账户拒绝，重启读取来源可用，不能作为完整来源生成明细', async () => {
  const service = new XingkongService(mock().fetcher), connection = await service.connect(binding, credentials);
  const sample = await service.probe(binding, connection.token, stock, options);
  saveXingkongProbe(binding.owner, binding.actor, sample);
  assert.equal(listXingkongProbes(binding.owner)[0].id, sample.id); assert.equal(listXingkongProbes('other').length, 0);
  assert.throws(() => getXingkongProbe('other', sample.id), /找不到/);
  assert.equal(getXingkongProbe(binding.owner, sample.id).rows[0].FMATERIALNUMBER, '000123');
  assert.equal(kingdeeView(binding.owner).batch, null); assert.throws(() => getKingdeeBatch(binding.owner, sample.id), /找不到/);
  assert.doesNotMatch(JSON.stringify(getXingkongProbe(binding.owner, sample.id)), /private-cookie|private-query-id|secret-not-persisted|offline-user/);
  assert.doesNotMatch(readFileSync(process.env.KINGDEE_DB_PATH!).toString(), /private-cookie|private-query-id|secret-not-persisted/);
  service.disconnect(binding, connection.token);
});

test('请求限制JSON类型和体积，保留原始小数及长内码', async () => {
  assert.deepEqual(parseLosslessJson('{"id":9007199254740993123,"qty":-0.1000000000001,"name":"0012","nil":null}'), { id:'9007199254740993123',qty:'-0.1000000000001',name:'0012',nil:null });
  await assert.rejects(readXingkongJson(new Request('https://local.test', { method: 'POST', body: 'x' })), /JSON请求/);
  await assert.rejects(readXingkongJson(new Request('https://local.test', { method: 'POST', headers:{'Content-Type':'application/json'},body:'x'.repeat(9000) })), /过大/);
});
