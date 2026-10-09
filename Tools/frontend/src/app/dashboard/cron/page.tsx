'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Icons } from '@/components/icons';

const cronJobs = [
  { id: '1', name: 'Database Backup', schedule: '0 3 * * *', command: '/scripts/backup-db.sh', server: 'Database Server', status: 'active', lastRun: '2026-04-13 03:00', nextRun: '2026-04-14 03:00', duration: '12m 30s' },
  { id: '2', name: 'Log Rotation', schedule: '0 0 * * 0', command: 'logrotate /etc/logrotate.conf', server: 'All Servers', status: 'active', lastRun: '2026-04-06 00:00', nextRun: '2026-04-13 00:00', duration: '45s' },
  { id: '3', name: 'SSL Renewal', schedule: '0 0 1 * *', command: 'certbot renew', server: 'Production Web', status: 'active', lastRun: '2026-04-01 00:00', nextRun: '2026-05-01 00:00', duration: '1m 15s' },
  { id: '4', name: 'Cache Cleanup', schedule: '*/30 * * * *', command: 'redis-cli FLUSHDB', server: 'Production Web', status: 'disabled', lastRun: '2026-04-12 23:30', nextRun: '-', duration: '2s' },
  { id: '5', name: 'Health Check', schedule: '*/5 * * * *', command: '/scripts/healthcheck.sh', server: 'All Servers', status: 'active', lastRun: '2026-04-13 12:25', nextRun: '2026-04-13 12:30', duration: '8s' },
];

export default function CronPage() {
  return (
    <div className='flex flex-1 flex-col gap-6 p-6 animate-rise'>
      <div className='flex items-center justify-between'>
        <div>
          <h2 className='text-2xl font-bold tracking-tight'>Cron Jobs</h2>
          <p className='text-muted-foreground'>Schedule and manage automated tasks.</p>
        </div>
        <Button><Icons.add className='mr-2 size-4' />Add Cron Job</Button>
      </div>

      <div className='grid gap-4 stagger'>
        {cronJobs.map((job) => (
          <Card key={job.id} className='hover-lift'>
            <CardContent className='flex items-center gap-6 py-4'>
              <div className='flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10'>
                <Icons.clock className='size-5 text-primary' />
              </div>
              <div className='flex-1'>
                <div className='flex items-center gap-3'>
                  <h3 className='font-semibold'>{job.name}</h3>
                  <Badge variant={job.status === 'active' ? 'success' : 'info'}>{job.status}</Badge>
                  <code className='rounded bg-muted px-2 py-0.5 text-xs'>{job.schedule}</code>
                </div>
                <div className='flex items-center gap-4 mt-1 text-sm text-muted-foreground'>
                  <span className='font-mono text-xs'>{job.command}</span>
                </div>
                <div className='flex items-center gap-4 mt-1 text-xs text-muted-foreground'>
                  <span className='flex items-center gap-1'><Icons.server className='size-3' />{job.server}</span>
                  <span>Last: {job.lastRun}</span>
                  <span>Next: {job.nextRun}</span>
                  <span>Duration: {job.duration}</span>
                </div>
              </div>
              <div className='flex items-center gap-2'>
                <Button variant='outline' size='sm'><Icons.play className='size-4 mr-1' />Run Now</Button>
                <Button variant='outline' size='sm'><Icons.edit className='size-4' /></Button>
                <Button variant='ghost' size='sm' className='text-destructive'><Icons.trash className='size-4' /></Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
