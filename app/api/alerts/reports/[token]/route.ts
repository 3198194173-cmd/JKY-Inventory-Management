import { readReportExport } from "@/lib/alert-report-export";
import { alertWorkbook } from "@/lib/excel";

export async function GET(_request:Request,{params}:{params:Promise<{token:string}>}) {
  const report=readReportExport((await params).token);
  if(!report)return new Response("报告不存在或下载链接已过期（有效期90天）",{status:404,headers:{"Cache-Control":"no-store"}});
  const bytes=alertWorkbook(report.card);
  return new Response(bytes.buffer as ArrayBuffer,{headers:{
    "Content-Type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition":`attachment; filename="${report.warehouseCode}_alert.xlsx"`,
    "Cache-Control":"private, no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff"
  }});
}
