import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * Accessible modal dialog: traps focus, closes on Escape (when allowed),
 * restores focus to the element that opened it.
 */
export function Modal({
  title,
  description,
  onClose,
  canClose = true,
  children,
  footer,
  size = 'md',
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  canClose?: boolean;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md';
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>(
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])',
    );
    first?.focus();
    return () => opener?.focus?.();
  }, []);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape' && canClose) {
      event.stopPropagation();
      onClose();
    }
    if (event.key === 'Tab' && panel.current) {
      const items = Array.from(
        panel.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
        ),
      );
      if (items.length === 0) return;
      const first = items[0] as HTMLElement;
      const last = items[items.length - 1] as HTMLElement;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-0 sm:items-center sm:p-4"
      onKeyDown={onKeyDown}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className={`max-h-[92vh] w-full overflow-y-auto rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl ${size === 'sm' ? 'sm:max-w-md' : 'sm:max-w-lg'}`}
      >
        <div className="brand-stripe h-1 rounded-t-3xl" aria-hidden />
        <div className="space-y-4 p-6">
          <div>
            <h2 id={titleId} className="text-lg font-bold">
              {title}
            </h2>
            {description && (
              <div id={descId} className="mt-1 text-sm text-black/65">
                {description}
              </div>
            )}
          </div>
          {children}
        </div>
        {footer && (
          <div className="flex flex-col-reverse gap-2 border-t border-black/5 px-6 py-4 sm:flex-row sm:justify-end">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
