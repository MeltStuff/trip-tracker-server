# Turning Trip 2026 into a real offline app with notifications

Two pieces, in two folders:

- **`pwa/`** — your original site plus a service worker (`sw.js`) for
  offline caching and a small client (`push-client.js`) that subscribes the
  device to push and syncs your trip events to the backend. This is a
  drop-in replacement for what you already host — same files, same host.
- **`server/`** — a small Node backend that stores subscriptions + events
  and sends a push notification a few hours before each flight/bus/hotel/
  activity, even when the app is closed. See `server/README.md` for setup.

## Order of operations

1. Deploy `server/` first (Railway/Render/Fly — see `server/README.md`),
   generate VAPID keys, note the HTTPS URL it gives you.
2. In `pwa/push-client.js`, set `PUSH_SERVER_URL` to that URL.
3. Deploy `pwa/` to wherever you currently host it (same static hosting
   works — Vercel, Netlify, GitHub Pages, etc.) — just replace the files.
4. Open the app on your phone, tap the bell icon top-right, allow
   notifications. On iOS, the app needs to be **added to the Home Screen**
   first (Share → Add to Home Screen) — installed PWAs get push support on
   iOS 16.4+, but a regular Safari tab does not.

## What you get

- **Offline**: once loaded once, the app shell (HTML/CSS/JS/icons) is
  cached and works with no connection. Your trip data already lives in
  `localStorage`, so editing events offline works exactly as before.
- **Notifications**: real push notifications sent from a server, so they
  arrive even if your phone's browser/app isn't open — a proper "flight
  boards in 3 hours" style reminder.

## Note on `robots.txt`

Your existing `robots.txt` blocks all crawling — keep it, since this is a
personal app you don't want indexed.
