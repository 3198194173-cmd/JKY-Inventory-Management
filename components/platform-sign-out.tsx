'use client';
import { useState } from 'react';
import { LogOut } from 'lucide-react';

export function PlatformSignOut() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function signOut() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/session', { method: 'DELETE' });
      if (!response.ok) throw new Error('退出失败，请重试');
      window.location.assign('/login');
    } catch { setError('退出失败，请重试'); setBusy(false); }
  }
  return <div className="platform-sign-out"><button type="button" disabled={busy} onClick={signOut}><LogOut size={16}/>{busy ? '退出中…' : '退出登录'}</button>{error && <p role="alert">{error}</p>}</div>;
}
