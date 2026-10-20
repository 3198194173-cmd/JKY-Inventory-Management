import { currentContext, assertSameOrigin, errorResponse } from '@/lib/auth';
import { audit, AccessError } from '@/lib/accounts';
import { createKingdeeImport } from '@/lib/kingdee-store';
export const maxDuration = 180;
export async function POST(request: Request) {
  try {
    assertSameOrigin(request); const { actor, target } = await currentContext();
    const body = await request.json() as { batch?: unknown };
    if (typeof body.batch !== 'string') throw new AccessError('请选择待重算的批次', 400);
    const batch = await createKingdeeImport(target.data_owner, actor.id, [], body.batch);
    audit(actor.id, target.id, 'kingdee_recalculate', { batch: batch.id });
    return Response.json({ batch }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}
