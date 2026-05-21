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

  // Use both sort orders so we catch listings regardless of what FB surfaces first.
  // daysSinceListed=2 gives us a slightly wider net without blowing up seen-IDs.
  const fbUrl = `https://www.facebook.com/marketplace/melbourne/search/?query=${encodeURIComponent(keyword)}&sortBy=creation_time_descend&daysSinceListed=2`;

  try {
    const res = await axios.post(
      `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items`,
      {
        urls: [fbUrl],
        maxItems: 40,          // Increased — more raw results = fewer misses
        includeDetails: true,  // Required for vehicle_odometer_data, location object, etc.
      },
      { params: { token: APIFY_TOKEN }, headers: { 'Content-Type': 'application/json' }, timeout: 240000 }
    );

    const items = Array.isArray(res.data) ? res.data.filter(i => !i.error) : [];
    console.log(`[Apify] "${keyword}" -> ${items.length} raw item(s)`);

    return items.map(item => {
      // ── ID ──────────────────────────────────────────────
      const id = String(
        item.id ||
        item.listingId ||
        item.marketplace_listing_id ||
        item.listing_id ||
        ''
      );

      // ── Description (FB sometimes splits across fields) ──
      const description = (
        item.redacted_description?.text ||
        item.description?.text ||
        item.description ||
        item.listing_description ||
        null
      );

      // ── Title ───────────────────────────────────────────
      const title = (
        item.marketplace_listing_title ||
        item.name ||
        item.title ||
        keyword
      );

      // ── Price ───────────────────────────────────────────
      const price = parsePrice(
        item.listing_price?.amount ||
        item.listing_price?.formatted_amount ||
        item.price?.amount ||
        item.price
      );

      // ── URL ─────────────────────────────────────────────
      const url = item.listingUrl || item.url || `https://www.facebook.com/marketplace/item/${id}/`;

      // ── Image — try multiple known field paths ───────────
      const image = (
        item.primary_listing_photo_url ||
        item.primary_listing_photo?.image?.uri ||
        item.primary_listing_photo?.image?.url ||
        item.listing_photos?.[0]?.image?.uri ||
        item.cover_photo?.photo?.image?.uri ||
        null
      );

      // ── Location ─────────────────────────────────────────
      const location = (
        typeof item.location === 'string' ? item.location :
        item.location?.reverse_geocode?.city ||
        item.location?.reverse_geocode?.suburb ||
        item.location?.city ||
        item.location_text ||
        null
      );

      // ── Mileage — FB exposes odometer in several places ──
      // Priority: structured odometer field > custom_sub_titles > listing title > description
      const rawOdo = (
        item.vehicle_odometer_data?.odometer_value ||           // Structured int (km)
        item.vehicle_odometer_data?.value ||
        item.odometer_reading ||
        item.odometer ||
        item.mileage ||
        extractOdoFromSubTitles(item.custom_sub_titles_with_rendering_flags) ||
        extractOdoFromSubTitles(item.listing_sub_titles) ||
        null
      );

      // Fall back to free-text extraction from title + description combined
      const mileage = parseMileage(rawOdo) ||
                      parseMileage(title + ' ' + (description || ''));

      // ── Year / Make / Model (bonus for vehicles) ─────────
      const year  = item.year  || item.vehicle_year  || extractYear(title)  || null;
      const make  = item.make  || item.vehicle_make  || null;
      const model = item.model || item.vehicle_model || null;

      return { id, title, price, url, image, location, description, mileage, year, make, model, keyword, foundAt: new Date().toISOString() };
    }).filter(l => l.id);

  } catch (e) {
    console.error(`[Apify] Error for "${keyword}":`, e.response ? JSON.stringify(e.response.data).slice(0, 300) : e.message);
    return [];
  }
}

/**
 * Facebook sometimes puts "123,456 km" in a custom_sub_titles array of objects
 * like [{ subtitle: "123,456 km" }, ...]. Extract the first km-looking entry.
 */
