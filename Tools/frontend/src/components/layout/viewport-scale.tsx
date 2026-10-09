'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

const DESIGN_WIDTH = 819;

/**
 * aaPanel-style "zoomed desktop" on small screens.
 *
 * The initial <head> script sets a fixed initial-scale on first load, but client-side
 * navigation (SPA) doesn't re-run it — so the zoom can drift / stay where the previous
 * page left it. This re-asserts the fit scale on every route change by briefly clamping
 * maximum-scale (which forces the browser to snap back to the fit zoom) and then releasing
 * it so pinch-zoom still works.
 *
 * Detection uses screen.width (the physical screen, stable) rather than matchMedia, because
 * once the viewport is width=1280 a max-width media query would no longer match.
 */
export default function ViewportScale() {
  const pathname = usePathname();

  useEffect(() => {
    try {
      const sw = window.screen?.width || window.innerWidth || 0;
      if (!sw || sw > 820) return; // desktop / large tablet — leave native

      const scale = Math.round((sw / DESIGN_WIDTH) * 1000) / 1000;
      let vp = document.querySelector('meta[name="viewport"]') as HTMLMetaElement | null;
      if (!vp) {
        vp = document.createElement('meta');
        vp.setAttribute('name', 'viewport');
        document.head.appendChild(vp);
      }
      // Clamp to the fit scale (snaps any stray zoom back), then release for pinch-zoom.
      vp.setAttribute('content', `width=${DESIGN_WIDTH}, initial-scale=${scale}, maximum-scale=${scale}`);
      const t = setTimeout(() => {
        vp!.setAttribute('content', `width=${DESIGN_WIDTH}, initial-scale=${scale}, user-scalable=yes`);
      }, 80);
      return () => clearTimeout(t);
    } catch {
      /* ignore */
    }
  }, [pathname]);

  return null;
}
