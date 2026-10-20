import { currentContext, assertSameOrigin, errorResponse } from '@/lib/auth';
import { audit } from '@/lib/accounts';
import { createKingdeeImport, readKingdeeSubmission } from '@/lib/kingdee-store';
export const runtime = 'nodejs';
export const maxDuration = 180;
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { actor, target } = await currentContext();
    const { uploads, references } = await readKingdeeSubmission(request);
    const batch = await createKingdeeImport(target.data_owner, actor.id, uploads, undefined, references);
    audit(actor.id, target.id, 'kingdee_import', { batch: batch.id, rows: batch.summary.goods });
    return Response.json({ batch }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}
