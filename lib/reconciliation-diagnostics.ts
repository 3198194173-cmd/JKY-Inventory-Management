import { addQuantity, compareQuantity, subtractQuantity } from "./decimal";
import type { InboundReconciliation } from "./inbound";

/** Explain signed net sales and actual pending inbound reversals. */
export function reconciliationDiagnostic(item?: InboundReconciliation) {
  if (!item || item.status === "failed" || item.inboundQuantity == null || item.correctedQuantity == null) return null;
  const raw = subtractQuantity(item.openingQuantity, item.closingQuantity);
  if (raw !== item.rawDifference || addQuantity(raw, item.inboundQuantity) !== item.correctedQuantity) return null;
  if (compareQuantity(item.inboundQuantity, "0") < 0) return {
    kind: "inbound_reversal" as const, difference: item.correctedQuantity, increase: null,
    message: `入库合计为 ${item.inboundQuantity}，存在负数入库/冲销明细，需核对单据后确定销量。`,
  };
  if (compareQuantity(item.correctedQuantity, "0") < 0) {
    const increase = subtractQuantity("0", item.correctedQuantity);
    if (item.status === "verified") return {
      kind: "net_return" as const, difference: item.correctedQuantity, increase,
      message: "负销量按退货/回补的净变化口径统计，保留负号并计入近7天销量均值。",
    };
    return {
      kind: "unexplained_increase" as const, difference: item.correctedQuantity, increase,
      message: `扣除已知入库后，可订购量仍额外增加 ${increase}；这是未解释回补，不能直接认定销量。${item.inboundQuantity === "0" ? "本区间入库查询已完成，未取得该货品入库明细。" : ""}请核对库存锁定/释放及库存变动日志。`,
    };
  }
  return null;
}
