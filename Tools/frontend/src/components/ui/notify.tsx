'use client';

import { createContext, useContext, useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Icons } from '@/components/icons';

type NotifyType = 'success' | 'error' | 'info' | 'warning';

interface Notification {
  id: number;
  type: NotifyType;
  message: string;
  fading: boolean;
}

interface ConfirmState {
  message: string;
  resolve: (ok: boolean) => void;
}

interface NotifyContextType {
  success: (msg: string) => void;
  error: (msg: string) => void;
  info: (msg: string) => void;
  warning: (msg: string) => void;
  confirm: (msg: string) => Promise<boolean>;
}

const NotifyContext = createContext<NotifyContextType | null>(null);

export function useNotify() {
  const ctx = useContext(NotifyContext);
  if (!ctx) throw new Error('useNotify must be used within NotifyProvider');
  return ctx;
}

let idCounter = 0;

export function NotifyProvider({ children }: { children: React.ReactNode }) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);

  const add = useCallback((type: NotifyType, message: string) => {
    const id = ++idCounter;
    setNotifications(prev => [...prev, { id, type, message, fading: false }]);
    setTimeout(() => {
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, fading: true } : n));
    }, 2500);
    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== id));
    }, 3000);
  }, []);

  const dismiss = useCallback((id: number) => {
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, fading: true } : n));
    setTimeout(() => setNotifications(prev => prev.filter(n => n.id !== id)), 300);
  }, []);

  const confirmFn = useCallback((message: string): Promise<boolean> => {
    return new Promise((resolve) => {
      setConfirmState({ message, resolve });
    });
  }, []);

  const handleConfirm = (ok: boolean) => {
    confirmState?.resolve(ok);
    setConfirmState(null);
  };

  const ctx: NotifyContextType = {
    success: useCallback((msg: string) => add('success', msg), [add]),
    error: useCallback((msg: string) => add('error', msg), [add]),
    info: useCallback((msg: string) => add('info', msg), [add]),
    warning: useCallback((msg: string) => add('warning', msg), [add]),
    confirm: confirmFn,
  };

  const iconMap = {
    success: Icons.circleCheck,
    error: Icons.circleX,
    info: Icons.info,
    warning: Icons.warning,
  };

  const colorMap = {
    success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    error: 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400',
    info: 'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400',
    warning: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  };

  const iconColorMap = {
    success: 'text-emerald-500',
    error: 'text-red-500',
    info: 'text-blue-500',
    warning: 'text-amber-500',
  };

  return (
    <NotifyContext.Provider value={ctx}>
      {children}

      {/* Toast notifications - center screen */}
      {notifications.length > 0 && (
        <div className='fixed inset-0 z-[99999] pointer-events-none flex flex-col items-center justify-center gap-2'>
          {notifications.map(n => {
            const Icon = iconMap[n.type];
            return (
              <div key={n.id}
                className={cn(
                  'pointer-events-auto flex items-center gap-3 px-5 py-3 rounded-xl border shadow-lg backdrop-blur-sm max-w-sm transition-all duration-300 cursor-pointer',
                  colorMap[n.type],
                  n.fading ? 'opacity-0 scale-95 translate-y-2' : 'opacity-100 scale-100 translate-y-0 animate-in fade-in-0 zoom-in-95'
                )}
                onClick={() => dismiss(n.id)}>
                <Icon className={cn('size-5 shrink-0', iconColorMap[n.type])} />
                <span className='text-sm font-medium'>{n.message}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Confirm dialog - center screen, themed */}
      {confirmState && (
        <div className='fixed inset-0 z-[99998] flex items-center justify-center'>
          <div className='absolute inset-0 bg-black/40 backdrop-blur-[2px]' onClick={() => handleConfirm(false)} />
          <div className='relative bg-card text-card-foreground border rounded-xl shadow-2xl w-full max-w-sm mx-4 animate-in fade-in-0 zoom-in-95'>
            <div className='p-5'>
              <div className='flex items-start gap-3'>
                <div className='flex size-10 shrink-0 items-center justify-center rounded-full bg-amber-500/10'>
                  <Icons.warning className='size-5 text-amber-500' />
                </div>
                <div className='flex-1 min-w-0 pt-1'>
                  <h3 className='font-semibold text-sm'>Confirm</h3>
                  <p className='text-sm text-muted-foreground mt-1'>{confirmState.message}</p>
                </div>
              </div>
            </div>
            <div className='flex items-center justify-end gap-2 px-5 py-3 border-t bg-muted/30 rounded-b-xl'>
              <button onClick={() => handleConfirm(false)}
                className='px-4 py-1.5 text-sm rounded-md border hover:bg-muted transition-colors'>
                Cancel
              </button>
              <button onClick={() => handleConfirm(true)}
                className='px-4 py-1.5 text-sm rounded-md bg-destructive text-white hover:bg-destructive/90 transition-colors font-medium'>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </NotifyContext.Provider>
  );
}
