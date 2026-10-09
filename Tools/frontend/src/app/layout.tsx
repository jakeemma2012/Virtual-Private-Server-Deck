import Providers from '@/components/layout/providers';
import { fontVariables } from '@/components/themes/font.config';
import { DEFAULT_THEME, THEMES } from '@/components/themes/theme.config';
import ThemeProvider from '@/components/themes/theme-provider';
import { cn } from '@/lib/utils';
import type { Metadata, Viewport } from 'next';
import NextTopLoader from 'nextjs-toploader';
import ViewportScale from '@/components/layout/viewport-scale';
import { NuqsAdapter } from 'nuqs/adapters/next/app';
import '../styles/globals.css';

const META_THEME_COLORS = {
  light: '#ffffff',
  dark: '#09090b'
};

export const metadata: Metadata = {
  title: 'VPSDeck — Server Control Panel',
  description: 'Comprehensive VPS Management Dashboard'
};

export const viewport: Viewport = {
  themeColor: META_THEME_COLORS.light,
  width: 'device-width',
  initialScale: 1
};

// Danh sách theme hợp lệ, nhúng vào script inline bên dưới để nó tự kiểm tra
// mà không cần import gì ở runtime.
const VALID_THEMES = JSON.stringify(THEMES.map((t) => t.value));

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // data-theme được script inline đặt TRƯỚC khi vẽ. Trước đây giá trị này do
    // server đọc cookie rồi render ra, nhưng static export không có server —
    // và đọc ở client trong <head> cũng tránh được flash y như vậy.
    <html lang='vi' suppressHydrationWarning data-theme={DEFAULT_THEME}>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                var m = document.cookie.match(/(?:^|;\\s*)active_theme=([^;]*)/);
                var t = m && decodeURIComponent(m[1]);
                if (t && ${VALID_THEMES}.indexOf(t) !== -1) {
                  document.documentElement.setAttribute('data-theme', t);
                }
              } catch (_) {}
            `
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                if (localStorage.theme === 'dark' || ((!('theme' in localStorage) || localStorage.theme === 'system') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
                  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '${META_THEME_COLORS.dark}')
                }
              } catch (_) {}
            `
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                var sw = window.screen.width || window.innerWidth || 0;
                if (sw && sw <= 820) {
                  var dw = 819;
                  var scale = Math.round((sw / dw) * 1000) / 1000;
                  var vp = document.querySelector('meta[name="viewport"]');
                  if (!vp) { vp = document.createElement('meta'); vp.setAttribute('name','viewport'); document.head.appendChild(vp); }
                  // Fixed initial-scale (not browser auto-fit) so async content reflow
                  // (e.g. the file manager table loading) can't change the zoom level.
                  vp.setAttribute('content', 'width=' + dw + ', initial-scale=' + scale + ', user-scalable=yes');
                }
              } catch (_) {}
            `
          }}
        />
      </head>
      <body
        className={cn(
          'bg-background overflow-x-hidden overscroll-none font-sans antialiased',
          fontVariables
        )}
      >
        <NextTopLoader color='var(--primary)' showSpinner={false} />
        <ViewportScale />
        <NuqsAdapter>
          <ThemeProvider
            attribute='class'
            defaultTheme='system'
            enableSystem
            disableTransitionOnChange
            enableColorScheme
          >
            <Providers>
              {children}
            </Providers>
          </ThemeProvider>
        </NuqsAdapter>
      </body>
    </html>
  );
}
