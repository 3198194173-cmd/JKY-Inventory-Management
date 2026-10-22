import { currentContext, assertSameOrigin, errorResponse } from '@/lib/auth';
import { audit, AccessError } from '@/lib/accounts';
import { readXingkongJson, xingkongService } from '@/lib/kingdee-xingkong';
import { kingdeeRules, listXingkongProbes, saveXingkongProbe } from '@/lib/kingdee-store';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;
const headers = { 'Cache-Control': 'private, no-store' };
export async function GET(request:Request) {
  try { const { target } = await currentContext(),kind=new URL(request.url).searchParams.get('kind');if(kind!==null&&kind!=='companySales'&&kind!=='companyStock')throw new AccessError('探测模块无效',400);return Response.json({ probes: listXingkongProbes(target.data_owner,kind||undefined) }, { headers }); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { actor, target } = await currentContext();
    const probe = await xingkongService().probe({ actor: actor.id, owner: target.data_owner }, request.headers.get('X-Kingdee-Session') || '', await readXingkongJson(request),
      { signal: request.signal, excludeCustomers: kingdeeRules(target.data_owner).companySales.excludeCustomerContains });
    saveXingkongProbe(target.data_owner, actor.id, probe);
    audit(actor.id, target.id, 'kingdee_xingkong_probe', { id: probe.id, kind: probe.kind, rows: probe.returnedRows });
    return Response.json({ probe }, { headers });
  } catch (error) { return errorResponse(error); }
}
