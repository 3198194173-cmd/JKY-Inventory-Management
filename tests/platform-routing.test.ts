import assert from 'node:assert/strict';
import { test } from 'node:test';
import { platformDestination, platformEntryPath, platformSelectionPath } from '../lib/platform-routing';

test('登录先选平台，站内目标只在选对平台时恢复', () => {
  assert.equal(platformSelectionPath('/'), '/platforms');
  const deep = '/kingdee/reports?batch=20261019';
  assert.equal(platformEntryPath('kingdee', deep), deep);
  assert.equal(platformEntryPath('jackyun', deep), '/jackyun');
  assert.equal(platformSelectionPath(deep), '/platforms?returnTo=%2Fkingdee%2Freports%3Fbatch%3D20261019');
  assert.equal(platformEntryPath('jackyun', '/api/alerts/reports/private-token'), '/api/alerts/reports/private-token');
});

test('外部地址、伪前缀、控制字符及未知资源不成为平台目标', () => {
  for (const value of ['https://evil.test', '//evil.test', '/\\evil.test', '/kingdee\n/reports', '/jackyun-other', '/api/admin/accounts', '/api/alerts/reports/token/export', '/kingdee/../../api/session', '/%2f%2fevil.test', ['kingdee']]) {
    assert.equal(platformDestination(value), null, String(value));
    assert.equal(platformSelectionPath(value), '/platforms');
  }
});
