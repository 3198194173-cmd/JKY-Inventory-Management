import { readReportExport } from "@/lib/alert-report-export";
import { alertWorkbook } from "@/lib/excel";
import { currentContext, errorResponse } from '@/lib/auth';
import { AccessError, accountByOwner, audit } from '@/lib/accounts';
import { NextResponse } from 'next/server';

export async function GET(_request:Request,{params}:{params:Promise<{token:string}>}) {
  try {
  const {actor,target}=await currentContext();
  const report=readReportExport((await params).token,{owner:target.data_owner,admin:actor.role==='admin'});
  if(!report)return new Response("报告不存在或下载链接已过期（有效期90天）",{status:404,headers:{"Cache-Control":"no-store"}});
  const bytes=alertWorkbook(report.card);
  audit(actor.id,accountByOwner(report.owner)?.id||report.owner,'report_download');
  return new Response(bytes.buffer as ArrayBuffer,{headers:{
    "Content-Type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition":`attachment; filename="${report.warehouseCode}_alert.xlsx"`,
    "Cache-Control":"private, no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff"
  }});
  }catch(e){
    if(e instanceof AccessError&&e.status===401){const url=new URL('/login',process.env.INVENTORY_SITE_URL||_request.url);url.searchParams.set('returnTo',new URL(_request.url).pathname);return NextResponse.redirect(url,303);}
    return errorResponse(e);
  }
}
