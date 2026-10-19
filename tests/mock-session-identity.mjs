// Test-only deterministic company directory; never loaded in production.
import { readFileSync } from 'node:fs';
globalThis.fetch = async (url, init) => {
  const mode = readFileSync(process.env.MOCK_IDENTITY_STATE_PATH, 'utf8').trim();
  if (mode === 'unavailable') throw new Error('offline identity test');
  const path = new URL(String(url)).pathname;
  if (path === '/v1.0/oauth2/accessToken') return Response.json({ accessToken: 'offline-test-token' });
  if (path === '/topapi/v2/user/get') {
    if (mode === 'departed') return Response.json({ errcode: 60111 });
    const { userid } = JSON.parse(String(init.body));
    return Response.json({ errcode: 0, result: { userid, unionid: 'union-' + userid, name: userid, dept_id_list: [1] } });
  }
  throw new Error('Unexpected request in session test');
};
