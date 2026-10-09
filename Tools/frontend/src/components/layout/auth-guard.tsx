'use client';

import { useEffect, useState, useRef } from 'react';
import { useAuthStore } from '@/lib/auth-store';

const EXPIRY_WARNING_MS = 5 * 60 * 1000; // Warn 5 minutes before expiry

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [warningText, setWarningText] = useState<string | null>(null);
  const warningRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      window.location.href = '/auth';
      return;
    }
    useAuthStore.getState().hydrate();
    if (!useAuthStore.getState().isAuthenticated) return;
    setReady(true);
  }, []);

  // Single interval for both check + countdown — updates DOM directly, no React re-renders
  useEffect(() => {
    if (!ready) return;

    const interval = setInterval(() => {
      const store = useAuthStore.getState();
      if (store.isTokenExpired()) {
        store.logout();
        return;
      }
      const remaining = store.getTimeUntilExpiry();
      if (remaining <= EXPIRY_WARNING_MS && remaining > 0) {
        const mins = Math.floor(remaining / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        const text = `${mins}:${secs.toString().padStart(2, '0')}`;
        // Direct DOM update — avoids React re-render of entire tree
        if (warningRef.current) {
          warningRef.current.style.display = 'flex';
          const span = warningRef.current.querySelector('[data-countdown]');
          if (span) span.textContent = text;
        } else {
          setWarningText(text);
        }
      } else {
        if (warningRef.current) warningRef.current.style.display = 'none';
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [ready]);

  if (!ready) return null;

  return (
    <>
      {children}
      {/* Token expiry warning banner — hidden by default, shown via direct DOM update */}
      <div ref={warningRef} style={{ display: 'none' }}
        className='fixed top-0 left-0 right-0 z-[99999] items-center justify-center gap-3 bg-amber-500 text-white px-4 py-2 text-sm font-medium shadow-lg'>
        <svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
          <path d='M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z'/>
          <line x1='12' y1='9' x2='12' y2='13'/><line x1='12' y1='17' x2='12.01' y2='17'/>
        </svg>
        <span>Session expires in <strong data-countdown>{warningText}</strong></span>
        <button
          onClick={() => window.location.href = '/auth'}
          className='ml-2 px-3 py-1 rounded-md bg-white/20 hover:bg-white/30 text-xs font-semibold transition-colors'>
          Re-login
        </button>
        <button
          onClick={() => { if (warningRef.current) warningRef.current.style.display = 'none'; }}
          className='ml-1 px-2 py-1 rounded-md hover:bg-white/20 text-xs transition-colors'>
          Dismiss
        </button>
      </div>
    </>
  );
}
