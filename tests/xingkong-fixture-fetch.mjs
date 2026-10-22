// Test-process preload ONLY. Production code has no fixture mode or configurable destination.
if (!process.env.KINGDEE_STORAGE_DIR?.includes('xingkong-http-')) throw new Error('Fixture requires its isolated HTTP test directory');
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname !== 'benks.ik3cloud.com') return nativeFetch(input, init);
  const body = JSON.parse(String(init?.body));
  if (url.pathname.includes('ValidateUser')) {
    if (body.username !== 'offline-user' || body.password !== 'offline-password') return Response.json({ LoginResultType: 0 });
    return Response.json({ LoginResultType: 1 }, { headers: { 'Set-Cookie': 'ASP.NET_SessionId=fixture-only-private-session; Secure; HttpOnly' } });
  }
  if (!new Headers(init?.headers).get('cookie')?.includes('fixture-only-private-session')) throw new Error('Fixture session missing');
  if (url.pathname.includes('ExecuteBillQuery')) return new Response('[[3780019,"103","CASEBANG事业部"]]');
  if (url.pathname.includes('GetSysReportData')) {
    const query = JSON.parse(body.data);
    if (query.Limit !== 20 || query.StartRow !== 0) throw new Error('Fixture only permits twenty rows');
    return Response.json({ Result: { IsSuccess: true, RowCount: 100, Rows: [query.FieldKeys.split(',').map(field => ({ FSETTLEORGNAME: 'CASEBANG事业部', FSALEORGNAME: 'CASEBANG事业部', FMATERIALNUMBER: 'OFFLINE-001', FMATERIALNAME: '离线测试商品（非ERP数据）', FCUSTOMERNAME: '离线客户', FOUTSTOCKQTY: '-2.5' })[field] ?? '')] } });
  }
  if (url.pathname.includes('StockReportQueryService')) {
    const query = JSON.parse(body.parameters[0]);
    if (query.Limit !== 20 || query.StartRow !== 0 || query.QuicklyCondition.length) throw new Error('Invalid fixture stock query');
    return Response.json({ success: true, TotalCount: 100, CurQueryId: 'fixture-only-private-query', data: [{ FMATERIALNUMBER: 'OFFLINE-001', FMATERIALNAME: '离线测试商品（非ERP数据）', FSTOCKNAME: '离线测试仓', FQTY: '-2.5', FZERO: 0, FBLANK: null }] });
  }
  throw new Error('Fixture refuses unregistered Kingdee service');
};
