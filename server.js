const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');
const axios   = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

// ── In-memory store ───────────────────────────────────────
// Resets on redeploy — good enough for prototype.
// Swap for Upstash Redis / Railway Postgres when you go to prod.
let watchlist    = [];
let seenListings = new Set();
let lastScanTime = null;
let lastScanCount = 0;

// ── Pushover ──────────────────────────────────────────────
async function sendPushover(title, message, url) {
  const token = process.env.PUSHOVER_TOKEN;
  const user  = process.env.PUSHOVER_USER;
  if (!token || !user) {
    console.log('[Pushover] Skipped — PUSHOVER_TOKEN or PUSHOVER_USER not set');
    return;
  }
  try {
    const payload = { token, user, title: title.slice(0, 250), message: message.slice(0, 1024), sound: 'cashregister' };
    if (url) payload.url = url;
    await axios.post('https://api.pushover.net/1/messages.json', payload);
    console.log('[Pushover] Sent:', title);
  } catch (e) {
    console.error('[Pushover] Error:', e.message);
  }
}

// ── Apify scraper ─────────────────────────────────────────
// Actor: "Curious Coder's Facebook Marketplace Scraper"
// Actor ID: curious_coder/facebook-marketplace-scraper
// Apify token: set APIFY_TOKEN env var in Railway

const APIFY_TOKEN  = process.env.APIFY_TOKEN;
const APIFY_ACTOR  = 'curious_coder~facebook-marketplace-scraper';

// Run the actor synchronously and return results.
// Max wait: 60 seconds. Apify free tier: ~$10 USD/month compute.
async function scrapeKeyword(keyword, maxPrice) {
  if (!APIFY_TOKEN) {
    console.warn('[Apify] APIFY_TOKEN not set — skipping scrape');
    return [];
  }

  // Input schema for this actor:
  // https://apify.com/curious_coder/facebook-marketplace-scraper/input-schema
  const input = {
    queries: [keyword],
    locationId: '109993985682491', // Melbourne, VIC
    // Alternatively use lat/lng:
    // latitude: -37.8136,
    // longitude: 144.9631,
    // radiusKm: 50,
    maxResults: 20,
    sortBy: 'creation_time_descend',
    ...(maxPrice ? { maxPrice } : {}),
  };

  try {
    // Run actor and wait for finish (synchronous run endpoint)
    const runRes = await axios.post(
      `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items`,
      input,
      {
        params: { token: APIFY_TOKEN },
        headers: { 'Content-Type': 'application/json' },
        timeout: 90_000, // actor can take ~30–60s
      }
    );

    const items = Array.isArray(runRes.data) ? runRes.data : [];
    console.log(`[Apify] "${keyword}" → ${items.length} item(s) returned`);

    return items.map(item => ({
      id:      item.id || item.listingId || String(item.marketplace_listing_id || ''),
      title:   item.name || item.title || keyword,
      price:   parsePrice(item.price || item.priceAmount),
      url:     item.url || `https://www.facebook.com/marketplace/item/${item.id}/`,
      keyword,
    })).filter(l => l.id);

  } catch (e) {
    // Surface the Apify error clearly so it's easy to debug
    if (e.response) {
      console.error(`[Apify] HTTP ${e.response.status}:`, JSON.stringify(e.response.data).slice(0, 300));
    } else {
      console.error(`[Apify] Error for "${keyword}":`, e.message);
    }
    return [];
  }
}

function parsePrice(raw) {
  if (!raw) return 0;
  if (typeof raw === 'number') return raw;
  // "$1,500" → 1500
  return parseInt(String(raw).replace(/[^0-9]/g, ''), 10) || 0;
}

