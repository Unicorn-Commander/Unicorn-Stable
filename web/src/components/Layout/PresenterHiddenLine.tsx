export function PresenterHiddenLine({
  count,
  className = "",
}: {
  count: number;
  className?: string;
}) {
  if (count <= 0) return null;
  return (
    <p
      className={`px-2.5 py-1 text-[11px] text-slate-600 ${className}`}
      data-testid="presenter-hidden-line"
    >
      {count} hidden while presenting
    </p>
  );
}
