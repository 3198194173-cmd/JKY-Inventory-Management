import { assertSameOrigin, errorResponse, requireAdmin } from '@/lib/auth';
import { findShareRecipient } from '@/lib/warehouse-sharing';
export async function POST(request:Request){
  try{assertSameOrigin(request);const actor=await requireAdmin(),body=await request.json() as Record<string,unknown>|null;return Response.json(await findShareRecipient(actor,body?.mobile),{headers:{'Cache-Control':'no-store'}});}catch(e){return errorResponse(e);}
}
