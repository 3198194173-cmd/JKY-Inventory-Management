import { currentContext, assertSameOrigin, errorResponse } from '@/lib/auth';
import { audit, AccessError } from '@/lib/accounts';
import { saveKingdeeWarehouses } from '@/lib/kingdee-store';
export async function PUT(request: Request) {
  try {
    assertSameOrigin(request); const { actor, target } = await currentContext();
    if (Number(request.headers.get('content-length') || 0) > 100000) throw new AccessError('配置内容过大', 413);
    const { members } = await request.json() as { members?: unknown };
    const rules = saveKingdeeWarehouses(target.data_owner, actor.id, members);
    audit(actor.id, target.id, 'kingdee_warehouse_rules', { version: rules.version, count: rules.warehouses.members.length });
    return Response.json({ rules }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}
