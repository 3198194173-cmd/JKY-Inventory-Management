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
    if(query.Limit===10000){
      if(query.StartRow!==0)throw new Error('Unexpected fixture full page');
      const business={FSETTLEORGNAME:'CASEBANG事业部',FSALEORGNAME:'CASEBANG事业部',FMATERIALNUMBER:'A',FMATERIALNAME:'离线商品A',FCUSTOMERNUMBER:'C1',FCUSTOMERNAME:'离线客户',FUNITNAME:'Pcs',FCURRENCYNAME:'人民币',FISFREE:'是',FMATERIALID:'123',FOUTSTOCKQTY:'5'};
      const excluded={...business,FCUSTOMERNUMBER:'C2',FCUSTOMERNAME:'casebang福田星河店',FOUTSTOCKQTY:'7'};
      const subtotal=row=>({...row,FSETTLEORGNAME:'',FCUSTOMERNUMBER:'',FCUSTOMERNAME:'',FUNITNAME:'',FCURRENCYNAME:'',FISFREE:'',FMATERIALID:'123(小计)'});
      return Response.json({Result:{IsSuccess:true,RowCount:4,Rows:[business,subtotal(business),excluded,subtotal(excluded)].map(row=>query.FieldKeys.split(',').map(field=>row[field]??''))}});
    }
    if (query.Limit !== 20 || query.StartRow !== 0) throw new Error('Unexpected fixture query');
    return Response.json({ Result: { IsSuccess: true, RowCount: 100, Rows: [query.FieldKeys.split(',').map(field => ({ FSETTLEORGNAME: 'CASEBANG事业部', FSALEORGNAME: 'CASEBANG事业部', FMATERIALNUMBER: 'OFFLINE-001', FMATERIALNAME: '离线测试商品（非ERP数据）', FCUSTOMERNAME: '离线客户', FOUTSTOCKQTY: '-2.5' })[field] ?? '')] } });
  }
  if (url.pathname.includes('StockReportQueryService')) {
    const query = JSON.parse(body.parameters[0]);
    if(query.Limit===1000){
      if(query.StartRow!==0||query.CurQueryId!=='')throw new Error('Unexpected fixture stock page');
      const stock=(warehouse,quantity,id)=>({FMATERIALID:'123',FMATERIALNUMBER:'A',FMATERIALNAME:'离线商品A',FSTOCKID:id,FSTOCKNUMBER:'CK'+id,FSTOCKNAME:warehouse,FSTOCKUNITNAME:'Pcs',FOWNERTYPENAME:'业务组织',FOWNERNAME:'CASEBANG事业部',FSTOCKQCQTY:'0',FSTOCKINQTY:'0',FSTOCKOUTQTY:'0',FSTOCKJCQTY:quantity,finvturnovernum:'0',finvturnoverdays:'0',fidentityid:id});
      return Response.json({success:true,TotalCount:3,CurQueryId:'fixture-only-private-query',data:[stock('CASEBANG电商仓','5','1'),stock('Casebang Tiktok FBT美国仓','-1','2'),stock('名单外仓','7','3')]});
    }
    if (query.Limit !== 20 || query.StartRow !== 0 || query.QuicklyCondition.length) throw new Error('Invalid fixture stock query');
    return Response.json({ success: true, TotalCount: 100, CurQueryId: 'fixture-only-private-query', data: [{ FMATERIALNUMBER: 'OFFLINE-001', FMATERIALNAME: '离线测试商品（非ERP数据）', FSTOCKNAME: '离线测试仓', FQTY: '-2.5', FZERO: 0, FBLANK: null }] });
  }
  throw new Error('Fixture refuses unregistered Kingdee service');
};
