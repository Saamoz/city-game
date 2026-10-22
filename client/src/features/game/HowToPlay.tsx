import { useEffect, useRef, useState, type ReactNode } from 'react';
import { INK, RUST } from './CardGlyphs';

// A short swipeable deck of rule cards for Challenge Hunt, each with a sketched diagram. Opened
// from the pre-game lobby and the in-game menu.

const TEAL = '#3d7a74';
const GOLD = '#c99a2e';
const RED = '#b5432f';
const PAPER = '#fbf6e8';

interface Slide {
  title: string;
  body: ReactNode;
  art: ReactNode;
}

const SLIDES: Slide[] = [
  {
    title: 'Explore the city',
    body: <>This is a scavenger hunt across the city. <b>Stick together</b> as a team and complete the most challenges. <b>Uber and Lyft are banned.</b></>,
    art: <TeamArt />,
  },
  {
    title: 'First team takes it',
    body: <>Some challenges are pinned to a place, some can be done anywhere. The <b>first team</b> to complete one gets the points and it leaves the board. Some have <b>bonus points</b> too, so read each card's full rules.</>,
    art: <PinsArt />,
  },
  {
    title: 'Done? Prove it',
    body: <>When you finish a challenge, tap <b>Complete</b> on its card, then send a <b>photo or video</b> of it to the group chat.</>,
    art: <ProofArt />,
  },
  {
    title: 'Collect the pieces',
    body: <>Each completed challenge gives your team a <b>fragment of a secret picture</b>. See yours with the 🧩 button at the top right. After the game every fragment is revealed to everyone, and together they show a place in the city we all have to reach!</>,
    art: <FragmentsArt />,
  },
  {
    title: 'Do as many as you can',
    body: <>Every challenge is worth the same, so do as many as you can before time runs out or the board is cleared. <b>Bonus points</b> might be the edge your team needs to win.</>,
    art: <PointsArt />,
  },
  {
    title: 'iPhone: add to Home Screen',
    body: <>Tap <b>Share</b> in Safari, then <b>Add to Home Screen</b>, and open the game from there. You get the full-screen map, and notifications only work this way.</>,
    art: <HomeScreenArt />,
  },
];

