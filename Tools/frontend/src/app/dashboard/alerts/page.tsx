'use client';

import { useEffect, useState, useCallback } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Icons } from '@/components/icons';
import { useNotify } from '@/components/ui/notify';
import { cn } from '@/lib/utils';

interface Alert { id: string; content: string; }

const API_BASE = '';

async function apiCall(path: string, options: RequestInit = {}) {
  const token = localStorage.getItem('token') || '';
  const headers: Record<string, string> = { 'Authorization': `Bearer ${token}`, ...(options.headers as Record<string, string>) };
  if (!(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const res = await fetch(API_BASE + path, { ...options, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.status === 204 ? null : res.json();
}

export default function AlertsPage() {
  const toast = useNotify();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Alert | null>(null);
  const [formId, setFormId] = useState('');
  const [formContent, setFormContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');

  const fetchAlerts = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiCall('/api/alerts');
      setAlerts(data);
    } catch (e: any) { toast.error(e.message); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { fetchAlerts(); }, [fetchAlerts]);

  const openAdd = () => { setEditing(null); setFormId(''); setFormContent(''); setShowForm(true); };
  const openEdit = (a: Alert) => { setEditing(a); setFormId(a.id); setFormContent(a.content); setShowForm(true); };

  const handleSave = async () => {
    if (!formId.trim()) { toast.error('ID required'); return; }
    setSaving(true);
    try {
      if (editing) {
        await apiCall(`/api/alerts/${encodeURIComponent(editing.id)}`, { method: 'PUT', body: JSON.stringify({ id: editing.id, content: formContent }) });
        toast.success('Updated');
      } else {
        await apiCall('/api/alerts', { method: 'POST', body: JSON.stringify({ id: formId.trim(), content: formContent }) });
        toast.success('Created');
      }
      setShowForm(false); setEditing(null); setFormId(''); setFormContent('');
      fetchAlerts();
    } catch (e: any) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  const handleDelete = async (a: Alert) => {
    if (!(await toast.confirm(`Delete alert "${a.id}"?`))) return;
    try { await apiCall(`/api/alerts/${encodeURIComponent(a.id)}`, { method: 'DELETE' }); toast.success('Deleted'); fetchAlerts(); }
    catch (e: any) { toast.error(e.message); }
  };

  const filtered = search ? alerts.filter(a => a.id.toLowerCase().includes(search.toLowerCase()) || (a.content || '').toLowerCase().includes(search.toLowerCase())) : alerts;

  return (
    <div className='flex flex-1 flex-col gap-4 p-3 md:p-6 animate-rise'>
      <div className='flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between'>
        <div>
          <h2 className='text-lg md:text-2xl font-bold tracking-tight'>Alerts</h2>
          <p className='text-muted-foreground text-xs md:text-sm'>Manage alert messages</p>
        </div>
        <div className='flex items-center gap-2'>
          <Button variant='outline' size='sm' className='h-8 text-xs' onClick={fetchAlerts}>
            <Icons.refresh className='size-3 mr-1' />Refresh
          </Button>
          <Button size='sm' className='h-8 text-xs' onClick={openAdd}>
            <Icons.add className='size-3 mr-1' />Add Alert
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className='relative max-w-sm'>
        <Icons.search className='absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground' />
        <Input value={search} onChange={e => setSearch(e.target.value)} placeholder='Search by ID or content...' className='pl-9 h-8 text-sm' />
      </div>

      {/* Form - shown inline when adding/editing */}
      {showForm && (
        <Card className='animate-pop'>
          <CardHeader className='pb-2'>
            <h3 className='text-sm font-semibold'>{editing ? `Edit Alert: ${editing.id}` : 'New Alert'}</h3>
          </CardHeader>
          <CardContent className='space-y-3'>
            <div className='space-y-1.5'>
              <Label className='text-xs'>ID *</Label>
              <Input value={formId} onChange={e => setFormId(e.target.value)} disabled={!!editing}
                placeholder='e.g. alert_001' className='h-8 text-sm font-mono' />
            </div>
            <div className='space-y-1.5'>
              <Label className='text-xs'>Content</Label>
              <Textarea value={formContent} onChange={e => setFormContent(e.target.value)}
                placeholder='Alert message content...'
                className='min-h-[100px] text-sm resize-y' />
            </div>
            <div className='flex items-center justify-end gap-2'>
              <Button variant='outline' size='sm' onClick={() => { setShowForm(false); setEditing(null); }}>Cancel</Button>
              <Button size='sm' onClick={handleSave} disabled={saving}>
                {saving ? <Icons.spinner className='size-3 animate-spin mr-1' /> : <Icons.check className='size-3 mr-1' />}
                {editing ? 'Update' : 'Create'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Table */}
      <Card>
        <CardContent className='p-0'>
          <div className='hidden md:grid grid-cols-[200px_1fr_140px] gap-2 px-4 py-2 border-b bg-muted/50 text-xs font-medium text-muted-foreground'>
            <div>ID</div><div>Content</div><div className='text-right'>Actions</div>
          </div>

          {loading ? (
            <div className='flex justify-center py-12'><Icons.spinner className='size-8 animate-spin text-muted-foreground' /></div>
          ) : filtered.length === 0 ? (
            <div className='text-center py-12 text-muted-foreground text-sm'>
              {search ? 'No results' : alerts.length === 0 ? 'No alerts yet. Click "Add Alert".' : 'No match'}
            </div>
          ) : (
            <div className='stagger'>
              {filtered.map(a => (
                <div key={a.id} className='flex flex-col md:grid md:grid-cols-[200px_1fr_140px] gap-2 md:items-center px-4 py-3 border-b last:border-b-0 hover:bg-muted/30 transition-colors'>
                  <div className='font-mono text-sm font-semibold truncate'>{a.id}</div>
                  <div className='text-sm text-muted-foreground line-clamp-2'>{a.content || <span className='italic opacity-50'>empty</span>}</div>
                  <div className='flex items-center gap-1 md:justify-end'>
                    <Button variant='outline' size='sm' className='h-7 text-xs' onClick={() => openEdit(a)}>
                      <Icons.edit className='size-3 mr-1' />Edit
                    </Button>
                    <Button variant='ghost' size='sm' className='h-7 w-7 p-0 text-destructive press' onClick={() => handleDelete(a)}>
                      <Icons.trash className='size-3.5' />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className='text-xs text-muted-foreground'>Total: {alerts.length} alert{alerts.length !== 1 ? 's' : ''}</div>
    </div>
  );
}
