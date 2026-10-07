"use client";
import { Fragment, useState } from "react";
import type { TurnoverCard } from "@/lib/dingtalk-card-data";
import { SalesTrend } from "@/components/sales-trend";

export function InventoryAlertCardPreview({ card }: { card: TurnoverCard }) {
  const [selected, setSelected] = useState<string | null>(null);
  return <div className="alert-native-preview">
    <header><strong>{card.title}</strong><p>{card.summary}</p></header>
    <div className="alert-native-table-wrap"><table>
      <colgroup><col className="alert-column-code"/><col className="alert-column-number"/><col className="alert-column-number"/><col className="alert-column-turnover"/><col className="alert-column-trend"/></colgroup>
      <thead><tr><th>商品编码</th><th>库存</th><th>均值</th><th>周转/天</th><th>7天趋势</th></tr></thead>
      <tbody>{card.rows.map(row => <Fragment key={row.goodsNo}>
        <tr><td title={row.goodsName}>{row.goodsNo}</td><td>{row.quantity}</td><td>{row.average}</td><td className="alert-native-turnover">{row.turnover}</td><td><button className="alert-trend-button" type="button" aria-label={`查看 ${row.goodsNo} 的详细销量趋势`} aria-expanded={selected === row.goodsNo} onClick={() => setSelected(selected === row.goodsNo ? null : row.goodsNo)}><SalesTrend compact samples={card.dates.map((date, i) => ({ date, value: row.sales[i] }))}/></button></td></tr>
        {selected === row.goodsNo && <tr><td colSpan={5}><section className="alert-native-detail"><div><strong>{row.goodsNo} · {row.goodsName}</strong><button type="button" onClick={() => setSelected(null)} aria-label="收起详细趋势图">收起</button></div><SalesTrend samples={card.dates.map((date, i) => ({ date, value: row.sales[i] }))}/></section></td></tr>}
      </Fragment>)}</tbody>
    </table></div>
    <footer>{card.footer}<span>点击曲线查看详细趋势图；钉钉使用原生图表详情，布局以客户端为准。</span></footer>
  </div>;
}
