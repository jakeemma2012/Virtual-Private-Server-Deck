'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Icons } from '@/components/icons';
import { useCountUp } from '@/hooks/use-count-up';
import { api, VpsServer, ServerStats, SystemStats } from '@/lib/api';
import Link from 'next/link';

// ─── Helpers ────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

function formatMbToDisplay(mb: number): string {
  if (mb < 1024) return `${mb} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function usageColor(pct: number): string {
  if (pct >= 90) return 'text-red-500';
  if (pct >= 70) return 'text-amber-500';
  return 'text-emerald-500';
}

function usageBarColor(pct: number): string {
  if (pct >= 90) return 'bg-red-500';
  if (pct >= 70) return 'bg-amber-500';
  return 'bg-emerald-500';
}

function progressColorClass(pct: number): string {
  if (pct >= 90) return '[&>[data-slot=progress-indicator]]:bg-red-500';
  if (pct >= 70) return '[&>[data-slot=progress-indicator]]:bg-amber-500';
  return '[&>[data-slot=progress-indicator]]:bg-emerald-500';
}

// ─── Sub-components ─────────────────────────────────────────

function ResourceCard({
  icon: Icon,
  label,
  statValue,
  decimals,
  suffix = '',
  percent,
  detail,
  subDetail,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  statValue: number;
  decimals: number;
  suffix?: string;
  percent: number;
  detail: string;
  subDetail?: string;
}) {
  const animated = useCountUp(statValue, { decimals });
  return (
    <Card className='hover-lift'>
      <CardHeader className='flex flex-row items-center gap-3 pb-2 px-4 pt-4'>
        <div className={`rounded-lg p-2 ${percent >= 90 ? 'bg-red-500/10' : percent >= 70 ? 'bg-amber-500/10' : 'bg-emerald-500/10'}`}>
          <Icon className={`size-5 ${usageColor(percent)}`} />
        </div>
        <div className='flex-1 min-w-0'>
          <p className='text-xs text-muted-foreground'>{label}</p>
          <div className='flex items-baseline gap-2'>
            <span className={`text-2xl font-bold tabular-nums ${usageColor(percent)}`}>
              {animated.toFixed(decimals)}{suffix}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent className='px-4 pb-4 space-y-2'>
        <Progress value={percent} className={`h-2 ${progressColorClass(percent)}`} />
        <div className='flex justify-between text-xs text-muted-foreground'>
          <span>{detail}</span>
          {subDetail && <span>{subDetail}</span>}
        </div>
      </CardContent>
    </Card>
  );
}

function SummaryCard({
  title,
  value,
  icon: Icon,
  color,
  bg,
}: {
  title: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  bg: string;
}) {
  const animated = useCountUp(value);
  return (
    <Card className='hover-lift'>
      <CardHeader className='flex flex-row items-center justify-between pb-1 px-3 pt-3 md:px-4 md:pt-4'>
        <CardTitle className='text-xs md:text-sm font-medium'>{title}</CardTitle>
        <div className={`rounded-md p-1.5 ${bg}`}>
          <Icon className={`size-3.5 md:size-4 ${color || 'text-muted-foreground'}`} />
        </div>
      </CardHeader>
      <CardContent className='px-3 pb-3 md:px-4 md:pb-4'>
        <div className={`text-xl md:text-2xl font-bold tabular-nums ${color}`}>
          {Math.round(animated)}
        </div>
      </CardContent>
    </Card>
  );
}

function SystemInfoCard({ sys }: { sys: SystemStats }) {
  return (
    <Card>
      <CardHeader className='pb-2 px-4 pt-4'>
        <CardTitle className='text-sm flex items-center gap-2'>
          <Icons.server className='size-4' />
          System Info
        </CardTitle>
      </CardHeader>
      <CardContent className='px-4 pb-4'>
        <div className='grid grid-cols-2 gap-x-6 gap-y-2 text-xs'>
          <div>
            <span className='text-muted-foreground'>Hostname</span>
            <p className='font-medium truncate'>{sys.hostname}</p>
          </div>
          <div>
            <span className='text-muted-foreground'>OS</span>
            <p className='font-medium truncate'>{sys.os}</p>
          </div>
          <div>
            <span className='text-muted-foreground'>Kernel</span>
            <p className='font-medium truncate'>{sys.kernel}</p>
          </div>
          <div>
            <span className='text-muted-foreground'>Uptime</span>
            <p className='font-medium'>{sys.uptime}</p>
          </div>
          <div>
            <span className='text-muted-foreground'>Processes</span>
            <p className='font-medium'>{sys.processCount}</p>
          </div>
          <div>
            <span className='text-muted-foreground'>Load Avg</span>
            <p className='font-medium tabular-nums'>
              {sys.loadAvg1.toFixed(2)} / {sys.loadAvg5.toFixed(2)} / {sys.loadAvg15.toFixed(2)}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function NetworkCard({ sys }: { sys: SystemStats }) {
  return (
    <Card>
      <CardHeader className='pb-2 px-4 pt-4'>
        <CardTitle className='text-sm flex items-center gap-2'>
          <Icons.network className='size-4' />
          Network I/O
        </CardTitle>
      </CardHeader>
      <CardContent className='px-4 pb-4'>
        <div className='grid grid-cols-2 gap-4'>
          <div className='flex items-center gap-3'>
            <div className='rounded-lg bg-blue-500/10 p-2'>
              <Icons.arrowDown className='size-4 text-blue-500' />
            </div>
            <div>
              <p className='text-xs text-muted-foreground'>Download</p>
              <p className='text-lg font-bold tabular-nums'>{formatBytes(sys.networkRxBytes)}</p>
            </div>
          </div>
          <div className='flex items-center gap-3'>
            <div className='rounded-lg bg-violet-500/10 p-2'>
              <Icons.arrowUp className='size-4 text-violet-500' />
            </div>
            <div>
              <p className='text-xs text-muted-foreground'>Upload</p>
              <p className='text-lg font-bold tabular-nums'>{formatBytes(sys.networkTxBytes)}</p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase();
  const badgeVariant: Record<string, 'success' | 'warning' | 'destructive'> = {
    online: 'success',
    offline: 'destructive',
    warning: 'warning',
  };
  const dotColor: Record<string, string> = {
    online: 'bg-emerald-500 text-emerald-500',
    offline: 'bg-red-500 text-red-500',
    warning: 'bg-amber-500 text-amber-500',
  };
  return (
    <Badge variant={badgeVariant[s] || 'destructive'}>
      <span
        className={`status-dot mr-1 inline-block size-1.5 rounded-full ${dotColor[s] || dotColor.offline}`}
      />
      {s.charAt(0).toUpperCase() + s.slice(1)}
    </Badge>
  );
}

function UsageBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className='space-y-1'>
      <div className='flex justify-between text-xs'>
        <span className='text-muted-foreground'>{label}</span>
        <span className='font-medium tabular-nums'>{value.toFixed(1)}%</span>
      </div>
      <div className='bg-primary/10 h-1.5 w-full overflow-hidden rounded-full'>
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${color}`}
          style={{ width: `${Math.min(value, 100)}%` }}
        />
      </div>
    </div>
  );
}

