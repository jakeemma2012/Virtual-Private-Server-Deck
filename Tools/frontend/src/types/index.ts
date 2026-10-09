import { Icons } from '@/components/icons';

export interface NavItem {
  title: string;
  url: string;
  disabled?: boolean;
  external?: boolean;
  shortcut?: [string, string];
  icon?: keyof typeof Icons;
  label?: string;
  description?: string;
  isActive?: boolean;
  items?: NavItem[];
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export interface VpsServer {
  id: string;
  name: string;
  hostname: string;
  ip: string;
  port: number;
  os: string;
  status: 'online' | 'offline' | 'warning';
  cpu: number;
  ram: number;
  disk: number;
  uptime: string;
  location: string;
  provider: string;
  tags: string[];
}
