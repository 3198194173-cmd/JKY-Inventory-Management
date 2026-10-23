import { currentContext, assertSameOrigin, errorResponse } from '@/lib/auth';
import { audit } from '@/lib/accounts';
import { xingkongCollections } from '@/lib/kingdee-collections';
import { readXingkongJson } from '@/lib/kingdee-xingkong';
import { readPriceSchema } from '@/lib/kingdee-price-source';
export const runtime='nodejs';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store'};
export async function GET(){try{const {target}=await currentContext();let priceConfigured=false;try{readPriceSchema();priceConfigured=true;}catch{}return Response.json({runs:xingkongCollections().runs(target.data_owner),collections:xingkongCollections().list(target.data_owner),priceConfigured,goodsConfigured:!!(process.env.JACKYUN_APP_KEY&&process.env.JACKYUN_APP_SECRET)},{headers});}catch(error){return errorResponse(error);}}
export async function POST(request:Request){try{assertSameOrigin(request);const {actor,target}=await currentContext();const run=xingkongCollections().startRun({actor:actor.id,owner:target.data_owner},request.headers.get('X-Kingdee-Session')||'',await readXingkongJson(request));audit(actor.id,target.id,'kingdee_collection_run',{id:run.id,kinds:run.kinds});return Response.json({run},{status:202,headers});}catch(error){return errorResponse(error);}}
export async function DELETE(request:Request){try{assertSameOrigin(request);const {target}=await currentContext();const input=await readXingkongJson(request) as {id:string};return Response.json({run:xingkongCollections().cancelRun(target.data_owner,input.id)},{headers});}catch(error){return errorResponse(error);}}