function extractOdoFromSubTitles(arr) {
  if (!Array.isArray(arr)) return null;
  for (const entry of arr) {
    const text = (typeof entry === 'string') ? entry : (entry.subtitle || entry.text || entry.title || '');
    if (/\d[\d,]*\s*k(?:m|ms)/i.test(text)) return text;
  }
  return null;
}

/** Pull a 4-digit year from a listing title like "2019 Honda CB300R" */
function extractYear(title) {
  if (!title) return null;
  const m = title.match(/\b(19[5-9]\d|20[0-2]\d)\b/);
  return m ? parseInt(m[1]) : null;
}

function parsePrice(raw) {
  if (!raw) return 0;
  if (typeof raw === 'number') return Math.round(raw);
  return Math.round(parseFloat(String(raw).replace(/[^0-9.]/g, '')) || 0);
}

/**
 * Robust mileage parser for Australian Facebook Marketplace listings.
 *
 * Handles formats seen in the wild:
 *   123456          — raw integer from odometer_value field
 *   123,456 km      — comma-separated with unit
 *   123456km        — no space
 *   123456 kms      — plural
 *   123,456 kilometres / kilometers
 *   ~123,000 km     — approximate prefix
 *   123k km / 123k kms — shorthand thousands (rare but seen)
 *   "Odometer: 87,500" — label prefix with no unit (inferred)
 *   "87500 klms"    — alternate Aussie spelling
 *   "low km 45000"  — unit before number
 */
function parseMileage(raw) {
  if (raw === null || raw === undefined || raw === '') return null;

  // ── Direct numeric value (e.g. from vehicle_odometer_data.odometer_value) ──
  if (typeof raw === 'number') {
    // FB sometimes stores in raw metres or as 0; ignore clearly bad values
    if (raw > 0 && raw <= 1_500_000) return Math.round(raw);
    return null;
  }

  if (typeof raw !== 'string') return null;

  const text = raw.replace(/\u00a0/g, ' '); // Replace non-breaking spaces

  // ── Pattern 1: number followed by km variant (most common) ──────────────
  // Covers: 123,456 km | 123456km | 123,456 kilometres | 87500 klms
  let m = text.match(/~?(\d[\d,]*)\s*k(?:lm|m|ms|ilometres?|ilometers?)s?\b/i);
  if (m) {
    const val = parseFloat(m[1].replace(/,/g, ''));
    if (val >= 100 && val <= 1_500_000) return Math.round(val);
  }

  // ── Pattern 2: shorthand thousands — "123k km" or "123k kms" ─────────────
  m = text.match(/(\d+(?:\.\d+)?)\s*k\s+k(?:m|ms)\b/i);
  if (m) {
    const val = parseFloat(m[1]) * 1000;
    if (val >= 100 && val <= 1_500_000) return Math.round(val);
  }

  // ── Pattern 3: "Odometer: 87,500" — label with no unit ───────────────────
  m = text.match(/odometer[:\s]+(\d[\d,]+)/i);
  if (m) {
    const val = parseFloat(m[1].replace(/,/g, ''));
    if (val >= 100 && val <= 1_500_000) return Math.round(val);
  }

  // ── Pattern 4: "low km 45000" — unit before number ───────────────────────
  m = text.match(/\bkms?\s+(\d[\d,]+)/i);
  if (m) {
    const val = parseFloat(m[1].replace(/,/g, ''));
    if (val >= 100 && val <= 1_500_000) return Math.round(val);
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
  const nextMins = mins < 30 ? 30 - mins : 60 - mins;
  const withMileage = listings.filter(l => l.mileage != null).length;
  res.json({
    ok: true,
    lastScan: lastScanTime,
    lastScanNewListings: lastScanCount,
    nextScanInMins: nextMins,
    watches: watchlist.length,
    listingsStored: listings.length,
    listingsWithMileage: withMileage,
    mileageCoverage: listings.length ? Math.round((withMileage / listings.length) * 100) + '%' : '—',
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
