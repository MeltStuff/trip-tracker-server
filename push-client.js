// Trip 2026 — Push notification client
//
// Talks to the small backend in /server (see server/README.md) to:
//   1. Subscribe this device for Web Push
//   2. Upload the trip's events so the server can schedule reminders
//
// IMPORTANT: set PUSH_SERVER_URL to wherever you deploy the backend, e.g.
// "https://trip2026-push.up.railway.app"
const PUSH_SERVER_URL = 'https://trip2026-push-server-production.up.railway.app';

// Converts a naive "datetime-local" string (e.g. "2026-08-15T14:00", no
// timezone) into a proper ISO timestamp with the correct UTC offset, using
// THIS device's timezone as the intended one (since that's what was picked
// in the date/time picker). Without this, the server parses the naive
// string using its own timezone (usually UTC), silently shifting every
// event by however many hours off UTC the user's local time is — which is
// why reminders were firing at the wrong moment or not at all.
function toAbsoluteISOString(value) {
  if (!value) return value;
  // Already has a timezone marker (Z or +hh:mm/-hh:mm) — leave it alone
  if (/Z$|[+-]\d{2}:\d{2}$/.test(value)) return value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

function prepareEventsForSync(events) {
  return (events || []).map((evt) => ({
    ...evt,
    start: toAbsoluteISOString(evt.start),
    end: toAbsoluteISOString(evt.end)
  }));
}

let cachedSubscription = null;

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function getExistingSubscription() {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.ready;
  cachedSubscription = await reg.pushManager.getSubscription();
  return cachedSubscription;
}

async function subscribeToPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    alert('Push notifications are not supported in this browser.');
    return null;
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    alert('Notifications were not enabled. You can turn them on later from this button.');
    return null;
  }

  const reg = await navigator.serviceWorker.ready;

  // Fetch the server's public VAPID key so the push service can route
  // notifications to it later.
  const res = await fetch(`${PUSH_SERVER_URL}/api/vapid-public-key`);
  const { publicKey } = await res.json();

  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey)
  });

  cachedSubscription = subscription;

  // Register it with the backend and push the current trip data along.
  // `events` is declared with `let` in the main <script> block above — classic
  // (non-module) scripts on the same page share one top-level scope, so it's
  // visible here directly. We also send this device's current timezone so
  // the server can format notification times correctly (it otherwise has
  // no idea what timezone you're in and defaults to its own, UTC).
  await fetch(`${PUSH_SERVER_URL}/api/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subscription,
      events: prepareEventsForSync(typeof events !== 'undefined' ? events : []),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    })
  });

  return subscription;
}

async function unsubscribeFromPush() {
  const sub = await getExistingSubscription();
  if (!sub) return;

  await fetch(`${PUSH_SERVER_URL}/api/unsubscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint })
  });

  await sub.unsubscribe();
  cachedSubscription = null;
}

// Wired to the bell button in the header
async function togglePushSubscription() {
  const existing = await getExistingSubscription();
  if (existing) {
    await unsubscribeFromPush();
  } else {
    await subscribeToPush();
  }
  refreshNotifButtonState();
}

// Keeps the server's copy of events up to date so it can schedule reminders
// (departure times, check-ins, etc). Safe to call even before subscribing —
// it's a no-op until there's a subscription on file.
async function syncEventsToPushServer(events) {
  const sub = await getExistingSubscription();
  if (!sub) return;

  try {
    await fetch(`${PUSH_SERVER_URL}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: sub.endpoint,
        events: prepareEventsForSync(events),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
      })
    });
  } catch (err) {
    console.warn('Could not sync events to push server (offline?)', err);
  }
}

async function refreshNotifButtonState() {
  const btn = document.getElementById('notif-btn');
  if (!btn) return;
  const sub = await getExistingSubscription();
  const iconEl = document.getElementById('notif-icon-placeholder');
  if (iconEl && typeof icons !== 'undefined') {
    iconEl.innerHTML = sub ? icons.bell : icons.bellOff;
  }
  btn.style.color = sub ? '#4ade80' : '#ffffff';
}

window.togglePushSubscription = togglePushSubscription;
window.syncEventsToPushServer = syncEventsToPushServer;
window.refreshNotifButtonState = refreshNotifButtonState;
