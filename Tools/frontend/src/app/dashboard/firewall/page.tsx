'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Icons } from '@/components/icons';
import { useCountUp } from '@/hooks/use-count-up';

const rules = [
  { id: '1', name: 'SSH Access', port: '22', protocol: 'TCP', source: '0.0.0.0/0', action: 'ACCEPT', direction: 'IN' },
  { id: '2', name: 'HTTP', port: '80', protocol: 'TCP', source: '0.0.0.0/0', action: 'ACCEPT', direction: 'IN' },
  { id: '3', name: 'HTTPS', port: '443', protocol: 'TCP', source: '0.0.0.0/0', action: 'ACCEPT', direction: 'IN' },
  { id: '4', name: 'MySQL', port: '3306', protocol: 'TCP', source: '10.0.0.0/8', action: 'ACCEPT', direction: 'IN' },
  { id: '5', name: 'Redis', port: '6379', protocol: 'TCP', source: '127.0.0.1', action: 'ACCEPT', direction: 'IN' },
  { id: '6', name: 'Block Telnet', port: '23', protocol: 'TCP', source: '0.0.0.0/0', action: 'DROP', direction: 'IN' },
];

export default function FirewallPage() {
  const rulesCount = useCountUp(rules.length);
  const blockedToday = useCountUp(1247);
  const allowCount = rules.filter(r => r.action === 'ACCEPT').length;
  const blockCount = rules.filter(r => r.action === 'DROP').length;

  return (
    <div className='flex flex-1 flex-col gap-6 p-6 animate-rise'>
      <div className='flex items-center justify-between'>
        <div>
          <h2 className='text-2xl font-bold tracking-tight'>Firewall & Security</h2>
          <p className='text-muted-foreground'>Manage firewall rules and security settings.</p>
        </div>
        <Button><Icons.add className='mr-2 size-4' />Add Rule</Button>
      </div>

      <div className='grid gap-4 md:grid-cols-3 stagger'>
        <Card className='hover-lift'>
          <CardHeader className='pb-2'><CardTitle className='text-sm font-medium'>Firewall Status</CardTitle></CardHeader>
          <CardContent><Badge variant='success'><span className='status-dot inline-block size-1.5 rounded-full bg-current text-emerald-500' /><Icons.shieldLock className='mr-1 size-3' />Active</Badge></CardContent>
        </Card>
        <Card className='hover-lift'>
          <CardHeader className='pb-2'><CardTitle className='text-sm font-medium'>Rules</CardTitle></CardHeader>
          <CardContent><div className='text-2xl font-bold'>{rulesCount}</div><p className='text-xs text-muted-foreground'>{allowCount} allow, {blockCount} block</p></CardContent>
        </Card>
        <Card className='hover-lift'>
          <CardHeader className='pb-2'><CardTitle className='text-sm font-medium'>Blocked Today</CardTitle></CardHeader>
          <CardContent><div className='text-2xl font-bold'>{blockedToday.toLocaleString()}</div><p className='text-xs text-muted-foreground'>attempted connections</p></CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Firewall Rules</CardTitle></CardHeader>
        <CardContent>
          <div className='rounded-xl border'>
            <div className='grid grid-cols-[1fr_80px_80px_150px_80px_80px_60px] gap-4 border-b bg-muted/50 px-4 py-2 text-xs font-medium text-muted-foreground'>
              <div>Name</div>
              <div>Port</div>
              <div>Protocol</div>
              <div>Source</div>
              <div>Action</div>
              <div>Direction</div>
              <div></div>
            </div>
            <div className='stagger'>
              {rules.map((rule) => (
                <div key={rule.id} className='grid grid-cols-[1fr_80px_80px_150px_80px_80px_60px] gap-4 items-center px-4 py-3 text-sm border-b last:border-b-0 hover:bg-muted/30 transition-colors'>
                  <div className='font-medium'>{rule.name}</div>
                  <div className='font-mono'>{rule.port}</div>
                  <div>{rule.protocol}</div>
                  <div className='font-mono text-xs text-muted-foreground'>{rule.source}</div>
                  <div><Badge variant={rule.action === 'ACCEPT' ? 'success' : 'destructive'} className='text-xs'>{rule.action}</Badge></div>
                  <div><Badge variant='info' className='text-xs'>{rule.direction}</Badge></div>
                  <div><Button variant='ghost' size='sm' className='press'><Icons.ellipsis className='size-4' /></Button></div>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