export function HowToPlay({ onClose }: { onClose(): void }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const isLast = index === SLIDES.length - 1;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight') goTo(index + 1);
      if (event.key === 'ArrowLeft') goTo(index - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // The track scrolls natively (snap points do the paging), so a swipe follows the finger.
  const goTo = (next: number) => {
    const track = trackRef.current;
    if (!track) return;
    const clamped = Math.max(0, Math.min(SLIDES.length - 1, next));
    track.scrollTo({ left: clamped * track.clientWidth, behavior: 'smooth' });
  };

  return (
    <div aria-label="How to play" aria-modal="true" className="fixed inset-0 z-[80] flex flex-col bg-[#182126]/55 pb-[env(safe-area-inset-bottom,0px)] pt-[env(safe-area-inset-top,0px)] backdrop-blur-[2px]" role="dialog">
      <div className="flex justify-end px-4 pt-3">
        <button aria-label="Close" className="flex h-9 w-9 items-center justify-center rounded-full border border-[#c8b48a]/60 bg-[#f3ecd8] text-lg text-[#48575d]" onClick={onClose} type="button">×</button>
      </div>

      <div
        className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onScroll={(event) => {
          const track = event.currentTarget;
          setIndex(Math.round(track.scrollLeft / Math.max(1, track.clientWidth)));
        }}
        ref={trackRef}
      >
        {SLIDES.map((slide, slideIndex) => (
          <div className="flex w-full shrink-0 snap-center items-center justify-center px-5 py-3" key={slide.title}>
            <article className="relative flex max-h-full w-full max-w-[22rem] flex-col overflow-hidden rounded-[1.35rem] border border-[#a98c5a] bg-[radial-gradient(circle_at_28%_18%,#fbf6e8,#f2e8cf_62%,#e8d9b6)] shadow-[0_24px_60px_rgba(30,24,14,0.38)]">
              <div aria-hidden="true" className="pointer-events-none absolute inset-[7px] rounded-[1rem] border border-[#c4a874]/70" />
              <div className="relative px-6 pb-2 pt-6">
                <p className="text-[10px] font-bold uppercase tracking-[0.22em]" style={{ color: RUST }}>{slideIndex + 1} of {SLIDES.length}</p>
                <h2 className="mt-1 font-[Georgia,Times_New_Roman,serif] text-[1.45rem] font-semibold leading-tight" style={{ color: INK }}>{slide.title}</h2>
              </div>
              <div className="relative mx-5 rounded-2xl border border-[#d6c39a] bg-[#fbf5e5]/80">{slide.art}</div>
              <p className="relative min-h-0 overflow-y-auto px-6 pb-6 pt-4 text-[15px] leading-6 text-[#3d362a] [&_b]:font-semibold [&_b]:text-[#2f2a20]">{slide.body}</p>
            </article>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-3 px-6 pb-5 pt-2">
        <button className="h-11 w-20 rounded-full text-sm font-semibold text-[#f4ead7] disabled:opacity-0" disabled={index === 0} onClick={() => goTo(index - 1)} type="button">Back</button>
        <div className="flex gap-1.5">
          {SLIDES.map((slide, dotIndex) => (
            <button aria-label={'Card ' + (dotIndex + 1)} className={['h-2 rounded-full transition-all', dotIndex === index ? 'w-5 bg-[#f3ecd8]' : 'w-2 bg-[#f3ecd8]/45'].join(' ')} key={slide.title} onClick={() => goTo(dotIndex)} type="button" />
          ))}
        </div>
        <button className="h-11 w-20 rounded-full bg-[#f3ecd8] text-sm font-semibold text-[#24343a]" onClick={() => (isLast ? onClose() : goTo(index + 1))} type="button">{isLast ? 'Got it' : 'Next'}</button>
      </div>
    </div>
  );
}

// Every diagram shares a wobble filter so straight SVG lines look drawn by hand.
function Sketch({ id, children }: { id: string; children: ReactNode }) {
  return (
    <svg aria-hidden="true" className="block h-auto w-full" fill="none" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 300 170">
      <defs>
        <filter id={id} x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence baseFrequency="0.035" numOctaves="2" seed="7" type="fractalNoise" />
          <feDisplacementMap in="SourceGraphic" scale="2.6" />
        </filter>
      </defs>
      <g filter={`url(#${id})`}>{children}</g>
    </svg>
  );
}

function Label({ x, y, children, color = INK, size = 15, anchor = 'middle', rotate = 0 }: { x: number; y: number; children: ReactNode; color?: string; size?: number; anchor?: 'start' | 'middle' | 'end'; rotate?: number }) {
  return <text fill={color} fontFamily="Kalam, Caveat, cursive" fontSize={size} textAnchor={anchor} transform={rotate ? `rotate(${rotate} ${x} ${y})` : undefined} x={x} y={y}>{children}</text>;
}

function Person({ x, y, color }: { x: number; y: number; color: string }) {
  return (
    <g stroke={INK} strokeWidth={2.2}>
      <circle cx={x} cy={y} fill={color} r={6.5} />
      <path d={`M${x} ${y + 7} L${x} ${y + 26} M${x} ${y + 26} L${x - 6} ${y + 38} M${x} ${y + 26} L${x + 6} ${y + 38} M${x - 9} ${y + 14} L${x + 9} ${y + 14}`} />
    </g>
  );
}

function TeamArt() {
  return (
    <Sketch id="sketch-team">
      {/* streets */}
      <path d="M10 40 H290 M10 120 H290 M70 10 V160 M160 10 V160 M240 10 V160" stroke="#d2bf96" strokeWidth={6} />
      <path d="M30 150 C70 140 90 105 120 100 S150 96 170 78" stroke={RUST} strokeDasharray="5 7" strokeWidth={2.4} />
      <Person color={GOLD} x={96} y={78} />
      <Person color={TEAL} x={116} y={74} />
      <Person color={RED} x={136} y={78} />
      <path d="M103 92 L109 88 M123 88 L129 92" stroke={INK} strokeWidth={2} />
      <Label rotate={-4} x={118} y={30}>stick together!</Label>
      {/* car, crossed out */}
      <g stroke={INK} strokeWidth={2.2}>
        <path d="M208 120 L214 104 Q218 98 226 98 L254 98 Q262 98 266 104 L272 120 Z" fill="#f3ecd8" />
        <rect fill="#efe2c4" height={14} rx={4} width={74} x={202} y={118} />
        <circle cx={218} cy={134} fill={INK} r={6} />
        <circle cx={258} cy={134} fill={INK} r={6} />
      </g>
      <Label size={13} x={240} y={88}>UBER</Label>
      <path d="M196 92 L284 146 M284 92 L196 146" stroke={RED} strokeWidth={4.5} />
    </Sketch>
  );
}

function Pin({ x, y, color, children }: { x: number; y: number; color: string; children?: ReactNode }) {
  return (
    <g stroke={INK} strokeWidth={2.2}>
      <path d={`M${x} ${y} C${x - 14} ${y - 18} ${x - 14} ${y - 36} ${x} ${y - 36} C${x + 14} ${y - 36} ${x + 14} ${y - 18} ${x} ${y} Z`} fill={color} />
      <circle cx={x} cy={y - 24} fill={PAPER} r={4.5} />
      {children}
    </g>
  );
}

function PinsArt() {
  return (
    <Sketch id="sketch-pins">
      <rect fill="#efe6cf" height={124} rx={10} stroke={INK} strokeWidth={2.2} width={170} x={14} y={18} />
      <path d="M14 66 H184 M14 106 H184 M70 18 V142 M128 18 V142" stroke="#d2bf96" strokeWidth={4} />
      <Pin color={RED} x={56} y={100} />
      <Pin color={TEAL} x={150} y={66} />
      {/* first-place flag on the teal pin */}
      <path d="M150 30 V6 M150 6 L170 12 L150 18" fill={GOLD} stroke={INK} strokeWidth={2} />
      <Label color={RUST} rotate={-3} size={14} x={100} y={162}>1st team wins it</Label>
      {/* an anywhere card */}
      <g stroke={INK} strokeWidth={2.2}>
        <rect fill={PAPER} height={92} rx={9} transform="rotate(6 245 85)" width={74} x={208} y={38} />
      </g>
      <Label color={RUST} rotate={6} size={13} x={246} y={62}>anywhere</Label>
      <Label rotate={6} size={30} x={242} y={98}>★</Label>
      <Label color={TEAL} rotate={6} size={14} x={240} y={122}>+1 bonus</Label>
    </Sketch>
  );
}

function ProofArt() {
  return (
    <Sketch id="sketch-proof">
      {/* phone with the complete button */}
      <rect fill="#2f2a20" height={148} rx={14} stroke={INK} strokeWidth={2.2} width={84} x={26} y={11} />
      <rect fill={PAPER} height={128} rx={8} width={70} x={33} y={21} />
      <path d="M42 40 H94 M42 52 H86 M42 62 H90" stroke="#bfae8a" strokeWidth={3} />
      <rect fill="#3a3022" height={22} rx={6} stroke={INK} strokeWidth={2} width={58} x={39} y={116} />
      <Label color="#f5ecd6" size={11} x={68} y={131}>Complete</Label>
      {/* tap */}
      <circle cx={96} cy={135} r={9} stroke={GOLD} strokeWidth={2.4} />
      <path d="M104 146 L110 154 M108 140 L117 143" stroke={GOLD} strokeWidth={2.2} />
      {/* arrow to the chat */}
      <path d="M118 84 C150 60 176 58 196 70" stroke={RUST} strokeWidth={2.6} />
      <path d="M186 62 L197 71 L184 76" stroke={RUST} strokeWidth={2.6} />
      <Label color={RUST} rotate={-8} size={14} x={152} y={110}>then…</Label>
      {/* chat bubble with a camera */}
      <path d="M200 46 H282 Q290 46 290 54 V110 Q290 118 282 118 H226 L210 132 L214 118 H208 Q200 118 200 110 V54 Q200 46 208 46 Z" fill={PAPER} stroke={INK} strokeWidth={2.2} />
      <rect fill="#efe2c4" height={34} rx={6} stroke={INK} strokeWidth={2.2} width={50} x={220} y={64} />
      <circle cx={245} cy={81} fill={PAPER} r={10} stroke={INK} strokeWidth={2.2} />
      <path d="M230 64 L236 57 H252 L258 64" stroke={INK} strokeWidth={2.2} />
      <Label size={13} x={245} y={152}>group chat</Label>
    </Sketch>
  );
}

function FragmentsArt() {
  const filled = new Set([0, 4, 5, 9, 10]);
  const colors = [GOLD, TEAL, RED, '#7b9b5a', RUST];
  return (
    <Sketch id="sketch-fragments">
      {/* the clue pill */}
      <rect fill="#f3ecd8" height={24} rx={12} stroke={INK} strokeWidth={2} width={62} x={16} y={14} />
      <Label size={13} x={47} y={31}>🧩 5/12</Label>
      {/* the mosaic */}
      {Array.from({ length: 12 }, (_, tile) => {
        const x = 16 + (tile % 4) * 30;
        const y = 50 + Math.floor(tile / 4) * 30;
        const color = colors[tile % colors.length];
        return filled.has(tile)
          ? <rect fill={color} fillOpacity={0.75} height={26} key={tile} rx={3} stroke={INK} strokeWidth={2} width={26} x={x} y={y} />
          : <rect height={26} key={tile} rx={3} stroke="#b9a67b" strokeDasharray="4 4" strokeWidth={1.8} width={26} x={x} y={y} />;
      })}
      {/* revealed: a place to meet */}
      <path d="M146 92 C168 86 186 80 202 70" stroke={RUST} strokeWidth={2.6} />
      <path d="M192 66 L203 69 L197 79" stroke={RUST} strokeWidth={2.6} />
      <Label color={RUST} rotate={-6} size={13} x={88} y={158}>after the game, all revealed</Label>
      <rect fill="#efe6cf" height={96} rx={10} stroke={INK} strokeWidth={2.2} width={78} x={210} y={18} />
      <path d="M218 90 C232 70 250 76 262 60 S280 44 284 40" stroke="#d2bf96" strokeWidth={4} />
      <Pin color={RED} x={250} y={78} />
      <Label size={20} x={250} y={58}>?</Label>
      <Label size={13} x={249} y={132}>meet here!</Label>
    </Sketch>
  );
}

function PointsArt() {
  return (
    <Sketch id="sketch-points">
      {[0, 1, 2, 3].map((card) => (
        <g key={card} transform={`rotate(${(card - 1.5) * 7} ${70 + card * 38} 95)`}>
          <rect fill={PAPER} height={74} rx={8} stroke={INK} strokeWidth={2.2} width={52} x={44 + card * 38} y={50} />
          <circle cx={70 + card * 38} cy={87} fill={GOLD} fillOpacity={0.8} r={15} stroke={INK} strokeWidth={2} />
          <Label size={16} x={70 + card * 38} y={93}>1</Label>
        </g>
      ))}
      <Label color={RUST} rotate={-3} size={15} x={120} y={30}>all worth the same</Label>
      <Label color={TEAL} rotate={-8} size={14} x={112} y={150}>+ bonus = the edge</Label>
      {/* hourglass */}
      <g stroke={INK} strokeWidth={2.4}>
        <path d="M232 40 H276 M232 132 H276" />
        <path d="M238 40 C238 70 270 70 270 86 C270 102 238 102 238 132 M270 40 C270 70 238 70 238 86 C238 102 270 102 270 132" />
        <path d="M244 124 Q254 108 264 124 Z" fill={GOLD} />
        <path d="M248 58 Q254 68 260 58 Z" fill={GOLD} />
      </g>
    </Sketch>
  );
}

function HomeScreenArt() {
  return (
    <Sketch id="sketch-home">
      {/* safari toolbar with the share button */}
      <rect fill={PAPER} height={40} rx={10} stroke={INK} strokeWidth={2.2} width={96} x={12} y={108} />
      <path d="M42 120 V136 H62 V120 M52 128 V108 M45 115 L52 108 L59 115" stroke={TEAL} strokeWidth={2.4} />
      <Label color={RUST} size={13} x={60} y={98}>1. Share</Label>
      {/* the menu row */}
      <path d="M112 118 C130 100 136 84 146 76" stroke={RUST} strokeWidth={2.4} />
      <path d="M138 74 L147 75 L146 84" stroke={RUST} strokeWidth={2.4} />
      <rect fill={PAPER} height={34} rx={8} stroke={INK} strokeWidth={2.2} width={142} x={150} y={52} />
      <Label anchor="start" size={12} x={158} y={74}>Add to Home Screen</Label>
      <rect height={16} rx={4} stroke={INK} strokeWidth={2} width={16} x={268} y={61} />
      <path d="M276 64 V74 M271 69 H281" stroke={INK} strokeWidth={2} />
      <Label color={RUST} size={13} x={160} y={42}>2.</Label>
      {/* home screen icon */}
      <path d="M187 90 C189 104 189 112 187 120" stroke={RUST} strokeWidth={2.4} />
      <path d="M181 112 L187 121 L193 112" stroke={RUST} strokeWidth={2.4} />
      <rect fill="#f3ecd8" height={34} rx={9} stroke={INK} strokeWidth={2.2} width={34} x={170} y={126} />
      <Label size={18} x={187} y={149}>🧭</Label>
      <Label anchor="start" color={TEAL} rotate={-4} size={14} x={212} y={150}>3. open it here</Label>
    </Sketch>
  );
}
