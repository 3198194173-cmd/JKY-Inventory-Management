# Ubuntu 部署操作手册

适用版本：2026-09-30 的 Node/SQLite 迁移版本。代码已脱离 Sites 登录和 D1 运行依赖；旧 Site 不会随本地改动自动更新。当前第一版为一个管理员账号，所有使用该账号的人共享该账号的仓库；尚未提供多用户账号管理界面。

## 已确认的服务器环境

Ubuntu 22.04.5；Docker 29.1.3、Compose 2.40.3；现有 Nginx 配置有效。现有项目使用 3100、3456、8080，代理配置还引用 3000。本项目仅映射 `127.0.0.1:3108`，新建 Compose 项目 `jky-inventory`。现有 PM2、容器、数据库与系统 Node 20 不作修改。

以下命令分阶段执行；任何一步报错先检查该步，不连续执行后续操作。不要使用 `docker compose down -v`，它会删除本项目持久化数据卷。

## 1. 本地推送与服务器更新

Windows PowerShell，在本地 web-app 中核对并提交本次修改：

```powershell
Set-Location -LiteralPath "C:\Users\Administrator\Desktop\吉客云仓库库存数据统计与入库申请状态分析自动化\web-app"
git status --short
git add .
git diff --cached --stat
git commit -m "feat: add Ubuntu Docker runtime and background collection"
git push github main
```

Ubuntu：

```bash
cd /home/ubuntu/apps/JKY-Inventory-Management
git pull --ff-only
git log -1 --oneline
```

推送/拉取失败不强制覆盖分支，先解决错误。

## 2. 创建独立配置

使用容器里的 Node 生成配置，不升级宿主机 Node。此命令只创建 `.env.production`，已存在时拒绝覆盖。

```bash
cd /home/ubuntu/apps/JKY-Inventory-Management
sudo docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$PWD:/app" -w /app \
  node:24.14.0-bookworm-slim \
  node scripts/server-config.mjs
chmod 600 .env.production
nano .env.production
```

生成器仅在你的终端显示初始密码，请自行保存，不把密码或完整配置贴到聊天。账号默认 `admin`；配置保存的是 scrypt 密码哈希，不保存明文密码。

填写 `JACKYUN_APP_SECRET`；AppKey 默认 `92058521`。首次验证保留：

```text
INVENTORY_SITE_URL=http://localhost:3108
INVENTORY_SCHEDULE_ENABLED=false
```

`INVENTORY_OWNER_ID=admin` 是新数据归属标识。历史数据导入时必须映射归属，不能随意更改后认为旧数据丢失。钉钉暂时留空，不发送预警。

## 3. 构建并启动

```bash
sudo docker compose build
sudo docker compose up -d
sudo docker compose ps
curl --fail http://127.0.0.1:3108/api/health
```

健康检查应返回 `{"ok":true}`。首次构建需要下载镜像/依赖并编译，耗时受网络、CPU、内存影响。源码构建限制为单个 Next 构建 worker，但仍应观察共享服务器资源。

故障检查：

```bash
sudo docker compose logs --tail=100 web worker
```

本地没有 Docker，本文对应代码的生产构建、Node 服务与 SQLite 测试已经验证，Linux 容器镜像构建和实际吉客云连通性仍需在此步骤验收。

## 4. 通过 SSH 隧道验证网页

先在 Windows PowerShell 单独开一个窗口，保持运行：

```powershell
ssh -N -L 3108:127.0.0.1:3108 ubuntu@139.199.63.119
```

这里使用你现有的服务器登录方式；GitHub Deploy Key 只用于访问 GitHub，不是服务器 SSH 登录密钥。如果服务器 SSH 使用其他端口或专用密钥，沿用实际 SSH 参数。

浏览器打开 `http://localhost:3108`，使用生成的账号密码登录。添加/选择仓库后手动采集一次，检查状态、缺失清单、当前库存和 Excel。刷新/关闭网页不会取消已入队任务。任务排队、运行、失败或完成都会留存记录。

数据库存放在独立 Docker volume `jky-inventory_inventory-data`。普通容器重启、重建镜像不会清空历史数据。

## 5. 接入子域名与 HTTPS

确认 `inventory.casebang.tech` 未被其他服务使用且备案/接入满足部署条件后，在 Cloudflare 新增 A 记录：名称 `inventory`，地址 `139.199.63.119`，仅 DNS。保留原 NS、主域名和其他项目记录。

