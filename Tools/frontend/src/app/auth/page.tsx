'use client';

import { useState } from 'react';
import { useNotify } from '@/components/ui/notify';
import { useAuthStore } from '@/lib/auth-store';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export default function AuthPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const notify = useNotify();
  const authLogin = useAuthStore(s => s.login);

  const handleLogin = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();

      if (!res.ok) {
        notify.error(data.error || 'Login failed');
        setLoading(false);
        return;
      }

      // Use auth store for consistent token management + expiry tracking
      authLogin(data.token, data.username, data.role);
      notify.success('Login successful');
      setTimeout(() => { window.location.href = '/dashboard/overview'; }, 500);
    } catch (err: any) {
      notify.error(err.message || 'Network error');
      setLoading(false);
    }
  };

  const handleSubmitKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') handleLogin();
  };

  return (
    <div className='flex min-h-screen items-center justify-center bg-background p-4'>
      <Card className='animate-pop w-full max-w-sm shadow-soft-lg'>
        <CardHeader className='flex flex-col items-center gap-1.5 text-center'>
          <div className='mb-2 flex size-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-soft'>
            <svg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'><path d='M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z'/><path d='m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z'/><path d='M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0'/><path d='M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5'/></svg>
          </div>
          <CardTitle className='text-xl'>VPSDeck</CardTitle>
          <CardDescription>Sign in to manage your servers</CardDescription>
        </CardHeader>

        <CardContent className='space-y-4'>
          <div className='space-y-2'>
            <Label htmlFor='username'>Username</Label>
            <Input
              id='username'
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder='admin'
              autoComplete='username'
              onKeyDown={handleSubmitKey}
            />
          </div>
          <div className='space-y-2'>
            <Label htmlFor='password'>Password</Label>
            <Input
              id='password'
              type='password'
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder='••••••••'
              autoComplete='current-password'
              onKeyDown={handleSubmitKey}
            />
          </div>
          <Button
            className='w-full'
            onClick={handleLogin}
            disabled={loading || !username || !password}
            isLoading={loading}
          >
            Sign In
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
