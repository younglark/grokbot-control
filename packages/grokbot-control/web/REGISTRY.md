# shadcn/ui components

Source: https://ui.shadcn.com/r/styles/new-york-v4/ (official registry, retrieved 2026-11-11).

Components: badge, button, card, command, dialog, input, progress, scroll-area, separator, sheet, sidebar, skeleton, tooltip, use-mobile.

MIT license retained in SHADCN-LICENSE.txt. Components use semantic Tailwind v4 tokens; no remote runtime services.

Local adaptations: registry `cn` imports resolve to @/lib/utils; CommandDialog exposes the Radix onCloseAutoFocus hook to restore keyboard invocation focus. Source components are otherwise retained.

Used in the monitor: Sidebar, Card, Badge, Sheet, Command/Dialog, Tooltip, Separator, Skeleton, Button and Input. ScrollArea and Progress sources are available but not used. A usage bar is not drawn when the included limit is zero. cents/currency remain unverified; breakdown ppm is shown as a percentage of the limit.
