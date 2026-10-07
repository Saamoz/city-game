// A faint repeating city skyline along the bottom edge of a screen. Purely decorative.
export function SkylineBackdrop({ className = 'h-24 sm:h-32' }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-x-0 bottom-0 bg-[url('/skyline.svg')] bg-[length:auto_100%] bg-bottom bg-repeat-x ${className}`}
    />
  );
}
