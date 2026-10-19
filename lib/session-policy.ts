const DAY = 86400;
export function sessionMaxAge(company: boolean) {
  if (!company) return DAY;
  const days = Number(process.env.INVENTORY_SESSION_DAYS || 30);
  return (Number.isInteger(days) && days >= 1 && days <= 90 ? days : 30) * DAY;
}
export function sessionCookieOptions(company: boolean, requestUrl: string) {
  return { httpOnly: true, secure: (process.env.INVENTORY_SITE_URL || requestUrl).startsWith('https:'), sameSite: company ? 'lax' as const : 'strict' as const, path: '/', maxAge: sessionMaxAge(company) };
}
export function verificationRetryPath(value: unknown) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !/[\\\x00-\x20\x7f]/.test(value) && value.length < 512 ? value : '/';
}
