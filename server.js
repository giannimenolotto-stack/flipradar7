const express = require('express');
const crypto  = require('crypto');
const cors    = require('cors');
const axios   = require('axios');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const cron    = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const Stripe = require('stripe');
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Upstash Redis ─────────────────────────────────────────
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisGet(key) {
  if (!REDIS_URL) return null;
  try {
    const res = await axios.get(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
    if (!res.data.result) return null;
    let parsed = JSON.parse(res.data.result);
    // Handle legacy double-serialized values
    if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch(e) {} }
    return parsed;
  } catch (e) { console.error('[Redis] GET error:', e.message); return null; }
}

async function redisSet(key, value) {
  if (!REDIS_URL) return;
  try {
    await axios.post(
      `${REDIS_URL}/set/${encodeURIComponent(key)}`,
      JSON.stringify(value),
      { headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (e) { console.error('[Redis] SET error:', e.message); }
}

async function redisDel(key) {
  if (!REDIS_URL) return;
  try {
    await axios.delete(`${REDIS_URL}/del/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
  } catch (e) { console.error('[Redis] DEL error:', e.message); }
}

// Redis key helpers — everything scoped per-user or per-watch
const K = {
  user:        id  => `fr:user:${id}`,
  emailIdx:    em  => `fr:email:${em.toLowerCase()}`,
  userWatches: uid => `fr:user-watches:${uid}`,   // Set of watch IDs for a user
  watch:       id  => `fr:watch:${id}`,            // Individual watch object
  listings:    uid => `fr:listings:${uid}`,         // Per-user listings array
  seen:        uid => `fr:seen:${uid}`,             // Per-user seen map
};

// ── Auth ──────────────────────────────────────────────────
const JWT_SECRET    = process.env.AUTH_SECRET || 'flipradar-secret-change-me';
const RESEND_API_KEY = process.env.RESEND_API_KEY || null;

// ── Stripe ────────────────────────────────────────────────
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || null;
const PRICE_IDS = {
  basic_weekly:    'price_1Ta7LcPDjYUYNInHPy2AMqba',
  basic_monthly:   'price_1Ta7MLPDjYUYNInHYru4vO5M',
  basic_yearly:    'price_1Ta7MdPDjYUYNInHu5k5kiOU',
  premium_weekly:  'price_1Ta7PsPDjYUYNInHMvbMiWvV',
  premium_monthly: 'price_1Ta7QDPDjYUYNInHDQTp70Mt',
  premium_yearly:  'price_1Ta7QSPDjYUYNInHLG2F4aT3',
};
// Map price ID back to plan name
const PRICE_TO_PLAN = {};
Object.entries(PRICE_IDS).forEach(([key, priceId]) => {
  PRICE_TO_PLAN[priceId] = key.startsWith('basic') ? 'basic' : 'premium';
});
const PLAN_APPRAISAL_LIMITS = { free: 5, basic: 25, premium: Infinity };
const PLAN_WATCHLIST_LIMITS = { free: 0, basic: 1, premium: 2 };
const PLAN_SCAN_INTERVALS   = { free: null, basic: 30 * 60 * 1000, premium: 15 * 60 * 1000 };
const FROM_EMAIL     = process.env.FROM_EMAIL || 'FlipRadar <noreply@yourdomain.com>';
const INACTIVE_DAYS = 7;
const BCRYPT_ROUNDS = 10;

function makeToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '90d' });
}
function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET).sub; } catch { return null; }
}
function authMiddleware(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.replace('Bearer ', '').trim();
  const userId = verifyToken(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  req.userId = userId;
  next();
}

// ── User helpers ──────────────────────────────────────────
async function getUser(userId)  { return redisGet(K.user(userId)); }
async function saveUser(user)   { await redisSet(K.user(user.id), user); }
async function getUserByEmail(email) {
  const uid = await redisGet(K.emailIdx(email));
  if (!uid) return null;
  return getUser(uid);
}

// ── Per-user watch helpers ────────────────────────────────
async function getUserWatchIds(userId) {
  const ids = await redisGet(K.userWatches(userId));
  return Array.isArray(ids) ? ids : [];
}
async function addWatchId(userId, watchId) {
  const ids = await getUserWatchIds(userId);
  if (!ids.includes(watchId)) ids.push(watchId);
  await redisSet(K.userWatches(userId), ids);
}
async function removeWatchId(userId, watchId) {
  const ids = await getUserWatchIds(userId);
  await redisSet(K.userWatches(userId), ids.filter(id => id !== watchId));
}
async function getWatch(watchId)    { return redisGet(K.watch(watchId)); }
async function saveWatch(watch)     { await redisSet(K.watch(watch.id), watch); }
async function deleteWatch(watchId) { await redisDel(K.watch(watchId)); }
async function getUserWatches(userId) {
  const ids = await getUserWatchIds(userId);
  const watches = await Promise.all(ids.map(getWatch));
  return watches.filter(Boolean);
}

// ── Per-user listings helpers ─────────────────────────────
async function getUserListings(userId) {
  const l = await redisGet(K.listings(userId));
  return Array.isArray(l) ? l : [];
}
async function saveUserListings(userId, items) {
  await redisSet(K.listings(userId), items);
}
async function getUserSeen(userId) {
  const s = await redisGet(K.seen(userId));
  return (s && typeof s === 'object' && !Array.isArray(s)) ? s : {};
}
async function saveUserSeen(userId, seen) {
  const cutoff = Date.now() - SEEN_TTL_MS;
  const pruned = Object.fromEntries(
    Object.entries(seen)
      .filter(([, ts]) => ts > cutoff)
      .sort(([,a],[,b]) => b - a)
      .slice(0, 2000)
  );
  await redisSet(K.seen(userId), pruned);
}


// ── Email (Resend) ────────────────────────────────────────
async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) { console.log(`[Email] No RESEND_API_KEY — skipping email to ${to}`); return; }
  try {
    const res = await axios.post('https://api.resend.com/emails', {
      from: FROM_EMAIL,
      to,
      subject,
      html,
    }, {
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    console.log(`[Email] Sent "${subject}" to ${to}`);
    return res.data;
  } catch (e) {
    console.error(`[Email] Failed to send to ${to}:`, e.response?.data || e.message);
  }
}

function welcomeEmail(name, email) {
  return sendEmail(email, 'Welcome to FlipRadar 👀', `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#07070e;font-family:'Helvetica Neue',Arial,sans-serif">
  <div style="max-width:520px;margin:0 auto;padding:40px 24px">
    <!-- Logo -->
    <div style="font-size:32px;font-weight:900;letter-spacing:2px;color:#fff;margin-bottom:32px">
      Flip<span style="color:#00ff88">Radar</span>
    </div>

    <!-- Hero -->
    <div style="background:linear-gradient(135deg,rgba(0,255,136,.12),rgba(0,255,136,.04));border:1px solid rgba(0,255,136,.25);border-radius:20px;padding:32px;margin-bottom:24px">
      <div style="font-size:40px;margin-bottom:12px">👋</div>
      <h1 style="color:#fff;font-size:24px;font-weight:800;margin:0 0 8px">Hey ${name}, you're in!</h1>
      <p style="color:#888;font-size:15px;line-height:1.6;margin:0">
        FlipRadar is now scanning Facebook Marketplace for you. Add your first watchlist keyword and we'll notify you the moment something worth flipping shows up.
      </p>
    </div>

    <!-- Steps -->
    <div style="margin-bottom:24px">
      <div style="color:#555;font-size:11px;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:12px">Get started in 3 steps</div>
      ${[
        ['👁️', 'Add a watchlist', 'Type in what you\'re hunting — e.g. "ps5", "bmw e30", "vintage levis"'],
        ['📡', 'We scan for you', 'FlipRadar checks Marketplace every 30 minutes and sends you new listings instantly'],
        ['💸', 'Flip for profit', 'Use the Sell Scanner to appraise anything and generate a listing description'],
      ].map(([icon, title, desc]) => `
      <div style="display:flex;gap:14px;margin-bottom:16px">
        <div style="font-size:24px;flex-shrink:0;width:36px;text-align:center">${icon}</div>
        <div>
          <div style="color:#fff;font-weight:700;font-size:14px;margin-bottom:3px">${title}</div>
          <div style="color:#666;font-size:13px;line-height:1.5">${desc}</div>
        </div>
      </div>`).join('')}
    </div>

    <!-- CTA -->
    <div style="text-align:center;margin-bottom:32px">
      <a href="https://flip-radar.app" style="display:inline-block;background:#00ff88;color:#000;font-weight:800;font-size:16px;padding:16px 40px;border-radius:14px;text-decoration:none;letter-spacing:.5px">
        Open FlipRadar →
      </a>
    </div>

    <!-- Footer -->
    <div style="border-top:1px solid #1a1a2e;padding-top:20px;color:#444;font-size:12px;line-height:1.6">
      You're receiving this because you signed up at FlipRadar.<br>
      Questions? Just reply to this email.
    </div>
  </div>
</body>
</html>
`);
}

function verificationEmail(name, email, code) {
  return sendEmail(email, `${code} — Verify your FlipRadar email`, `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#07070e;font-family:'Helvetica Neue',Arial,sans-serif">
  <div style="max-width:520px;margin:0 auto;padding:40px 24px">
    <div style="font-size:32px;font-weight:900;letter-spacing:2px;color:#fff;margin-bottom:32px">
      Flip<span style="color:#00ff88">Radar</span>
    </div>

    <div style="background:#0d0d1a;border:1px solid #1a1a2e;border-radius:20px;padding:32px;margin-bottom:24px;text-align:center">
      <div style="font-size:40px;margin-bottom:16px">✉️</div>
      <h2 style="color:#fff;font-size:20px;font-weight:800;margin:0 0 8px">Verify your email</h2>
      <p style="color:#666;font-size:14px;margin:0 0 28px">Enter this code in the app to verify your email address. It expires in 15 minutes.</p>
      <div style="background:#00ff88;color:#000;font-size:36px;font-weight:900;letter-spacing:10px;border-radius:14px;padding:20px 24px;display:inline-block;font-family:'Courier New',monospace">
        ${code}
      </div>
    </div>

    <div style="color:#444;font-size:12px;text-align:center">
      If you didn't sign up for FlipRadar, you can safely ignore this email.
    </div>
  </div>
</body>
</html>
`);
}

// ── Scan intervals per plan ───────────────────────────────
const PLAN_INTERVALS = {
  free:    null,
  basic:   30 * 60 * 1000,
  premium: 15 * 60 * 1000,
};
const SEEN_TTL_MS = 48 * 60 * 60 * 1000;

// ── In-memory state (indexes only — source of truth is Redis) ──
// watchlist: array of watch objects loaded at boot, updated on mutations
// seenListings / listings: kept per-user in Redis; small in-memory cache for active scans
let watchlist = [];         // all watches across all users (for timer management)
let lastScanTime  = null;
let lastScanCount = 0;

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
  const days     = opts.initialScan ? 7 : 1;
  const maxItems = opts.initialScan ? 25 : 50;
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
      { urls: [fbUrl], maxItems, includeDetails: false },
      { params: { token: APIFY_TOKEN }, headers: { 'Content-Type': 'application/json' }, timeout: 180000 }
    );
    const items = Array.isArray(res.data) ? res.data.filter(i => !i.error) : [];
    console.log(`[Apify] "${keyword}" -> ${items.length} item(s)`);
    return items.map(item => {
      const id = item.id || item.listingId || String(item.marketplace_listing_id || '');
      const rawListedAt = item.creation_time || item.listed_at || item.listingCreationTime
        || item.listing_creation_time || item.created_time || item.date || null;
      const listedAt = rawListedAt
        ? (typeof rawListedAt === 'number'
            ? new Date(rawListedAt * 1000).toISOString()
            : new Date(rawListedAt).toISOString())
        : new Date().toISOString();
      const title       = item.marketplace_listing_title || item.title || keyword;
      const description = item.redacted_description?.text || item.description || null;
      const isVehicle   = isVehicleListing(keyword, title, description);
      return {
        id,
        title,
        price:       parsePrice(item.listing_price?.amount || item.listing_price?.formatted_amount || item.price),
        url:         item.listingUrl || item.url || `https://www.facebook.com/marketplace/item/${id}/`,
        image:       item.primary_listing_photo_url || item.primary_listing_photo?.image?.uri || null,
        location:    typeof item.location === 'string' ? item.location : (item.location?.reverse_geocode?.city || null),
        description,
        keyword,
        listedAt,
        foundAt:  new Date().toISOString(),
        // Vehicle fields — null for non-vehicle listings
        mileage:  isVehicle ? extractMileage(title, description) : null,
        year:     isVehicle ? extractYear(title, description)    : null,
        make:     isVehicle ? extractMake(keyword, title)        : null,
      };
    }).filter(l => l.id);
  } catch (e) {
    console.error(`[Apify] Error for "${keyword}":`, e.response ? JSON.stringify(e.response.data).slice(0,200) : e.message);
    return [];
  }
}

// ── Detail scrape for a single listing URL (vehicle mileage fallback) ──
async function scrapeListingDetail(listingUrl) {
  if (!APIFY_TOKEN) return null;
  try {
    const res = await axios.post(
      `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items`,
      { urls: [listingUrl], maxItems: 1, includeDetails: true },
      { params: { token: APIFY_TOKEN }, headers: { 'Content-Type': 'application/json' }, timeout: 120000 }
    );
    const items = Array.isArray(res.data) ? res.data.filter(i => !i.error) : [];
    if (!items.length) return null;
    const item = items[0];
    const desc = item.redacted_description?.text || item.description || null;
    const title = item.marketplace_listing_title || item.title || '';
    // Pull out vehicle fields from full detail response
    // The detail page exposes vehicle_info or similar structured fields
    const vehicleInfo = item.vehicle_info || item.vehicleInfo || item.listing_vehicle_data || {};
    const mileageRaw = vehicleInfo.odometer || vehicleInfo.mileage || vehicleInfo.kilometers
      || item.odometer || item.mileage || null;
    const mileage = mileageRaw
      ? (typeof mileageRaw === 'number' ? mileageRaw : parsePrice(String(mileageRaw)))
      : extractMileage(title, desc);
    const year = vehicleInfo.year || vehicleInfo.model_year || extractYear(title, desc);
    const make = vehicleInfo.make || vehicleInfo.brand || extractMake('', title);
    const model = vehicleInfo.model || null;
    console.log(`[DetailScrape] ${listingUrl} → mileage:${mileage} year:${year} make:${make}`);
    return { mileage, year, make, model };
  } catch (e) {
    console.error('[DetailScrape] Error:', e.message);
    return null;
  }
}


// ── Vehicle data extraction ───────────────────────────────
const VEHICLE_KEYWORDS = ['car','ute','van','truck','bike','motorcycle','suv','4wd','wagon',
  'sedan','hatch','coupe','convertible','tractor','forklift','boat','jet ski','caravan',
  'camper','trailer','scooter','moped','excavator','loader','hilux','landcruiser','patrol',
  'ranger','triton','navara','colorado','dmax','bt50','pajero','prado','defender','discovery',
  'transit','sprinter','vito','ducato','daily','commodore','falcon','camry','corolla',
  'civic','accord','mazda','subaru','toyota','ford','holden','honda','nissan','mitsubishi',
  'hyundai','kia','bmw','mercedes','audi','volkswagen','vw','jeep','ram','dodge'];

function isVehicleListing(keyword, title, description) {
  const text = (keyword + ' ' + title + ' ' + (description || '')).toLowerCase();
  return VEHICLE_KEYWORDS.some(kw => text.includes(kw));
}

function extractMileage(title, description) {
  const text = (title + ' ' + (description || '')).toLowerCase();
  // Each entry: [pattern, multiplyBy1000]
  const patterns = [
    [/(\d{1,3}(?:,\d{3})+)\s*k(?:m|ms|ilometres?|ilometers?)/, false],
    [/(\d{2,6})\s*k(?:m|ms|ilometres?|ilometers?)/, false],
    [/(\d{1,4})\s*k\s*k(?:m|ms|ilometres?|ilometers?|s)/, true],
    [/(\d{1,4})\s*k(?=\s|$)/, true],
  ];
  for (const [pattern, multiply] of patterns) {
    const m = text.match(pattern);
    if (m) {
      let val = parseInt(m[1].replace(/,/g, ''));
      if (multiply) val *= 1000;
      if (val > 0 && val < 1000000) return val;
    }
  }
  return null;
}
function extractYear(title, description) {
  const text = title + ' ' + (description || '');
  // Match 4-digit years between 1970 and next year
  const nextYear = new Date().getFullYear() + 1;
  const m = text.match(/(19[7-9]\d|20[0-2]\d)/);
  if (m) {
    const yr = parseInt(m[1]);
    if (yr >= 1970 && yr <= nextYear) return yr;
  }
  return null;
}

function extractMake(keyword, title) {
  const MAKES = ['toyota','ford','holden','honda','nissan','mitsubishi','mazda','subaru',
    'hyundai','kia','bmw','mercedes','audi','volkswagen','vw','jeep','ram','dodge',
    'isuzu','ldv','great wall','gwm','chery','mg','skoda','volvo','peugeot','renault',
    'citroen','fiat','alfa','land rover','range rover','lexus','infiniti','acura',
    'cadillac','chevrolet','buick','pontiac','chrysler','suzuki','daihatsu','ssangyong'];
  const text = (keyword + ' ' + title).toLowerCase();
  for (const make of MAKES) {
    if (text.includes(make)) return make.charAt(0).toUpperCase() + make.slice(1);
  }
  return null;
}

function parsePrice(raw) {
  if (!raw) return 0;
  if (typeof raw === 'number') return Math.round(raw);
  return Math.round(parseFloat(String(raw).replace(/[^0-9.]/g, '')) || 0);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Per-watch scan ────────────────────────────────────────
async function scanWatchItem(watcher, opts = {}) {
  const keyword = watcher.keyword.toLowerCase();
  const raw = await scrapeKeyword(keyword, {
    city: watcher.location, lat: watcher.lat, lng: watcher.lng,
    radius: watcher.radius, initialScan: opts.initialScan || false
  });

  const userId  = watcher.userId;
  const seen    = await getUserSeen(userId);
  const userListings = await getUserListings(userId);
  let newCount  = 0;

  for (const listing of raw) {
    const key = `${keyword}:${listing.id}`;
    // Check seen
    const seenTs = seen[key];
    if (seenTs && (Date.now() - seenTs) < SEEN_TTL_MS) continue;
    // Price filter
    if (watcher.maxPrice && listing.price > watcher.maxPrice) continue;
    if (watcher.minPrice && listing.price < watcher.minPrice) continue;
    seen[key] = Date.now();
    if (!userListings.find(l => l.id === listing.id)) {
      userListings.unshift(listing);
      userListings.sort((a, b) => new Date(b.listedAt || b.foundAt) - new Date(a.listedAt || a.foundAt));
      if (userListings.length > 500) userListings.length = 500;
    }
    newCount++;
    const pToken = watcher.pushoverToken || process.env.PUSHOVER_TOKEN;
    const pUser  = watcher.pushoverUser  || process.env.PUSHOVER_USER;
    const priceStr = listing.price ? `$${listing.price}` : 'Price unknown';
    await sendPushover(pToken, pUser, `FlipRadar: ${keyword}`, `${listing.title}\n${priceStr}`, listing.url);
    await sleep(300);
  }

  if (newCount > 0) {
    await saveUserListings(userId, userListings);
    await saveUserSeen(userId, seen);
  }

  // ── Vehicle detail fallback — fire for vehicle listings missing mileage ──
  const needsDetail = userListings.filter(l =>
    l.keyword === keyword &&
    isVehicleListing(keyword, l.title, l.description) &&
    l.mileage === null &&
    l.url &&
    // Only retry listings found in this scan (within last 2 mins)
    (Date.now() - new Date(l.foundAt).getTime()) < 2 * 60 * 1000
  );
  if (needsDetail.length > 0) {
    console.log(`[DetailScrape] Fetching details for ${needsDetail.length} vehicle listing(s) without mileage`);
    // Run up to 5 detail scrapes in parallel to keep it snappy
    const chunks = [];
    for (let i = 0; i < needsDetail.length; i += 5) chunks.push(needsDetail.slice(i, i + 5));
    let detailUpdated = false;
    for (const chunk of chunks) {
      const results = await Promise.all(chunk.map(l => scrapeListingDetail(l.url)));
      results.forEach((detail, idx) => {
        if (!detail) return;
        const listing = chunk[idx];
        const idx2 = userListings.findIndex(l => l.id === listing.id);
        if (idx2 === -1) return;
        if (detail.mileage) { userListings[idx2].mileage = detail.mileage; detailUpdated = true; }
        if (detail.year)    { userListings[idx2].year    = detail.year;    detailUpdated = true; }
        if (detail.make)    { userListings[idx2].make    = detail.make;    detailUpdated = true; }
        if (detail.model)   { userListings[idx2].model   = detail.model;   detailUpdated = true; }
      });
      await sleep(500);
    }
    if (detailUpdated) {
      await saveUserListings(userId, userListings);
      console.log(`[DetailScrape] Updated ${needsDetail.length} listing(s) with vehicle details`);
    }
  }

  // Update lastScanned on the watch
  watcher.lastScanned = new Date().toISOString();
  await saveWatch(watcher);

  console.log(`[Scan] "${keyword}" (${watcher.plan||'basic'}) → ${newCount} new`);
  return newCount;
}

// ── Per-watch timers ──────────────────────────────────────
const watchTimers = {};

function startWatchTimer(watcher) {
  if (watchTimers[watcher.id]) clearInterval(watchTimers[watcher.id]);
  const interval = PLAN_INTERVALS[watcher.plan] || PLAN_INTERVALS.basic;
  console.log(`[Timer] "${watcher.keyword}" every ${interval/60000}m (${watcher.plan||'basic'})`);
  watchTimers[watcher.id] = setInterval(() => {
    scanWatchItem(watcher).catch(e => console.error(`[Timer] Error for "${watcher.keyword}":`, e.message));
  }, interval);
}

function stopWatchTimer(watchId) {
  if (watchTimers[watchId]) { clearInterval(watchTimers[watchId]); delete watchTimers[watchId]; }
}

// ── Auto-pause inactive users ─────────────────────────────
async function pauseInactiveUsers() {
  const CUTOFF = Date.now() - INACTIVE_DAYS * 24 * 60 * 60 * 1000;
  let paused = 0;
  for (const w of watchlist) {
    if (w.paused) continue;
    const user = await getUser(w.userId);
    if (!user || !user.lastSeen) continue;
    if (new Date(user.lastSeen).getTime() < CUTOFF) {
      w.paused = true;
      stopWatchTimer(w.id);
      await saveWatch(w);
      paused++;
      console.log(`[AutoPause] "${w.keyword}" (user ${w.userId}) paused — inactive 7+ days`);
    }
  }
  console.log(`[AutoPause] Done — ${paused} watch(es) paused`);
}
cron.schedule('0 3 * * *', () => pauseInactiveUsers().catch(e => console.error('[AutoPause]', e.message)));

// ── Boot: load all watches from Redis into memory ─────────
async function loadAllWatches() {
  // We store a global index of all watch IDs for timer management at boot
  const allIds = await redisGet('fr:all-watch-ids') || [];
  const watches = await Promise.all(allIds.map(getWatch));
  watchlist = watches.filter(Boolean);
  console.log(`[Boot] Loaded ${watchlist.length} watch(es)`);
  watchlist.forEach(w => { if (!w.paused) startWatchTimer(w); });
}

async function addToGlobalWatchIndex(watchId) {
  const ids = await redisGet('fr:all-watch-ids') || [];
  if (!ids.includes(watchId)) ids.push(watchId);
  await redisSet('fr:all-watch-ids', ids);
}
async function removeFromGlobalWatchIndex(watchId) {
  const ids = await redisGet('fr:all-watch-ids') || [];
  await redisSet('fr:all-watch-ids', ids.filter(id => id !== watchId));
}

// Keep Render awake
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
if (SELF_URL) {
  setInterval(() => axios.get(SELF_URL + '/').catch(() => {}), 14 * 60 * 1000);
}

// ── Routes ────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status: 'ok',
  apify:  APIFY_TOKEN ? 'connected' : 'NO APIFY_TOKEN SET',
  redis:  REDIS_URL   ? 'connected' : 'not set',
  watches: watchlist.length,
  timers:  Object.keys(watchTimers).length,
  lastScan: lastScanTime,
  lastScanNewListings: lastScanCount,
}));

