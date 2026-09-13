import type { ReactNode } from 'react';

interface Props {
  summary: ReactNode;
  children: ReactNode;
  className?: string;
  defaultOpen?: boolean;
}

/** A click-to-expand section — used for anything secondary (warnings) or worth calling out
 * (shared suggestions) without it always taking up visual space on the page. */
export function Collapsible({ summary, children, className, defaultOpen }: Props) {
  return (
    <details className={['collapsible', className].filter(Boolean).join(' ')} open={defaultOpen}>
      <summary>{summary}</summary>
      <div className="collapsible-body">{children}</div>
    </details>
  );
}
