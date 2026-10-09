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
      <thead><tr><th>商品编码 / 名称</th><th>库存</th><th>销售均值</th><th>周转/天</th><th>7天趋势</th></tr></thead>
      <tbody>{card.rows.map(row => <Fragment key={row.goodsNo}>
        <tr className="alert-native-data-row"><td><span className="alert-product-code">{row.goodsNo}</span><span className="alert-product-name">{row.goodsName || "未提供商品名称"}</span></td><td><span className="alert-mobile-label">库存 </span>{row.quantity}</td><td><span className="alert-mobile-label">销售均值 </span>{row.average}</td><td className="alert-native-turnover"><span className="alert-mobile-label">周转 </span>{row.turnover}<span className="alert-mobile-label"> 天</span></td><td><button className="alert-trend-button" type="button" aria-label={`查看 ${row.goodsNo} 的详细销量趋势`} aria-expanded={selected === row.goodsNo} onClick={() => setSelected(selected === row.goodsNo ? null : row.goodsNo)}><SalesTrend compact samples={card.dates.map((date, i) => ({ date, value: row.sales[i] }))}/></button><span className="alert-mobile-caption">7天趋势 · 点击查看</span></td></tr>
        {selected === row.goodsNo && <tr className="alert-native-detail-row"><td colSpan={5}><section className="alert-native-detail"><div><strong>{row.goodsNo} · {row.goodsName}</strong><button type="button" onClick={() => setSelected(null)} aria-label="收起详细趋势图">收起</button></div><SalesTrend samples={card.dates.map((date, i) => ({ date, value: row.sales[i] }))}/></section></td></tr>}
      </Fragment>)}</tbody>
    </table></div>
    <footer>{card.footer}<span>点击曲线查看详细趋势图；钉钉使用原生图表详情，布局以客户端为准。</span></footer>
  </div>;
}
