export function FullPageSpinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex min-h-[50vh] items-center justify-center" role="status" aria-live="polite">
      <div className="flex items-center gap-3 text-sm text-black/60">
        <span
          className="h-5 w-5 animate-spin rounded-full border-2 border-ischool-blue/20 border-t-ischool-blue"
          aria-hidden
        />
        {label}
      </div>
    </div>
  );
}
