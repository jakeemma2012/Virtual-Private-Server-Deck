'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Icons } from '@/components/icons';
import { useCountUp } from '@/hooks/use-count-up';

const sites = [
  { id: '1', domain: 'example.com', type: 'Reverse Proxy', target: 'localhost:3000', ssl: true, status: 'active', server: 'Production Web' },
  { id: '2', domain: 'api.example.com', type: 'Reverse Proxy', target: 'localhost:8080', ssl: true, status: 'active', server: 'Production Web' },
  { id: '3', domain: 'staging.example.com', type: 'Static', target: '/var/www/staging', ssl: false, status: 'active', server: 'Staging Server' },
  { id: '4', domain: 'old.example.com', type: 'Redirect', target: 'https://example.com', ssl: true, status: 'disabled', server: 'Production Web' },
];

export default function NginxPage() {
  const activeCount = sites.filter(s => s.status === 'active').length;
  const sslCount = sites.filter(s => s.ssl).length;
  const sitesCountUp = useCountUp(sites.length);
  const sslCountUp = useCountUp(sslCount);

  return (
    <div className='flex flex-1 flex-col gap-6 p-6 animate-rise'>
      <div className='flex items-center justify-between'>
        <div>
          <h2 className='text-2xl font-bold tracking-tight'>Nginx Manager</h2>
          <p className='text-muted-foreground'>Manage Nginx virtual hosts and proxy settings.</p>
        </div>
        <div className='flex gap-2'>
          <Button variant='outline'><Icons.refresh className='mr-2 size-4' />Reload Nginx</Button>
          <Button><Icons.add className='mr-2 size-4' />Add Site</Button>
        </div>
      </div>

      <div className='grid gap-4 md:grid-cols-3 stagger'>
        <Card>
          <CardHeader className='pb-2'><CardTitle className='text-sm font-medium'>Nginx Status</CardTitle></CardHeader>
          <CardContent>
            <Badge variant='success'>
              <span className='status-dot inline-block size-1.5 rounded-full bg-emerald-500 text-emerald-500' />Running
            </Badge>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className='pb-2'><CardTitle className='text-sm font-medium'>Sites</CardTitle></CardHeader>
          <CardContent><div className='text-2xl font-bold'>{sitesCountUp}</div><p className='text-xs text-muted-foreground'>{activeCount} active</p></CardContent>
        </Card>
        <Card>
          <CardHeader className='pb-2'><CardTitle className='text-sm font-medium'>SSL Certificates</CardTitle></CardHeader>
          <CardContent><div className='text-2xl font-bold'>{sslCountUp}</div><p className='text-xs text-muted-foreground'>with SSL enabled</p></CardContent>
        </Card>
      </div>

      <div className='grid gap-4 stagger'>
        {sites.map((site) => (
          <Card key={site.id} className='hover-lift'>
            <CardContent className='flex items-center gap-6 py-4'>
              <div className='flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10'>
                <Icons.globe className='size-5 text-primary' />
              </div>
              <div className='flex-1'>
                <div className='flex items-center gap-3'>
                  <h3 className='font-semibold'>{site.domain}</h3>
                  {site.ssl && <Badge variant='success'><Icons.lock className='mr-1 size-3' />SSL</Badge>}
                  <Badge variant={site.status === 'active' ? 'success' : 'destructive'}>{site.status}</Badge>
                </div>
                <div className='flex items-center gap-4 mt-1 text-sm text-muted-foreground'>
                  <span>{site.type}</span>
                  <span className='flex items-center gap-1'><Icons.arrowRight className='size-3' />{site.target}</span>
                  <span className='flex items-center gap-1'><Icons.server className='size-3' />{site.server}</span>
                </div>
              </div>
              <div className='flex items-center gap-2'>
                <Button variant='outline' size='sm'><Icons.edit className='size-4' /></Button>
                <Button variant='outline' size='sm'><Icons.externalLink className='size-4' /></Button>
                <Button variant='ghost' size='sm' className='text-destructive'><Icons.trash className='size-4' /></Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