// ── Main scan loop ────────────────────────────────────────
async function runScan() {
  if (watchlist.length === 0) {
    console.log('[Scan] No keywords — skipping');
    return;
  }

  console.log(`[Scan] Starting — ${watchlist.length} keyword(s)`);
  lastScanTime = new Date().toISOString();
  let totalNew = 0;

  for (const item of watchlist) {
    try {
      const listings = await scrapeKeyword(item.keyword, item.maxPrice);

      for (const listing of listings) {
        const key = `${item.keyword}:${listing.id}`;
        if (seenListings.has(key)) continue;
        seenListings.add(key);

        // Price filter (actor does this too, but double-check client side)
        if (item.maxPrice && listing.price > item.maxPrice) {
          console.log(`[Scan] Skipping "${listing.title}" — $${listing.price} over max $${item.maxPrice}`);
          continue;
        }

        totalNew++;
        const priceStr = listing.price ? `$${listing.price}` : 'Price unknown';
        await sendPushover(
          `🔥 FlipRadar: ${item.keyword}`,
          `${listing.title}\n${priceStr}\n\nTap to view`,
          listing.url
        );

        // Polite gap between notifications
        await sleep(500);
      }

    } catch (e) {
      console.error(`[Scan] Error on "${item.keyword}":`, e.message);
    }
  }

  lastScanCount = totalNew;
  console.log(`[Scan] Done — ${totalNew} new listing(s) alerted`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Every 15 minutes — Apify free tier burns fast if you go every 5 mins
// Change to '*/5 * * * *' once you're on a paid plan
cron.schedule('*/15 * * * *', () => {
  runScan().catch(e => console.error('[Cron] Error:', e.message));
});

// ── API Routes ────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    apify: APIFY_TOKEN ? 'connected' : 'NO APIFY_TOKEN SET',
    watchlist: watchlist.length,
    lastScan: lastScanTime,
    lastScanNewListings: lastScanCount,
    seenTotal: seenListings.size,
  });
});

app.get('/watchlist', (req, res) => res.json(watchlist));

app.post('/watchlist', (req, res) => {
  const { keyword, maxPrice } = req.body;
  if (!keyword || typeof keyword !== 'string' || keyword.trim().length < 2) {
    return res.status(400).json({ error: 'keyword required (min 2 chars)' });
  }
  const item = {
    id: uuidv4(),
    keyword: keyword.trim(),
    maxPrice: maxPrice ? parseInt(maxPrice, 10) : null,
    addedAt: new Date().toISOString(),
  };
  watchlist.push(item);
  console.log(`[Watchlist] Added: "${item.keyword}" (max $${item.maxPrice ?? 'any'})`);
  res.json(item);
});

app.delete('/watchlist/:id', (req, res) => {
  const before = watchlist.length;
  watchlist = watchlist.filter(w => w.id !== req.params.id);
  if (watchlist.length === before) return res.status(404).json({ error: 'not found' });
  console.log(`[Watchlist] Removed: ${req.params.id}`);
  res.json({ ok: true });
});

// Manual scan trigger — handy for testing
app.post('/scan/now', async (req, res) => {
  console.log('[Scan] Manual trigger');
  res.json({ ok: true, message: 'Scan started — check Pushover shortly' });
  runScan().catch(e => console.error('[Scan] Manual error:', e.message));
});

// Test a single keyword immediately — returns raw results to the caller
app.post('/scan/test', async (req, res) => {
  const { keyword, maxPrice } = req.body;
  if (!keyword) return res.status(400).json({ error: 'keyword required' });
  console.log(`[Test] "${keyword}" maxPrice=$${maxPrice || 'any'}`);
  try {
    const listings = await scrapeKeyword(keyword, maxPrice ? parseInt(maxPrice) : null);
    res.json({ keyword, count: listings.length, listings });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FlipRadar backend on port ${PORT}`);
  console.log(`Apify: ${APIFY_TOKEN ? 'token set ✓' : '⚠️  APIFY_TOKEN missing'}`);
  console.log(`Pushover: ${process.env.PUSHOVER_TOKEN ? 'set ✓' : 'not set'}`);
});
