import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { parseEnv } from 'node:util';

// Prepares explicit opt-in configuration; never prints credentials or changes data ownership.
const file='.env.production';
if(!existsSync(file))throw new Error('请先运行 node scripts/server-config.mjs 创建配置文件');
let source=readFileSync(file,'utf8'),values=parseEnv(source);
const initial={INVENTORY_DINGTALK_LOGIN_ENABLED:'false',INVENTORY_LOCAL_LOGIN_ENABLED:'true',DINGTALK_CORP_ID:'ding59f3632868ff8b8235c2f4657eb6378f',DINGTALK_ADMIN_UNION_ID:'fnul0pTq5XHzntrrhu8MWgiEiE',DINGTALK_ADMIN_USER_ID:'',DINGTALK_LOGIN_CLIENT_ID:'',DINGTALK_LOGIN_CLIENT_SECRET:''};
function set(key,value){if(/[\r\n]/.test(value))throw new Error('配置不能含换行');const line=key+'='+JSON.stringify(value);const re=new RegExp('^'+key+'=.*$','m');source=re.test(source)?source.replace(re,()=>line):source.replace(/\s*$/,'')+'\n'+line+'\n';values[key]=value;}
for(const [key,value] of Object.entries(initial))if(values[key]===undefined)set(key,value);
if(process.argv.includes('--use-robot-app')){
  if(!values.DINGTALK_CLIENT_ID||!values.DINGTALK_CLIENT_SECRET)throw new Error('现有机器人凭证不完整，请先配置');
  set('DINGTALK_LOGIN_CLIENT_ID',values.DINGTALK_CLIENT_ID);set('DINGTALK_LOGIN_CLIENT_SECRET',values.DINGTALK_CLIENT_SECRET);
}
if(process.argv.includes('--enable')){
  const site=new URL(values.INVENTORY_SITE_URL||'');
  if(site.protocol!=='https:'||site.username||site.password||!values.DINGTALK_CORP_ID||!values.DINGTALK_LOGIN_CLIENT_ID||!values.DINGTALK_LOGIN_CLIENT_SECRET||!(values.DINGTALK_ADMIN_USER_ID||values.DINGTALK_ADMIN_UNION_ID))throw new Error('请先填写 HTTPS 地址、CorpID、指定管理员身份和登录应用凭证');
  set('INVENTORY_DINGTALK_LOGIN_ENABLED','true');set('INVENTORY_LOCAL_LOGIN_ENABLED','false');
}
if(process.argv.includes('--disable')){set('INVENTORY_DINGTALK_LOGIN_ENABLED','false');set('INVENTORY_LOCAL_LOGIN_ENABLED','true');}
writeFileSync(file,source,{mode:0o600});if(process.platform!=='win32')chmodSync(file,0o600);
console.log('钉钉登录配置已保存，密钥不会输出。');
console.log('回调地址：'+(values.INVENTORY_SITE_URL||'').replace(/\/$/,'')+'/api/auth/dingtalk/callback');
console.log('当前钉钉登录：'+values.INVENTORY_DINGTALK_LOGIN_ENABLED+'；修改后需重新创建 web 和 worker 容器。');
