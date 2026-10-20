import { verificationRetryPath } from './session-policy';

export const platforms = [
  { id: 'jackyun', name: '吉客云', href: '/jackyun' },
  { id: 'kingdee', name: '金蝶', href: '/kingdee' },
] as const;
export type PlatformId = typeof platforms[number]['id'];

// Only known business destinations can be carried through the selection page.
export function platformDestination(value: unknown): { platform: PlatformId; href: string } | null {
  const safe = verificationRetryPath(value);
  if (safe === '/') return null;
  const parsed = new URL(safe, 'https://platform.invalid');
  const pathname = parsed.pathname;
  const platform = platforms.find(item => pathname === item.href || pathname.startsWith(item.href + '/'));
  if (platform) return { platform: platform.id, href: pathname + parsed.search };
  // Existing private alert report links belong to the Jackyun system.
  if (/^\/api\/alerts\/reports\/[A-Za-z0-9_-]+$/.test(pathname)) {
    return { platform: 'jackyun', href: pathname + parsed.search };
  }
  return null;
}

export function platformSelectionPath(returnTo?: unknown) {
  const target = platformDestination(returnTo);
  return target ? '/platforms?' + new URLSearchParams({ returnTo: target.href }) : '/platforms';
}

export function platformEntryPath(platform: PlatformId, returnTo?: unknown) {
  const target = platformDestination(returnTo);
  return target?.platform === platform ? target.href : platforms.find(item => item.id === platform)!.href;
}
