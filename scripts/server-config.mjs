import { randomBytes, scryptSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const password = randomBytes(18).toString('base64url'), salt = randomBytes(16).toString('hex');
const hash = scryptSync(password,salt,64).toString('hex');
const config = `INVENTORY_SITE_URL=http://localhost:3108
INVENTORY_USERNAME=admin
INVENTORY_PASSWORD_HASH=${salt}:${hash}
INVENTORY_OWNER_ID=admin
INVENTORY_SCHEDULE_ENABLED=false
INVENTORY_CRON_SECRET=${randomBytes(32).toString('hex')}
JACKYUN_APP_KEY=92058521
JACKYUN_APP_SECRET=
DINGTALK_CLIENT_ID=
DINGTALK_CLIENT_SECRET=
DINGTALK_ROBOT_CODE=
DINGTALK_OPEN_CONVERSATION_ID=
`;
writeFileSync('.env.production',config,{flag:'wx',mode:0o600});
console.log('已创建 .env.production（不会覆盖已有文件）。登录账号：admin');
console.log('请立即保存初始登录密码：'+password);
console.log('填写吉客云 AppSecret 后启动。域名启用时修改 INVENTORY_SITE_URL，定时启用时设置 INVENTORY_SCHEDULE_ENABLED=true。');