// ── Auth routes ───────────────────────────────────────────
app.post('/auth/signup', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const existing = await getUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'An account already exists for this email' });
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    // Generate 6-digit verification code
    const verifyCode = String(Math.floor(100000 + Math.random() * 900000));
    const user = {
      id: uuidv4(),
      email: email.toLowerCase().trim(),
      name:  (name || email.split('@')[0]).trim(),
      passwordHash,
      createdAt:     new Date().toISOString(),
      lastSeen:      new Date().toISOString(),
      plan:          'basic',
      emailVerified: false,
      verifyCode,
      verifyExpiry:  new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 mins
    };
    await saveUser(user);
    await redisSet(K.emailIdx(user.email), user.id);
    const token = makeToken(user.id);
    console.log(`[Auth] Signup: ${user.email}`);
    // Send verification email only — welcome email fires after they verify
    verificationEmail(user.name, user.email, verifyCode).catch(e => console.error('[Email] Verify failed:', e.message));
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, plan: user.plan, emailVerified: false } });
  } catch (e) { console.error('[Signup]', e.message); res.status(500).json({ error: 'Server error' }); }
});

app.post('/auth/verify-email', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Verification code required' });
    const user = await getUser(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.emailVerified) return res.json({ ok: true, alreadyVerified: true });
    console.log('[Verify] user.verifyCode:', user.verifyCode, 'submitted:', String(code).trim(), 'expiry:', user.verifyExpiry);
    if (!user.verifyCode || user.verifyCode !== String(code).trim())
      return res.status(400).json({ error: 'Incorrect code. Please check your email and try again.' });
    if (new Date(user.verifyExpiry) < new Date())
      return res.status(400).json({ error: 'Code expired. Request a new one.' });
    user.emailVerified = true;
    delete user.verifyCode;
    delete user.verifyExpiry;
    await saveUser(user);
    console.log(`[Auth] Email verified: ${user.email}`);
    // Send welcome email now that they've verified
    welcomeEmail(user.name, user.email).catch(e => console.error('[Email] Welcome failed:', e.message));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/auth/resend-verify', authMiddleware, async (req, res) => {
  try {
    const user = await getUser(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.emailVerified) return res.json({ ok: true, alreadyVerified: true });
    const verifyCode = String(Math.floor(100000 + Math.random() * 900000));
    user.verifyCode   = verifyCode;
    user.verifyExpiry = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await saveUser(user);
    verificationEmail(user.name, user.email, verifyCode).catch(e => console.error('[Email] Resend verify failed:', e.message));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = await getUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(401).json({ error: 'Invalid email or password' });
    user.lastSeen = new Date().toISOString();
    await saveUser(user);
    const token = makeToken(user.id);
    console.log(`[Auth] Login: ${user.email}`);
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, plan: user.plan } });
  } catch (e) { console.error('[Login]', e.message); res.status(500).json({ error: 'Server error' }); }
});

