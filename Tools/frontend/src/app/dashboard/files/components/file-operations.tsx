'use client';

import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';

export function FileOperations({ onAction }: { onAction: (action: string) => void }) {
  const [open, setOpen] = useState(false);
  const [newSub, setNewSub] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setNewSub(false); } };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, [open]);

  return (
    <div ref={ref} className='relative'>
      <Button variant='outline' size='sm' className='h-8 text-xs gap-1.5 border-primary/30 text-primary hover:bg-primary/5' onClick={() => { setOpen(!open); setNewSub(false); }}>
        <Icons.folder className='size-3.5 text-amber-500' />
        File Operations
        <Icons.chevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
      </Button>
      {open && (
        <div className='absolute top-full left-0 mt-1 z-50 min-w-[200px] rounded-lg border bg-popover text-popover-foreground shadow-xl py-1.5 animate-in fade-in-0 zoom-in-95'>
          <MenuItem icon={Icons.upload} label='Upload' onClick={() => { onAction('upload'); setOpen(false); }} />
          <MenuItem icon={Icons.download} label='Remote Download' onClick={() => { onAction('remote-download'); setOpen(false); }} />
          <div className='relative'
            onMouseEnter={() => setNewSub(true)} onMouseLeave={() => setNewSub(false)}>
            <div className='flex w-full items-center justify-between px-4 py-2.5 text-sm hover:bg-accent transition-colors cursor-pointer'>
              <span className='flex items-center gap-2.5'><Icons.folder className='size-4 text-amber-500' />Mới</span>
              <Icons.chevronRight className='size-3.5 text-muted-foreground' />
            </div>
            {newSub && (
              <div className='absolute left-full top-0 ml-0.5 min-w-[150px] rounded-lg border bg-popover shadow-lg py-1 animate-in fade-in-0 slide-in-from-left-1'>
                <MenuItem icon={Icons.page} label='New File' onClick={() => { onAction('newfile'); setOpen(false); }} />
                <MenuItem icon={Icons.folder} label='New Folder' onClick={() => { onAction('newfolder'); setOpen(false); }} />
              </div>
            )}
          </div>
          <MenuItem icon={Icons.search} label='Search File Content' onClick={() => { onAction('search-content'); setOpen(false); }} />
          <div className='my-1 border-t' />
          <MenuItem icon={Icons.terminal} label='Terminal' onClick={() => { onAction('terminal-popup'); setOpen(false); }} />
          <MenuItem icon={Icons.folder} label='Root Directory' onClick={() => { onAction('goto-root'); setOpen(false); }} />
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick }: { icon: any; label: string; onClick: () => void }) {
  return (
    <button className='flex w-full items-center gap-2.5 rounded-md px-4 py-2.5 text-sm hover:bg-accent transition-colors'
      onClick={onClick}>
      <Icon className='size-4' />{label}
    </button>
  );
}
