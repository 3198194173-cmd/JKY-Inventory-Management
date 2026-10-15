import { createHash, randomBytes } from 'node:crypto';
import { sqlite } from './sqlite.mjs';
import { AccessError, type Account, type CompanyIdentity, accountById, accountByOwner, assertOwnerActive, companyLoginEnabled, markDeparted } from './accounts';

const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
export const loginBrowserCookie='inventory_login_browser';
export function loginConfig(){
  const corpId=process.env.DINGTALK_CORP_ID||'',clientId=process.env.DINGTALK_LOGIN_CLIENT_ID||'',secret=process.env.DINGTALK_LOGIN_CLIENT_SECRET||'';
  let origin='';try{const u=new URL(process.env.INVENTORY_SITE_URL||'');if(u.protocol==='https:'&&!u.username&&!u.password)origin=u.origin;}catch{}
  const ready=!!(corpId&&clientId&&secret&&origin&&(process.env.DINGTALK_ADMIN_USER_ID||process.env.DINGTALK_ADMIN_UNION_ID));
  return {corpId,clientId,secret,origin,ready};
}
export function beginDingLogin(returnTo='/'){
  const config=loginConfig();if(!companyLoginEnabled()||!config.ready)throw new AccessError('钉钉登录尚未配置完成',503);
  const state=randomBytes(32).toString('base64url'),browser=randomBytes(32).toString('base64url');
  let safeReturn='/';
  if(returnTo.startsWith('/')&&!returnTo.startsWith('//')&&!/[\\\x00-\x20\x7f]/.test(returnTo)&&returnTo.length<512){const u=new URL(returnTo,config.origin);if(u.origin===config.origin)safeReturn=u.pathname+u.search;}
  const db=sqlite();db.prepare('DELETE FROM login_transactions WHERE expires_at<?').run(Date.now());
  if(Number(db.prepare('SELECT COUNT(*) AS n FROM login_transactions').get()!.n)>2000)throw new AccessError('登录请求较多，请稍后重试',429);
  db.prepare('INSERT INTO login_transactions VALUES(?,?,?,?)').run(digest(state),digest(browser),Date.now()+300000,safeReturn);
  const url=new URL('https://login.dingtalk.com/oauth2/auth');
  url.search=new URLSearchParams({redirect_uri:config.origin+'/api/auth/dingtalk/callback',client_id:config.clientId,response_type:'code',scope:'openid corpid',prompt:'consent',corpId:config.corpId,state}).toString();
  return {url:url.toString(),browser};
}
export function consumeDingLogin(state:string,browser:string){
  if(!/^[\w-]{43}$/.test(state)||!/^[\w-]{43}$/.test(browser))throw new AccessError('登录校验失败，请重新发起登录',400);
  const row=sqlite().prepare('DELETE FROM login_transactions WHERE state_hash=? AND browser_hash=? AND expires_at>? RETURNING return_to').get(digest(state),digest(browser),Date.now());
  if(!row)throw new AccessError('登录已过期或已使用，请重新发起登录',400);
  return String(row.return_to);
}
export class NotCompanyMember extends AccessError {constructor(){super('仅允许本公司有效成员登录');}}
async function json(url:string,options:RequestInit,fetcher:typeof fetch){
  let response:Response;
  try{response=await fetcher(url,{...options,signal:AbortSignal.timeout(15000),redirect:'error',cache:'no-store'});}catch{throw new AccessError('暂时无法核验钉钉身份，请稍后重试',503);}
  const data=await response.json().catch(()=>null) as Record<string,unknown>|null;
  if(!response.ok||!data)throw new AccessError('钉钉身份接口不可用，请检查应用权限后重试',503);
  return data;
}
async function appToken(fetcher:typeof fetch){
  const config=loginConfig();if(!config.ready)throw new AccessError('钉钉登录配置不完整',503);
  const data=await json('https://api.dingtalk.com/v1.0/oauth2/accessToken',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({appKey:config.clientId,appSecret:config.secret})},fetcher);
  if(typeof data.accessToken!=='string')throw new AccessError('钉钉企业凭证不可用',503);
  return data.accessToken;
}
async function companyPost(path:string,body:Record<string,unknown>,token:string,fetcher:typeof fetch){
  const url=new URL('https://oapi.dingtalk.com/'+path);url.searchParams.set('access_token',token);
  const data=await json(url.toString(),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},fetcher);
  if(Number(data.errcode)!==0){
    if([60121,60111,60112].includes(Number(data.errcode)))throw new NotCompanyMember();
    throw new AccessError('公司通讯录核验失败，请检查应用通讯录范围与权限',503);
  }
  return data.result as Record<string,unknown>;
}
function employee(result:Record<string,unknown>,userId:string,unionId:string):CompanyIdentity{
  if(!result||result.userid!==userId||result.unionid!==unionId||!Array.isArray(result.dept_id_list)||!result.dept_id_list.length)throw new NotCompanyMember();
  // active means activation, not employment; membership is proved by the company-scoped directory result.
  return {corpId:loginConfig().corpId,userId,unionId,name:typeof result.name==='string'?result.name:userId,avatar:typeof result.avatar==='string'&&result.avatar.startsWith('https://')?result.avatar:''};
}
export async function verifyCompanyLogin(code:string,fetcher:typeof fetch=fetch){
  if(!code||code.length>2048)throw new AccessError('登录授权码无效',400);
  const config=loginConfig();
  const userToken=await json('https://api.dingtalk.com/v1.0/oauth2/userAccessToken',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientId:config.clientId,clientSecret:config.secret,code,grantType:'authorization_code'})},fetcher);
  if(userToken.corpId!==config.corpId)throw new NotCompanyMember();
  if(typeof userToken.accessToken!=='string')throw new AccessError('无法取得钉钉登录凭证',503);
  const me=await json('https://api.dingtalk.com/v1.0/contact/users/me',{headers:{'x-acs-dingtalk-access-token':userToken.accessToken}},fetcher);
  if(typeof me.unionId!=='string'||!me.unionId)throw new NotCompanyMember();
  const token=await appToken(fetcher),mapped=await companyPost('topapi/user/getbyunionid',{unionid:me.unionId},token,fetcher);
  if(typeof mapped?.userid!=='string'||!mapped.userid)throw new NotCompanyMember();
  return employee(await companyPost('topapi/v2/user/get',{userid:mapped.userid},token,fetcher),mapped.userid,me.unionId);
}
export async function verifyEmployee(account:Account,fetcher:typeof fetch=fetch){
  if(account.corp_id!==loginConfig().corpId||!account.dingtalk_user_id||!account.union_id)throw new NotCompanyMember();
  const token=await appToken(fetcher);
  return employee(await companyPost('topapi/v2/user/get',{userid:account.dingtalk_user_id},token,fetcher),account.dingtalk_user_id,account.union_id);
}
const checking=new Map<string,Promise<void>>();
export async function ensureOwnerAccess(owner:string){
  assertOwnerActive(owner);
  const account=accountByOwner(owner);
  if(!account||account.provider!=='dingtalk'||(!companyLoginEnabled()))return;
  if(Date.now()-account.membership_checked_at<900000)return;
  if(!checking.has(account.id))checking.set(account.id,(async()=>{
    try{
      await verifyEmployee(account);
      const latest=accountById(account.id);if(latest?.status!=='active')throw new AccessError('账户已禁用');
      sqlite().prepare("UPDATE accounts SET membership_checked_at=?,member_state='verified' WHERE id=? AND status='active'").run(Date.now(),account.id);
    }catch(e){if(e instanceof NotCompanyMember)markDeparted(account.id);throw e;}
  })().finally(()=>checking.delete(account.id)));
  await checking.get(account.id);assertOwnerActive(owner);
}
