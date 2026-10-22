import { currentContext, assertSameOrigin, errorResponse } from '@/lib/auth';
import { audit } from '@/lib/accounts';
import { readXingkongJson, xingkongService } from '@/lib/kingdee-xingkong';
export const runtime = 'nodejs';
export const maxDuration = 40;
const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' };
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { actor, target } = await currentContext();
    const result = await xingkongService().connect({ actor: actor.id, owner: target.data_owner }, await readXingkongJson(request), request.signal);
    audit(actor.id, target.id, 'kingdee_xingkong_connection', { connected: true });
    return Response.json(result, { headers });
  } catch (error) { return errorResponse(error); }
}
export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const { actor, target } = await currentContext();
    xingkongService().disconnect({ actor: actor.id, owner: target.data_owner }, request.headers.get('X-Kingdee-Session') || '');
    return Response.json({ disconnected: true }, { headers });
  } catch (error) { return errorResponse(error); }
}
