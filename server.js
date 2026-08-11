// Trip 2026 — Push notification backend
//
// Stores web-push subscriptions + each device's trip events in a flat JSON
// file (fine for a single-user personal trip app; swap for a real DB if
// you ever need more than that). Every minute, a cron job checks whether
// any event's reminder time has arrived and sends a push notification.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const cron = require('node-cron');
const multer = require('multer');

// Receipt images are handled in memory only (never written to disk) and
// discarded as soon as the request finishes.
const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 } // 8MB
});

const DB_PATH = path.join(__dirname, 'data', 'db.json');
const PORT = process.env.PORT || 3000;

// ---- VAPID setup ----
if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
  console.error(
    'Missing VAPID keys. Run "npm run generate-vapid-keys" and put the ' +
    'output into your .env file (see .env.example).'
  );
  process.exit(1);
}
webpush.setVapidDetails(
  process.env.VAPID_CONTACT || 'mailto:you@example.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ---- Tiny JSON "database" ----
function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify({ subscriptions: [] }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}
function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// How far ahead of an event to send the reminder, by event type
const REMINDER_MINUTES = {
  flight: 180,
  bus: 90,
  hotel: 60,
  activity: 60
};

// ---- App ----
const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// Register (or update) a subscription and its event list
app.post('/api/subscribe', (req, res) => {
  const { subscription, events, timezone } = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Missing subscription' });
  }

  const db = loadDB();
  const existing = db.subscriptions.find((s) => s.endpoint === subscription.endpoint);
  if (existing) {
    existing.subscription = subscription;
    existing.events = events || existing.events || [];
    if (timezone) existing.timezone = timezone;
  } else {
    db.subscriptions.push({
      endpoint: subscription.endpoint,
      subscription,
      events: events || [],
      timezone: timezone || 'UTC',
      sentReminders: []
    });
  }
  saveDB(db);
  res.json({ ok: true });
});

// Update just the event list for an existing subscription (called whenever
// the trip itinerary changes on the device)
app.post('/api/events', (req, res) => {
  const { endpoint, events, timezone } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });

  const db = loadDB();
  const existing = db.subscriptions.find((s) => s.endpoint === endpoint);
  if (!existing) return res.status(404).json({ error: 'Unknown subscription' });

  existing.events = events || [];
  if (timezone) existing.timezone = timezone;
  saveDB(db);
  res.json({ ok: true });
});

app.post('/api/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  const db = loadDB();
  db.subscriptions = db.subscriptions.filter((s) => s.endpoint !== endpoint);
  saveDB(db);
  res.json({ ok: true });
});

// Scan a receipt photo and pull out the total, merchant, and date.
// The image is held in memory only (see receiptUpload above) and never
// touches disk — it's forwarded to Claude and then discarded.
app.post('/api/scan-receipt', receiptUpload.single('receipt'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Missing ANTHROPIC_API_KEY');
    return res.status(500).json({ error: 'Server not configured for receipt scanning' });
  }

  try {
    const base64Image = req.file.buffer.toString('base64');
    const mediaType = req.file.mimetype || 'image/jpeg';

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Image } },
            {
              type: 'text',
              text:
                'This is a photo of a receipt. Find the FINAL TOTAL amount charged ' +
                '(not the subtotal, not a single line item, not a tip suggestion). Also ' +
                'decide whether this receipt is from a restaurant, cafe, bar, fast food ' +
                'place, or grocery/convenience store (category "food"), versus anything ' +
                'else like transport, lodging, tickets, or shopping (category "other"). ' +
                'Respond with ONLY raw JSON, no markdown fences, no explanation, in ' +
                'exactly this shape: {"total": 0.00, "merchant": "string or null", ' +
                '"date": "YYYY-MM-DD or null", "currency": "3-letter code or null", ' +
                '"category": "food or other"}. If you cannot find a total, set total to null.'
            }
          ]
        }]
      })
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      console.error('Anthropic API error:', aiRes.status, errText);
      return res.status(502).json({ error: 'Receipt scan failed' });
    }

    const aiData = await aiRes.json();
    const textBlock = (aiData.content || []).find((b) => b.type === 'text');

    // Claude sometimes wraps its answer in ```json fences despite being told
    // not to — strip those before parsing rather than fighting the prompt.
    let raw = (textBlock && textBlock.text || '{}').trim();
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error('Could not parse model output:', textBlock && textBlock.text);
      return res.status(502).json({ error: 'Could not read that receipt' });
    }

    res.json({
      total: parsed.total ?? null,
      merchant: parsed.merchant ?? null,
      date: parsed.date ?? null,
      currency: parsed.currency ?? null,
      category: parsed.category === 'food' ? 'food' : 'other'
    });
  } catch (err) {
    console.error('Receipt scan error:', err);
    res.status(500).json({ error: 'Receipt scan failed' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Trip 2026 push server listening on :${PORT}`));

// ---- Reminder scheduler: runs every minute ----
cron.schedule('* * * * *', async () => {
  const db = loadDB();
  const now = Date.now();
  let changed = false;

  for (const sub of db.subscriptions) {
    for (const evt of sub.events || []) {
      if (!evt.start) continue;
      const startMs = new Date(evt.start).getTime();
      if (Number.isNaN(startMs)) continue;

      const reminderMinutes = REMINDER_MINUTES[evt.type] ?? 60;
      const reminderAt = startMs - reminderMinutes * 60 * 1000;
      const reminderKey = `${evt.id}`;

      const alreadySent = sub.sentReminders.includes(reminderKey);
      const isDue = now >= reminderAt && now < startMs;

      if (isDue && !alreadySent) {
        const payload = JSON.stringify({
          title: evt.title || 'Upcoming trip event',
          body: `${evt.city ? evt.city + ' · ' : ''}${new Date(evt.start).toLocaleString('en-US', {
            weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: sub.timezone || 'UTC'
          })}`,
          tag: `trip-event-${evt.id}`,
          eventId: evt.id,
          url: '/'
        });

        try {
          await webpush.sendNotification(sub.subscription, payload);
          sub.sentReminders.push(reminderKey);
          changed = true;
        } catch (err) {
          console.error(`Push failed for ${sub.endpoint}:`, err.statusCode || err.message);
          // 410/404 means the subscription is dead — drop it
          if (err.statusCode === 410 || err.statusCode === 404) {
            db.subscriptions = db.subscriptions.filter((s) => s.endpoint !== sub.endpoint);
            changed = true;
          }
        }
      }
    }
  }

  if (changed) saveDB(db);
});
