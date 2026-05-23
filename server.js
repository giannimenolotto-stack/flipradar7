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

// ── Scan intervals per plan (ms) ─────────────────────────
const PLAN_INTERVALS = {
  basic:   30 * 60 * 1000,  // 30 mins
  premium: 15 * 60 * 1000,  // 15 mins
};

// ── In-memory state ───────────────────────────────────────
let watchlist    = [];
let seenListings = {};
let listings     = [];
let lastScanTime  = null;
let lastScanCount = 0;

const SEEN_TTL_MS = 48 * 60 * 60 * 1000;

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
  if (savedWatch && Array.isArray(savedWatch))       { watchlist = savedWatch; console.log(`[Redis] Loaded ${watchlist.length} watches`); }
  if (savedListings && Array.isArray(savedListings)) { listings  = savedListings; console.log(`[Redis] Loaded ${listings.length} listings`); }
  if (savedSeen && typeof savedSeen === 'object' && !Array.isArray(savedSeen)) {
    seenListings = savedSeen; pruneSeen();
    console.log(`[Redis] Loaded ${Object.keys(seenListings).length} seen IDs`);
  } else if (savedSeen && Array.isArray(savedSeen)) {
    savedSeen.forEach(k => { seenListings[k] = Date.now(); });
  }
}

