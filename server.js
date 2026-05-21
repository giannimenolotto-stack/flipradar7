const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');
const axios   = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

// ── Upstash Redis ─────────────────────────────────────────
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisGet(key) {
  if (!REDIS_URL) return null;
  try {
    const res = await axios.get(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    return res.data.result ? JSON.parse(res.data.result) : null;
  } catch (e) { console.error('[Redis] GET error:', e.message); return null; }
}

async function redisSet(key, value) {
  if (!REDIS_URL) return;
  try {
    await axios.post(`${REDIS_URL}/set/${encodeURIComponent(key)}`,
      JSON.stringify(JSON.stringify(value)),
      { headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (e) { console.error('[Redis] SET error:', e.message); }
}

// ── In-memory state (backed by Redis on startup) ──────────
let watchlist    = [];
let seenListings = {}; // { "keyword:id": timestamp } — expires after 48h
let listings     = [];
let lastScanTime  = null;
let lastScanCount = 0;

const SEEN_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours

function hasSeen(key) {
  const ts = seenListings[key];
  if (!ts) return false;
  if (Date.now() - ts > SEEN_TTL_MS) { delete seenListings[key]; return false; }
  return true;
}
function markSeen(key) { seenListings[key] = Date.now(); }
function pruneSeen() {
  const cutoff = Date.now() - SEEN_TTL_MS;
  for (const key of Object.keys(seenListings)) {
    if (seenListings[key] < cutoff) delete seenListings[key];
  }
}

async function loadFromRedis() {
  console.log('[Redis] Loading state...');
  const savedWatch    = await redisGet('flipradar:watchlist');
  const savedListings = await redisGet('flipradar:listings');
  const savedSeen     = await redisGet('flipradar:seen');
  if (savedWatch && Array.isArray(savedWatch))    { watchlist = savedWatch; console.log(`[Redis] Loaded ${watchlist.length} watches`); }
  if (savedListings && Array.isArray(savedListings)) { listings  = savedListings; console.log(`[Redis] Loaded ${listings.length} listings`); }
  if (savedSeen && typeof savedSeen === 'object' && !Array.isArray(savedSeen)) {
    seenListings = savedSeen;
    pruneSeen();
    console.log(`[Redis] Loaded ${Object.keys(seenListings).length} seen IDs`);
  } else if (savedSeen && Array.isArray(savedSeen)) {
    // Migrate old array format — stamp with current time
    savedSeen.forEach(k => { seenListings[k] = Date.now(); });
    console.log(`[Redis] Migrated ${Object.keys(seenListings).length} seen IDs from old format`);
  }
}

async function saveWatchlist() { await redisSet('flipradar:watchlist', watchlist); }
async function saveListings()  { await redisSet('flipradar:listings', listings); }
async function saveSeen() {
  pruneSeen();
  // Keep only the most recent 2000 entries by timestamp
  const entries = Object.entries(seenListings).sort((a, b) => b[1] - a[1]).slice(0, 2000);
  await redisSet('flipradar:seen', Object.fromEntries(entries));
}

// ── Pushover ──────────────────────────────────────────────
async function sendPushover(token, user, title, message, url) {
  if (!token || !user) return;
  try {
    const payload = { token, user, title: title.slice(0,250), message: message.slice(0,1024), sound: 'cashregister' };
    if (url) payload.url = url;
    await axios.post('https://api.pushover.net/1/messages.json', payload);
  } catch (e) { console.error('[Pushover] Error:', e.message); }
}

// ── Apify ─────────────────────────────────────────────────
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const APIFY_ACTOR = 'curious_coder~facebook-marketplace';

async function scrapeKeyword(keyword) {
  if (!APIFY_TOKEN) return [];
  const fbUrl = `https://www.facebook.com/marketplace/melbourne/search/?query=${encodeURIComponent(keyword)}&sortBy=creation_time_descend&daysSinceListed=1`;
  try {
    const res = await axios.post(
      `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items`,
      { urls: [fbUrl], maxItems: 25, includeDetails: true },
      { params: { token: APIFY_TOKEN }, headers: { 'Content-Type': 'application/json' }, timeout: 180000 }
    );
    const items = Array.isArray(res.data) ? res.data.filter(i => !i.error) : [];
    console.log(`[Apify] "${keyword}" -> ${items.length} item(s)`);
    return items.map(item => {
      const id = item.id || item.listingId || String(item.marketplace_listing_id || '');
      const description = item.redacted_description?.text || item.description || null;
      return {
        id,
        title:       item.marketplace_listing_title || item.title || keyword,
        price:       parsePrice(item.listing_price?.amount || item.listing_price?.formatted_amount || item.price),
        url:         item.listingUrl || item.url || `https://www.facebook.com/marketplace/item/${id}/`,
        image:       item.primary_listing_photo_url || item.primary_listing_photo?.image?.uri || null,
        location:    typeof item.location === 'string' ? item.location : (item.location?.reverse_geocode?.city || null),
        description,
        mileage:     parseMileage(item.vehicle_odometer_data?.odometer_value || item.mileage || item.odometer || description),
        keyword,
        foundAt:     new Date().toISOString(),
      };
    }).filter(l => l.id);
  } catch (e) {
    console.error(`[Apify] Error for "${keyword}":`, e.response ? JSON.stringify(e.response.data).slice(0,200) : e.message);
    return [];
  }
}

function parsePrice(raw) {
  if (!raw) return 0;
  if (typeof raw === 'number') return Math.round(raw);
  return Math.round(parseFloat(String(raw).replace(/[^0-9.]/g, '')) || 0);
}

function parseMileage(raw) {
  if (!raw) return null;
  // If it's a number (direct odometer field), return it
  if (typeof raw === 'number' && raw > 0) return raw;
  // If it's a string (description text), extract km/kms/kilometres
  if (typeof raw === 'string') {
    // Match patterns like: 123,456 km | 123456km | 123k kms | 123,456 kilometres
    const match = raw.match(/(\d[\d,]*\.?\d*)\s*k(?:m|ms|ilometres?|ilometers?)\b/i);
    if (match) {
      const val = parseFloat(match[1].replace(/,/g, ''));
      // If written as "123k kms" style — already handled since we match digits before k
      // Sanity check: real mileage is between 100 and 1,000,000
      if (val >= 100 && val <= 1000000) return Math.round(val);
    }
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Scan ──────────────────────────────────────────────────
async function runScan() {
  if (watchlist.length === 0) { console.log('[Scan] No keywords'); return; }
  const uniqueKeywords = [...new Set(watchlist.map(w => w.keyword.toLowerCase()))];
  console.log(`[Scan] ${watchlist.length} watches, ${uniqueKeywords.length} unique keyword(s)`);
  lastScanTime = new Date().toISOString();
  let totalNew = 0;

  for (const keyword of uniqueKeywords) {
    const found = await scrapeKeyword(keyword);
    for (const listing of found) {
      const key = `${keyword}:${listing.id}`;
      if (hasSeen(key)) continue;
      markSeen(key);

      // Avoid storing duplicate listing IDs across keywords
      if (!listings.find(l => l.id === listing.id)) {
        listings.unshift(listing);
        if (listings.length > 500) listings = listings.slice(0, 500);
      }
      totalNew++;

      const watchers = watchlist.filter(w => w.keyword.toLowerCase() === keyword);
      for (const watcher of watchers) {
        if (watcher.maxPrice && listing.price > watcher.maxPrice) continue;
        const pToken = watcher.pushoverToken || process.env.PUSHOVER_TOKEN;
        const pUser  = watcher.pushoverUser  || process.env.PUSHOVER_USER;
        const priceStr = listing.price ? `$${listing.price}` : 'Price unknown';
        await sendPushover(pToken, pUser, `FlipRadar: ${keyword}`, `${listing.title}\n${priceStr}`, listing.url);
        await sleep(300);
      }
    }
    await sleep(500);
  }

  lastScanCount = totalNew;
  console.log(`[Scan] Done — ${totalNew} new listing(s)`);

  // Always persist after every scan so Redis stays current even if no new listings
  await saveListings();
  await saveSeen();
}

cron.schedule('*/30 * * * *', () => {
  runScan().catch(e => console.error('[Cron]', e.message));
});

// Keep Render free tier awake — ping self every 14 mins so the process never sleeps
// (Render spins down after 15 mins of inactivity, which would kill the cron)
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
if (SELF_URL) {
  setInterval(() => {
    axios.get(SELF_URL + '/').catch(() => {});
    console.log('[Ping] Self-ping sent');
  }, 14 * 60 * 1000);
} else {
  console.warn('[Ping] No RENDER_EXTERNAL_URL set — server may sleep and miss cron jobs on free tier');
}

// ── Routes ────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status: 'ok',
  apify: APIFY_TOKEN ? 'connected' : 'NO APIFY_TOKEN SET',
  redis: REDIS_URL ? 'connected' : 'not set',
  watches: watchlist.length,
  uniqueKeywords: [...new Set(watchlist.map(w => w.keyword.toLowerCase()))].length,
  listingsCount: listings.length,
  lastScan: lastScanTime,
  lastScanNewListings: lastScanCount,
  seenTotal: Object.keys(seenListings).length,
}));

app.get('/status', (req, res) => {
  const now = new Date();
  const mins = now.getMinutes();
  // Next 30-min mark
  const nextMins = mins < 30 ? 30 - mins : 60 - mins;
  res.json({
    ok: true,
    lastScan: lastScanTime,
    lastScanNewListings: lastScanCount,
    nextScanInMins: nextMins,
    watches: watchlist.length,
    listingsStored: listings.length,
    seenEntries: Object.keys(seenListings).length,
    uptime: Math.floor(process.uptime()) + 's',
  });
});

app.get('/watchlist', (req, res) => {
  const userId = req.query.userId;
  res.json(userId ? watchlist.filter(w => w.userId === userId) : watchlist);
});

app.post('/watchlist', async (req, res) => {
  const { keyword, maxPrice, userId, pushoverToken, pushoverUser } = req.body;
  if (!keyword || keyword.trim().length < 2)
    return res.status(400).json({ error: 'keyword required' });
  const item = {
    id: uuidv4(),
    userId: userId || 'default',
    keyword: keyword.trim().toLowerCase(),
    maxPrice: maxPrice ? parseInt(maxPrice) : null,
    pushoverToken: pushoverToken || null,
    pushoverUser:  pushoverUser  || null,
    addedAt: new Date().toISOString(),
  };
  watchlist.push(item);
  await saveWatchlist();
  console.log(`[Watch] Added "${item.keyword}" for user ${item.userId}`);
  res.json(item);
});

app.delete('/watchlist/:id', async (req, res) => {
  const before = watchlist.length;
  watchlist = watchlist.filter(w => w.id !== req.params.id);
  if (watchlist.length === before) return res.status(404).json({ error: 'not found' });
  await saveWatchlist();
  res.json({ ok: true });
});

app.get('/listings', (req, res) => {
  const { keyword } = req.query;
  res.json(keyword ? listings.filter(l => l.keyword === keyword) : listings);
});

app.delete('/listings', async (req, res) => {
  listings = [];
  seenListings = {};
  await saveListings();
  await saveSeen();
  console.log('[Clear] Feed cleared');
  res.json({ ok: true });
});

// Image proxy
app.get('/proxy-image', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
        'Referer': 'https://www.facebook.com/'
      }
    });
    const base64 = Buffer.from(response.data).toString('base64');
    const mediaType = response.headers['content-type'] || 'image/jpeg';
    res.json({ base64, mediaType });
  } catch (e) {
    console.error('[Proxy] Image fetch failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/scan/now', async (req, res) => {
  res.json({ ok: true, message: 'Scan started' });
  runScan().catch(e => console.error('[Scan/now]', e.message));
});

app.post('/scan/test', async (req, res) => {
  const { keyword } = req.body;
  if (!keyword) return res.status(400).json({ error: 'keyword required' });
  try {
    const found = await scrapeKeyword(keyword);
    res.json({ keyword, count: found.length, listings: found });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`FlipRadar backend on port ${PORT}`);
  console.log(`Apify: ${APIFY_TOKEN ? 'token set' : 'NO TOKEN'}`);
  console.log(`Redis: ${REDIS_URL ? 'connected' : 'NOT SET — data will not persist'}`);
  console.log(`Pushover: ${process.env.PUSHOVER_TOKEN ? 'set' : 'not set'}`);
  await loadFromRedis();
  console.log('[Ready] Server fully loaded');
});
