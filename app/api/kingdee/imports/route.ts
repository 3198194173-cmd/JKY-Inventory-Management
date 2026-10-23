import { currentContext, assertSameOrigin, errorResponse } from '@/lib/auth';
import { audit, AccessError } from '@/lib/accounts';
import { createKingdeeImport, readKingdeeSubmission } from '@/lib/kingdee-store';
export const runtime = 'nodejs';
export const maxDuration = 180;
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { actor, target } = await currentContext();
    const { uploads, references, collectionReferences, options, hasInheritance } = await readKingdeeSubmission(request);
    if (!hasInheritance) throw new AccessError('请刷新页面，按继承底表流程填写期间后生成',400);
    const batch = await createKingdeeImport(target.data_owner, actor.id, uploads, undefined, references, collectionReferences, options);
    audit(actor.id, target.id, 'kingdee_import', { batch: batch.id, rows: batch.summary.goods });
    return Response.json({ batch }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}
