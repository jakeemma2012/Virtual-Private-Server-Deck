'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Chuyển tới trang tổng quan.
 *
 * Cùng lý do như `app/page.tsx`: `redirect()` của `next/navigation` là tính
 * năng server, không dùng được với `output: 'export'`. Điều hướng ở client.
 */
export default function DashboardPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/dashboard/overview');
  }, [router]);

  return (
    <div className='flex flex-1 items-center justify-center p-8'>
      <div className='size-6 animate-spin rounded-full border-2 border-muted border-t-primary' />
      <span className='sr-only'>Đang mở trang tổng quan…</span>
    </div>
  );
}
