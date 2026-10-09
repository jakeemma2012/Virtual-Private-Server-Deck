# VPSDeck Design System — Refactor Contract

**Aesthetic**: Soft SaaS / friendly — generous rounding, soft layered shadows, pastel accents, gentle bounce.
**Motion**: Balanced & lively — `transform`/`opacity` only, ~60fps, always degrades under `prefers-reduced-motion`.
**Themes**: Keep all 10 themes. Always use theme tokens (`bg-card`, `text-muted-foreground`, `border`, `bg-primary`, etc.). Never hardcode hex/oklch colors. The ONLY allowed literal colors are the semantic status colors that already live in the Badge `success`/`warning`/`info` variants.

---

## Primitives available (already built — just USE them)

### Components
- `<Input>` (`@/components/ui/input`) — IME-safe, soft. Use for ALL text inputs.
- `<Textarea>` (`@/components/ui/textarea`) — IME-safe, soft. Use for ALL textareas.
- `<Card>` / `CardHeader` / `CardContent` ... — soft shadow + token radius.
- `<Button>` — has press-scale + smooth transitions. Variants: default/secondary/outline/ghost/destructive/link.
- `<Badge>` — pill. Variants: default/secondary/destructive/outline + **success / warning / info** (use these for online/running = success, warning = warning, stopped/offline = destructive, neutral/info = info).
- `<Skeleton>` — shimmer loading.

### Hooks
- `useCountUp(target, { decimals })` (`@/hooks/use-count-up`) — animated numbers. Use ONLY for prominent stat readouts (CPU %, RAM %, counts on Overview/dashboard cards). Do NOT use inside rows of a frequently re-rendering table.
- `useImeGuard<HTMLInputElement>(onChange)` (`@/hooks/use-ime-guard`) — spread onto a *raw* `<input>`/`<textarea>` that can't be swapped for the components above.

### CSS utility classes (from motion.css / globals.css)
- `animate-rise` — fade + slide-up entrance. Put on a page's main container or major sections on mount.
- `animate-fade` / `animate-pop` — fade / bouncy scale-in (pop = good for modals/dialogs content, badges appearing).
- `stagger` — add to a parent of a card grid / list; children cascade in automatically (no JS, capped at 12).
- `hover-lift` — add to clickable Cards / list rows / server tiles (lifts 3px on hover).
- `press` — add to small tappable controls (icon chips, toggles) for a press-down feel.
- `skeleton-shimmer` — already inside `<Skeleton>`; reuse on custom loading blocks.
- `status-dot` — wrap a small round colored dot to give it a breathing ring (server online indicator).
- `pulse-soft` — gentle opacity pulse (e.g. a "connecting…" label).
- `shadow-soft` / `shadow-soft-lg` — soft elevation (Card already uses `shadow-soft`).

---

## Rules (MUST follow)

1. **IME first.** Replace every raw controlled `<input>` with `<Input>` and every raw `<textarea>` with `<Textarea>`. If a raw element must stay (e.g. an inline-styled tree-rename field, a checkbox), make it IME-safe with `useImeGuard` — UNLESS it's `type="checkbox"/"radio"/"file"/"number"` or uses `defaultValue` (uncontrolled), which don't need it.
   - For Enter-to-submit on text fields, guard composition: `onKeyDown={e => { if (e.nativeEvent.isComposing) return; if (e.key==='Enter') submit(); }}`.
2. **Liveliness, lightly.** Add `animate-rise` to the page's top-level content wrapper. Add `stagger` to the main card grid / list. Add `hover-lift` to clickable cards/rows. That's usually enough — don't animate everything.
3. **Status semantics.** Online/running/healthy → `<Badge variant="success">`; warning/degraded → `warning`; stopped/offline/error → `destructive`; neutral/info → `info`. Pair with a small `status-dot` where there's a status indicator dot.
4. **Stat numbers.** On Overview/dashboard summary cards, feed the displayed number through `useCountUp`. Keep formatting at the call site.
5. **Soft shape.** Prefer the components' built-in radii. For bespoke panels use `rounded-xl`/`rounded-2xl` + `shadow-soft` + `border`. Generous padding (`p-4`/`p-5`/`p-6`).
6. **DO NOT break behavior.** Preserve all existing state, refs, data fetching, event handlers, props, and keys. This is a visual + IME pass, NOT a logic rewrite. Do not remove functionality.
7. **DO NOT regress performance.** No new React Context. No new heavy dependencies. No per-keystroke JS work. Motion is CSS classes only. Do not add `useState` in hot render paths. (The separate perf plan handles re-render fixes.)
8. **Out of scope:** do not change `next.config.ts`, font loading, server/client component boundaries, or `next/dynamic` usage. Pages are already `'use client'` where needed — keep it that way.
9. **Tokens only** for color/spacing (except Badge status colors). Keep dark mode working — test mentally against both `[data-theme]` and `[data-theme].dark`.
10. **Next 16.2.3** has breaking changes vs older versions — you are only touching JSX/Tailwind classes and these existing components/hooks, so no Next API changes are needed. Do not introduce any.

## Done = 
- Every text field is IME-safe.
- The screen has a tasteful entrance (rise/stagger), clickable things lift/press, statuses use semantic badges, stats count up where relevant.
- No logic changed, no new deps, builds clean.
