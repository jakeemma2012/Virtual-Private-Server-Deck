'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Icons } from '@/components/icons';
import { useCountUp } from '@/hooks/use-count-up';

const databases = [
  { id: '1', name: 'app_production', type: 'MySQL 8.0', size: '2.4 GB', tables: 48, server: 'Database Server', status: 'active', charset: 'utf8mb4' },
  { id: '2', name: 'app_staging', type: 'MySQL 8.0', size: '512 MB', tables: 48, server: 'Staging Server', status: 'active', charset: 'utf8mb4' },
  { id: '3', name: 'analytics', type: 'PostgreSQL 16', size: '8.1 GB', tables: 24, server: 'Database Server', status: 'active', charset: 'UTF8' },
  { id: '4', name: 'cache_store', type: 'Redis 7', size: '256 MB', tables: 0, server: 'Production Web', status: 'active', charset: '-' },
  { id: '5', name: 'logs_archive', type: 'MongoDB 7', size: '15.3 GB', tables: 12, server: 'Backup Server', status: 'inactive', charset: '-' },
];

export default function DatabasePage() {
  const dbCount = useCountUp(databases.length);
  const totalSize = useCountUp(26.6, { decimals: 1 });
  const totalTables = useCountUp(132);
  const dbEngines = useCountUp(4);

  return (
    <div className='flex flex-1 flex-col gap-6 p-6 animate-rise'>
      <div className='flex items-center justify-between'>
        <div>
          <h2 className='text-2xl font-bold tracking-tight'>Database Manager</h2>
          <p className='text-muted-foreground'>Manage databases across all your servers.</p>
        </div>
        <Button><Icons.add className='mr-2 size-4' />Create Database</Button>
      </div>

      <div className='grid gap-4 md:grid-cols-4 stagger'>
        <Card className='hover-lift'>
          <CardHeader className='pb-2'><CardTitle className='text-sm font-medium'>Databases</CardTitle></CardHeader>
          <CardContent><div className='text-2xl font-bold'>{dbCount}</div></CardContent>
        </Card>
        <Card className='hover-lift'>
          <CardHeader className='pb-2'><CardTitle className='text-sm font-medium'>Total Size</CardTitle></CardHeader>
          <CardContent><div className='text-2xl font-bold'>{totalSize.toFixed(1)} GB</div></CardContent>
        </Card>
        <Card className='hover-lift'>
          <CardHeader className='pb-2'><CardTitle className='text-sm font-medium'>Total Tables</CardTitle></CardHeader>
          <CardContent><div className='text-2xl font-bold'>{totalTables}</div></CardContent>
        </Card>
        <Card className='hover-lift'>
          <CardHeader className='pb-2'><CardTitle className='text-sm font-medium'>DB Engines</CardTitle></CardHeader>
          <CardContent><div className='text-2xl font-bold'>{dbEngines}</div><p className='text-xs text-muted-foreground'>MySQL, PostgreSQL, Redis, MongoDB</p></CardContent>
        </Card>
      </div>

      <div className='grid gap-4 stagger'>
        {databases.map((db) => (
          <Card key={db.id} className='hover-lift'>
            <CardContent className='flex items-center gap-6 py-4'>
              <div className='flex size-10 shrink-0 items-center justify-center rounded-xl bg-orange-500/10'>
                <Icons.database className='size-5 text-orange-500' />
              </div>
              <div className='flex-1'>
                <div className='flex items-center gap-3'>
                  <h3 className='font-semibold'>{db.name}</h3>
                  <Badge variant='outline'>{db.type}</Badge>
                  <Badge variant={db.status === 'active' ? 'success' : 'secondary'}>{db.status}</Badge>
                </div>
                <div className='flex items-center gap-4 mt-1 text-sm text-muted-foreground'>
                  <span>Size: {db.size}</span>
                  {db.tables > 0 && <span>{db.tables} tables</span>}
                  <span className='flex items-center gap-1'><Icons.server className='size-3' />{db.server}</span>
                  {db.charset !== '-' && <span>Charset: {db.charset}</span>}
                </div>
              </div>
              <div className='flex items-center gap-2'>
                <Button variant='outline' size='sm'><Icons.terminal className='size-4 mr-1' />Query</Button>
                <Button variant='outline' size='sm'><Icons.download className='size-4 mr-1' />Backup</Button>
                <Button variant='ghost' size='sm' className='text-destructive press'><Icons.trash className='size-4' /></Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