`deploy/nginx-http.conf` 是新增站点模板，不能覆盖原来的 `casebang.tech.conf`。在确认同名文件不存在后复制到独立站点配置，通过 `sudo nginx -t` 后再 reload。模板中的 HTTP 用于配置及证书接入，正式登录应使用 HTTPS。

根据服务器现有证书管理方式，为该子域名单独签发证书并配置 443 与 HTTP→HTTPS 跳转，验证自动续期。不复用证书前先核实证书是否包含新子域名，不覆盖其他站点证书。证书配置完成后修改：

```text
INVENTORY_SITE_URL=https://inventory.casebang.tech
```

执行 `sudo docker compose up -d` 重新创建受配置影响的容器。正式使用域名登录；此时直接通过 localhost 提交登录会因同源校验被拒绝，属于预期行为。

## 6. 启用每日定时

手动采集和历史数据切换验证完成后，把 `.env.production` 的 `INVENTORY_SCHEDULE_ENABLED` 改为 `true`，执行：

```bash
sudo docker compose up -d
sudo docker compose logs --tail=50 worker
```

定时功能由独立 worker 内置调度循环执行，不额外创建主机 cron/systemd timer。按北京时间 08:00 检查所有启用仓库；首次启动已过 08:00 时补采当天尚无基准的仓库。每仓每日最多三次自动尝试，失败重试间隔至少五分钟；成功后不重复覆盖当天基准。相同仓库的手动/定时任务会去重，后台逐仓处理，以限制外部接口和数据库压力。

只运行一个 worker。后台有新鲜心跳且启用了定时，网页才显示“云端定时已启用”。异常退出后，新 worker 最多等待旧心跳 90 秒过期后启动。

已入队的任务持久化保留；进程重启时正在执行的任务明确标为中断失败。当前版本重试从仓库目录重新采集，不支持批次级断点续传。已完成的库存不会被中断任务覆盖。

## 7. 备份、更新与回滚

创建一致性在线备份：

```bash
sudo docker compose exec web node scripts/backup.mjs
```

备份放在数据卷内 `backups` 目录。还需要定期把备份复制到服务器外，数据卷内备份不能防止服务器磁盘损坏。记录命令返回的文件名后，可通过 `docker compose cp web:/app/storage/backups/<文件名> ./<文件名>` 取出，文件不要提交 GitHub。

升级前备份、记录当前提交 SHA，再拉取、构建和 `up -d`。不要在有采集运行时更新 worker；若必须中断，重启后重新采集。数据库迁移自动执行，并记录已执行版本；迁移失败停止启动，不继续使用半迁移状态。

回滚代码前检查数据库结构兼容性。不要直接用旧备份覆盖上线后的新数据；恢复前先备份当前数据库并停止所有数据库写入进程。

## 8. 历史数据切换仍需单独完成

新部署默认空数据库，不会自动读取旧 Site 的数据。不要误把新站首日没有销售列当作历史数据已迁移。CK031 的 2026-09-29 完整快照与每日基准按《Site历史基准迁移》操作；其他仓库的历史快照、每日基准、仓库、采集记录等仍要单独导出、映射 owner、测试导入并逐仓核对；总体方案见《服务器部署与域名迁移方案》第 9 节。

未完成历史导入前可做手动连接测试，但不要宣布数据切换完成。历史不完整的日期不补零、不伪造基准。第一版账号为单管理员，不应把多名旧 owner 的数据无条件合并。

## 9. 本地验证命令

Node 24.14 或更高版本：

```text
npm ci
npm run build:ubuntu
npm test
npm run test:ubuntu
```

集成测试使用独立临时 SQLite 和模拟库存接口，不读取实际 AppSecret，不发送钉钉消息。测试覆盖匿名与伪造身份拒绝、登录/退出、同源检查、队列去重、重启持久化、网页服务关闭后的后台采集、失败状态、Excel，以及原有库存业务测试。

## 10. 钉钉云端 Stream 接入

见[钉钉云端接入](./钉钉云端接入.md)。填写 ClientID、ClientSecret、RobotCode 并重建容器后，worker 自动同步机器人所在群；网页“预警”中刷新群列表、勾选接收群、启用通知并保存，无需手填群 ID。运行时镜像仍包含 `scripts/dingtalk-stream.mjs --verify-events`，可用于事件订阅页连接验证；群发现及主动通知不依赖该工具持续运行。
