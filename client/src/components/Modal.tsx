import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

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
  focusPanel = false,
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  canClose?: boolean;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  focusPanel?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    // Start in the content (not on the close button), then the footer.
    const selector =
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])';
    const first =
      panel.current?.querySelector<HTMLElement>(`[data-modal-body] :is(${selector})`) ??
      panel.current?.querySelector<HTMLElement>(`[data-modal-footer] :is(${selector})`) ??
      panel.current?.querySelector<HTMLElement>(selector);
    (focusPanel ? panel.current : (first ?? panel.current))?.focus({ preventScroll: true });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
      opener?.focus?.();
    };
  }, [focusPanel]);

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
      if (items.length === 0) {
        event.preventDefault();
        panel.current.focus();
        return;
      }
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

  // Rendered at the end of <body>, so no parent layout (sticky bars, transforms,
  // disabled fieldsets) can trap or cover it.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-0 sm:items-center sm:p-4"
      onKeyDown={onKeyDown}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && canClose) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className={`flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl ${size === 'sm' ? 'sm:max-w-md' : size === 'lg' ? 'sm:max-w-3xl' : 'sm:max-w-lg'}`}
      >
        <div className="brand-stripe h-1 shrink-0" aria-hidden />
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-black/5 px-6 pt-5 pb-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-bold">
              {title}
            </h2>
            {description && (
              <div id={descId} className="mt-1 text-sm text-black/65">
                {description}
              </div>
            )}
          </div>
          {canClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="modal-close -mt-1 -mr-2 inline-flex size-10 shrink-0 items-center justify-center rounded-xl text-black/55 transition hover:bg-ahly-red/10 hover:text-ahly-red-dark focus-visible:outline-2 focus-visible:outline-ischool-blue"
            >
              <svg
                aria-hidden
                viewBox="0 0 24 24"
                className="size-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          )}
        </div>
        <div data-modal-body className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6">
          {children}
        </div>
        {footer && (
          <div
            data-modal-footer
            className="flex shrink-0 flex-col-reverse gap-2 border-t border-black/5 px-6 py-4 sm:flex-row sm:justify-end"
          >
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
