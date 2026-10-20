import { currentOwner, errorResponse } from '@/lib/auth';
import { kingdeeView } from '@/lib/kingdee-store';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try { return Response.json(kingdeeView(await currentOwner(), new URL(request.url).searchParams), { headers: { 'Cache-Control': 'private, no-store' } }); }
  catch (error) { return errorResponse(error); }
}
