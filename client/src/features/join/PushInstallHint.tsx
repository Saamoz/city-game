import { PLATFORM_NAME } from '@city-game/shared';

export function PushInstallHint({ className = '' }: { className?: string }) {
  return (
    <p className={`text-sm leading-6 text-[#44545b] ${className}`}>
      To get zone alerts on iPhone, tap <span className="font-semibold">Share</span> then{' '}
      <span className="font-semibold">Add to Home Screen</span>, and open {PLATFORM_NAME} from there.
    </p>
  );
}
