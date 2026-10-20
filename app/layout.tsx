import type { Metadata } from 'next';
import './globals.css';
import './inventory-tweaks.css';
import './compact-inventory.css';
import './inventory-light.css';
import './inventory-mobile.css';
import './accounts.css';
import './warehouse-picker.css';
import './session-status.css';
import './platforms.css';
import './kingdee.css';
export const metadata:Metadata={title:'数据分析工作台',description:'吉客云仓库分析与金蝶存销分析。',icons:{icon:'/inventory-icon.svg',shortcut:'/inventory-icon.svg'}};
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>){return <html lang="zh-CN"><body className="antialiased">{children}</body></html>;}
