"use client";
import { useEffect, useState } from 'react';

export function SessionKeeper() {
  const [status, setStatus] = useState<'ok' | 'retry' | 'expired'>('ok');
  useEffect(() => {
    const controller = new AbortController();
    let busy = false, expired = false, nextAttempt = 0;
    async function renew() {
      if (document.hidden || busy || expired || Date.now() < nextAttempt) return;
      busy = true;
      try {
        const response = await fetch('/api/session', { method: 'PATCH', credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (controller.signal.aborted) return;
        if (response.status === 401 || response.status === 403) {
          expired = true; setStatus('expired');
        } else if (response.ok) {
          nextAttempt = Date.now() + 15 * 60_000; setStatus('ok');
        } else {
          nextAttempt = Date.now() + 60_000; setStatus('retry');
        }
      } catch {
        if (!controller.signal.aborted) { nextAttempt = Date.now() + 60_000; setStatus('retry'); }
      } finally { busy = false; }
    }
    void renew();
    const timer = window.setInterval(() => { void renew(); }, 60_000);
    const onVisible = () => { void renew(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    window.addEventListener('pageshow', onVisible);
    return () => { controller.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onVisible); window.removeEventListener('pageshow', onVisible); };
  }, []);
  if (status === 'ok') return null;
  return <p className="account-session-status" role={status === 'expired' ? 'alert' : 'status'}>{status === 'expired' ? <>登录已过期或已被撤销，请<a href="/login">重新登录</a>。</> : '连接或身份核验暂时不可用，正在自动重试；登录凭证已保留。'}</p>;
}
