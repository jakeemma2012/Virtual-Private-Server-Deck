'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Icons } from '@/components/icons';
import { api, VpsServer } from '@/lib/api';
import { useNotify } from '@/components/ui/notify';
import { cn } from '@/lib/utils';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from '@/components/ui/select';

interface Website {
  domain: string;
  aliases: string;
  root: string;
  ssl: boolean;
  sslExpiry: string;
  status: string;
  configPath: string;
}

function parseSites(output: string): Website[] {
  return output.split('===SITE===').filter(b => b.trim()).map(block => {
    const m: Record<string, string> = {};
    block.trim().split('\n').forEach(l => { const [k, ...v] = l.split('='); if (k) m[k.trim()] = v.join('=').trim(); });
    return m.domain ? {
      domain: m.domain, aliases: m.aliases || '', root: m.root || '',
      ssl: m.ssl === 'yes', sslExpiry: m.ssl_expiry || '',
      status: m.status || 'running', configPath: m.config || ''
    } : null;
  }).filter(Boolean) as Website[];
}

// ========== Site Config Popup (aaPanel style) ==========
function SiteConfigPopup({ serverId, site, onClose, onRefresh }: {
  serverId: string; site: Website; onClose: () => void; onRefresh: () => void;
}) {
  const toast = useNotify();
  const [tab, setTab] = useState('domain');
  const [configContent, setConfigContent] = useState('');
  const [configLoading, setConfigLoading] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [domains, setDomains] = useState('');
  const [domainsLoading, setDomainsLoading] = useState(false);
  const [sslStatus, setSslStatus] = useState<any>(null);
  const [redirectRules, setRedirectRules] = useState('');
  const [proxyTarget, setProxyTarget] = useState('');
  const [directory, setDirectory] = useState(site.root);
  const [EditorComp, setEditorComp] = useState<any>(null);
  const contentRef = useRef(configContent);
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;

  useEffect(() => {
    if (!isMobile) import('@monaco-editor/react').then(m => setEditorComp(() => m.default));
  }, [isMobile]);

  // Load data per tab
  useEffect(() => {
    if (tab === 'config') loadConfig();
    if (tab === 'domain') loadDomains();
    if (tab === 'ssl') loadSsl();
    if (tab === 'rewrite') loadRewrite();
  }, [tab]);

  const loadConfig = async () => {
    setConfigLoading(true);
    try {
      const r = await api.executeCommand(serverId, `cat ${site.configPath}`);
      setConfigContent(r.output); contentRef.current = r.output;
    } catch {} finally { setConfigLoading(false); }
  };

  const saveConfig = async () => {
    setConfigSaving(true);
    try {
      const escaped = contentRef.current.replace(/'/g, "'\\''");
      await api.executeCommand(serverId, `echo '${escaped}' > ${site.configPath}`);
      const test = await api.executeCommand(serverId, 'nginx -t 2>&1');
      if (test.exitCode !== 0) { toast.error('Nginx config error: ' + test.error + test.output); }
      else { await api.executeCommand(serverId, 'nginx -s reload'); toast.success('Saved & reloaded'); }
    } catch (e: any) { toast.error(e.message); }
    finally { setConfigSaving(false); }
  };

  const loadDomains = async () => {
    setDomainsLoading(true);
    try {
      const r = await api.executeCommand(serverId, `grep -m1 'server_name' ${site.configPath} | sed 's/.*server_name//;s/;//'`);
      setDomains(r.output.trim());
    } catch {} finally { setDomainsLoading(false); }
  };

  const saveDomains = async () => {
    try {
      await api.executeCommand(serverId, `sed -i 's/server_name .*/server_name ${domains.trim()};/' ${site.configPath}`);
      const t = await api.executeCommand(serverId, 'nginx -t 2>&1 && nginx -s reload 2>&1');
      toast[t.exitCode === 0 ? 'success' : 'error'](t.exitCode === 0 ? 'Domains updated' : t.output);
      onRefresh();
    } catch (e: any) { toast.error(e.message); }
  };

  const loadSsl = async () => {
    try {
      const r = await api.executeCommand(serverId, `
        cert=$(grep -m1 'ssl_certificate ' ${site.configPath} 2>/dev/null | sed 's/.*ssl_certificate //;s/;//' | xargs)
        if [ -n "$cert" ] && [ -f "$cert" ]; then
          echo "enabled=yes"
          openssl x509 -in "$cert" -noout -subject -enddate -issuer 2>/dev/null
        else
          echo "enabled=no"
        fi
      `);
      const lines = r.output.trim().split('\n');
      const enabled = lines[0]?.includes('enabled=yes');
      setSslStatus({
        enabled,
        subject: lines.find(l => l.startsWith('subject='))?.replace('subject=', '') || '',
        expiry: lines.find(l => l.startsWith('notAfter='))?.replace('notAfter=', '') || '',
        issuer: lines.find(l => l.startsWith('issuer='))?.replace('issuer=', '') || '',
      });
    } catch {}
  };

  const enableSsl = async () => {
    toast.info('Requesting SSL...');
    try {
      const r = await api.executeCommand(serverId, `certbot --nginx -d ${site.domain} --non-interactive --agree-tos --register-unsafely-without-email 2>&1`);
      toast[r.exitCode === 0 ? 'success' : 'error'](r.exitCode === 0 ? 'SSL enabled' : 'Failed: ' + r.output.slice(-200));
      if (r.exitCode === 0) { loadSsl(); onRefresh(); }
    } catch (e: any) { toast.error(e.message); }
  };

  const loadRewrite = async () => {
    try {
      const r = await api.executeCommand(serverId, `grep -A20 'location /' ${site.configPath} | grep 'rewrite\\|return' | head -10`);
      setRedirectRules(r.output.trim());
    } catch {}
  };

  const saveDirectory = async () => {
    try {
      await api.executeCommand(serverId, `mkdir -p ${directory} && sed -i 's|root .*|root ${directory};|' ${site.configPath}`);
      const t = await api.executeCommand(serverId, 'nginx -t 2>&1 && nginx -s reload 2>&1');
      toast[t.exitCode === 0 ? 'success' : 'error'](t.exitCode === 0 ? 'Directory updated' : t.output);
      onRefresh();
    } catch (e: any) { toast.error(e.message); }
  };

  const addProxy = async () => {
    if (!proxyTarget.trim()) return;
    try {
      const proxyConf = `location / {\n    proxy_pass ${proxyTarget};\n    proxy_set_header Host $host;\n    proxy_set_header X-Real-IP $remote_addr;\n    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n    proxy_set_header X-Forwarded-Proto $scheme;\n}`;
      // This is simplified - in production would need smarter config editing
      toast.info('Add reverse proxy config manually in Config tab');
    } catch (e: any) { toast.error(e.message); }
  };

  const tabs = [
    { id: 'domain', label: 'Domain Manager', icon: Icons.globe },
    { id: 'directory', label: 'Directory', icon: Icons.folder },
    { id: 'ssl', label: 'SSL', icon: Icons.lock },
    { id: 'config', label: 'Config', icon: Icons.code },
    { id: 'rewrite', label: 'URL Rewrite', icon: Icons.arrowRight },
    { id: 'proxy', label: 'Reverse Proxy', icon: Icons.network },
    { id: 'log', label: 'Access Log', icon: Icons.logs },
  ];

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  return (
    <div className='fixed inset-0 z-[9998] flex items-start justify-center pt-4 md:pt-12'>
      <div className='absolute inset-0 bg-black/40' onClick={onClose} />
      <div className='relative w-full max-w-4xl mx-2 bg-background rounded-xl border shadow-2xl overflow-hidden flex flex-col' style={{ maxHeight: 'calc(100vh - 2rem)' }}>
        {/* Header */}
        <div className='flex items-center justify-between px-4 py-3 border-b bg-muted/30 shrink-0'>
          <div className='min-w-0'>
            <h3 className='font-semibold text-sm truncate'>Site modification [{site.domain}]</h3>
            <p className='text-[10px] text-muted-foreground'>Config: {site.configPath}</p>
          </div>
          <button onClick={onClose} className='text-muted-foreground hover:text-foreground shrink-0 ml-2'>
            <Icons.close className='size-5' />
          </button>
        </div>

        {/* Body: sidebar tabs + content */}
        <div className='flex flex-1 min-h-0 overflow-hidden'>
          {/* Tab sidebar */}
          <div className='w-32 md:w-40 border-r bg-muted/10 overflow-y-auto shrink-0'>
            {tabs.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={cn('flex items-center gap-1.5 w-full text-left px-3 py-2.5 text-xs transition-colors border-l-2',
                  tab === t.id ? 'border-l-primary bg-background text-foreground font-medium' : 'border-l-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50')}>
                <t.icon className='size-3.5 shrink-0' />
                <span className='truncate'>{t.label}</span>
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className='flex-1 overflow-y-auto p-4 min-w-0'>

            {/* Domain Manager */}
            {tab === 'domain' && (
              <div className='space-y-4'>
                <p className='text-xs text-muted-foreground'>A domain per line. Wildcard: *.domain.com. Custom port: domain.com:88</p>
                <Textarea value={domains} onChange={e => setDomains(e.target.value)}
                  className='h-24 bg-muted/30 text-sm font-mono'
                  placeholder='example.com&#10;www.example.com' />
                <Button size='sm' onClick={saveDomains}><Icons.check className='size-3 mr-1' />Save</Button>
              </div>
            )}

            {/* Directory */}
            {tab === 'directory' && (
              <div className='space-y-4'>
                <div className='space-y-2'>
                  <Label className='text-xs'>Document Root</Label>
                  <div className='flex gap-2'>
                    <Input value={directory} onChange={e => setDirectory(e.target.value)} className='font-mono text-sm' />
                    <Button size='sm' onClick={saveDirectory}><Icons.check className='size-3 mr-1' />Save</Button>
                  </div>
                </div>
              </div>
            )}

            {/* SSL */}
            {tab === 'ssl' && (
              <div className='space-y-4'>
                {sslStatus?.enabled ? (
                  <div className='space-y-3'>
                    <Badge variant='success'>
                      <Icons.lock className='size-3 mr-1' />SSL Enabled
                    </Badge>
                    <div className='rounded-md border p-3 space-y-1 text-sm'>
                      <div><span className='text-muted-foreground'>Subject:</span> {sslStatus.subject}</div>
                      <div><span className='text-muted-foreground'>Issuer:</span> {sslStatus.issuer}</div>
                      <div><span className='text-muted-foreground'>Expires:</span> {sslStatus.expiry}</div>
                    </div>
                    <Button variant='outline' size='sm' onClick={enableSsl}>
                      <Icons.refresh className='size-3 mr-1' />Renew Certificate
                    </Button>
                  </div>
                ) : (
                  <div className='space-y-3'>
                    <p className='text-sm text-muted-foreground'>SSL is not enabled for this site.</p>
                    <Button size='sm' onClick={enableSsl}>
                      <Icons.lock className='size-3 mr-1' />Enable SSL (Let's Encrypt)
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Config (nginx conf editor) */}
            {tab === 'config' && (
              <div className='space-y-3 h-full flex flex-col'>
                <div className='flex items-center justify-between'>
                  <span className='text-xs text-muted-foreground font-mono'>{site.configPath}</span>
                  <Button size='sm' className='h-6 text-xs' onClick={saveConfig} disabled={configSaving}>
                    {configSaving ? <Icons.spinner className='size-3 animate-spin mr-1' /> : <Icons.check className='size-3 mr-1' />}
                    Save & Reload
                  </Button>
                </div>
                <div className='flex-1 min-h-[300px] rounded-md border overflow-hidden'>
                  {configLoading ? (
                    <div className='flex items-center justify-center h-full'><Icons.spinner className='size-6 animate-spin' /></div>
                  ) : isMobile || !EditorComp ? (
                    <Textarea value={configContent}
                      onChange={e => { setConfigContent(e.target.value); contentRef.current = e.target.value; }}
                      className='w-full h-full resize-none rounded-none border-0 bg-card text-foreground font-mono text-xs'
                      spellCheck={false} />
                  ) : (
                    <EditorComp height='100%' language='nginx' value={configContent} theme='vs-dark'
                      onChange={(v: string | undefined) => { contentRef.current = v || ''; setConfigContent(v || ''); }}
                      options={{ fontSize: 13, minimap: { enabled: false }, wordWrap: 'on',
                        automaticLayout: true, scrollBeyondLastLine: false }} />
                  )}
                </div>
              </div>
            )}

            {/* URL Rewrite */}
            {tab === 'rewrite' && (
              <div className='space-y-4'>
                <p className='text-xs text-muted-foreground'>Current rewrite/redirect rules detected:</p>
                <pre className='rounded-md border bg-muted/30 p-3 text-xs font-mono whitespace-pre-wrap'>
                  {redirectRules || 'No rewrite rules found'}
                </pre>
                <p className='text-xs text-muted-foreground'>Edit rewrite rules directly in the Config tab.</p>
              </div>
            )}

            {/* Reverse Proxy */}
            {tab === 'proxy' && (
              <div className='space-y-4'>
                <div className='space-y-2'>
                  <Label className='text-xs'>Proxy Target URL</Label>
                  <div className='flex gap-2'>
                    <Input value={proxyTarget} onChange={e => setProxyTarget(e.target.value)}
                      placeholder='http://127.0.0.1:3000' className='font-mono text-sm' />
                    <Button size='sm' onClick={addProxy}><Icons.add className='size-3 mr-1' />Add</Button>
                  </div>
                </div>
                <p className='text-xs text-muted-foreground'>For complex proxy configs, edit directly in the Config tab.</p>
              </div>
            )}

            {/* Access Log */}
            {tab === 'log' && <AccessLogTab serverId={serverId} domain={site.domain} />}
          </div>
        </div>
      </div>
    </div>
  );
}

// Access log viewer
function AccessLogTab({ serverId, domain }: { serverId: string; domain: string }) {
  const [log, setLog] = useState('');
  const [loading, setLoading] = useState(true);
  const [lines, setLines] = useState(50);

  const loadLog = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.executeCommand(serverId,
        `tail -n ${lines} /var/log/nginx/${domain}.access.log 2>/dev/null || tail -n ${lines} /www/wwwlogs/${domain}.log 2>/dev/null || echo "Log file not found"`);
      setLog(r.output);
    } catch {} finally { setLoading(false); }
  }, [serverId, domain, lines]);

  useEffect(() => { loadLog(); }, [loadLog]);

  return (
    <div className='space-y-3'>
      <div className='flex items-center gap-2'>
        <span className='text-xs text-muted-foreground'>Last</span>
        <Select value={String(lines)} onValueChange={v => setLines(Number(v))}>
          <SelectTrigger className='w-20 h-7 text-xs'><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value='50'>50</SelectItem>
            <SelectItem value='100'>100</SelectItem>
            <SelectItem value='500'>500</SelectItem>
          </SelectContent>
        </Select>
        <span className='text-xs text-muted-foreground'>lines</span>
        <Button variant='outline' size='sm' className='h-7 text-xs ml-auto' onClick={loadLog}>
          <Icons.refresh className='size-3 mr-1' />Refresh
        </Button>
      </div>
      {loading ? (
        <div className='flex justify-center py-8'><Icons.spinner className='size-6 animate-spin' /></div>
      ) : (
        <pre className='rounded-lg border bg-muted/40 text-foreground p-3 text-[11px] font-mono whitespace-pre-wrap max-h-[400px] overflow-y-auto leading-relaxed'>
          {log || 'No logs found'}
        </pre>
      )}
    </div>
  );
}

// ========== Main Page ==========
export default function WebsitePage() {
  const toast = useNotify();
  const [servers, setServers] = useState<VpsServer[]>([]);
  const [selectedServer, setSelectedServer] = useState('');
  const [websites, setWebsites] = useState<Website[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [nginxInfo, setNginxInfo] = useState({ version: '', status: '' });
  const [configSite, setConfigSite] = useState<Website | null>(null);
  const [newDomain, setNewDomain] = useState('');
  const [newRoot, setNewRoot] = useState('/var/www/');
  const [saving, setSaving] = useState(false);

  useEffect(() => { api.getServers().then(setServers).catch(() => {}); }, []);

  const fetchSites = useCallback(async () => {
    if (!selectedServer) return;
    setLoading(true);
    try {
      const [ver, status, sites] = await Promise.all([
        api.executeCommand(selectedServer, 'nginx -v 2>&1'),
        api.executeCommand(selectedServer, 'systemctl is-active nginx 2>/dev/null || echo stopped'),
        api.executeCommand(selectedServer, `for conf in /etc/nginx/sites-enabled/* /www/server/panel/vhost/nginx/*.conf; do
  [ -f "$conf" ] || continue
  domain=$(grep -m1 'server_name' "$conf" 2>/dev/null | sed 's/.*server_name//;s/;//' | awk '{print $1}')
  [ -z "$domain" ] && continue
  aliases=$(grep -m1 'server_name' "$conf" 2>/dev/null | sed 's/.*server_name//;s/;//' | awk '{$1=""; print $0}' | xargs)
  root=$(grep -m1 'root ' "$conf" 2>/dev/null | sed 's/.*root //;s/;//' | xargs)
  ssl="no"; ssl_expiry=""
  grep -q 'ssl_certificate' "$conf" 2>/dev/null && ssl="yes"
  if [ "$ssl" = "yes" ]; then
    cert=$(grep -m1 'ssl_certificate ' "$conf" 2>/dev/null | sed 's/.*ssl_certificate //;s/;//' | xargs)
    [ -f "$cert" ] && ssl_expiry=$(openssl x509 -enddate -noout -in "$cert" 2>/dev/null | cut -d= -f2)
  fi
  echo "===SITE==="
  echo "domain=$domain"
  echo "aliases=$aliases"
  echo "root=$root"
  echo "config=$conf"
  echo "ssl=$ssl"
  echo "ssl_expiry=$ssl_expiry"
  echo "status=running"
done`),
      ]);
      setNginxInfo({ version: (ver.output || ver.error).trim().replace('nginx version: ', ''), status: status.output.trim() });
      setWebsites(parseSites(sites.output));
    } catch (e: any) { toast.error(e.message); }
    finally { setLoading(false); }
  }, [selectedServer]);

  useEffect(() => { if (selectedServer) fetchSites(); }, [selectedServer, fetchSites]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDomain.trim() || !selectedServer) return;
    setSaving(true);
    try {
      const root = newRoot.endsWith('/') ? newRoot + newDomain : newRoot;
      const conf = `server {\n    listen 80;\n    server_name ${newDomain};\n    root ${root};\n    index index.html index.htm index.php;\n    location / { try_files \\$uri \\$uri/ /index.html; }\n    access_log /var/log/nginx/${newDomain}.access.log;\n    error_log /var/log/nginx/${newDomain}.error.log;\n}`;
      await api.executeCommand(selectedServer, `mkdir -p ${root}`);
      await api.executeCommand(selectedServer, `cat > /etc/nginx/sites-available/${newDomain}.conf << 'NGINXEOF'\n${conf}\nNGINXEOF`);
      await api.executeCommand(selectedServer, `ln -sf /etc/nginx/sites-available/${newDomain}.conf /etc/nginx/sites-enabled/`);
      const t = await api.executeCommand(selectedServer, 'nginx -t 2>&1');
      if (t.exitCode !== 0) toast.error('Config error: ' + t.output + t.error);
      else { await api.executeCommand(selectedServer, 'nginx -s reload'); toast.success('Site created'); setNewDomain(''); setShowAdd(false); fetchSites(); }
    } catch (e: any) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  const deleteSite = async (site: Website) => {
    if (!(await toast.confirm(`Delete "${site.domain}"?`))) return;
    try {
      await api.executeCommand(selectedServer, `rm -f ${site.configPath} /etc/nginx/sites-enabled/${site.domain}.conf /etc/nginx/sites-available/${site.domain}.conf`);
      await api.executeCommand(selectedServer, 'nginx -s reload');
      toast.success('Deleted'); fetchSites();
    } catch (e: any) { toast.error(e.message); }
  };

  const daysLeft = (exp: string) => {
    if (!exp) return '';
    const d = Math.floor((new Date(exp).getTime() - Date.now()) / 86400000);
    return d > 0 ? `${d} Days` : 'Expired';
  };

  return (
    <div className='flex flex-1 flex-col gap-3 p-3 md:p-6 animate-rise'>
      <div className='flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between'>
        <div>
          <h2 className='text-lg md:text-2xl font-bold tracking-tight'>Website</h2>
          <p className='text-muted-foreground text-xs md:text-sm'>Manage Nginx websites</p>
        </div>
        <Select value={selectedServer} onValueChange={setSelectedServer}>
          <SelectTrigger className='w-full sm:w-[200px] h-8 text-xs sm:text-sm'>
            <SelectValue placeholder='Select server' />
          </SelectTrigger>
          <SelectContent>
            {servers.filter(s => s.status === 'ONLINE').map(s => (
              <SelectItem key={s.id} value={s.id}>{s.name} ({s.ip})</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {selectedServer && (
        <>
          <div className='flex flex-wrap items-center gap-2'>
            <Button size='sm' className='h-7 text-xs' onClick={() => setShowAdd(!showAdd)}>
              <Icons.add className='size-3 mr-1' />{showAdd ? 'Cancel' : 'Add site'}
            </Button>
            <Button variant='outline' size='sm' className='h-7 text-xs' onClick={async () => {
              const r = await api.executeCommand(selectedServer, 'nginx -t 2>&1 && nginx -s reload 2>&1');
              toast[r.exitCode === 0 ? 'success' : 'error'](r.exitCode === 0 ? 'Reloaded' : r.output);
            }}>
              <Icons.refresh className='size-3 mr-1' />Reload
            </Button>
            <div className='ml-auto flex items-center gap-2'>
              {(() => {
                const up = nginxInfo.status.includes('active') || nginxInfo.status === 'running';
                return (
                  <Badge variant={up ? 'success' : 'destructive'} className='text-[10px]'>
                    <span className={cn('status-dot mr-1 size-1.5 rounded-full inline-block', up ? 'bg-emerald-500' : 'bg-red-500')} />
                    {nginxInfo.version || 'Nginx'}
                  </Badge>
                );
              })()}
            </div>
          </div>

          {showAdd && (
            <Card><CardContent className='pt-4 pb-4'>
              <form onSubmit={handleAdd} className='grid gap-3 grid-cols-1 sm:grid-cols-3'>
                <div className='space-y-1'><Label className='text-xs'>Domain *</Label>
                  <Input className='h-8 text-sm' value={newDomain} onChange={e => setNewDomain(e.target.value)} placeholder='example.com' required /></div>
                <div className='space-y-1'><Label className='text-xs'>Document Root</Label>
                  <Input className='h-8 text-sm' value={newRoot} onChange={e => setNewRoot(e.target.value)} /></div>
                <div className='flex items-end'>
                  <Button type='submit' size='sm' isLoading={saving} className='w-full h-8'><Icons.add className='size-3 mr-1' />Create</Button></div>
              </form>
            </CardContent></Card>
          )}

          {loading ? (
            <div className='flex justify-center py-12'><Icons.spinner className='size-8 animate-spin text-muted-foreground' /></div>
          ) : (
            <Card><CardContent className='p-0 stagger'>
              {/* Header */}
              <div className='hidden md:grid grid-cols-[1fr_80px_70px_90px_90px] gap-2 px-4 py-2 border-b bg-muted/50 text-xs font-medium text-muted-foreground'>
                <div>Site name</div><div>Status</div><div>SSL</div><div>Expiration</div><div className='text-right'>Operate</div>
              </div>

              {websites.length === 0 && (
                <div className='text-center py-12 text-muted-foreground text-sm'>No websites. Click "Add site".</div>
              )}

              {websites.map(site => (
                <div key={site.domain + site.configPath}
                  className='hover-lift flex flex-col md:grid md:grid-cols-[1fr_80px_70px_90px_90px] gap-1 md:gap-2 md:items-center px-4 py-3 border-b last:border-b-0 hover:bg-muted/30 transition-colors cursor-pointer'
                  onClick={() => setConfigSite(site)}>
                  <div className='min-w-0'>
                    <div className='flex items-center gap-2'>
                      <Icons.globe className='size-3.5 text-primary shrink-0' />
                      <span className='font-semibold text-sm truncate'>{site.domain}</span>
                      <a href={`http${site.ssl ? 's' : ''}://${site.domain}`} target='_blank' rel='noopener'
                        className='text-muted-foreground hover:text-foreground shrink-0' onClick={e => e.stopPropagation()}>
                        <Icons.externalLink className='size-3' />
                      </a>
                    </div>
                    <div className='text-[10px] text-muted-foreground ml-5 truncate'>{site.root}</div>
                  </div>
                  <div>
                    <Badge variant='success' className='text-[10px]'>Active</Badge>
                  </div>
                  <div>
                    {site.ssl ? <Badge variant='success' className='text-[10px]'><Icons.lock className='size-2.5 mr-0.5' />SSL</Badge>
                      : <Badge variant='warning' className='text-[10px]'>Off</Badge>}
                  </div>
                  <div className='text-xs text-muted-foreground'>
                    {site.ssl && site.sslExpiry ? daysLeft(site.sslExpiry) : '-'}
                  </div>
                  <div className='flex items-center gap-1 md:justify-end' onClick={e => e.stopPropagation()}>
                    <Button variant='outline' size='sm' className='h-6 text-[10px] px-2' onClick={() => setConfigSite(site)}>Conf</Button>
                    <Button variant='ghost' size='sm' className='h-6 w-6 p-0 text-destructive' onClick={() => deleteSite(site)}>
                      <Icons.trash className='size-3' />
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent></Card>
          )}
        </>
      )}

      {/* Site config popup */}
      {configSite && selectedServer && (
        <SiteConfigPopup serverId={selectedServer} site={configSite}
          onClose={() => setConfigSite(null)} onRefresh={fetchSites} />
      )}
    </div>
  );
}
