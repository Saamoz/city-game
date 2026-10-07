import { PLATFORM_NAME } from '@city-game/shared';

interface BrandMarkProps {
  className?: string;
  // Decorative when the app name is already written next to it.
  decorative?: boolean;
}

export function BrandMark({ className = 'h-8 w-8', decorative = false }: BrandMarkProps) {
  return (
    <img
      src="/logo.svg"
      alt={decorative ? '' : PLATFORM_NAME}
      aria-hidden={decorative || undefined}
      draggable={false}
      className={`${className} shrink-0 select-none rounded-[22%] shadow-[0_6px_16px_rgba(79,63,42,0.16)]`}
    />
  );
}
