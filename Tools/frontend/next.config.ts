import type { NextConfig } from 'next';

/**
 * Static export: `next build` sinh ra thư mục `out/` gồm HTML/CSS/JS thuần, và
 * gateway Rust serve trực tiếp thư mục đó. Nhờ vậy production không còn cần
 * nginx lẫn tiến trình Node — chỉ một binary.
 *
 * App này 100% client-side (mọi page đều 'use client', auth bằng token trong
 * localStorage, dữ liệu lấy qua /api), và không có dynamic route nào, nên static
 * export không mất tính năng gì.
 *
 * `rewrites` cũ (proxy /api -> localhost:8080) đã bỏ: nó là tính năng của
 * Next server, không tồn tại trong static export. Khi chạy `next dev`, trỏ
 * frontend sang backend bằng biến môi trường:
 *
 *   NEXT_PUBLIC_API_URL=http://localhost:8080 npm run dev
 *
 * Ở production để trống — frontend và API cùng origin do Rust serve cả hai.
 */
const nextConfig: NextConfig = {
  output: 'export',

  // Static export không có server để tối ưu ảnh lúc chạy.
  images: { unoptimized: true },

  // Mỗi route thành <route>/index.html — khớp với cách ServeDir của tower-http
  // tìm index trong thư mục, nên không cần luật rewrite nào ở phía Rust.
  trailingSlash: true,
};

export default nextConfig;