function ServerCard({ server, stats }: { server: VpsServer; stats?: ServerStats }) {
  return (
    <Card className='hover-lift'>
      <CardHeader className='pb-2 px-4 pt-4'>
        <div className='flex items-center justify-between'>
          <CardTitle className='text-sm'>{server.name}</CardTitle>
          <StatusBadge status={server.status} />
        </div>
        <CardDescription className='flex items-center gap-1.5 text-xs'>
          <Icons.globe className='size-3' />
          {server.ip}
          {server.location && <span className='hidden sm:inline text-muted-foreground'>| {server.location}</span>}
        </CardDescription>
      </CardHeader>
      <CardContent className='space-y-2 px-4 pb-4'>
        <div className='flex items-center gap-2 text-xs text-muted-foreground'>
          <Icons.desktop className='size-3' />
          <span className='truncate'>{server.os || 'Unknown'}</span>
          {stats?.uptime && (
            <span className='ml-auto flex items-center gap-1 shrink-0'>
              <Icons.clock className='size-3' />{stats.uptime}
            </span>
          )}
        </div>
        {stats ? (
          <>
            <UsageBar label='CPU' value={stats.cpuUsage} color={usageBarColor(stats.cpuUsage)} />
            <UsageBar label='RAM' value={stats.ramUsagePercent} color={usageBarColor(stats.ramUsagePercent)} />
            <UsageBar label='Disk' value={stats.diskUsagePercent} color={usageBarColor(stats.diskUsagePercent)} />
            <div className='flex gap-3 pt-1 text-[10px] text-muted-foreground'>
              <span>RAM: {formatMbToDisplay(stats.ramUsedMb)} / {formatMbToDisplay(stats.ramTotalMb)}</span>
              <span>Disk: {stats.diskUsedGb}G / {stats.diskTotalGb}G</span>
            </div>
          </>
        ) : server.status === 'ONLINE' ? (
          <div className='flex items-center gap-2 py-3'>
            <Icons.spinner className='size-3 animate-spin text-muted-foreground' />
            <span className='text-xs text-muted-foreground'>Fetching stats...</span>
          </div>
        ) : (
          <div className='py-2 text-xs text-muted-foreground'>Server offline</div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Skeleton loaders ───────────────────────────────────────

function SystemResourcesSkeleton() {
  return (
    <div className='grid gap-3 grid-cols-1 sm:grid-cols-2 xl:grid-cols-4'>
      {Array.from({ length: 4 }).map((_, i) => (
        <Card key={i}>
          <CardHeader className='flex flex-row items-center gap-3 pb-2 px-4 pt-4'>
            <Skeleton className='size-9 rounded-lg' />
            <div className='flex-1 space-y-1'>
              <Skeleton className='h-3 w-12' />
              <Skeleton className='h-7 w-16' />
            </div>
          </CardHeader>
          <CardContent className='px-4 pb-4 space-y-2'>
            <Skeleton className='h-2 w-full rounded-full' />
            <Skeleton className='h-3 w-24' />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────

const REFRESH_INTERVAL = 10_000;

export default function OverviewPage() {
  const [servers, setServers] = useState<VpsServer[]>([]);
  const [serverStats, setServerStats] = useState<Record<string, ServerStats>>({});
  const [systemStats, setSystemStats] = useState<SystemStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [systemLoading, setSystemLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchSystemStats = useCallback(async () => {
    try {
      const data = await api.getSystemStats();
      setSystemStats(data);
    } catch {
      // Silently handle - system stats are optional
    } finally {
      setSystemLoading(false);
    }
  }, []);

  const fetchServers = useCallback(async () => {
    try {
      const data = await api.getServers();
      setServers(data);
      const onlineServers = data.filter((s) => s.status === 'ONLINE');
      const results = await Promise.allSettled(
        onlineServers.map((s) =>
          api.getServerStats(s.id).then((st) => ({ id: s.id, st }))
        )
      );
      const newStats: Record<string, ServerStats> = {};
      for (const r of results) {
        if (r.status === 'fulfilled') newStats[r.value.id] = r.value.st;
      }
      setServerStats(newStats);
    } catch {
      // handled by empty state
    } finally {
      setLoading(false);
      setLastRefresh(new Date());
    }
  }, []);

  const refreshAll = useCallback(() => {
    fetchSystemStats();
    fetchServers();
  }, [fetchSystemStats, fetchServers]);

  useEffect(() => {
    refreshAll();
    intervalRef.current = setInterval(refreshAll, REFRESH_INTERVAL);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [refreshAll]);

  const { online, warning, offline } = useMemo(() => ({
    online: servers.filter((s) => s.status === 'ONLINE').length,
    warning: servers.filter((s) => s.status === 'WARNING').length,
    offline: servers.filter((s) => s.status === 'OFFLINE').length,
  }), [servers]);

  return (
    <div className='animate-rise flex flex-1 flex-col gap-4 p-3 md:p-6'>
      {/* Header */}
      <div className='flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between'>
        <div>
          <h2 className='text-lg md:text-2xl font-bold tracking-tight'>Dashboard</h2>
          <p className='text-muted-foreground text-xs md:text-sm'>
            System resources & server overview
          </p>
        </div>
        <div className='flex items-center gap-2 self-start'>
          {lastRefresh && (
            <span className='text-[10px] text-muted-foreground hidden sm:block'>
              Auto-refresh {REFRESH_INTERVAL / 1000}s | {lastRefresh.toLocaleTimeString()}
            </span>
          )}
          <Button onClick={refreshAll} variant='outline' size='sm'>
            <Icons.refresh className='mr-1 size-3.5' />
            Refresh
          </Button>
        </div>
      </div>

      {/* ─── System Resources (like aaPanel) ─── */}
      <section>
        <h3 className='mb-3 text-sm md:text-base font-semibold flex items-center gap-2'>
          <Icons.activity className='size-4' />
          Host System Resources
        </h3>

        {systemLoading ? (
          <SystemResourcesSkeleton />
        ) : systemStats ? (
          <div className='space-y-3'>
            {/* Resource gauges */}
            <div className='stagger grid gap-3 grid-cols-1 sm:grid-cols-2 xl:grid-cols-4'>
              <ResourceCard
                icon={Icons.cpu}
                label='CPU Usage'
                statValue={systemStats.cpuUsage}
                decimals={1}
                suffix='%'
                percent={systemStats.cpuUsage}
                detail={`Load: ${systemStats.loadAvg1.toFixed(2)}`}
                subDetail={`${systemStats.processCount} processes`}
              />
              <ResourceCard
                icon={Icons.systemMonitor}
                label='Memory'
                statValue={systemStats.ramUsagePercent}
                decimals={1}
                suffix='%'
                percent={systemStats.ramUsagePercent}
                detail={`${formatMbToDisplay(systemStats.ramUsed)} / ${formatMbToDisplay(systemStats.ramTotal)}`}
              />
              <ResourceCard
                icon={Icons.sdCard}
                label='Disk'
                statValue={systemStats.diskUsagePercent}
                decimals={1}
                suffix='%'
                percent={systemStats.diskUsagePercent}
                detail={`${formatBytes(systemStats.diskUsed * 1073741824)} / ${formatBytes(systemStats.diskTotal * 1073741824)}`}
              />
              <ResourceCard
                icon={Icons.gauge}
                label='Load Average'
                statValue={systemStats.loadAvg1}
                decimals={2}
                percent={Math.min(systemStats.loadAvg1 * 25, 100)}
                detail={`5m: ${systemStats.loadAvg5.toFixed(2)}`}
                subDetail={`15m: ${systemStats.loadAvg15.toFixed(2)}`}
              />
            </div>

            {/* System info + Network */}
            <div className='grid gap-3 grid-cols-1 md:grid-cols-2'>
              <SystemInfoCard sys={systemStats} />
              <NetworkCard sys={systemStats} />
            </div>
          </div>
        ) : (
          <Card className='border-dashed'>
            <CardContent className='flex items-center gap-3 py-6 px-4'>
              <Icons.info className='size-5 text-muted-foreground shrink-0' />
              <div>
                <p className='text-sm font-medium'>VPS Agent not available</p>
                <p className='text-xs text-muted-foreground'>
                  Start the VPS Agent on port 9090 to see host system resources (CPU, RAM, Disk, Network).
                </p>
              </div>
            </CardContent>
          </Card>
        )}
      </section>

      {/* ─── Server Summary ─── */}
      <section>
        <h3 className='mb-3 text-sm md:text-base font-semibold flex items-center gap-2'>
          <Icons.server className='size-4' />
          VPS Servers
        </h3>

        <div className='stagger grid gap-3 grid-cols-2 lg:grid-cols-4'>
          {[
            { title: 'Total', value: servers.length, icon: Icons.server, color: '', bg: 'bg-primary/10' },
            { title: 'Online', value: online, icon: Icons.circleCheck, color: 'text-emerald-500', bg: 'bg-emerald-500/10' },
            { title: 'Warning', value: warning, icon: Icons.warning, color: 'text-amber-500', bg: 'bg-amber-500/10' },
            { title: 'Offline', value: offline, icon: Icons.circleX, color: 'text-red-500', bg: 'bg-red-500/10' },
          ].map((s) => (
            <SummaryCard
              key={s.title}
              title={s.title}
              value={s.value}
              icon={s.icon}
              color={s.color}
              bg={s.bg}
            />
          ))}
        </div>
      </section>

      {/* ─── Server Cards Grid ─── */}
      {loading ? (
        <div className='flex items-center justify-center py-12'>
          <Icons.spinner className='size-8 animate-spin text-muted-foreground' />
        </div>
      ) : servers.length === 0 ? (
        <Card className='py-8 border-dashed'>
          <CardContent className='text-center'>
            <Icons.server className='mx-auto size-10 text-muted-foreground mb-3' />
            <h3 className='font-semibold'>No servers yet</h3>
            <p className='text-muted-foreground text-sm mb-3'>
              Add your first VPS server to get started.
            </p>
            <Button size='sm' asChild>
              <Link href='/dashboard/servers'>
                <Icons.add className='mr-1 size-4' />
                Add Server
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className='stagger grid gap-3 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3'>
          {servers.map((server) => (
            <ServerCard
              key={server.id}
              server={server}
              stats={serverStats[server.id]}
            />
          ))}
        </div>
      )}
    </div>
  );
}
