import { currentContext, errorResponse } from '@/lib/auth';
import { xingkongCollections } from '@/lib/kingdee-collections';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request,context:{params:Promise<{id:string}>}){try{
  const {target}=await currentContext(),{id}=await context.params,manager=xingkongCollections(),format=new URL(request.url).searchParams.get('download');
  if(format){const {bytes,file}=await manager.download(target.data_owner,id,format);return new Response(new Uint8Array(bytes),{headers:{'Cache-Control':'private, no-store','Content-Type':format==='source'?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="xingkong-${id}-${file}"`}});}
  return Response.json({collection:manager.get(target.data_owner,id)},{headers:{'Cache-Control':'private, no-store'}});
}catch(error){return errorResponse(error);}}
