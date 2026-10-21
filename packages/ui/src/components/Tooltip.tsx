import { Tooltip as RadixTooltip } from 'radix-ui';
import type { ReactNode } from 'react';

export const TooltipProvider = RadixTooltip.Provider;

/**
 * Supplementary hint only: tooltips are not reachable on touch devices, so never
 * put information here that is unavailable elsewhere (use visible text or a dialog).
 */
export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <RadixTooltip.Root delayDuration={300}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          sideOffset={6}
          className="z-50 max-w-xs rounded-sm bg-text px-2.5 py-1.5 text-xs text-bg shadow-card"
        >
          {content}
          <RadixTooltip.Arrow className="fill-text" />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
