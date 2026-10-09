import { NavGroup } from '@/types';

export const navGroups: NavGroup[] = [
  {
    label: 'Overview',
    items: [
      {
        title: 'Dashboard',
        url: '/dashboard/overview',
        icon: 'dashboard',
        isActive: true,
        shortcut: ['g', 'd']
      }
    ]
  },
  {
    label: 'Server Management',
    items: [
      {
        title: 'VPS Servers',
        url: '/dashboard/servers',
        icon: 'server',
        shortcut: ['g', 's']
      },
      {
        title: 'Terminal',
        url: '/dashboard/terminal',
        icon: 'terminal',
        shortcut: ['g', 't']
      },
      {
        title: 'File Manager',
        url: '/dashboard/files',
        icon: 'folder',
        shortcut: ['g', 'f']
      },
      {
        title: 'Website',
        url: '/dashboard/website',
        icon: 'globe',
        shortcut: ['g', 'w']
      }
    ]
  },
  {
    label: 'Services',
    items: [
      {
        title: 'Docker',
        url: '/dashboard/docker',
        icon: 'docker'
      },
      {
        title: 'Nginx',
        url: '/dashboard/nginx',
        icon: 'globe'
      },
      {
        title: 'Database',
        url: '/dashboard/database',
        icon: 'database'
      }
    ]
  },
  {
    label: 'Security',
    items: [
      {
        title: 'Firewall',
        url: '/dashboard/firewall',
        icon: 'shieldLock'
      },
      {
        title: 'SSL Certificates',
        url: '/dashboard/ssl',
        icon: 'certificate'
      }
    ]
  },
  {
    label: 'System',
    items: [
      {
        title: 'Alerts',
        url: '/dashboard/alerts',
        icon: 'notification',
        shortcut: ['g', 'a']
      },
      {
        title: 'Cron Jobs',
        url: '/dashboard/cron',
        icon: 'clock'
      },
      {
        title: 'Settings',
        url: '/dashboard/settings',
        icon: 'settings',
        shortcut: ['g', ',']
      }
    ]
  }
];
