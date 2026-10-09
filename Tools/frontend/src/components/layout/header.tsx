import React from 'react';
import { SidebarTrigger } from '../ui/sidebar';
import { Separator } from '../ui/separator';
import { Breadcrumbs } from '../breadcrumbs';
import SearchInput from '../search-input';
import { ThemeModeToggle } from '../themes/theme-mode-toggle';
import { ThemeSelector } from '../themes/theme-selector';

export default function Header() {
  return (
    <header className='bg-background/95 supports-[backdrop-filter]:bg-background/80 sticky top-0 z-20 flex h-16 shrink-0 items-center justify-between gap-2 border-b backdrop-blur transition-colors'>
      <div className='flex items-center gap-2 px-4'>
        <SidebarTrigger className='press -ml-1' />
        <Separator orientation='vertical' className='mr-2 h-4' />
        <Breadcrumbs />
      </div>

      <div className='flex items-center gap-3 px-4'>
        <div className='hidden md:flex'>
          <SearchInput />
        </div>
        <ThemeSelector />
        <ThemeModeToggle />
      </div>
    </header>
  );
}
