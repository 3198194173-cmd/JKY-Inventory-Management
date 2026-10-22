import { currentContext, assertSameOrigin, errorResponse } from '@/lib/auth';
import { audit } from '@/lib/accounts';
import { xingkongCollections } from '@/lib/kingdee-collections';
export const runtime='nodejs';
export async function POST(request:Request,context:{params:Promise<{id:string}>}){try{
  assertSameOrigin(request);const {actor,target}=await currentContext(),{id}=await context.params;
  const collection=xingkongCollections().cancel(target.data_owner,id);audit(actor.id,target.id,'kingdee_xingkong_cancel',{id});
  return Response.json({collection},{headers:{'Cache-Control':'private, no-store'}});
}catch(error){return errorResponse(error);}}
