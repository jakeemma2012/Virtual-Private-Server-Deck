'use client';

import { Icons } from '@/components/icons';
import { Button } from '@/components/ui/button';

export function BreadcrumbPath({ path, onNavigate, onEdit }: {
  path: string; onNavigate: (path: string) => void; onEdit: () => void;
}) {
  const segments = path.split('/').filter(Boolean);

  return (
    <div className='flex items-center gap-0 min-w-0 flex-1 overflow-x-auto' style={{ WebkitOverflowScrolling: 'touch' }}>
      <Button variant='outline' size='sm' className='h-8 w-8 p-0 shrink-0 rounded-r-none border-r-0'
        onClick={() => { const parts = path.split('/').filter(Boolean); parts.pop(); onNavigate('/' + parts.join('/') || '/'); }}>
        <Icons.chevronLeft className='size-4' />
      </Button>

      <div className='flex items-center h-8 border rounded-none px-1 bg-card min-w-0 overflow-x-auto gap-0'>
        <button onClick={() => onNavigate('/')}
          className='press flex items-center gap-0.5 rounded-md px-1.5 py-1 text-xs hover:text-primary hover:bg-muted/50 transition-colors shrink-0'>
          <Icons.folder className='size-3 text-amber-500' />
          <span>Root dir</span>
        </button>

        {segments.map((seg, i) => {
          const segPath = '/' + segments.slice(0, i + 1).join('/');
          const isLast = i === segments.length - 1;
          return (
            <div key={segPath} className='flex items-center shrink-0'>
              <Icons.chevronRight className='size-3 text-muted-foreground' />
              <button onClick={() => onNavigate(segPath)}
                className={`press rounded-md px-1.5 py-1 text-xs max-w-[120px] truncate transition-colors ${isLast ? 'text-foreground font-medium' : 'hover:text-primary hover:bg-muted/50 text-muted-foreground'}`}>
                {seg}
              </button>
            </div>
          );
        })}
      </div>

      <Button variant='outline' size='sm' className='h-8 w-8 p-0 shrink-0 rounded-l-none border-l-0'
        onClick={onEdit} title='Edit path'>
        <Icons.edit className='size-3' />
      </Button>
    </div>
  );
}
