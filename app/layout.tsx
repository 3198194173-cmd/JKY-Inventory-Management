import type { Metadata } from "next";
import "./globals.css";
import "./inventory-tweaks.css";
import "./compact-inventory.css";

export const metadata: Metadata = {
  title: "仓库数据 · 库存与销售",
  description: "多仓库实时可购数量、每日销售库存差额与 Excel 汇总。",
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
