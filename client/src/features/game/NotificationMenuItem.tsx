import { useState } from 'react';
import { subscribeCurrentPlayerPush } from '../../lib/api';
import {
  getNotificationPermission,
  needsHomeScreenInstallForPush,
  subscribeToPushNotifications,
  supportsPushNotifications,
} from '../../lib/push-notifications';
import { PushInstallHint } from '../join/PushInstallHint';

interface NotificationMenuItemProps {
  isSubscribed: boolean;
}

type ItemState = 'idle' | 'subscribing' | 'enabled' | 'error';

// In-game way to turn on zone alerts, for players who never saw the lobby prompt
// (joined mid-game, came back later, or dismissed it).
export function NotificationMenuItem({ isSubscribed }: NotificationMenuItemProps) {
  const [state, setState] = useState<ItemState>(isSubscribed ? 'enabled' : 'idle');
  const [message, setMessage] = useState<string | null>(null);

  if (!supportsPushNotifications()) {
    return needsHomeScreenInstallForPush() ? (
      <div className="rounded-xl border border-[#c8b48a]/55 bg-[#fbf6ea] px-3 py-2.5">
        <PushInstallHint className="text-xs leading-5" />
      </div>
    ) : null;
  }

  if (state === 'enabled' || isSubscribed) {
    return <p className="px-3 py-1.5 text-xs text-[#5a676c]">Zone alerts are on for this device.</p>;
  }

  if (getNotificationPermission() === 'denied') {
    return (
      <p className="px-3 py-1.5 text-xs leading-5 text-[#5a676c]">
        Notifications are blocked for this site. Allow them in your browser or phone settings to get zone alerts.
      </p>
    );
  }

  const enable = async () => {
    setState('subscribing');
    setMessage(null);
    try {
      await subscribeCurrentPlayerPush(await subscribeToPushNotifications());
      setState('enabled');
    } catch (error) {
      setState('error');
      setMessage(error instanceof Error ? error.message : 'Unable to turn on notifications right now.');
    }
  };

  return (
    <div>
      <button
        className="w-full rounded-xl border border-[#c8b48a]/55 bg-[#fff8eb] px-3 py-2.5 text-left text-sm font-semibold text-[#24343a] transition hover:bg-white disabled:opacity-60"
        disabled={state === 'subscribing'}
        onClick={() => { void enable(); }}
        type="button"
      >
        {state === 'subscribing' ? 'Turning on alerts…' : 'Turn on zone alerts'}
      </button>
      {message ? <p className="mt-1 px-1 text-xs text-[#8a5a42]">{message}</p> : null}
    </div>
  );
}