app.post('/auth/ping', authMiddleware, async (req, res) => {
  try {
    const user = await getUser(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.lastSeen = new Date().toISOString();
    await saveUser(user);
    // Resume any paused watches for this user
    let resumed = 0;
    const userWatches = watchlist.filter(w => w.userId === req.userId && w.paused);
    for (const w of userWatches) {
      w.paused = false;
      await saveWatch(w);
      startWatchTimer(w);
      resumed++;
    }
    if (resumed > 0) console.log(`[Ping] Resumed ${resumed} watch(es) for ${user.email}`);
    res.json({ ok: true, lastSeen: user.lastSeen, resumed });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await getUser(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ id: user.id, email: user.email, name: user.name, plan: user.plan, lastSeen: user.lastSeen });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Watchlist routes ──────────────────────────────────────
app.get('/watchlist', authMiddleware, async (req, res) => {
  try {
    const watches = await getUserWatches(req.userId);
    res.json(watches);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/watchlist', authMiddleware, async (req, res) => {
  try {
    const { keyword, maxPrice, minPrice, pushoverToken, pushoverUser, plan, name, speed } = req.body;
    if (!keyword || keyword.trim().length < 2)
      return res.status(400).json({ error: 'Keyword required' });
    // Enforce watchlist limit per plan
    const user = await getUser(req.userId);
    const planLimit = PLAN_WATCHLIST_LIMITS[user?.plan || 'free'];
    const existingWatches = await getUserWatches(req.userId);
    if (existingWatches.length >= planLimit)
      return res.status(403).json({ error: 'Watchlist limit reached for your plan', plan: user?.plan, limit: planLimit });
    const watchPlan = plan || (speed === 'premium' ? 'premium' : 'basic');
    const item = {
      id: uuidv4(),
      userId:   req.userId,
      keyword:  keyword.trim().toLowerCase(),
      name:     name || keyword.trim(),
      maxPrice: maxPrice ? parseInt(maxPrice) : null,
      minPrice: minPrice ? parseInt(minPrice) : null,
      location: req.body.location || null,
      lat:      req.body.lat    ? parseFloat(req.body.lat)  : null,
      lng:      req.body.lng    ? parseFloat(req.body.lng)  : null,
      radius:   req.body.radius ? parseInt(req.body.radius) : 50,
      plan:     watchPlan,
      pushoverToken: pushoverToken || null,
      pushoverUser:  pushoverUser  || null,
      paused:    false,
      addedAt:   new Date().toISOString(),
      lastScanned: null,
    };
    await saveWatch(item);
    await addWatchId(req.userId, item.id);
    await addToGlobalWatchIndex(item.id);
    watchlist.push(item);
    startWatchTimer(item);
    console.log(`[Watch] Added "${item.keyword}" for user ${req.userId}`);
    res.json(item);
    // Background initial backfill
    scanWatchItem(item, { initialScan: true })
      .then(n => console.log(`[InitialScan] "${item.keyword}" → ${n} listing(s)`))
      .catch(e => console.error(`[InitialScan] Error:`, e.message));
  } catch (e) { console.error('[AddWatch]', e.message); res.status(500).json({ error: 'Server error' }); }
});

app.delete('/watchlist/:id', authMiddleware, async (req, res) => {
  try {
    const watch = await getWatch(req.params.id);
    if (!watch || watch.userId !== req.userId)
      return res.status(404).json({ error: 'Not found' });
    stopWatchTimer(req.params.id);
    await deleteWatch(req.params.id);
    await removeWatchId(req.userId, req.params.id);
    await removeFromGlobalWatchIndex(req.params.id);
    watchlist = watchlist.filter(w => w.id !== req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Listings routes ───────────────────────────────────────
app.get('/listings', authMiddleware, async (req, res) => {
  try {
    const { keyword, since } = req.query;
    let result = await getUserListings(req.userId);
    if (keyword) result = result.filter(l => l.keyword === keyword);
    if (since) {
      const sinceMs = new Date(since).getTime();
      if (!isNaN(sinceMs)) result = result.filter(l => new Date(l.foundAt).getTime() > sinceMs);
    }
    result = [...result].sort((a, b) => new Date(b.listedAt || b.foundAt) - new Date(a.listedAt || a.foundAt));
    res.json(result);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/listings', authMiddleware, async (req, res) => {
  try {
    await saveUserListings(req.userId, []);
    await saveUserSeen(req.userId, {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Misc routes ───────────────────────────────────────────
app.get('/proxy-image', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer', timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
        'Referer': 'https://www.facebook.com/'
      }
    });
    res.json({
      base64: Buffer.from(response.data).toString('base64'),
      mediaType: response.headers['content-type'] || 'image/jpeg'
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/scan/now', authMiddleware, async (req, res) => {
  res.json({ ok: true, message: 'Scan started' });
  const watches = watchlist.filter(w => w.userId === req.userId && !w.paused);
  for (const w of watches) {
    await scanWatchItem(w).catch(e => console.error(`[Scan/now]`, e.message));
    await sleep(500);
  }
});

app.post('/scan/test', async (req, res) => {
  const { keyword } = req.body;
  if (!keyword) return res.status(400).json({ error: 'keyword required' });
  try {
    const found = await scrapeKeyword(keyword, {});
    res.json({ keyword, count: found.length, listings: found });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── Stripe routes ─────────────────────────────────────────
app.post('/stripe/create-checkout', authMiddleware, async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
    const { priceId } = req.body;
    if (!priceId || !Object.values(PRICE_IDS).includes(priceId))
      return res.status(400).json({ error: 'Invalid price' });
    const user = await getUser(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: 'https://flip-radar.app?upgraded=1',
      cancel_url:  'https://flip-radar.app?cancelled=1',
      customer_email: user.email,
      metadata: { userId: user.id, priceId },
      subscription_data: { metadata: { userId: user.id, priceId } },
    });
    res.json({ url: session.url });
  } catch (e) { console.error('[Stripe] Checkout error:', e.message); res.status(500).json({ error: e.message }); }
});

app.post('/stripe/portal', authMiddleware, async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
    const user = await getUser(req.userId);
    if (!user || !user.stripeCustomerId) return res.status(400).json({ error: 'No subscription found' });
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: 'https://flip-radar.app',
    });
    res.json({ url: session.url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stripe webhook — must use raw body
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.json({ ok: true });
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (e) { console.error('[Stripe] Webhook sig failed:', e.message); return res.status(400).send('Webhook Error'); }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = session.metadata?.userId;
      const priceId = session.metadata?.priceId;
      if (userId && priceId) {
        const user = await getUser(userId);
        if (user) {
          user.plan = PRICE_TO_PLAN[priceId] || 'basic';
          user.stripeCustomerId = session.customer;
          user.stripeSubscriptionId = session.subscription;
          await saveUser(user);
          console.log(`[Stripe] Upgraded ${user.email} to ${user.plan}`);
        }
      }
    }
    if (event.type === 'customer.subscription.deleted' || event.type === 'customer.subscription.paused') {
      const sub = event.data.object;
      const userId = sub.metadata?.userId;
      if (userId) {
        const user = await getUser(userId);
        if (user) {
          user.plan = 'free';
          user.stripeSubscriptionId = null;
          await saveUser(user);
          console.log(`[Stripe] Downgraded ${user.email} to free`);
        }
      }
    }
  } catch (e) { console.error('[Stripe] Webhook handler error:', e.message); }
  res.json({ received: true });
});

app.get('/auth/plan', authMiddleware, async (req, res) => {
  try {
    const user = await getUser(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const appraisalsToday = user.appraisalsToday || 0;
    const appraisalDate = user.appraisalDate || '';
    const today = new Date().toISOString().slice(0, 10);
    const appraised = appraisalDate === today ? appraisalsToday : 0;
    const limit = PLAN_APPRAISAL_LIMITS[user.plan || 'free'];
    res.json({
      plan: user.plan || 'free',
      appraisalsUsedToday: appraised,
      appraisalsLimit: limit === Infinity ? -1 : limit,
      watchlistLimit: PLAN_WATCHLIST_LIMITS[user.plan || 'free'],
    });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/auth/appraisal', authMiddleware, async (req, res) => {
  try {
    const user = await getUser(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const today = new Date().toISOString().slice(0, 10);
    if (user.appraisalDate !== today) { user.appraisalsToday = 0; user.appraisalDate = today; }
    const limit = PLAN_APPRAISAL_LIMITS[user.plan || 'free'];
    if (limit !== Infinity && user.appraisalsToday >= limit)
      return res.status(429).json({ error: 'Daily appraisal limit reached', limit, plan: user.plan });
    user.appraisalsToday = (user.appraisalsToday || 0) + 1;
    await saveUser(user);
    res.json({ ok: true, used: user.appraisalsToday, limit: limit === Infinity ? -1 : limit });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`FlipRadar backend on port ${PORT}`);
  console.log(`Apify:  ${APIFY_TOKEN ? 'set' : 'NO TOKEN'}`);
  console.log(`Redis:  ${REDIS_URL   ? 'connected' : 'NOT SET'}`);
  await loadAllWatches();
  console.log('[Ready] Server fully loaded');
});
