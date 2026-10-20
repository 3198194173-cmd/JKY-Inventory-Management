// Local-only preview with a separate database; never loads production accounts.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, scryptSync } from 'node:crypto';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

if (!existsSync('.next/standalone/server.js')) throw new Error('请先运行 npm run build');
const testLogin = process.argv.includes('--test-login');
const port = Number(process.env.PLATFORM_PREVIEW_PORT || (testLogin ? 3109 : 3108));
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('预览端口无效');
const directory = resolve(testLogin ? '.sites-runtime/platform-preview/current' : '.sites-runtime/platform-preview/company');
mkdirSync(directory, { recursive: true });
const username = 'preview', password = testLogin ? randomBytes(12).toString('base64url') : '', salt = randomBytes(16).toString('hex');
const url = `http://127.0.0.1:${port}`;
const login = { url, username, password, database: resolve(directory, 'inventory.sqlite') };
if (testLogin) writeFileSync(resolve('.sites-runtime/platform-preview/latest.json'), JSON.stringify({ ...login, testOnly: true }, null, 2));
cpSync('drizzle', '.next/standalone/drizzle', { recursive: true });
cpSync('public', '.next/standalone/public', { recursive: true });
cpSync('.next/static', '.next/standalone/.next/static', { recursive: true });
// Real company login reads only explicitly configured authentication values. Never use .env.example.
const settings = existsSync('.env.production') ? parseEnv(readFileSync('.env.production', 'utf8')) : {};
const company = {};
for (const key of ['DINGTALK_CORP_ID', 'DINGTALK_LOGIN_CLIENT_ID', 'DINGTALK_LOGIN_CLIENT_SECRET', 'DINGTALK_ADMIN_USER_ID', 'DINGTALK_ADMIN_UNION_ID', 'INVENTORY_SITE_URL']) company[key] = process.env[key] || settings[key] || '';
const env = {
  ...process.env, PORT: String(port), HOSTNAME: '127.0.0.1', INVENTORY_SITE_URL: url,
  INVENTORY_DB_PATH: login.database, INVENTORY_USERNAME: username,
  KINGDEE_DB_PATH: resolve(directory, 'kingdee.sqlite'), KINGDEE_STORAGE_DIR: resolve(directory, 'kingdee-files'),
  INVENTORY_PASSWORD_HASH: `${salt}:${scryptSync(password, salt, 64).toString('hex')}`,
  INVENTORY_OWNER_ID: 'local-platform-preview', INVENTORY_DINGTALK_LOGIN_ENABLED: testLogin ? 'false' : 'true',
  INVENTORY_LOCAL_LOGIN_ENABLED: testLogin ? 'true' : 'false', INVENTORY_SCHEDULE_ENABLED: 'false',
  JACKYUN_APP_SECRET: '', DINGTALK_CLIENT_SECRET: '', DINGTALK_LOGIN_CLIENT_SECRET: '',
  ...(testLogin ? {} : company), INVENTORY_PREVIEW_TEST_LOGIN: testLogin ? 'true' : 'false',
};
console.log('仅本机预览，独立数据库（重启保留导入），未启动吉客云采集worker。');
if (testLogin) { console.log('仅开发回归：显式启用隔离测试登录，不是正式业务登录。'); console.log(JSON.stringify({ url, username, password }, null, 2)); }
else { console.log(JSON.stringify({ url, login: '公司钉钉登录', localPasswordLogin: false })); console.log('真实扫码需要已配置的HTTPS站点及已登记的钉钉回调；localhost不会代替正式回调，也不自动开放密码入口。'); }
const server = spawn(process.execPath, ['.next/standalone/server.js'], { env, stdio: 'inherit' });
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.on('exit', code => { process.exitCode = code || 0; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill());
