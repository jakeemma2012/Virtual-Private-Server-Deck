'use client';

import { useEffect, useState, useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';
import { api, VpsServer, ServerCreateRequest } from '@/lib/api';
import { useNotify } from '@/components/ui/notify';
import Link from 'next/link';

function StatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase();
  const variant: Record<string, 'success' | 'destructive' | 'warning'> = {
    online: 'success',
    offline: 'destructive',
    warning: 'warning',
  };
  return (
    <Badge variant={variant[s] || 'destructive'}>
      <span className='status-dot mr-1 inline-block size-1.5 rounded-full bg-current' />
      {s.charAt(0).toUpperCase() + s.slice(1)}
    </Badge>
  );
}

export default function ServersPage() {
  const notify = useNotify();
  const [servers, setServers] = useState<VpsServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [form, setForm] = useState<ServerCreateRequest>({
    name: '', ip: '', port: 22, sshUsername: 'root', sshPassword: '',
    hostname: '', os: '', location: '', provider: '', tags: ''
  });
  const [saving, setSaving] = useState(false);

  // Edit state
  const [editingServer, setEditingServer] = useState<VpsServer | null>(null);
  const [editForm, setEditForm] = useState<ServerCreateRequest>({
    name: '', ip: '', port: 22, sshUsername: 'root', sshPassword: '',
    hostname: '', os: '', location: '', provider: '', tags: ''
  });
  const [editSaving, setEditSaving] = useState(false);

  const fetchServers = async () => {
    try { setServers(await api.getServers()); } catch { notify.error('Failed to load servers'); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchServers(); }, []);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.createServer(form);
      notify.success('Server added');
      setShowAdd(false);
      setForm({ name: '', ip: '', port: 22, sshUsername: 'root', sshPassword: '', hostname: '', os: '', location: '', provider: '', tags: '' });
      fetchServers();
    } catch (e: any) { notify.error(e.message || 'Failed'); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!(await notify.confirm(`Delete "${name}"?`))) return;
    try { await api.deleteServer(id); notify.success('Deleted'); fetchServers(); }
    catch (e: any) { notify.error(e.message); }
  };

  const openEdit = (server: VpsServer) => {
    setEditingServer(server);
    setEditForm({
      name: server.name, ip: server.ip, port: server.port,
      sshUsername: server.sshUsername, sshPassword: '',
      hostname: server.hostname || '', os: server.os || '',
      location: server.location || '', provider: server.provider || '',
      tags: server.tags || '',
    });
  };

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingServer) return;
    setEditSaving(true);
    try {
      // Only send password if user entered a new one
      const payload = { ...editForm };
      if (!payload.sshPassword) delete payload.sshPassword;
      await api.updateServer(editingServer.id, payload);
      notify.success('Server updated');
      setEditingServer(null);
      fetchServers();
    } catch (e: any) { notify.error(e.message || 'Failed to update'); }
    finally { setEditSaving(false); }
  };

  const handleTest = async (id: string) => {
    try {
      const r = await api.testConnection(id);
      notify[r.connected ? 'success' : 'error'](r.connected ? 'Connection OK' : 'Connection failed');
      fetchServers();
    } catch (e: any) { notify.error(e.message); }
  };

  const filtered = useMemo(() => servers.filter(s => {
    if (filter !== 'all' && s.status.toLowerCase() !== filter) return false;
    if (search && !s.name.toLowerCase().includes(search.toLowerCase()) && !s.ip.includes(search)) return false;
    return true;
  }), [servers, filter, search]);

  return (
    <div className='animate-rise flex flex-1 flex-col gap-4 p-3 md:p-6'>
      <div className='flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between'>
        <div>
          <h2 className='text-lg md:text-2xl font-bold tracking-tight'>VPS Servers</h2>
          <p className='text-muted-foreground text-xs md:text-sm'>Manage and monitor your servers</p>
        </div>
        <Button size='sm' onClick={() => setShowAdd(!showAdd)}>
          <Icons.add className='mr-1 size-4' />{showAdd ? 'Cancel' : 'Add Server'}
        </Button>
      </div>

      {showAdd && (
        <Card className='animate-pop'>
          <CardContent className='pt-4 pb-4'>
            <form onSubmit={handleAdd} className='grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3'>
              <div className='space-y-1'>
                <Label className='text-xs'>Server Name *</Label>
                <Input className='h-8 text-sm' value={form.name} onChange={e => setForm({...form, name: e.target.value})} placeholder='My VPS' required />
              </div>
              <div className='space-y-1'>
                <Label className='text-xs'>IP Address *</Label>
                <Input className='h-8 text-sm' value={form.ip} onChange={e => setForm({...form, ip: e.target.value})} placeholder='103.45.67.89' required />
              </div>
              <div className='space-y-1'>
                <Label className='text-xs'>SSH Port</Label>
                <Input className='h-8 text-sm' type='number' value={form.port} onChange={e => setForm({...form, port: parseInt(e.target.value)})} />
              </div>
              <div className='space-y-1'>
                <Label className='text-xs'>SSH Username *</Label>
                <Input className='h-8 text-sm' value={form.sshUsername} onChange={e => setForm({...form, sshUsername: e.target.value})} placeholder='root' required />
              </div>
              <div className='space-y-1'>
                <Label className='text-xs'>SSH Password</Label>
                <Input className='h-8 text-sm' type='password' value={form.sshPassword} onChange={e => setForm({...form, sshPassword: e.target.value})} />
              </div>
              <div className='space-y-1'>
                <Label className='text-xs'>Location</Label>
                <Input className='h-8 text-sm' value={form.location} onChange={e => setForm({...form, location: e.target.value})} placeholder='Singapore' />
              </div>
              <div className='space-y-1'>
                <Label className='text-xs'>Provider</Label>
                <Input className='h-8 text-sm' value={form.provider} onChange={e => setForm({...form, provider: e.target.value})} placeholder='DigitalOcean' />
              </div>
              <div className='space-y-1'>
                <Label className='text-xs'>OS</Label>
                <Input className='h-8 text-sm' value={form.os} onChange={e => setForm({...form, os: e.target.value})} placeholder='Ubuntu 22.04' />
              </div>
              <div className='flex items-end'>
                <Button type='submit' size='sm' isLoading={saving} className='w-full'>
                  <Icons.add className='mr-1 size-4' />Add
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <div className='flex flex-col gap-2 sm:flex-row sm:items-center'>
        <div className='relative flex-1'>
          <Icons.search className='text-muted-foreground absolute left-3 top-1/2 size-4 -translate-y-1/2' />
          <Input placeholder='Search...' className='pl-9 h-8 text-sm' value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className='inline-flex h-8 items-center rounded-lg bg-muted p-[2px] text-muted-foreground text-xs'>
          {(['all', 'online', 'offline'] as const).map((v) => (
            <button key={v} onClick={() => setFilter(v)}
              className={cn('press inline-flex h-[calc(100%-2px)] items-center rounded-md px-2.5 py-1 font-medium transition-colors',
                filter === v ? 'bg-background text-foreground shadow-sm' : 'hover:text-foreground')}>
              {v === 'all' ? `All (${servers.length})` : v === 'online' ? `Online (${servers.filter(s => s.status === 'ONLINE').length})` : `Offline (${servers.filter(s => s.status === 'OFFLINE').length})`}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className='flex items-center justify-center py-12'>
          <Icons.spinner className='size-8 animate-spin text-muted-foreground' />
        </div>
      ) : (
        <div className='stagger grid gap-3'>
          {filtered.map((server) => (
            <Card key={server.id} className='hover-lift'>
              <CardContent className='p-3 md:p-4'>
                <div className='flex flex-col gap-3 sm:flex-row sm:items-center'>
                  {/* Icon - hidden on mobile */}
                  <div className='hidden sm:flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10'>
                    <Icons.server className='size-5 text-primary' />
                  </div>

                  {/* Info */}
                  <div className='flex-1 min-w-0'>
                    <div className='flex items-center gap-2 flex-wrap'>
                      <h3 className='font-semibold text-sm'>{server.name}</h3>
                      <StatusBadge status={server.status} />
                    </div>
                    <div className='flex items-center gap-2 md:gap-3 mt-1 text-xs text-muted-foreground flex-wrap'>
                      <span className='flex items-center gap-1'><Icons.globe className='size-3' />{server.ip}:{server.port}</span>
                      {server.os && <span className='hidden sm:inline'>{server.os}</span>}
                      {server.provider && <span className='hidden md:inline'>{server.provider}</span>}
                      {server.location && <span className='hidden md:inline'>{server.location}</span>}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className='flex items-center gap-1.5 flex-shrink-0'>
                    <Button variant='outline' size='sm' className='h-7 w-7 p-0' onClick={() => handleTest(server.id)} title='Test'>
                      <Icons.wifi className='size-3.5' />
                    </Button>
                    <Button variant='outline' size='sm' className='h-7 w-7 p-0' onClick={() => openEdit(server)} title='Edit'>
                      <Icons.edit className='size-3.5' />
                    </Button>
                    <Button variant='outline' size='sm' className='h-7 w-7 p-0' asChild title='Terminal'>
                      <Link href={`/dashboard/terminal?serverId=${server.id}`}>
                        <Icons.terminal className='size-3.5' />
                      </Link>
                    </Button>
                    <Button variant='outline' size='sm' className='h-7 w-7 p-0' asChild title='Files'>
                      <Link href={`/dashboard/files?serverId=${server.id}`}>
                        <Icons.folder className='size-3.5' />
                      </Link>
                    </Button>
                    <Button variant='ghost' size='sm' className='h-7 w-7 p-0 text-destructive' onClick={() => handleDelete(server.id, server.name)}>
                      <Icons.trash className='size-3.5' />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
          {filtered.length === 0 && (
            <div className='animate-pop flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed bg-card/50 px-6 py-12 text-center shadow-soft'>
              <div className='flex size-12 items-center justify-center rounded-2xl bg-primary/10'>
                <Icons.server className='size-6 text-primary' />
              </div>
              <div className='space-y-1'>
                <p className='text-sm font-medium'>No servers found</p>
                <p className='text-muted-foreground text-xs'>
                  {servers.length === 0 ? 'Add your first VPS to get started.' : 'Try adjusting your search or filter.'}
                </p>
              </div>
              {servers.length === 0 && (
                <Button size='sm' onClick={() => setShowAdd(true)}>
                  <Icons.add className='mr-1 size-4' />Add Server
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Edit Server Dialog */}
      {editingServer && (
        <div className='fixed inset-0 z-[99998] flex items-center justify-center'>
          <div className='absolute inset-0 bg-black/40 backdrop-blur-[2px]' onClick={() => setEditingServer(null)} />
          <div className='animate-pop relative bg-card text-card-foreground border rounded-2xl shadow-soft-lg w-full max-w-lg mx-4'>
            <div className='flex items-center justify-between px-5 py-3 border-b'>
              <h3 className='font-semibold text-sm'>Edit Server: {editingServer.name}</h3>
              <button onClick={() => setEditingServer(null)} className='press text-muted-foreground hover:text-foreground'>
                <Icons.close className='size-5' />
              </button>
            </div>
            <form onSubmit={handleEdit} className='p-5'>
              <div className='grid gap-3 grid-cols-1 sm:grid-cols-2'>
                <div className='space-y-1'>
                  <Label className='text-xs'>Server Name *</Label>
                  <Input className='h-8 text-sm' value={editForm.name} onChange={e => setEditForm({...editForm, name: e.target.value})} required />
                </div>
                <div className='space-y-1'>
                  <Label className='text-xs'>IP Address *</Label>
                  <Input className='h-8 text-sm' value={editForm.ip} onChange={e => setEditForm({...editForm, ip: e.target.value})} required />
                </div>
                <div className='space-y-1'>
                  <Label className='text-xs'>SSH Port</Label>
                  <Input className='h-8 text-sm' type='number' value={editForm.port} onChange={e => setEditForm({...editForm, port: parseInt(e.target.value) || 22})} />
                </div>
                <div className='space-y-1'>
                  <Label className='text-xs'>SSH Username *</Label>
                  <Input className='h-8 text-sm' value={editForm.sshUsername} onChange={e => setEditForm({...editForm, sshUsername: e.target.value})} required />
                </div>
                <div className='space-y-1 sm:col-span-2'>
                  <Label className='text-xs'>SSH Password <span className='text-muted-foreground'>(leave empty to keep current)</span></Label>
                  <Input className='h-8 text-sm' type='password' value={editForm.sshPassword} onChange={e => setEditForm({...editForm, sshPassword: e.target.value})} placeholder='unchanged' />
                </div>
                <div className='space-y-1'>
                  <Label className='text-xs'>Hostname</Label>
                  <Input className='h-8 text-sm' value={editForm.hostname} onChange={e => setEditForm({...editForm, hostname: e.target.value})} />
                </div>
                <div className='space-y-1'>
                  <Label className='text-xs'>OS</Label>
                  <Input className='h-8 text-sm' value={editForm.os} onChange={e => setEditForm({...editForm, os: e.target.value})} />
                </div>
                <div className='space-y-1'>
                  <Label className='text-xs'>Location</Label>
                  <Input className='h-8 text-sm' value={editForm.location} onChange={e => setEditForm({...editForm, location: e.target.value})} />
                </div>
                <div className='space-y-1'>
                  <Label className='text-xs'>Provider</Label>
                  <Input className='h-8 text-sm' value={editForm.provider} onChange={e => setEditForm({...editForm, provider: e.target.value})} />
                </div>
                <div className='space-y-1 sm:col-span-2'>
                  <Label className='text-xs'>Tags</Label>
                  <Input className='h-8 text-sm' value={editForm.tags} onChange={e => setEditForm({...editForm, tags: e.target.value})} placeholder='e.g. production, game, web' />
                </div>
              </div>
              <div className='flex items-center justify-end gap-2 mt-4 pt-3 border-t'>
                <Button type='button' variant='outline' size='sm' onClick={() => setEditingServer(null)}>Cancel</Button>
                <Button type='submit' size='sm' isLoading={editSaving}>
                  <Icons.check className='size-3.5 mr-1' />Save Changes
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
