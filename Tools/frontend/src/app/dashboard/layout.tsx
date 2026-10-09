import KBar from '@/components/kbar';
import AppSidebar from '@/components/layout/app-sidebar';
import Header from '@/components/layout/header';
import AuthGuard from '@/components/layout/auth-guard';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'VPS Manager Dashboard',
  description: 'Manage all your VPS servers from one place',
  robots: { index: false, follow: false }
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Trạng thái mở/đóng sidebar trước đây đọc từ cookie ở server. Static export
  // không có server, nên để SidebarProvider tự đọc ở client (nó đã ghi cookie
  // `sidebar_state` rồi, chỉ là trước đây không tự đọc lại).
  return (
    <AuthGuard>
      <KBar>
        <SidebarProvider>
          <AppSidebar />
          <SidebarInset>
            <Header />
            <div className='animate-fade flex flex-1 flex-col'>{children}</div>
          </SidebarInset>
        </SidebarProvider>
      </KBar>
    </AuthGuard>
  );
}
