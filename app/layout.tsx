import type { Metadata } from "next";
import "./globals.css";
import "./inventory-tweaks.css";

export const metadata: Metadata = {
  title: "仓库库存分析 · 吉客云",
  description: "易速菲泰国8仓成品仓的可订购量、库存快照和 Excel 汇总。",
  icons: {
    icon: "/inventory-icon.svg",
    shortcut: "/inventory-icon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
