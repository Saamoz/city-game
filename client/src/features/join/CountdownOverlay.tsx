import { useEffect, useMemo, useState } from 'react';

interface CountdownOverlayProps {
  active: boolean;
  onComplete(): void;
}

const beats = ['3', '2', '1', 'GO!'] as const;

export function CountdownOverlay({ active, onComplete }: CountdownOverlayProps) {
  const [beatIndex, setBeatIndex] = useState(0);
  const [isClosing, setIsClosing] = useState(false);

  useEffect(() => {
    if (!active) {
      setBeatIndex(0);
      setIsClosing(false);
      return;
    }

    setBeatIndex(0);
    setIsClosing(false);

    const timers: number[] = [];
    for (let index = 1; index < beats.length; index += 1) {
      timers.push(window.setTimeout(() => setBeatIndex(index), index * 1000));
    }

    timers.push(window.setTimeout(() => setIsClosing(true), 3600));
    timers.push(window.setTimeout(() => onComplete(), 4000));

    return () => {
      for (const timer of timers) {
        window.clearTimeout(timer);
      }
    };
  }, [active, onComplete]);

  const beat = useMemo(() => beats[beatIndex] ?? beats[0], [beatIndex]);

  if (!active) {
    return null;
  }

  return (
    <div
      className={[
        'pointer-events-none absolute inset-0 z-40 flex items-center justify-center transition-opacity duration-300',
        isClosing ? 'opacity-0' : 'opacity-100',
      ].join(' ')}
      style={{ backgroundColor: 'rgba(31, 42, 47, 0.92)' }}
    >
      <div
        key={beat}
        className="animate-[join-countdown-beat_1s_ease-in-out] px-6 text-center font-[Georgia,Times_New_Roman,serif] text-[30vw] font-semibold leading-none sm:text-[22vw]"
        style={{ color: beat === 'GO!' ? '#c8a86b' : '#f5f0e8' }}
      >
        {beat}
      </div>
    </div>
  );
}
