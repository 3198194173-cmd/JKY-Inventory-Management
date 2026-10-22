import { currentContext, assertSameOrigin, errorResponse } from '@/lib/auth';
import { audit, AccessError } from '@/lib/accounts';
import { xingkongCollections } from '@/lib/kingdee-collections';
import { readXingkongJson } from '@/lib/kingdee-xingkong';
export const runtime='nodejs';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store'};
export async function GET(request:Request){try{const {target}=await currentContext(),kind=new URL(request.url).searchParams.get('kind');if(kind!==null&&kind!=='companySales'&&kind!=='companyStock')throw new AccessError('采集模块无效',400);return Response.json({collections:xingkongCollections().list(target.data_owner,kind||undefined)},{headers});}catch(error){return errorResponse(error);}}
export async function POST(request:Request){try{
  assertSameOrigin(request);const {actor,target}=await currentContext();
  const collection=xingkongCollections().start({actor:actor.id,owner:target.data_owner},request.headers.get('X-Kingdee-Session')||'',await readXingkongJson(request));
  audit(actor.id,target.id,'kingdee_xingkong_collect',{id:collection.id,kind:collection.kind});
  return Response.json({collection},{status:202,headers});
}catch(error){return errorResponse(error);}}
