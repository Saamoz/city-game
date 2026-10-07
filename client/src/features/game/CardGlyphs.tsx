// Card "suits" for the three challenge kinds, drawn like marks on an old map:
// a compass star for a pinned spot, a hatched plot for an area, a wind rose for anywhere.

export type CardSuit = 'pin' | 'area' | 'anywhere';

export const INK = '#4f3f2a';
export const RUST = '#8f5a3c';

export function SuitGlyph({ suit, size = 16, color = RUST }: { suit: CardSuit; size?: number; color?: string }) {
  if (suit === 'pin') return <CompassStar size={size} color={color} />;
  if (suit === 'area') return <AreaPlot size={size} color={color} />;
  return <WindRose size={size} color={color} />;
}

export function CompassStar({ size = 16, color = RUST }: { size?: number; color?: string }) {
  return (
    <svg aria-hidden="true" height={size} viewBox="0 0 24 24" width={size}>
      <path d="M12 1.5 14.2 9.8 22.5 12 14.2 14.2 12 22.5 9.8 14.2 1.5 12 9.8 9.8Z" fill={color} />
      <path d="M12 6.5 13 11 17.5 12 13 13 12 17.5 11 13 6.5 12 11 11Z" fill="#f5ecd6" opacity="0.9" />
    </svg>
  );
}

export function AreaPlot({ size = 16, color = RUST }: { size?: number; color?: string }) {
  return (
    <svg aria-hidden="true" height={size} viewBox="0 0 24 24" width={size}>
      <path d="M4 6.5 18.5 3.5 20.5 17 6 20.5Z" fill="none" stroke={color} strokeDasharray="2.6 1.8" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M8 16.5 15.5 7.5M6.8 12.5 11.5 7M11.5 17.5 17.5 10.5" stroke={color} strokeLinecap="round" strokeWidth="1.2" opacity="0.7" />
    </svg>
  );
}

export function WindRose({ size = 16, color = RUST }: { size?: number; color?: string }) {
  return (
    <svg aria-hidden="true" height={size} viewBox="0 0 24 24" width={size}>
      <circle cx="12" cy="12" fill="none" r="8.5" stroke={color} strokeWidth="1.5" />
      <path d="M12 2v20M2 12h20" stroke={color} strokeWidth="1" opacity="0.6" />
      <path d="M12 6.5 13.4 12 12 17.5 10.6 12Z" fill={color} />
    </svg>
  );
}

// Thin rule with a diamond in the middle, like a map cartouche divider.
export function Flourish({ color = '#b79b6a' }: { color?: string }) {
  return (
    <div aria-hidden="true" className="flex items-center gap-2">
      <span className="h-px flex-1" style={{ backgroundColor: color }} />
      <span className="h-1.5 w-1.5 rotate-45" style={{ backgroundColor: color }} />
      <span className="h-px flex-1" style={{ backgroundColor: color }} />
    </div>
  );
}

// The game's name printed on the card edge, top and (upside down) bottom, like the maker's mark on a
// playing card. It sits over the inner frame line on a parchment patch.
export function EdgeLabel({ text, size = 'full' }: { text: string; size?: 'full' | 'mini' }) {
  if (!text.trim()) return null;
  const className = size === 'full'
    ? 'top-[1px] max-w-[62%] px-2 text-[9px] tracking-[0.32em]'
    : 'top-0 max-w-[78%] px-1 text-[6.5px] tracking-[0.22em]';
  return (
    <>
      <span aria-hidden="true" className={'pointer-events-none absolute left-1/2 -translate-x-1/2 truncate rounded-sm bg-[#f5ecd5] font-semibold uppercase leading-[1.6] ' + className} style={{ color: '#8a6f45' }}>{text}</span>
      <span aria-hidden="true" className={'pointer-events-none absolute left-1/2 -translate-x-1/2 rotate-180 truncate rounded-sm bg-[#efe3c6] font-semibold uppercase leading-[1.6] ' + className.replace(/top-\S+/, size === 'full' ? 'bottom-[1px]' : 'bottom-0')} style={{ color: '#8a6f45' }}>{text}</span>
    </>
  );
}
