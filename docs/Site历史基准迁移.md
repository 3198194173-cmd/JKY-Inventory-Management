# CK031 历史基准迁移（2026-09-29）

旧 Site 的 CK031 在 2026-09-29 有一份完整的自动采集基准：6,137 个货品。2026-09-30 的旧 Site CK031 记录是未完成状态，不导入。新服务器已在 2026-09-30 采集 6,178 个货品；本操作只补入 9 月 29 日，不覆盖新服务器的今日数据。导入后页面的“09-29 销售量”才有两天库存可比较；两天中任一天缺少的货品仍显示空值。

私有数据文件在本地 `web-app/.sites-runtime/legacy-ck031-2026-09-29.bundle.json`，约 1.5 MB。`.sites-runtime` 已被 Git 忽略。不要把此文件提交到 GitHub、发到聊天或放入公开目录。

## 1. Windows：推送迁移程序

在本地 web-app 的 PowerShell 中：

```powershell
git status --short
git check-ignore .sites-runtime/legacy-ck031-2026-09-29.bundle.json
git add Dockerfile scripts/import-legacy-snapshot.mjs scripts/package-legacy-snapshot.mjs tests/legacy-import.test.mjs docs/Site历史基准迁移.md docs/Ubuntu部署操作手册.md
git diff --cached --stat
git commit -m "feat: import historical inventory daily baseline"
git push github main
```

`git check-ignore` 应输出私有文件路径；`git diff --cached --stat` 不能出现 `.sites-runtime` 或 `.bundle.json`。

## 2. Ubuntu：更新程序并备份当前库

```bash
cd /home/ubuntu/apps/JKY-Inventory-Management
git pull --ff-only
sudo docker compose exec -T web node scripts/backup.mjs
sudo docker compose build
sudo docker compose up -d
curl --fail http://127.0.0.1:3108/api/health
```

先记下备份文件名。`up -d` 仅重建服务，不删除 Docker 数据卷。不要执行 `down -v`。

## 3. Ubuntu：创建私有接收目录

```bash
mkdir -p /home/ubuntu/private/jky-inventory
chmod 700 /home/ubuntu/private /home/ubuntu/private/jky-inventory
```

## 4. Windows：上传私有数据包

另开本机 PowerShell，在本地 web-app 中执行：

```powershell
scp -i "$env:USERPROFILE\.ssh\casebang_server_login" `
  -o IdentitiesOnly=yes `
  ".sites-runtime\legacy-ck031-2026-09-29.bundle.json" `
  ubuntu@139.199.63.119:/home/ubuntu/private/jky-inventory/
```

这个私钥用于登录 Ubuntu。GitHub Deploy Key 只用于 GitHub 拉取。

上传前本地文件的 SHA-256 为 `1C26C4707EEFE3D755A6F5F450FCCDD50CF4A04B38ADD7224DF501DB57E1CB13`。Ubuntu 可用 `sha256sum /home/ubuntu/private/jky-inventory/legacy-ck031-2026-09-29.bundle.json` 核对，大小写不影响比较。

## 5. Ubuntu：导入并核对

```bash
cd /home/ubuntu/apps/JKY-Inventory-Management
sudo docker compose cp /home/ubuntu/private/jky-inventory/legacy-ck031-2026-09-29.bundle.json web:/app/storage/legacy-ck031-2026-09-29.bundle.json
sudo docker compose exec -T web node scripts/import-legacy-snapshot.mjs /app/storage/legacy-ck031-2026-09-29.bundle.json
```

正常输出为“历史基准导入成功：CK031 2026-09-29，6137 条”；重复运行会显示“历史基准已存在，跳过”。出错时不会覆盖今日基准。

在隧道网页刷新 CK031，应该有 09-29 销售列。销售量按 9 月 29 日库存减 9 月 30 日库存计算；9 月 30 日当前库存仍来自新服务器采集。可用以下只读命令核对两个日期与明细数：

```bash
sudo docker compose exec -T web node --input-type=module -e 'import { sqlite } from "./lib/sqlite.mjs"; const db=sqlite(); console.log(db.prepare("SELECT date,warehouse_code,goods_count,status FROM stock_snapshots WHERE owner=? AND warehouse_code=? ORDER BY date,captured_at").all(process.env.INVENTORY_OWNER_ID || "admin","CK031")); console.log(db.prepare("SELECT d.date,COUNT(e.goods_no) AS entries FROM daily_slots d JOIN stock_entries e ON e.snapshot_id=d.snapshot_id WHERE d.owner=? AND d.warehouse_code=? GROUP BY d.date ORDER BY d.date").all(process.env.INVENTORY_OWNER_ID || "admin","CK031"));'
```

预期每日基准至少有 2026-09-29 的 6,137 行和 2026-09-30 的 6,178 行。若今日数不同，先核对网页“采集记录”实际完成数，不要为凑数改数据库。

## 后续

完成历史基准核对后，再设置 `inventory.casebang.tech` 的 Cloudflare A 记录、独立 Nginx 站点与 HTTPS，最后启用每日 08:00 的 worker。域名接入前，继续通过 SSH 隧道使用网页。CK025 等其他仓库的历史基准另行迁移，不会因为这次 CK031 导入自动出现。
