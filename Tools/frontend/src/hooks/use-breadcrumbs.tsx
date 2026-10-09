'use client';

import { usePathname } from 'next/navigation';
import { useMemo } from 'react';

type BreadcrumbItem = {
  title: string;
  link: string;
};

const routeMapping: Record<string, BreadcrumbItem[]> = {
  '/dashboard': [{ title: 'Dashboard', link: '/dashboard' }],
  '/dashboard/overview': [
    { title: 'Dashboard', link: '/dashboard' },
    { title: 'Overview', link: '/dashboard/overview' }
  ],
  '/dashboard/servers': [
    { title: 'Dashboard', link: '/dashboard' },
    { title: 'VPS Servers', link: '/dashboard/servers' }
  ],
  '/dashboard/terminal': [
    { title: 'Dashboard', link: '/dashboard' },
    { title: 'Terminal', link: '/dashboard/terminal' }
  ],
  '/dashboard/files': [
    { title: 'Dashboard', link: '/dashboard' },
    { title: 'File Manager', link: '/dashboard/files' }
  ],
  '/dashboard/website': [
    { title: 'Dashboard', link: '/dashboard' },
    { title: 'Website', link: '/dashboard/website' }
  ],
  '/dashboard/docker': [
    { title: 'Dashboard', link: '/dashboard' },
    { title: 'Docker', link: '/dashboard/docker' }
  ],
  '/dashboard/nginx': [
    { title: 'Dashboard', link: '/dashboard' },
    { title: 'Nginx', link: '/dashboard/nginx' }
  ],
  '/dashboard/database': [
    { title: 'Dashboard', link: '/dashboard' },
    { title: 'Database', link: '/dashboard/database' }
  ],
  '/dashboard/firewall': [
    { title: 'Dashboard', link: '/dashboard' },
    { title: 'Firewall', link: '/dashboard/firewall' }
  ],
  '/dashboard/alerts': [
    { title: 'Dashboard', link: '/dashboard' },
    { title: 'Alerts', link: '/dashboard/alerts' }
  ],
  '/dashboard/cron': [
    { title: 'Dashboard', link: '/dashboard' },
    { title: 'Cron Jobs', link: '/dashboard/cron' }
  ],
  '/dashboard/ssl': [
    { title: 'Dashboard', link: '/dashboard' },
    { title: 'SSL Certificates', link: '/dashboard/ssl' }
  ],
  '/dashboard/settings': [
    { title: 'Dashboard', link: '/dashboard' },
    { title: 'Settings', link: '/dashboard/settings' }
  ]
};

export function useBreadcrumbs() {
  const pathname = usePathname();

  const breadcrumbs = useMemo(() => {
    if (routeMapping[pathname]) {
      return routeMapping[pathname];
    }

    const segments = pathname.split('/').filter(Boolean);
    return segments.map((segment, index) => {
      const path = `/${segments.slice(0, index + 1).join('/')}`;
      return {
        title: segment.charAt(0).toUpperCase() + segment.slice(1),
        link: path
      };
    });
  }, [pathname]);

  return breadcrumbs;
}
