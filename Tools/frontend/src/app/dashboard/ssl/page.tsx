'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Icons } from '@/components/icons';
import { useCountUp } from '@/hooks/use-count-up';

const certificates = [
  { id: '1', domain: 'example.com', issuer: "Let's Encrypt", expires: '2026-07-12', daysLeft: 90, status: 'valid', type: 'Wildcard', server: 'Production Web' },
  { id: '2', domain: 'api.example.com', issuer: "Let's Encrypt", expires: '2026-06-15', daysLeft: 63, status: 'valid', type: 'Single', server: 'Production Web' },
  { id: '3', domain: 'staging.example.com', issuer: 'Self-signed', expires: '2026-04-20', daysLeft: 7, status: 'expiring', type: 'Single', server: 'Staging Server' },
  { id: '4', domain: 'old.example.com', issuer: "Let's Encrypt", expires: '2026-03-01', daysLeft: -43, status: 'expired', type: 'Single', server: 'Production Web' },
];

const statusVariant = (status: string) =>
  status === 'valid' ? 'success' : status === 'expiring' ? 'warning' : 'destructive';

export default function SslPage() {
  const validCount = certificates.filter(c => c.status === 'valid').length;
  const attentionCount = certificates.filter(c => c.status !== 'valid').length;
  const totalCountUp = useCountUp(certificates.length);
  const validCountUp = useCountUp(validCount);
  const attentionCountUp = useCountUp(attentionCount);

  return (
    <div className='flex flex-1 flex-col gap-6 p-6 animate-rise'>
      <div className='flex items-center justify-between'>
        <div>
          <h2 className='text-2xl font-bold tracking-tight'>SSL Certificates</h2>
          <p className='text-muted-foreground'>Manage SSL/TLS certificates for your domains.</p>
        </div>
        <Button><Icons.add className='mr-2 size-4' />Add Certificate</Button>
      </div>

      <div className='grid gap-4 md:grid-cols-3 stagger'>
        <Card>
          <CardHeader className='pb-2'><CardTitle className='text-sm font-medium'>Total Certificates</CardTitle></CardHeader>
          <CardContent><div className='text-2xl font-bold'>{totalCountUp}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className='pb-2'><CardTitle className='text-sm font-medium'>Valid</CardTitle></CardHeader>
          <CardContent><div className='text-2xl font-bold text-emerald-600 dark:text-emerald-400'>{validCountUp}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className='pb-2'><CardTitle className='text-sm font-medium'>Attention Needed</CardTitle></CardHeader>
          <CardContent><div className='text-2xl font-bold text-amber-600 dark:text-amber-400'>{attentionCountUp}</div></CardContent>
        </Card>
      </div>

      <div className='grid gap-4 stagger'>
        {certificates.map((cert) => (
          <Card key={cert.id} className='hover-lift'>
            <CardContent className='flex items-center gap-6 py-4'>
              <div className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${cert.status === 'valid' ? 'bg-emerald-500/10' : cert.status === 'expiring' ? 'bg-amber-500/10' : 'bg-red-500/10'}`}>
                <Icons.certificate className={`size-5 ${cert.status === 'valid' ? 'text-emerald-600 dark:text-emerald-400' : cert.status === 'expiring' ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}`} />
              </div>
              <div className='flex-1'>
                <div className='flex items-center gap-3'>
                  <h3 className='font-semibold'>{cert.domain}</h3>
                  <Badge variant={statusVariant(cert.status)}>{cert.status}</Badge>
                  <Badge variant='outline'>{cert.type}</Badge>
                </div>
                <div className='flex items-center gap-4 mt-1 text-sm text-muted-foreground'>
                  <span>Issuer: {cert.issuer}</span>
                  <span>Expires: {cert.expires}</span>
                  <span>{cert.daysLeft > 0 ? `${cert.daysLeft} days left` : `Expired ${Math.abs(cert.daysLeft)} days ago`}</span>
                  <span className='flex items-center gap-1'><Icons.server className='size-3' />{cert.server}</span>
                </div>
              </div>
              <div className='flex items-center gap-2'>
                <Button variant='outline' size='sm'><Icons.refresh className='size-4 mr-1' />Renew</Button>
                <Button variant='outline' size='sm'><Icons.download className='size-4' /></Button>
                <Button variant='ghost' size='sm' className='text-destructive'><Icons.trash className='size-4' /></Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
