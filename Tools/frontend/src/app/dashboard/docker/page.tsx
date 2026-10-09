'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Icons } from '@/components/icons';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useCountUp } from '@/hooks/use-count-up';

const containers = [
  { id: 'abc123', name: 'nginx-proxy', image: 'nginx:latest', status: 'running', ports: '80:80, 443:443', created: '5 days ago', cpu: '0.5%', memory: '32 MB' },
  { id: 'def456', name: 'mysql-db', image: 'mysql:8.0', status: 'running', ports: '3306:3306', created: '10 days ago', cpu: '2.1%', memory: '512 MB' },
  { id: 'ghi789', name: 'redis-cache', image: 'redis:7-alpine', status: 'running', ports: '6379:6379', created: '10 days ago', cpu: '0.2%', memory: '64 MB' },
  { id: 'jkl012', name: 'app-backend', image: 'node:20-alpine', status: 'running', ports: '3000:3000', created: '2 days ago', cpu: '1.8%', memory: '256 MB' },
  { id: 'mno345', name: 'certbot', image: 'certbot/certbot', status: 'exited', ports: '-', created: '1 day ago', cpu: '0%', memory: '0 MB' },
];

const images = [
  { id: 'img1', name: 'nginx', tag: 'latest', size: '187 MB', created: '2 weeks ago' },
  { id: 'img2', name: 'mysql', tag: '8.0', size: '573 MB', created: '3 weeks ago' },
  { id: 'img3', name: 'redis', tag: '7-alpine', size: '30 MB', created: '1 month ago' },
  { id: 'img4', name: 'node', tag: '20-alpine', size: '126 MB', created: '1 week ago' },
];

export default function DockerPage() {
  const containerCount = useCountUp(containers.length);
  const imageCount = useCountUp(images.length);
  const networkCount = useCountUp(3);
  const volumeCount = useCountUp(5);

  return (
    <div className='flex flex-1 flex-col gap-6 p-6 animate-rise'>
      <div className='flex items-center justify-between'>
        <div>
          <h2 className='text-2xl font-bold tracking-tight'>Docker Manager</h2>
          <p className='text-muted-foreground'>Manage Docker containers, images, and volumes.</p>
        </div>
        <Button className='press'>
          <Icons.add className='mr-2 size-4' />
          Create Container
        </Button>
      </div>

      <div className='grid gap-4 md:grid-cols-4 stagger'>
        <Card className='hover-lift'>
          <CardHeader className='pb-2'><CardTitle className='text-sm font-medium'>Containers</CardTitle></CardHeader>
          <CardContent><div className='text-2xl font-bold'>{Math.round(containerCount)}</div><p className='text-xs text-muted-foreground'>{containers.filter(c => c.status === 'running').length} running</p></CardContent>
        </Card>
        <Card className='hover-lift'>
          <CardHeader className='pb-2'><CardTitle className='text-sm font-medium'>Images</CardTitle></CardHeader>
          <CardContent><div className='text-2xl font-bold'>{Math.round(imageCount)}</div><p className='text-xs text-muted-foreground'>916 MB total</p></CardContent>
        </Card>
        <Card className='hover-lift'>
          <CardHeader className='pb-2'><CardTitle className='text-sm font-medium'>Networks</CardTitle></CardHeader>
          <CardContent><div className='text-2xl font-bold'>{Math.round(networkCount)}</div><p className='text-xs text-muted-foreground'>bridge, host, app-net</p></CardContent>
        </Card>
        <Card className='hover-lift'>
          <CardHeader className='pb-2'><CardTitle className='text-sm font-medium'>Volumes</CardTitle></CardHeader>
          <CardContent><div className='text-2xl font-bold'>{Math.round(volumeCount)}</div><p className='text-xs text-muted-foreground'>12.4 GB used</p></CardContent>
        </Card>
      </div>

      <Tabs defaultValue='containers'>
        <TabsList>
          <TabsTrigger value='containers'>Containers</TabsTrigger>
          <TabsTrigger value='images'>Images</TabsTrigger>
        </TabsList>
        <TabsContent value='containers'>
          <div className='grid gap-3 stagger'>
            {containers.map((container) => (
              <Card key={container.id} className='hover-lift'>
                <CardContent className='flex items-center gap-6 py-3'>
                  <div className='flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10'>
                    <Icons.docker className='size-5 text-primary' />
                  </div>
                  <div className='flex-1 min-w-0'>
                    <div className='flex items-center gap-3'>
                      <h3 className='font-semibold'>{container.name}</h3>
                      <Badge variant={container.status === 'running' ? 'success' : 'secondary'} className='gap-1.5'>
                        {container.status === 'running' && (
                          <span className='status-dot inline-block size-1.5 rounded-full bg-emerald-500 text-emerald-500' />
                        )}
                        {container.status}
                      </Badge>
                      <code className='text-xs text-muted-foreground'>{container.id}</code>
                    </div>
                    <div className='flex items-center gap-4 mt-1 text-sm text-muted-foreground'>
                      <span>{container.image}</span>
                      <span>Ports: {container.ports}</span>
                      <span>CPU: {container.cpu}</span>
                      <span>Mem: {container.memory}</span>
                    </div>
                  </div>
                  <div className='flex items-center gap-2'>
                    {container.status === 'running' ? (
                      <Button variant='outline' size='sm' className='press'><Icons.stop className='size-4' /></Button>
                    ) : (
                      <Button variant='outline' size='sm' className='press'><Icons.play className='size-4' /></Button>
                    )}
                    <Button variant='outline' size='sm' className='press'><Icons.terminal className='size-4' /></Button>
                    <Button variant='outline' size='sm' className='press'><Icons.logs className='size-4' /></Button>
                    <Button variant='ghost' size='sm' className='press text-destructive'><Icons.trash className='size-4' /></Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>
        <TabsContent value='images'>
          <div className='grid gap-3 stagger'>
            {images.map((image) => (
              <Card key={image.id} className='hover-lift'>
                <CardContent className='flex items-center gap-6 py-3'>
                  <div className='flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10'>
                    <Icons.box className='size-5 text-primary' />
                  </div>
                  <div className='flex-1'>
                    <h3 className='font-semibold'>{image.name}:<span className='text-muted-foreground font-normal'>{image.tag}</span></h3>
                    <div className='flex items-center gap-4 mt-1 text-sm text-muted-foreground'>
                      <span>Size: {image.size}</span>
                      <span>Created: {image.created}</span>
                    </div>
                  </div>
                  <Button variant='ghost' size='sm' className='press text-destructive'><Icons.trash className='size-4' /></Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
