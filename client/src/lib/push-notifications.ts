import type { PushSubscriptionData } from '@city-game/shared';

const vapidPublicKey = (import.meta.env.VITE_VAPID_PUBLIC_KEY ?? import.meta.env.VAPID_PUBLIC_KEY ?? '').trim();

export function supportsPushNotifications(): boolean {
  return (
    Boolean(vapidPublicKey)
    && typeof window !== 'undefined'
    && 'Notification' in window
    && 'serviceWorker' in navigator
    && 'PushManager' in window
  );
}

export function getNotificationPermission(): NotificationPermission {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'default';
  }

  return Notification.permission;
}

export async function registerPushServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!supportsPushNotifications()) {
    return null;
  }

  try {
    return await navigator.serviceWorker.register('/sw.js');
  } catch {
    return null;
  }
}

export async function subscribeToPushNotifications(): Promise<PushSubscriptionData> {
  if (!supportsPushNotifications()) {
    throw new Error('Push notifications are not supported in this browser.');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notification permission was not granted.');
  }

  const registration = await navigator.serviceWorker.ready;
  const existingSubscription = await registration.pushManager.getSubscription();
  const subscription = existingSubscription ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: decodeBase64Url(vapidPublicKey),
  });

  return serializePushSubscription(subscription);
}

function serializePushSubscription(subscription: PushSubscription): PushSubscriptionData {
  const payload = subscription.toJSON();

  return {
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime ?? null,
    keys: {
      p256dh: payload.keys?.p256dh ?? '',
      auth: payload.keys?.auth ?? '',
    },
  };
}

function decodeBase64Url(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const raw = window.atob(padded);
  const output = new Uint8Array(raw.length);

  for (let index = 0; index < raw.length; index += 1) {
    output[index] = raw.charCodeAt(index);
  }

  return output.buffer.slice(0);
}
