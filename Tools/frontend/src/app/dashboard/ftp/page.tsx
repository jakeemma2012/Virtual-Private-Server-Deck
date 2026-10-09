'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Icons } from '@/components/icons';
import { useCountUp } from '@/hooks/use-count-up';

const ftpAccounts = [
  { id: '1', username: 'deploy-user', directory: '/var/www/html', status: 'active', server: 'Production Web', lastLogin: '2026-04-13 08:30', quota: '10 GB', used: '3.2 GB' },
  { id: '2', username: 'backup-ftp', directory: '/backup', status: 'active', server: 'Backup Server', lastLogin: '2026-04-13 03:00', quota: '50 GB', used: '28.5 GB' },
  { id: '3', username: 'dev-upload', directory: '/home/dev', status: 'active', server: 'Dev Server', lastLogin: '2026-04-12 16:45', quota: '5 GB', used: '1.8 GB' },
  { id: '4', username: 'media-ftp', directory: '/var/media', status: 'disabled', server: 'Production Web', lastLogin: '2026-03-20 12:00', quota: '20 GB', used: '15.3 GB' },
];

export default function FtpPage() {
  const totalAccounts = useCountUp(ftpAccounts.length);
  const activeAccounts = ftpAccounts.filter(a => a.status === 'active').length;
  const storageUsed = useCountUp(48.8, { decimals: 1 });
  const activeConnections = useCountUp(2);

  return (
    <div className='flex flex-1 flex-col gap-6 p-6 animate-rise'>
      <div className='flex items-center justify-between'>
        <div>
          <h2 className='text-2xl font-bold tracking-tight'>FTP Manager</h2>
          <p className='text-muted-foreground'>Manage FTP/SFTP accounts across your servers.</p>
        </div>
        <Button>
          <Icons.add className='mr-2 size-4' />
          Add FTP Account
        </Button>
      </div>

      <div className='grid gap-4 md:grid-cols-3 stagger'>
        <Card className='hover-lift'>
          <CardHeader className='pb-2'>
            <CardTitle className='text-sm font-medium'>Total Accounts</CardTitle>
          </CardHeader>
          <CardContent>
            <div className='text-2xl font-bold'>{totalAccounts}</div>
            <p className='text-xs text-muted-foreground'>{activeAccounts} active</p>
          </CardContent>
        </Card>
        <Card className='hover-lift'>
          <CardHeader className='pb-2'>
            <CardTitle className='text-sm font-medium'>Total Storage Used</CardTitle>
          </CardHeader>
          <CardContent>
            <div className='text-2xl font-bold'>{storageUsed.toFixed(1)} GB</div>
            <p className='text-xs text-muted-foreground'>of 85 GB quota</p>
          </CardContent>
        </Card>
        <Card className='hover-lift'>
          <CardHeader className='pb-2'>
            <CardTitle className='text-sm font-medium'>Active Connections</CardTitle>
          </CardHeader>
          <CardContent>
            <div className='text-2xl font-bold'>{activeConnections}</div>
            <p className='text-xs text-muted-foreground'>Real-time</p>
          </CardContent>
        </Card>
      </div>

      <div className='grid gap-4 stagger'>
        {ftpAccounts.map((account) => (
          <Card key={account.id} className='hover-lift'>
            <CardContent className='flex items-center gap-6 py-4'>
              <div className='flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10'>
                <Icons.cloudUpload className='size-5 text-primary' />
              </div>
              <div className='flex-1'>
                <div className='flex items-center gap-3'>
                  <h3 className='font-semibold'>{account.username}</h3>
                  <Badge variant={account.status === 'active' ? 'success' : 'destructive'}>
                    {account.status}
                  </Badge>
                </div>
                <div className='flex items-center gap-4 mt-1 text-sm text-muted-foreground'>
                  <span className='flex items-center gap-1'><Icons.server className='size-3' />{account.server}</span>
                  <span className='flex items-center gap-1'><Icons.folder className='size-3' />{account.directory}</span>
                  <span>Quota: {account.used} / {account.quota}</span>
                  <span className='flex items-center gap-1'><Icons.clock className='size-3' />{account.lastLogin}</span>
                </div>
              </div>
              <div className='flex items-center gap-2'>
                <Button variant='outline' size='sm'><Icons.edit className='size-4' /></Button>
                <Button variant='outline' size='sm'><Icons.key className='size-4' /></Button>
                <Button variant='ghost' size='sm' className='text-destructive press'><Icons.trash className='size-4' /></Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
