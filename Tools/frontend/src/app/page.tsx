'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Chuyển về trang đăng nhập.
 *
 * Trước đây file này gọi `redirect('/auth')` của `next/navigation`. Đó là
 * redirect phía SERVER, và với `output: 'export'` thì không có server nào thực
 * hiện nó: Next **không** báo lỗi lúc build mà nướng luôn trang lỗi vào
 * `out/index.html`, nên mở `/` ra là thấy "This page couldn't load" của error
 * boundary. Trang trả HTTP 200, chỉ nội dung là trang lỗi — vì vậy kiểm bằng
 * status code không phát hiện được.
 *
 * Với một SPA tĩnh thì điều hướng phải nằm ở client.
 */
export default function Home() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/auth');
  }, [router]);

  // Khung chờ thay cho màn hình trắng trong lúc chuyển trang.
  return (
    <div className='flex min-h-screen items-center justify-center bg-background'>
      <div className='size-6 animate-spin rounded-full border-2 border-muted border-t-primary' />
      <span className='sr-only'>Đang chuyển tới trang đăng nhập…</span>
    </div>
  );
}