async function saveWatchlist() { await redisSet('flipradar:watchlist', watchlist); }
async function saveListings()  { await redisSet('flipradar:listings', listings); }
async function saveSeen() {
  pruneSeen();
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

async function scrapeKeyword(keyword, opts = {}) {
  if (!APIFY_TOKEN) return [];
  const days = opts.initialScan ? 7 : 1;
  const maxItems = opts.initialScan ? 100 : 50;
  let fbUrl;
  if (opts.lat && opts.lng) {
    fbUrl = `https://www.facebook.com/marketplace/search/?query=${encodeURIComponent(keyword)}&latitude=${opts.lat}&longitude=${opts.lng}&radius=${opts.radius||50}&sortBy=creation_time_descend&daysSinceListed=${days}`;
  } else {
    const city = (opts.city || 'melbourne').toLowerCase().replace(/\s+/g, '');
    fbUrl = `https://www.facebook.com/marketplace/${city}/search/?query=${encodeURIComponent(keyword)}&sortBy=creation_time_descend&daysSinceListed=${days}`;
  }
  try {
    const res = await axios.post(
      `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items`,
      { urls: [fbUrl], maxItems, includeDetails: true },
      { params: { token: APIFY_TOKEN }, headers: { 'Content-Type': 'application/json' }, timeout: 180000 }
    );
    const items = Array.isArray(res.data) ? res.data.filter(i => !i.error) : [];
    console.log(`[Apify] "${keyword}" -> ${items.length} item(s)`);
    return items.map(item => {
      const id = item.id || item.listingId || String(item.marketplace_listing_id || '');
      // Best-effort Facebook listing date — Apify exposes several possible fields
      const rawListedAt = item.creation_time || item.listed_at || item.listingCreationTime
        || item.listing_creation_time || item.created_time || item.date || null;
      const listedAt = rawListedAt
        ? (typeof rawListedAt === 'number'
            ? new Date(rawListedAt * 1000).toISOString()   // unix seconds
            : new Date(rawListedAt).toISOString())
        : new Date().toISOString();
      return {
        id,
        title:       item.marketplace_listing_title || item.title || keyword,
        price:       parsePrice(item.listing_price?.amount || item.listing_price?.formatted_amount || item.price),
        url:         item.listingUrl || item.url || `https://www.facebook.com/marketplace/item/${id}/`,
        image:       item.primary_listing_photo_url || item.primary_listing_photo?.image?.uri || null,
        location:    typeof item.location === 'string' ? item.location : (item.location?.reverse_geocode?.city || null),
        description: item.redacted_description?.text || item.description || null,
        keyword,
        listedAt,
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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Relevance filter — DISABLED, let the search engine decide ────
// Always returns true so every result Apify returns gets through.
function isRelevant() { return true; }

// ── Per-watchlist scan ────────────────────────────────────
async function scanWatchItem(watcher, opts = {}) {
  const keyword = watcher.keyword.toLowerCase();
  const raw = await scrapeKeyword(keyword, { city: watcher.location, lat: watcher.lat, lng: watcher.lng, radius: watcher.radius, initialScan: opts.initialScan || false });
  // Pass everything through — no title/keyword relevance filtering
  const found = raw;
  console.log(`[Scan] "${keyword}" → ${found.length} result(s) from Apify (no filter)`);
  let newCount = 0;

  for (const listing of found) {
    const key = `${keyword}:${listing.id}`;
    if (hasSeen(key)) continue;
    // Check price BEFORE markSeen — so over-budget listings aren't permanently
    // blacklisted (seller might drop the price on a future scan)
    if (watcher.maxPrice && listing.price > watcher.maxPrice) continue;
    if (watcher.minPrice && listing.price < watcher.minPrice) continue;
    markSeen(key);
    if (!listings.find(l => l.id === listing.id)) {
      listings.unshift(listing);
      // Keep sorted by Facebook listing date, newest first
      listings.sort((a, b) => new Date(b.listedAt || b.foundAt) - new Date(a.listedAt || a.foundAt));
      if (listings.length > 500) listings = listings.slice(0, 500);
    }
    newCount++;
    const pToken = watcher.pushoverToken || process.env.PUSHOVER_TOKEN;
    const pUser  = watcher.pushoverUser  || process.env.PUSHOVER_USER;
    const priceStr = listing.price ? `$${listing.price}` : 'Price unknown';
    await sendPushover(pToken, pUser, `FlipRadar: ${keyword}`, `${listing.title}\n${priceStr}`, listing.url);
    await sleep(300);
  }

  if (newCount > 0) {
    await saveListings();
    await saveSeen();
  }

  console.log(`[Scan] "${keyword}" (${watcher.plan||'basic'}) → ${newCount} new`);
  return newCount;
}

// ── Per-watchlist timers ──────────────────────────────────
const watchTimers = {}; // watchId -> timer

function startWatchTimer(watcher) {
  if (watchTimers[watcher.id]) clearInterval(watchTimers[watcher.id]);
  const interval = PLAN_INTERVALS[watcher.plan] || PLAN_INTERVALS.basic;
  console.log(`[Timer] Starting "${watcher.keyword}" every ${interval/60000} mins (${watcher.plan||'basic'})`);
  watchTimers[watcher.id] = setInterval(() => {
    scanWatchItem(watcher).catch(e => console.error(`[Timer] Error for "${watcher.keyword}":`, e.message));
  }, interval);
}

function stopWatchTimer(watchId) {
  if (watchTimers[watchId]) {
    clearInterval(watchTimers[watchId]);
    delete watchTimers[watchId];
  }
}

function restartAllTimers() {
  // Clear existing
  Object.keys(watchTimers).forEach(id => clearInterval(watchTimers[id]));
  // Start one per watchlist
  watchlist.forEach(w => startWatchTimer(w));
  console.log(`[Timers] Started ${watchlist.length} watchlist timers`);
}

// ── Full scan (all watchlists) — used by /scan/now ────────
async function runScan() {
  if (watchlist.length === 0) { console.log('[Scan] No keywords'); return; }
  const uniqueKeywords = [...new Set(watchlist.map(w => w.keyword.toLowerCase()))];
  console.log(`[Scan] Manual scan — ${uniqueKeywords.length} unique keyword(s)`);
  lastScanTime = new Date().toISOString();
  let total = 0;
  for (const watcher of watchlist) {
    total += await scanWatchItem(watcher);
    await sleep(500);
  }
  lastScanCount = total;
  console.log(`[Scan] Done — ${total} new listing(s)`);
}

// Keep Render awake
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
if (SELF_URL) {
  setInterval(() => {
    axios.get(SELF_URL + '/').catch(() => {});
  }, 14 * 60 * 1000);
}

// ── Routes ────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status: 'ok',
  apify: APIFY_TOKEN ? 'connected' : 'NO APIFY_TOKEN SET',
  redis: REDIS_URL ? 'connected' : 'not set',
  watches: watchlist.length,
  timers: Object.keys(watchTimers).length,
  listingsCount: listings.length,
  lastScan: lastScanTime,
  lastScanNewListings: lastScanCount,
  seenTotal: Object.keys(seenListings).length,
}));

app.get('/watchlist', (req, res) => {
  const userId = req.query.userId;
  res.json(userId ? watchlist.filter(w => w.userId === userId) : watchlist);
});

app.post('/watchlist', async (req, res) => {
  const { keyword, maxPrice, minPrice, userId, pushoverToken, pushoverUser, plan, name, speed } = req.body;
  if (!keyword || keyword.trim().length < 2)
    return res.status(400).json({ error: 'keyword required' });

  // Determine plan from speed or explicit plan field
  const watchPlan = plan || (speed === 'premium' ? 'premium' : 'basic');

  const item = {
    id: uuidv4(),
    userId: userId || 'default',
    keyword: keyword.trim().toLowerCase(),
    name: name || keyword.trim(),
    maxPrice: maxPrice ? parseInt(maxPrice) : null,
    minPrice: minPrice ? parseInt(minPrice) : null,
    location: req.body.location || null,
    lat: req.body.lat ? parseFloat(req.body.lat) : null,
    lng: req.body.lng ? parseFloat(req.body.lng) : null,
    radius: req.body.radius ? parseInt(req.body.radius) : 50,
    plan: watchPlan,
    pushoverToken: pushoverToken || null,
    pushoverUser:  pushoverUser  || null,
    addedAt: new Date().toISOString(),
    lastScanned: null,
  };
  watchlist.push(item);
  await saveWatchlist();

  // Start its personal timer
  startWatchTimer(item);

  console.log(`[Watch] Added "${item.keyword}" plan=${item.plan} every ${PLAN_INTERVALS[item.plan]/60000} mins`);
  res.json(item);

  // Fire initial backfill scan (7 days, 100 items) in the background — don't await
  scanWatchItem(item, { initialScan: true })
    .then(n => console.log(`[InitialScan] "${item.keyword}" → ${n} new listing(s) from backfill`))
    .catch(e => console.error(`[InitialScan] Error for "${item.keyword}":`, e.message));
});

app.delete('/watchlist/:id', async (req, res) => {
  const before = watchlist.length;
  watchlist = watchlist.filter(w => w.id !== req.params.id);
  if (watchlist.length === before) return res.status(404).json({ error: 'not found' });
  stopWatchTimer(req.params.id);
  await saveWatchlist();
  res.json({ ok: true });
});

app.get('/listings', (req, res) => {
  const { keyword, since } = req.query;
  let result = keyword ? listings.filter(l => l.keyword === keyword) : listings;
  // ?since=ISO_TIMESTAMP — only return listings newer than that time
  if (since) {
    const sinceMs = new Date(since).getTime();
    if (!isNaN(sinceMs)) result = result.filter(l => new Date(l.foundAt).getTime() > sinceMs);
  }
  // Always return newest Facebook listings first
  result = [...result].sort((a, b) => new Date(b.listedAt || b.foundAt) - new Date(a.listedAt || a.foundAt));
  res.json(result);
});

app.delete('/listings', async (req, res) => {
  listings = [];
  seenListings = {};
  await saveListings();
  await saveSeen();
  console.log('[Clear] Feed cleared');
  res.json({ ok: true });
});

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
    const found = await scrapeKeyword(keyword, {});
    res.json({ keyword, count: found.length, listings: found });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`FlipRadar backend on port ${PORT}`);
  console.log(`Apify: ${APIFY_TOKEN ? 'token set' : 'NO TOKEN'}`);
  console.log(`Redis: ${REDIS_URL ? 'connected' : 'NOT SET'}`);
  console.log(`Pushover: ${process.env.PUSHOVER_TOKEN ? 'set' : 'not set'}`);
  await loadFromRedis();
  restartAllTimers();
  console.log('[Ready] Server fully loaded');
});
