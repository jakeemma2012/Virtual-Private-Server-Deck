'use client';
import React from 'react';
import { ActiveThemeProvider } from '../themes/active-theme';
import QueryProvider from './query-provider';
import { NotifyProvider } from '../ui/notify';
import { UploadProvider } from '../ui/upload-manager';
import { DownloadProvider } from '../ui/download-manager';

export default function Providers({
  activeThemeValue,
  children
}: {
  /** Tuỳ chọn. Static export không có server đọc cookie, nên bỏ trống thì
   *  ActiveThemeProvider tự đọc cookie ở client. */
  activeThemeValue?: string;
  children: React.ReactNode;
}) {
  return (
    <ActiveThemeProvider initialTheme={activeThemeValue}>
      <QueryProvider>
        <NotifyProvider>
          <UploadProvider>
            <DownloadProvider>{children}</DownloadProvider>
          </UploadProvider>
        </NotifyProvider>
      </QueryProvider>
    </ActiveThemeProvider>
  );
}
