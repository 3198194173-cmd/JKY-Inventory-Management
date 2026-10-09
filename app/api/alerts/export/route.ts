import { currentOwner,errorResponse } from "@/lib/auth";
import { previewTurnoverAlert } from "@/lib/alerts-store";
import { alertWorkbook } from "@/lib/excel";

export async function GET(request:Request) {
  try {
    const code=new URL(request.url).searchParams.get("warehouseCode")||"CK031";
    const report=await previewTurnoverAlert(await currentOwner(),code);
    if(report.incomplete)throw new Error("库存采集不完整，暂不能导出预警");
    if(!report.cards.length)throw new Error(report.message);
    const bytes=alertWorkbook(report.cards[0]);
    return new Response(bytes.buffer as ArrayBuffer,{headers:{"Content-Type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","Content-Disposition":`attachment; filename="${report.warehouseCode}_alert_${report.date}.xlsx"`,"Cache-Control":"private, no-store"}});
  } catch(error){return errorResponse(error);}
}
