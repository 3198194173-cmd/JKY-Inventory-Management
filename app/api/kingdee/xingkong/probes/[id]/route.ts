import { currentContext, errorResponse } from '@/lib/auth';
import { getXingkongProbe } from '@/lib/kingdee-store';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { target } = await currentContext(), { id } = await context.params;
    return Response.json(getXingkongProbe(target.data_owner, id), { headers: { 'Cache-Control': 'private, no-store',
      ...(new URL(request.url).searchParams.get('download') === '1' ? { 'Content-Disposition': `attachment; filename="xingkong-probe-${id}.json"` } : {}) } });
  } catch (error) { return errorResponse(error); }
}
