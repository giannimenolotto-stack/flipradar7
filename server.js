const express  = require('express');
const webpush  = require('web-push');
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
    if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch(e) {} }
    return parsed;
  } catch (e) { console.error('[Redis] GET error:', e.message); return null; }
}

async function redisSet(key, value, ttlSeconds = null) {
  if (!REDIS_URL) return;
  try {
    const qs = ttlSeconds ? `?ex=${ttlSeconds}` : '';
    await axios.post(
      `${REDIS_URL}/set/${encodeURIComponent(key)}${qs}`,
      JSON.stringify(value),
      { headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (e) { console.error('[Redis] SET error:', e.message); }
}

async function redisDel(key) {
  if (!REDIS_URL) return;
  try {
    await axios.post(`${REDIS_URL}/del/${encodeURIComponent(key)}`, null, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
    });
  } catch (e) { console.error('[Redis] DEL error:', e.message); }
}

// Redis key helpers
const K = {
  user:        id  => `fr:user:${id}`,
  emailIdx:    em  => `fr:email:${em.toLowerCase()}`,
  userWatches: uid => `fr:user-watches:${uid}`,
  watch:       id  => `fr:watch:${id}`,
  listings:    uid => `fr:listings:${uid}`,
  seen:        uid => `fr:seen:${uid}`,
  prices:      kw  => `fr:prices:${kw.toLowerCase().trim()}`,
  sharedScan:  kw  => `fr:scan:${kw.toLowerCase().trim()}`,  // shared scan cache across all users
  enrich:      id  => `fr:enrich:${id}`,                     // slim enrichment data per listing (7-day TTL)
  blocked:     uid => `fr:blocked:${uid}`,
  vpx:   (make, model, year) => `fr:vpx:${make}:${model}:${year}`,
  csales:(make, model, year) => `fr:csales:${make}:${model}:${year}`, // carsales market cache
  agrab: (make, model, year) => `fr:agrab:${make}:${model}:${year}`,  // autograb/redbook cache
};

// ── Auth ──────────────────────────────────────────────────
const JWT_SECRET     = process.env.AUTH_SECRET || 'flipradar-secret-change-me';
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
const PRICE_TO_PLAN = {};
Object.entries(PRICE_IDS).forEach(([key, priceId]) => {
  PRICE_TO_PLAN[priceId] = key.startsWith('basic') ? 'basic' : 'premium';
});
const PLAN_APPRAISAL_LIMITS = { free: 999, basic: 999, premium: 999 }; // TEMP — reset before launch
const PLAN_WATCHLIST_LIMITS = { free: 5, basic: 5, premium: 5 }; // TEMP — reset before launch
const FROM_EMAIL    = process.env.FROM_EMAIL || 'FlipRadar <noreply@yourdomain.com>';
const INACTIVE_DAYS = 7;
const BCRYPT_ROUNDS = 10;

const OWN_PRICE_MIN       = 10;                    // need 10 of our own records to skip AI
const VPX_REF_KM          = 100000;               // mileage reference for price normalization
const VPX_MIN_SAMPLES     = 5;                    // samples needed to use VPX instead of AI
const VPX_SAMPLE_CAP      = 500;                  // max samples stored per vehicle cohort
const VPX_TTL_SECS        = null;                 // permanent — hard-won scraped data must not expire
const SEEN_TTL_MS         = 48 * 60 * 60 * 1000;
const SEEN_MAX_ENTRIES    = 5000;
const CSALES_TTL_SECS     = 48 * 3600;            // 48 h carsales market cache
const AGRAB_TTL_SECS      = 30 * 24 * 3600;       // 30 day autograb/redbook cache
const CARSALES_BIAS       = 0.92;                  // asking-price → cleared-price correction (~8%)
const AUTOGRAB_API_KEY    = process.env.AUTOGRAB_API_KEY  || null;
const AUTOGRAB_BASE_URL   = process.env.AUTOGRAB_BASE_URL || 'https://api.autograb.com.au/v1';
const CARSALES_APIFY_ACTOR = process.env.CARSALES_APIFY_ACTOR || 'zuzka_k~carsales-scraper';

// Top AU vehicle models to seed on first deploy (make, model, year range)
const TOP_AU_SEED_MODELS = [
  ...['2019','2020','2021','2022'].flatMap(y => [
    {make:'Toyota',model:'Camry',year:parseInt(y)},
    {make:'Toyota',model:'Hilux',year:parseInt(y)},
    {make:'Toyota',model:'RAV4',year:parseInt(y)},
    {make:'Toyota',model:'LandCruiser Prado',year:parseInt(y)},
    {make:'Mazda',model:'CX-5',year:parseInt(y)},
    {make:'Ford',model:'Ranger',year:parseInt(y)},
    {make:'Hyundai',model:'Tucson',year:parseInt(y)},
    {make:'Mitsubishi',model:'Triton',year:parseInt(y)},
    {make:'Isuzu',model:'D-MAX',year:parseInt(y)},
    {make:'Subaru',model:'Forester',year:parseInt(y)},
  ]),
];

// ── Owner account — always premium, no payment required ──
const OWNER_EMAIL = 'giannimenolotto@gmail.com';
let ownerUserId = null; // resolved at boot
function isOwner(userOrWatcher) {
  if (!userOrWatcher) return false;
  if (userOrWatcher.email && userOrWatcher.email.toLowerCase() === OWNER_EMAIL) return true;
  if (ownerUserId && userOrWatcher.userId === ownerUserId) return true;
  return false;
}
// Use this everywhere instead of user.plan — owner always gets premium
function getEffectivePlan(userOrWatcher) {
  if (isOwner(userOrWatcher)) return 'premium';
  return userOrWatcher?.plan || 'free';
}


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

// ── In-memory user cache — avoids Redis round-trip on rapid appraisal bursts ──
const _userCache = new Map();
const USER_CACHE_TTL_MS = 8000;
function _getUserCached(userId) {
  const hit = _userCache.get(userId);
  if (hit && (Date.now() - hit.ts) < USER_CACHE_TTL_MS) return Promise.resolve(JSON.parse(JSON.stringify(hit.data)));
  return getUser(userId).then(u => {
    if (u) _userCache.set(userId, { data: JSON.parse(JSON.stringify(u)), ts: Date.now() });
    return u;
  });
}
function _invalidateUserCache(userId) { _userCache.delete(userId); }

async function consumeAppraisal(userId) {
  const user = await _getUserCached(userId);
  if (!user) return { ok: false, status: 404, error: 'User not found' };
  const today = new Date().toISOString().slice(0, 10);
  if (user.appraisalDate !== today) { user.appraisalsToday = 0; user.appraisalDate = today; }
  const limit = PLAN_APPRAISAL_LIMITS[getEffectivePlan(user)];
  if (limit !== Infinity && limit < 999 && user.appraisalsToday >= limit)
    return { ok: false, status: 429, error: 'Daily appraisal limit reached', limit, plan: getEffectivePlan(user) };
  user.appraisalsToday = (user.appraisalsToday || 0) + 1;
  await saveUser(user);
  _invalidateUserCache(userId);
  return { ok: true, user, used: user.appraisalsToday, limit: limit === Infinity ? -1 : limit };
}
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
// merge=true (default): re-reads current Redis state and merges before writing.
// This prevents concurrent keyword-scan calls from overwriting each other's entries —
// each setInterval fires independently, so two keywords for the same user can race.
// merge=false: replace entirely (used when clearing seen entries for a keyword).
async function saveUserSeen(userId, seen, { merge = true } = {}) {
  const cutoff = Date.now() - SEEN_TTL_MS;
  let base = seen;
  if (merge) {
    const current = await getUserSeen(userId);
    // Local entries win — they carry the freshest timestamps
    base = { ...current, ...seen };
  }
  const pruned = Object.fromEntries(
    Object.entries(base)
      .filter(([, ts]) => ts > cutoff)
      .sort(([, a], [, b]) => b - a)
      .slice(0, SEEN_MAX_ENTRIES)
  );
  await redisSet(K.seen(userId), pruned);
}

// ── Our own scan price history ────────────────────────────
// Every time we see a listing for a keyword, store its price
async function storeScanPrice(keyword, listing) {
  if (!listing.price || listing.price <= 0) return;
  if (listing.isOfferPrice) return; // placeholder prices pollute keyword price history
  // Patch B: only store price history for specific enough keywords.
  // Single generic words (bmw, ford, iphone, car) produce meaningless mixed medians.
  // Require either: 2+ words, OR a make+model is detected on the listing.
  const kwWords = keyword.trim().split(/\s+/).filter(Boolean);
  const isSpecific = kwWords.length >= 2 || !!(listing.make && listing.model);
  if (!isSpecific) {
    // Still feed VPX for vehicles with full make/model — just skip the broad keyword bucket
    if (listing.make && listing.year) {
      storeVehiclePrice(listing).catch(e => console.error('[VPX] passive write error:', e.message));
    }
    return;
  }
  // Patch C: don't store broken/project vehicle prices — they pollute medians
  if (listing.isBrokenOrProject) return;
  try {
    const existing = await redisGet(K.prices(keyword)) || [];
    if (!existing.find(r => r.id === listing.id)) {
      existing.unshift({ id: listing.id, price: listing.price, title: listing.title, date: new Date().toISOString() });
      await redisSet(K.prices(keyword), existing.slice(0, 200));
    }
  } catch (e) {
    console.error(`[PriceStore] Error for "${keyword}":`, e.message);
  }
  // Also feed the vehicle price index when structured vehicle data is present
  if (listing.make && listing.year) {
    storeVehiclePrice(listing).catch(e => console.error('[VPX] passive write error:', e.message));
  }
}

async function getOwnPriceRange(keyword) {
  const records = await redisGet(K.prices(keyword)) || [];
  if (records.length < OWN_PRICE_MIN) return null;
  const prices = records.map(r => r.price).filter(Boolean).sort((a, b) => a - b);
  return {
    prices,
    low:    prices[0],
    high:   prices[prices.length - 1],
    median: prices[Math.floor(prices.length / 2)],
    avg:    Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
    count:  prices.length,
    source: 'own_history',
  };
}

// ── Vehicle Price Index (VPX) ─────────────────────────────
// fr:vpx:<make>:<model>:<year> — mileage-normalised price samples per vehicle cohort.
// Populated passively from every FB listing; seeded by Carsales scrapes.
const _vpxCache = new Map();
const VPX_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min hot-cache — avoids Redis on every appraisal

async function storeVehiclePrice(listing) {
  let { make, model, year, mileage, price, id, location } = listing;
  if (!make || !year || !price || price <= 0) return;
  if (isOfferPrice(price)) return;
  // Patch F: don't index broken/project vehicles — their prices are not market comps
  if (listing.isBrokenOrProject) return;
  // Sanity-check price range for AU vehicles ($500–$500k)
  if (price > 500000) return;
  // Always coerce location to a string here — Apify can return objects
  if (location !== null && location !== undefined && typeof location !== 'string') {
    location = location.state || location.city || location.name || '';
  }

  // Fall back to extractModel if Apify didn't provide model
  if (!model) model = extractModel(make, listing.title || '');
  if (!model) return; // without model we can't build a meaningful cohort key

  const makeKey  = make.toLowerCase().trim();
  const modelKey = model.toLowerCase().trim().replace(/\s+/g, '-');
  const key      = K.vpx(makeKey, modelKey, year);

  try {
    const existing = await redisGet(key) || { samples: [] };
    if (existing.samples.find(s => s.id === id)) return; // already stored

    const normPrice = normalizePriceToRefKm(price, mileage, makeKey, modelKey);
    existing.samples.unshift({
      id,
      price,
      mileage:    mileage || null,
      normPrice,
      date:       new Date().toISOString(),
      state:      extractState(location),
      source:     'fb',
    });
    existing.samples = existing.samples.slice(0, VPX_SAMPLE_CAP);

    // Recompute stats from normalised prices
    const norm = existing.samples.map(s => s.normPrice).filter(p => p && p > 0).sort((a, b) => a - b);
    if (norm.length >= 3) {
      existing.stats = {
        count:          norm.length,
        medianAt100k:   norm[Math.floor(norm.length / 2)],
        p25At100k:      norm[Math.floor(norm.length * 0.25)],
        p75At100k:      norm[Math.floor(norm.length * 0.75)],
        lowAt100k:      norm[0],
        highAt100k:     norm[norm.length - 1],
        updatedAt:      new Date().toISOString(),
      };
    }

    await redisSet(key, existing, VPX_TTL_SECS);
    _vpxCache.delete(key); // invalidate hot-cache on write
  } catch (e) {
    console.error(`[VPX] storeVehiclePrice error ${make} ${model} ${year}:`, e.message);
  }
}

async function getVehiclePriceStats(make, model, year, mileage) {
  if (!make || !model || !year) return null;
  const makeKey  = make.toLowerCase().trim();
  const modelKey = model.toLowerCase().trim().replace(/\s+/g, '-');
  const key      = K.vpx(makeKey, modelKey, year);

  // Hot-cache first
  const hit = _vpxCache.get(key);
  if (hit && (Date.now() - hit.ts) < VPX_CACHE_TTL_MS) return hit.data;

  const doc = await redisGet(key);
  if (!doc || !doc.stats || doc.stats.count < VPX_MIN_SAMPLES) return null;

  const { medianAt100k, p25At100k, p75At100k, lowAt100k, highAt100k, count } = doc.stats;

  // Adjust reference prices to the listing's actual mileage for display
  const result = {
    make, model, year,
    samples:                count,
    medianAt100k,
    p25At100k,
    p75At100k,
    marketMedian:           mileage ? adjustMarketPriceToMileage(medianAt100k, mileage, makeKey, modelKey) : medianAt100k,
    marketLow:              mileage ? adjustMarketPriceToMileage(p25At100k,    mileage, makeKey, modelKey) : p25At100k,
    marketHigh:             mileage ? adjustMarketPriceToMileage(p75At100k,    mileage, makeKey, modelKey) : p75At100k,
    mileageAdjusted:        !!(mileage),
    updatedAt:              doc.stats.updatedAt,
    source:                 'vpx',
  };

  _vpxCache.set(key, { data: result, ts: Date.now() });
  return result;
}

// ── Carsales market cache ─────────────────────────────────
async function getCarsalesCache(makeKey, modelKey, year) {
  const doc = await redisGet(K.csales(makeKey, modelKey, year));
  if (!doc || doc.count < 3) return null;
  return doc;
}
async function storeCarsalesCache(makeKey, modelKey, year, samples) {
  if (!samples.length) return;
  const prices = samples.map(s => s.normPrice || s.price).filter(Boolean).sort((a, b) => a - b);
  const doc = {
    count:  prices.length,
    median: prices[Math.floor(prices.length / 2)],
    p25:    prices[Math.floor(prices.length * 0.25)],
    p75:    prices[Math.floor(prices.length * 0.75)],
    low:    prices[0],
    high:   prices[prices.length - 1],
    updatedAt: new Date().toISOString(),
  };
  await redisSet(K.csales(makeKey, modelKey, year), doc, CSALES_TTL_SECS);
}

// ── AutoGrab / RedBook cache ──────────────────────────────
async function getAutoGrabCache(makeKey, modelKey, year) {
  return redisGet(K.agrab(makeKey, modelKey, year));
}
async function storeAutoGrabCache(makeKey, modelKey, year, data) {
  await redisSet(K.agrab(makeKey, modelKey, year), data, AGRAB_TTL_SECS);
}

// Live AutoGrab API call — returns { privateSale, tradeIn, dealerRetail } or null.
// Sign up at autograb.com.au for an API key. Endpoint may need adjustment per their docs.
async function fetchAutoGrabLive(make, model, year) {
  if (!AUTOGRAB_API_KEY) return null;
  try {
    const res = await axios.get(`${AUTOGRAB_BASE_URL}/valuations`, {
      params: { make, model, year },
      headers: { Authorization: `Bearer ${AUTOGRAB_API_KEY}`, Accept: 'application/json' },
      timeout: 8000,
    });
    const d = res.data?.data || res.data || {};
    // Normalise field names — adjust if AutoGrab response shape differs
    const privateSale  = d.private_sale  || d.privateSale  || d.retail || null;
    const tradeIn      = d.trade_in      || d.tradeIn      || d.wholesale || null;
    const dealerRetail = d.dealer_retail || d.dealerRetail || d.dealer || privateSale;
    if (!privateSale) return null;
    return { privateSale: Math.round(privateSale), tradeIn: Math.round(tradeIn || privateSale * 0.82), dealerRetail: Math.round(dealerRetail) };
  } catch (e) {
    console.error(`[AutoGrab] ${make} ${model} ${year}:`, e.response?.status || e.message);
    return null;
  }
}

// ── Carsales Apify seeding — scrape active listings, write to VPX + cache ──
async function scrapeCarsalesForModel(make, model, year) {
  if (!APIFY_TOKEN) return 0;
  const makeKey  = make.toLowerCase().trim();
  const modelKey = model.toLowerCase().trim().replace(/\s+/g, '-');
  try {
    console.log(`[Carsales] Seeding ${make} ${model} ${year}...`);
    const res = await axios.post(
      `https://api.apify.com/v2/acts/${CARSALES_APIFY_ACTOR}/run-sync-get-dataset-items`,
      { make, model, yearFrom: year, yearTo: year, maxItems: 40 },
      { params: { token: APIFY_TOKEN }, headers: { 'Content-Type': 'application/json' }, timeout: 120000 }
    );
    const items = Array.isArray(res.data) ? res.data.filter(i => i && !i.error) : [];
    if (!items.length) { console.log(`[Carsales] No results for ${make} ${model} ${year}`); return 0; }

    const samples = [];
    for (const item of items) {
      const price   = parsePrice(item.price || item.priceValue || 0);
      const mileage = item.odometer || item.mileage || item.kilometres || null;
      const state   = item.state || item.location?.state || extractState(item.location || '');
      if (!price || price < 500 || isOfferPrice(price)) continue;
      const normPrice = normalizePriceToRefKm(price, mileage, makeKey, modelKey);
      samples.push({ id: item.id || item.listingId || String(Math.random()), price, mileage, normPrice, date: new Date().toISOString(), state, source: 'carsales' });
      // Also write directly into VPX — coerce location to string so extractState never crashes
      const locationStr = typeof item.location === 'string' ? item.location : (state || '');
      await storeVehiclePrice({ id: item.id, make, model, year, price, mileage, location: locationStr }).catch(() => {});
    }
    await storeCarsalesCache(makeKey, modelKey, year, samples);
    console.log(`[Carsales] ${make} ${model} ${year} — seeded ${samples.length} listings`);
    return samples.length;
  } catch (e) {
    console.error(`[Carsales] Seed error ${make} ${model} ${year}:`, e.response?.status || e.message);
    return 0;
  }
}

// ── Tiered vehicle pricing orchestrator ──────────────────
// Checks all cached sources in parallel, fetches live on cache miss.
// Returns the highest-confidence priced source, or null if none available.
async function fetchBestVehiclePrice(make, model, year, mileage) {
  const makeKey  = (make  || '').toLowerCase().trim();
  const modelKey = (model || '').toLowerCase().trim().replace(/\s+/g, '-');

  // Tier 1–3: all cache reads in parallel (~50ms)
  const [vpxStats, csalesDoc, agrabDoc] = await Promise.all([
    getVehiclePriceStats(make, model, year, mileage),
    getCarsalesCache(makeKey, modelKey, year),
    getAutoGrabCache(makeKey, modelKey, year),
  ]);

  const candidates = [];

  if (vpxStats && vpxStats.samples >= VPX_MIN_SAMPLES) {
    candidates.push({
      marketMedian:    vpxStats.marketMedian,
      marketLow:       vpxStats.marketLow,
      marketHigh:      vpxStats.marketHigh,
      samples:         vpxStats.samples,
      mileageAdjusted: vpxStats.mileageAdjusted,
      source:    'vpx',
      sourceLabel: `FlipRadar AU index · ${vpxStats.samples} comparable${vpxStats.samples !== 1 ? 's' : ''}`,
      confidence: calcConfidence('vpx', vpxStats.samples),
      make, model, year,
    });
  }

  if (agrabDoc) {
    const med  = mileage ? adjustMarketPriceToMileage(agrabDoc.privateSale,  mileage, makeKey, modelKey) : agrabDoc.privateSale;
    const low  = mileage ? adjustMarketPriceToMileage(agrabDoc.tradeIn,      mileage, makeKey, modelKey) : agrabDoc.tradeIn;
    const high = mileage ? adjustMarketPriceToMileage(agrabDoc.dealerRetail, mileage, makeKey, modelKey) : agrabDoc.dealerRetail;
    candidates.push({
      marketMedian: med, marketLow: low, marketHigh: high,
      samples: 0, mileageAdjusted: !!(mileage),
      source: 'autograb', sourceLabel: 'RedBook valuation (AutoGrab)',
      confidence: calcConfidence('autograb', 0),
      make, model, year,
    });
  }

  if (csalesDoc && csalesDoc.count >= 3) {
    const med  = Math.round((mileage ? adjustMarketPriceToMileage(csalesDoc.median, mileage, makeKey, modelKey) : csalesDoc.median) * CARSALES_BIAS);
    const low  = Math.round((mileage ? adjustMarketPriceToMileage(csalesDoc.p25,    mileage, makeKey, modelKey) : csalesDoc.p25)    * CARSALES_BIAS);
    const high = Math.round((mileage ? adjustMarketPriceToMileage(csalesDoc.p75,    mileage, makeKey, modelKey) : csalesDoc.p75)    * CARSALES_BIAS);
    candidates.push({
      marketMedian: med, marketLow: low, marketHigh: high,
      samples: csalesDoc.count, mileageAdjusted: !!(mileage),
      source: 'csales', sourceLabel: `Carsales AU market · ${csalesDoc.count} active listings`,
      confidence: calcConfidence('csales', csalesDoc.count),
      make, model, year,
    });
  }

  // Sort by confidence — return immediately if best is already high enough
  candidates.sort((a, b) => b.confidence - a.confidence);
  if (candidates.length && candidates[0].confidence >= 0.65) return candidates[0];

  // Tier 4: live AutoGrab (cache miss, $0.10–0.50, cached 30 days)
  if (AUTOGRAB_API_KEY) {
    const live = await fetchAutoGrabLive(makeKey, modelKey, year);
    if (live) {
      await storeAutoGrabCache(makeKey, modelKey, year, live);
      const med  = mileage ? adjustMarketPriceToMileage(live.privateSale,  mileage, makeKey, modelKey) : live.privateSale;
      const low  = mileage ? adjustMarketPriceToMileage(live.tradeIn,      mileage, makeKey, modelKey) : live.tradeIn;
      const high = mileage ? adjustMarketPriceToMileage(live.dealerRetail, mileage, makeKey, modelKey) : live.dealerRetail;
      return {
        marketMedian: med, marketLow: low, marketHigh: high,
        samples: 0, mileageAdjusted: !!(mileage),
        source: 'autograb', sourceLabel: 'RedBook valuation (AutoGrab)',
        confidence: calcConfidence('autograb', 0),
        make, model, year,
      };
    }
  }

  // Return best we have even if below threshold (caller decides whether to use AI)
  return candidates.length ? candidates[0] : null;
}

// ── Master price lookup — call this before AI ─────────────
// Returns price data if we have enough to skip AI, null if AI needed
async function getPriceCacheForKeyword(keyword) {
  // 1. Check our own scan history first (most relevant — AU marketplace prices)
  const own = await getOwnPriceRange(keyword);
  if (own) {
    console.log(`[PriceCache] "${keyword}" → own history (${own.count} records), skipping AI`);
    return own;
  }

  // 2. Not enough data — caller should use AI
  console.log(`[PriceCache] "${keyword}" → no cache, AI needed`);
  return null;
}

// Build a verdict from price data alone (no AI)
function buildCacheVerdict(listingPrice, priceData) {
  const { low, median, high, count, source } = priceData;

  const roi = median > 0 ? Math.round(((median - listingPrice) / listingPrice) * 100) : 0;
  const estimatedProfit = Math.round(median - listingPrice);

  let verdict, oneLiner, dealScore;
  if (roi >= 50) {
    verdict   = 'STEAL';
    oneLiner  = `Listed ${roi}% below median sold — incredible flip potential`;
    dealScore = 95;
  } else if (roi >= 30) {
    verdict   = 'GOOD DEAL';
    oneLiner  = `Listed ${roi}% below median sold price — strong flip potential`;
    dealScore = 80;
  } else if (roi >= 10) {
    verdict   = 'GOOD DEAL';
    oneLiner  = `Priced below market — room to profit`;
    dealScore = 65;
  } else if (roi >= 0) {
    verdict   = 'FAIR';
    oneLiner  = `Around market rate — slim margin`;
    dealScore = 45;
  } else {
    verdict   = 'PASS';
    oneLiner  = `Listed ${Math.abs(roi)}% above typical sold prices — negotiate hard or pass`;
    dealScore = 20;
  }

  return {
    verdict,
    dealScore,
    oneLiner,
    estimatedResellLow:  low,
    estimatedResellHigh: high,
    recommendedOffer:    Math.round(listingPrice * 0.85),
    walkAwayPrice:       Math.round(median * 1.05),
    estimatedProfit:     Math.max(0, estimatedProfit),
    roiPercent:          roi,
    dataPoints:          count,
    source,
    low, median, high,
    negotiationScript:   `Similar listings sell for around $${median} — would you take $${Math.round(listingPrice * 0.85)}?`,
  };
}

// Mileage-aware verdict using the unified priceSource format from fetchBestVehiclePrice.
function buildVehicleVerdict(listingPrice, priceSource, mileage) {
  const { marketMedian, marketLow, marketHigh, samples, make, model, year, mileageAdjusted,
          source, sourceLabel, confidence } = priceSource;

  const feeAdj          = marketMedian * 0.92;  // ~8% selling fees (FB/Gumtree)
  const roi             = marketMedian > 0 ? Math.round(((feeAdj - listingPrice) / listingPrice) * 100) : 0;
  const estimatedProfit = Math.max(0, Math.round(feeAdj - listingPrice));

  let verdict, oneLiner, dealScore;
  if (roi >= 50) {
    verdict = 'STEAL'; dealScore = 95;
    oneLiner = `Listed ${roi}% below AU market median — exceptional flip potential`;
  } else if (roi >= 30) {
    verdict = 'GOOD DEAL'; dealScore = 82;
    oneLiner = `Listed ${roi}% below market — strong flip potential`;
  } else if (roi >= 15) {
    verdict = 'GOOD DEAL'; dealScore = 68;
    oneLiner = `Priced below market — solid room to profit`;
  } else if (roi >= 0) {
    verdict = 'FAIR'; dealScore = 45;
    oneLiner = `Around market rate — slim margin`;
  } else {
    verdict = 'PASS'; dealScore = 18;
    oneLiner = `Listed ${Math.abs(roi)}% above market — negotiate hard or pass`;
  }

  let timeToSell;
  if (dealScore >= 80)      timeToSell = '1–3 days';
  else if (dealScore >= 60) timeToSell = '3–7 days';
  else if (dealScore >= 40) timeToSell = '1–2 weeks';
  else                      timeToSell = '2–4 weeks';

  let demandLevel;
  if (dealScore >= 80)      demandLevel = '🔥 High';
  else if (dealScore >= 55) demandLevel = '📈 Moderate';
  else                      demandLevel = '📉 Low';

  // Mileage unknown: lower dealScore and flag it — market median is at reference km, actual may differ significantly
  if (!mileageAdjusted) {
    dealScore = Math.max(0, dealScore - 8);
  }
  // Extra penalty for very high mileage — hard sell regardless of price
  if (mileage && mileage > 200000) {
    dealScore = Math.max(0, dealScore - 5);
  }

  const mileageNote = mileageAdjusted ? ' (mileage-adjusted)' : '';
  const carLabel    = [year, make, model].filter(Boolean).join(' ');
  const srcLabel    = sourceLabel || 'AU vehicle index';
  const confPct     = confidence != null ? Math.round(confidence * 100) : null;
  const mileageWarning = !mileageAdjusted ? ' Mileage not provided — actual value may vary significantly.' : '';

  const whyItsWorth = confPct != null
    ? `${srcLabel} — ${confPct}% confidence${samples ? `, ${samples} comparable${samples !== 1 ? 's' : ''}` : ''}${mileageNote}.${mileageWarning}`
    : `Based on ${samples} comparable ${carLabel} listings in AU${mileageNote}.${mileageWarning}`;

  return {
    verdict,
    dealScore,
    oneLiner,
    estimatedMarketValue: marketMedian,
    estimatedResellLow:   marketLow,
    estimatedResellHigh:  marketHigh,
    recommendedOffer:     Math.round(listingPrice * 0.82),
    walkAwayPrice:        Math.round(marketMedian * 0.95),
    estimatedProfit,
    roiPercent:           roi,
    timeToSell,
    demandLevel,
    whyItsWorth,
    greenFlags:          [],
    redFlags:            [],
    whatToCheckInPerson: [],
    dataPoints:          samples,
    source:              source || 'vpx',
    sourceLabel:         srcLabel,
    confidence:          confidence || 0,
    low:    marketLow,
    median: marketMedian,
    high:   marketHigh,
    negotiationScript: `Similar ${carLabel}s sell for around $${marketMedian.toLocaleString()}${mileageNote} in AU — would you take $${Math.round(listingPrice * 0.82).toLocaleString()}?`,
    vpxData: priceSource,
  };
}

// ── Email (Resend) ────────────────────────────────────────
async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) { console.log(`[Email] No RESEND_API_KEY — skipping email to ${to}`); return; }
  try {
    const res = await axios.post('https://api.resend.com/emails', {
      from: FROM_EMAIL, to, subject, html,
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
    <div style="font-size:32px;font-weight:900;letter-spacing:2px;color:#fff;margin-bottom:32px">
      Flip<span style="color:#00ff88">Radar</span>
    </div>
    <div style="background:linear-gradient(135deg,rgba(0,255,136,.12),rgba(0,255,136,.04));border:1px solid rgba(0,255,136,.25);border-radius:20px;padding:32px;margin-bottom:24px">
      <div style="font-size:40px;margin-bottom:12px">👋</div>
      <h1 style="color:#fff;font-size:24px;font-weight:800;margin:0 0 8px">Hey ${name}, you're in!</h1>
      <p style="color:#888;font-size:15px;line-height:1.6;margin:0">
        FlipRadar is now scanning Facebook Marketplace for you. Add your first watchlist keyword and we'll notify you the moment something worth flipping shows up.
      </p>
    </div>
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
    <div style="text-align:center;margin-bottom:32px">
      <a href="https://flip-radar.app" style="display:inline-block;background:#00ff88;color:#000;font-weight:800;font-size:16px;padding:16px 40px;border-radius:14px;text-decoration:none;letter-spacing:.5px">
        Open FlipRadar →
      </a>
    </div>
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

// ── In-memory state ───────────────────────────────────────
let watchlist     = [];
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
const APIFY_ACTOR        = 'curious_coder~facebook-marketplace';         // cheap — used for everything
const APIFY_ACTOR_DETAIL = null; // TEMP: disabled for testing — restore to: 'data-slayer~facebook-marketplace-details'

// ── Enrichment dedup cache ────────────────────────────────
// Prevents data-slayer from re-enriching the same listing on every 30-min scan cycle.
// Key = listingId, value = { ts }. TTL matches the shared scan cache (30 min).
const _enrichCache = new Map();
const ENRICH_CACHE_TTL_MS  = 6 * 60 * 60 * 1000;  // 6 hours — mileage/year/transmission don't change
const ENRICH_REDIS_TTL_SEC = 7 * 24 * 3600;        // 7 days — persists across restarts

// Types that look like vehicles in keywords/titles but don't need odometer enrichment
const NON_VEHICLE_TYPES = ['scooter','e-bike','ebike','electric bike','electric scooter',
  'golf cart','golf buggy','push bike','bicycle','mobility scooter'];

function shouldEnrich(item) {
  const text = ((item.marketplace_listing_title || item.title || '') + ' ' +
                (item.redacted_description?.text || item.description || '')).toLowerCase();
  return !NON_VEHICLE_TYPES.some(t => text.includes(t));
}

async function scrapeKeyword(keyword, opts = {}) {
  if (!APIFY_TOKEN) return [];
  // Initial scan looks back 7 days, fetches up to 25 items.
  // Regular scans look back 1 day and fetch 25.
  const days      = opts.backfillDays || (opts.backfill ? 7 : (opts.initialScan ? 7 : 1));
  const maxItems  = 25;
  // Use isVehicleKeyword (keyword only) — not isVehicleListing which checks descriptions
  // This prevents "callaway golf clubs" triggering vehicle mode
  const vehicleMode    = isVehicleKeyword(keyword);
  // includeDetails costs 3–5x more per run and was mainly needed for data-slayer's
  // vehicle_odometer_data field. custom_sub_titles (mileage chips) come back without it.
  const includeDetails = false;
  console.log(`[Apify] "${keyword}" — vehicle:${vehicleMode} includeDetails:${includeDetails}`);

  // Use exact phrase matching — wrap multi-word keywords in quotes so
  // "electric scooter" doesn't return plain "scooter" listings
  const searchQuery = keyword.includes(' ') ? `"${keyword}"` : keyword;

  let fbUrl;
  if (opts.lat && opts.lng) {
    fbUrl = `https://www.facebook.com/marketplace/search/?query=${encodeURIComponent(searchQuery)}&latitude=${opts.lat}&longitude=${opts.lng}&radius=${opts.radius||50}&sortBy=creation_time_descend&daysSinceListed=${days}`;
  } else {
    const city = (opts.city || 'melbourne').toLowerCase().replace(/\s+/g, '');
    fbUrl = `https://www.facebook.com/marketplace/${city}/search/?query=${encodeURIComponent(searchQuery)}&sortBy=creation_time_descend&daysSinceListed=${days}`;
  }
  try {
    const res = await axios.post(
      `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items`,
      { urls: [fbUrl], maxItems, includeDetails, maxRequestRetries: 1, maxPagesPerUrl: 1 },
      { params: { token: APIFY_TOKEN }, headers: { 'Content-Type': 'application/json' }, timeout: 180000 }
    );
    // Slice to maxItems — actor ignores cap when includeDetails:true
    const allItems = Array.isArray(res.data) ? res.data.filter(i => !i.error) : [];
    let items      = allItems.slice(0, maxItems);
    console.log(`[Apify] "${keyword}" -> ${items.length} item(s) (of ${allItems.length} returned)`);

    // ── Vehicle keywords: enrich with data-slayer ─────────
    // Step 1: restore Redis-cached enrichment data (survives restarts, 7-day TTL).
    // Step 2: only call data-slayer for listings still missing metadata after cache restore.
    // Step 3: store fresh data-slayer results to Redis for future scans.
    if (vehicleMode && items.length > 0 && APIFY_ACTOR_DETAIL) {
      // Restore Redis-cached enrichment in parallel for all listings
      const redisEnriched = await Promise.all(
        items.map(item => {
          const id = item.id || item.listingId || String(item.marketplace_listing_id || '');
          return id ? redisGet(K.enrich(id)).catch(() => null) : Promise.resolve(null);
        })
      );
      // Merge Redis enrichment: only overwrite fields that are currently null/undefined on the item.
      // This preserves valid curious_coder fields (e.g. custom_sub_titles with mileage chips)
      // that would otherwise be wiped if the slim object has null for those keys.
      items = items.map((item, i) => {
        const enriched = redisEnriched[i];
        if (!enriched) return item;
        const merged = { ...item };
        for (const [k, v] of Object.entries(enriched)) {
          if (v != null && merged[k] == null) merged[k] = v;  // only fill gaps, never overwrite
          else if (v != null) merged[k] = v;                   // non-null always wins
        }
        return merged;
      });

      // Only escalate to data-slayer when metadata is still genuinely missing
      const toEnrich = items.filter(item => {
        const listingId = item.id || item.listingId || String(item.marketplace_listing_id || '');
        if (!listingId) return false;
        const inMem = _enrichCache.get(listingId);
        if (inMem && (Date.now() - inMem.ts) < ENRICH_CACHE_TTL_MS) return false;
        if (!shouldEnrich(item)) return false;
        // Use extraction functions so subtitle chips and regex count before deciding to enrich
        const rawTitle    = item.marketplace_listing_title || item.custom_title || item.title || '';
        const description = item.redacted_description?.text || item.description || null;
        const hasOdo   = !!(extractMileageFromVehicleInfo(item) || extractMileage(rawTitle, description));
        const hasYear  = !!(item.vehicle_info?.year || item.listing_vehicle_data?.year ||
                            item.vehicleInfo?.year  || item.year || extractYear(rawTitle, description));
        const hasTrans = !!(item.vehicle_transmission_type ||
                            item.vehicle_info?.transmission || item.listing_vehicle_data?.transmission ||
                            extractTransmission(rawTitle, description));
        return !hasOdo || !hasYear || !hasTrans;
      });

      if (toEnrich.length > 0 && APIFY_ACTOR_DETAIL) {
        console.log(`[Apify] "${keyword}" — enriching ${toEnrich.length}/${items.length} via data-slayer (${items.length - toEnrich.length} already complete)`);
        try {
          const batchSize = 5;
          const detailMap = {};
          for (let b = 0; b < toEnrich.length; b += batchSize) {
            const batch = toEnrich.slice(b, b + batchSize);
            await Promise.all(batch.map(async item => {
              const listingId = item.id || item.listingId || String(item.marketplace_listing_id || '');
              if (!listingId) return;
              try {
                const r = await axios.post(
                  `https://api.apify.com/v2/acts/${APIFY_ACTOR_DETAIL}/run-sync-get-dataset-items`,
                  { listingId },
                  { params: { token: APIFY_TOKEN }, headers: { 'Content-Type': 'application/json' }, timeout: 45000 }
                );
                const rows = Array.isArray(r.data) ? r.data.filter(x => !x.error) : [];
                if (rows[0]) {
                  detailMap[listingId] = rows[0];
                  _enrichCache.set(listingId, { ts: Date.now() });
                  // Persist slim enrichment fields to Redis — survives restarts for 7 days.
                  // IMPORTANT: only store non-null values. Null entries spread onto fresh
                  // curious_coder items would overwrite valid fields (e.g. custom_sub_titles
                  // with mileage chips, top-level mileage). custom_sub_titles is excluded
                  // entirely — it belongs to curious_coder, not data-slayer.
                  const slim = {};
                  const _sv = (k, v) => { if (v != null) slim[k] = v; };
                  _sv('vehicle_odometer_data',    rows[0].vehicle_odometer_data);
                  _sv('vehicle_transmission_type',rows[0].vehicle_transmission_type);
                  _sv('vehicle_info',             rows[0].vehicle_info || rows[0].vehicleInfo || rows[0].listing_vehicle_data);
                  _sv('odometer',  rows[0].odometer);
                  _sv('mileage',   rows[0].mileage);
                  _sv('year',      rows[0].year);
                  _sv('make',      rows[0].make);
                  _sv('model',     rows[0].model);
                  // custom_sub_titles intentionally excluded — curious_coder owns this field
                  redisSet(K.enrich(listingId), slim, ENRICH_REDIS_TTL_SEC).catch(() => {});
                }
              } catch (e) {
                console.error(`[DataSlayer] Failed for listingId ${listingId}:`, e.message);
              }
            }));
            if (b + batchSize < toEnrich.length) await sleep(500);
          }
          const enriched = Object.keys(detailMap).length;
          console.log(`[DataSlayer] Enriched ${enriched}/${toEnrich.length} listing(s)`);
          if (enriched > 0) {
            items = items.map(item => {
              const listingId = item.id || item.listingId || String(item.marketplace_listing_id || '');
              const detail = detailMap[listingId];
              if (!detail) return item;
              // Non-null values from data-slayer win; never overwrite with null
              const merged = { ...item };
              for (const [k, v] of Object.entries(detail)) {
                if (v != null) merged[k] = v;
              }
              return merged;
            });
          }
        } catch (detailErr) {
          console.error(`[DataSlayer] Batch error for "${keyword}":`, detailErr.message);
        }
      } else {
        console.log(`[Apify] "${keyword}" — all ${items.length} vehicle listing(s) complete or cached, skipping data-slayer`);
      }
    }
    return items.map(item => {
      const id = item.id || item.listingId || String(item.marketplace_listing_id || '');

      // ── Robust listedAt parsing ───────────────────────────
      // Apify returns dates in multiple formats; we try each in order of reliability
      let listedAt = null;

      // 1. Numeric unix timestamp — check if seconds or milliseconds
      const tsRaw = item.creation_time || item.listed_at || item.listingCreationTime
        || item.listing_creation_time || item.created_time || null;
      if (tsRaw && typeof tsRaw === 'number') {
        // Timestamps < 1e10 are seconds, >= 1e10 are milliseconds
        const ms = tsRaw < 1e10 ? tsRaw * 1000 : tsRaw;
        const d = new Date(ms);
        if (d.getFullYear() >= 2020 && d <= new Date()) listedAt = d.toISOString();
      }

      // 2. String date field
      if (!listedAt) {
        const strRaw = item.date || item.listed_at_text || null;
        if (strRaw && typeof strRaw === 'string') {
          const d = new Date(strRaw);
          if (!isNaN(d.getTime()) && d.getFullYear() >= 2020) listedAt = d.toISOString();
        }
      }

      // 3. Parse relative time string from custom_sub_titles e.g. "Listed 3 hours ago", "Listed 2 days ago"
      if (!listedAt) {
        const subtitles = item.custom_sub_titles || item.subtitle || item.listing_subtitle || '';
        const subText = Array.isArray(subtitles) ? subtitles.join(' ') : String(subtitles || '');
        const relMatch = subText.match(/(\d+)\s*(second|minute|hour|day|week|month)s?\s*ago/i);
        if (relMatch) {
          const amt  = parseInt(relMatch[1]);
          const unit = relMatch[2].toLowerCase();
          const msMap = { second: 1000, minute: 60000, hour: 3600000, day: 86400000, week: 604800000, month: 2592000000 };
          listedAt = new Date(Date.now() - amt * (msMap[unit] || 86400000)).toISOString();
        }
      }

      // 4. Last resort — use foundAt (now). Flag it so we know it's unreliable.
      const listedAtUnknown = !listedAt;
      if (!listedAt) listedAt = new Date().toISOString();

      const rawTitle    = item.marketplace_listing_title || item.custom_title || item.title || keyword;
      const description = item.redacted_description?.text || item.description || null;
      const isVehicle   = isVehicleListing(keyword, rawTitle, description);
      const rawPrice = parsePrice(
        item.listing_price?.amount || item.listing_price?.formatted_amount ||
        item.formatted_price || item.price
      );

      // Extract structured fields before building title so we can inject missing make/year
      const year = isVehicle ? (
        item.vehicle_info?.year || item.listing_vehicle_data?.year ||
        item.vehicleInfo?.year || item.year ||
        extractYear(rawTitle, description)
      ) : null;
      const make = isVehicle ? (
        item.vehicle_make_display_name ||
        item.vehicle_info?.make || item.listing_vehicle_data?.make ||
        item.vehicleInfo?.make || item.make ||
        extractMake(keyword, rawTitle)
      ) : null;
      const title = isVehicle ? normalizeVehicleTitle(rawTitle, year, make) : rawTitle;

      return {
        id,
        title,
        price:       rawPrice,
        isOfferPrice: isOfferPrice(rawPrice),
        url:         item.share_uri || item.listingUrl || item.url || `https://www.facebook.com/marketplace/item/${id}/`,
        image:       item.primary_listing_photo_url || item.primary_listing_photo?.image?.uri || null,
        location:    item.location_text || (typeof item.location === 'string' ? item.location : (item.location?.reverse_geocode?.city || null)),
        description,
        keyword,
        listedAt,
        listedAtUnknown,
        foundAt:  new Date().toISOString(),
        mileage:       isVehicle ? (extractMileageFromVehicleInfo(item) || extractMileage(rawTitle, description)) : null,
        year,
        make,
        model:         isVehicle ? (
                         item.vehicle_model_display_name ||
                         item.vehicle_info?.model || item.listing_vehicle_data?.model ||
                         item.vehicleInfo?.model || item.model || null
                       ) : null,
        transmission:  isVehicle ? (
                         item.vehicle_transmission_type ||
                         item.vehicle_info?.transmission || item.listing_vehicle_data?.transmission ||
                         item.vehicleInfo?.transmission || item.transmission ||
                         (() => {
                           const subs = item.custom_sub_titles || item.listing_subtitle || item.subtitle || [];
                           const arr = Array.isArray(subs) ? subs : String(subs || '').split(/[·|]/);
                           for (const c of arr) {
                             const t = String(c || '').toLowerCase().trim();
                             if (t === 'automatic' || t === 'auto') return 'Automatic';
                             if (t === 'manual') return 'Manual';
                           }
                           return null;
                         })() ||
                         extractTransmission(rawTitle, description)
                       ) : null,
        fuelType:      isVehicle ? (
                         item.vehicle_fuel_type ||
                         item.vehicle_info?.fuel_type || item.listing_vehicle_data?.fuel_type ||
                         item.vehicle_info?.fuelType || item.vehicleInfo?.fuel_type ||
                         item.fuel_type || item.fuelType || null
                       ) : null,
        exteriorColor: isVehicle ? (
                         item.vehicle_exterior_color ||
                         item.vehicle_info?.exterior_color || item.listing_vehicle_data?.exterior_color ||
                         item.vehicleInfo?.exterior_color || item.exterior_color || item.color || null
                       ) : null,
        interiorColor: isVehicle ? (
                         item.vehicle_info?.interior_color || item.listing_vehicle_data?.interior_color ||
                         item.vehicleInfo?.interior_color || item.interior_color || null
                       ) : null,
        bodyStyle:     isVehicle ? (
                         item.vehicle_info?.body_style || item.listing_vehicle_data?.body_style ||
                         item.vehicleInfo?.body_style || item.body_style || item.bodyStyle || null
                       ) : null,
        sellerType:    isVehicle ? (item.vehicle_seller_type || null) : null,
        condition:     item.condition || null,
      };
    }).filter(l => l.id);
  } catch (e) {
    console.error(`[Apify] Error for "${keyword}":`, e.response ? JSON.stringify(e.response.data).slice(0,200) : e.message);
    return [];
  }
}

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
    const desc  = item.redacted_description?.text || item.description || null;
    const title = item.marketplace_listing_title || item.title || '';
    const vehicleInfo = item.vehicle_info || item.vehicleInfo || item.listing_vehicle_data || {};
    const mileageRaw = vehicleInfo.odometer || vehicleInfo.mileage || vehicleInfo.kilometers
      || item.odometer || item.mileage || null;
    const mileage = mileageRaw
      ? (typeof mileageRaw === 'number' ? mileageRaw : parsePrice(String(mileageRaw)))
      : extractMileage(title, desc);
    const year  = vehicleInfo.year || vehicleInfo.model_year || extractYear(title, desc);
    const make  = vehicleInfo.make || vehicleInfo.brand || extractMake('', title);
    const model = vehicleInfo.model || null;
    console.log(`[DetailScrape] ${listingUrl} → mileage:${mileage} year:${year} make:${make}`);
    return { mileage, year, make, model };
  } catch (e) {
    console.error('[DetailScrape] Error:', e.message);
    return null;
  }
}

// ── Vehicle helpers ───────────────────────────────────────
const VEHICLE_KEYWORDS = ['car','ute','van','truck','motorcycle','suv','4wd','wagon',
  'sedan','hatch','coupe','convertible','tractor','forklift','boat','caravan',
  'camper','excavator','loader','hilux','landcruiser','patrol',
  'ranger','triton','navara','colorado','dmax','bt50','pajero','prado','defender','discovery',
  'transit','sprinter','vito','ducato','daily','commodore','falcon','camry','corolla',
  'civic','accord','mazda','subaru','toyota','ford','holden','honda','nissan','mitsubishi',
  'hyundai','kia','bmw','mercedes','audi','volkswagen','vw','jeep','ram','dodge'];
// NOTE: scooter, moped, bike removed — electric versions dont need odometer data (includeDetails:true is wasted cost)

// Only checks the KEYWORD — prevents "callaway golf clubs" triggering vehicle mode
// just because someone mentions a Ram truck in their listing description
function isVehicleKeyword(keyword) {
  const kw = keyword.toLowerCase();
  return VEHICLE_KEYWORDS.some(v => kw.includes(v));
}

// Checks keyword + title + description — used for tagging individual listings
function isVehicleListing(keyword, title, description) {
  const text = (keyword + ' ' + title + ' ' + (description || '')).toLowerCase();
  return VEHICLE_KEYWORDS.some(kw => text.includes(kw));
}

// Extract mileage from Apify's structured vehicle_info block (more accurate than regex)
function extractMileageFromVehicleInfo(item) {
  // Priority 1: subtitle chips — FB returns ["2005", "175,000 km", "Automatic"] here
  const subs = item.custom_sub_titles || item.listing_subtitle || item.subtitle || [];
  const subArr = Array.isArray(subs) ? subs : String(subs || '').split(/[·|]/);
  for (const chip of subArr) {
    const c = String(chip || '').trim();
    // "175,000 km" / "175 000 km" / "175000km" / "175000kms"
    const m = c.match(/^(\d{1,3}(?:[,\s]\d{3})+)\s*k(?:m|ms|ilometres?)?$/i)
           || c.match(/^(\d{4,6})\s*k(?:m|ms|ilometres?)?$/i);
    if (m) {
      const val = parseInt(m[1].replace(/[,\s]/g, ''));
      if (val > 1000 && val < 2000000) return val;
    }
    // Shorthand chip: "220k" or "85k" — 2–4 digits followed by bare 'k'
    const shorthand = c.match(/^(\d{2,4})k$/i);
    if (shorthand) {
      const val = parseInt(shorthand[1]) * 1000;
      if (val > 10000 && val < 2000000) return val;
    }
  }
  // Priority 2: data-slayer vehicle_odometer_data — string like "250,000 km"
  const odoData = item.vehicle_odometer_data;
  if (odoData) {
    const parsed = parseInt(String(odoData).replace(/[^0-9]/g, ''));
    if (parsed > 0 && parsed < 2000000) return parsed;
  }
  // Priority 3: structured vehicle_info fields
  const vi = item.vehicle_info || item.listing_vehicle_data || item.vehicleInfo || {};
  const raw = vi.odometer || vi.mileage || vi.kilometers || vi.driven_km || vi.driven
    || item.odometer || item.mileage || item.kilometers || null;
  if (!raw) return null;
  if (typeof raw === 'number') return raw > 0 && raw < 2000000 ? raw : null;
  const parsed = parseInt(String(raw).replace(/[^0-9]/g, ''));
  return parsed > 0 && parsed < 2000000 ? parsed : null;
}

function extractMileage(title, description) {
  const text = (title + ' ' + (description || '')).toLowerCase();

  // Explicit odometer/odo labels — highest confidence
  const odoPatterns = [
    /odo(?:meter)?[\s:]*(\d{1,3}(?:,\d{3})+)/,           // odo: 210,000
    /odo(?:meter)?[\s:]*(\d{4,6})/,                        // odo: 210000
    /odometer[\s:]*(\d{1,3}(?:,\d{3})+)/,
    /odometer[\s:]*(\d{4,6})/,
    /odo(?:meter)?[\s:]*(\d{1,3}(?:\s\d{3})+)/,           // odo 220 000 (space-sep, no km suffix)
  ];
  for (const p of odoPatterns) {
    const m = text.match(p);
    if (m) {
      const val = parseInt(m[1].replace(/[,\s]/g, ''));
      if (val > 1000 && val < 1000000) return val;
    }
  }

  // "210 thousand km" / "210k kilometres"
  const thousandMatch = text.match(/(\d{1,3})\s*(?:thousand|thou)\s*k(?:m|ms|ilometres?|ilometers?)?/);
  if (thousandMatch) {
    const val = parseInt(thousandMatch[1]) * 1000;
    if (val > 1000 && val < 1000000) return val;
  }

  // Standard patterns with comma-separated numbers — e.g. 210,000km
  const commaMatch = text.match(/(\d{1,3}(?:,\d{3})+)\s*k(?:m|ms|ilometres?|ilometers?|s\b)/);
  if (commaMatch) {
    const val = parseInt(commaMatch[1].replace(/,/g, ''));
    if (val > 1000 && val < 1000000) return val;
  }

  // Space-separated thousands — e.g. "181 000 km" (common AU format)
  const spaceMatch = text.match(/(\d{1,3}(?:\s\d{3})+)\s*k(?:m|ms|ilometres?|ilometers?|s\b)/);
  if (spaceMatch) {
    const val = parseInt(spaceMatch[1].replace(/\s/g, ''));
    if (val > 1000 && val < 1000000) return val;
  }

  // Plain number followed by km variant — e.g. 210000km or 210000 kms
  const plainMatch = text.match(/(\d{4,6})\s*k(?:m|ms|ilometres?|ilometers?|s\b)/);
  if (plainMatch) {
    const val = parseInt(plainMatch[1]);
    if (val > 1000 && val < 1000000) return val;
  }

  // Shorthand — e.g. "210k" or "210 k" at word boundary
  const shortMatch = text.match(/\b(\d{2,4})\s*k(?:\s|$|[^a-z])/);
  if (shortMatch) {
    const val = parseInt(shortMatch[1]) * 1000;
    if (val > 10000 && val < 1000000) return val;
  }

  // "low ks" / "high ks" — can't extract exact number, return null
  return null;
}

function extractYear(title, description) {
  const text = title + ' ' + (description || '');
  const m = text.match(/(19[7-9]\d|20[0-2]\d)/);
  if (m) {
    const yr = parseInt(m[1]);
    if (yr >= 1970 && yr <= new Date().getFullYear() + 1) return yr;
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

function extractTransmission(title, description) {
  const text = (title + ' ' + (description || '')).toLowerCase();
  if (/\bdsg\b|\bdct\b|\bdual.?clutch\b/.test(text)) return 'DSG';
  if (/\bcvt\b/.test(text)) return 'CVT';
  if (/\bamt\b/.test(text)) return 'Auto';
  // "auto" as standalone word — avoid matching "automatic car" twice
  if (/\bautomatic\b/.test(text)) return 'Automatic';
  if (/(?:^|[\s,•·\-])auto(?:[\s,•·\-]|$)/.test(text)) return 'Auto';
  if (/\bmanual\b|\b[456]\s*speed\b|\b[456]\s*sp\b/.test(text)) return 'Manual';
  return null;
}

// Prepend year and/or make to title when they're known but absent from the raw title.
// Produces: "2012 Toyota Hilux SR5" from "Hilux SR5" + year=2012, make=Toyota.
// Never duplicates if make/year already in title.
function normalizeVehicleTitle(rawTitle, year, make) {
  if (!rawTitle) return rawTitle;
  const title = rawTitle.trim();
  const lo = title.toLowerCase();
  let prefix = '';
  if (year && !title.includes(String(year))) prefix += year + ' ';
  if (make && !lo.includes(make.toLowerCase())) prefix += make + ' ';
  return prefix ? (prefix + title) : title;
}

// ── AU vehicle depreciation rates ────────────────────────
// annualRate: fraction lost per year, perKm: $/km additional depreciation vs VPX_REF_KM
const DEP_TABLE = {
  toyota:      { annualRate: 0.12, perKm: 0.06 },
  mazda:       { annualRate: 0.12, perKm: 0.06 },
  honda:       { annualRate: 0.12, perKm: 0.06 },
  subaru:      { annualRate: 0.14, perKm: 0.07 },
  mitsubishi:  { annualRate: 0.14, perKm: 0.07 },
  hyundai:     { annualRate: 0.16, perKm: 0.08 },
  kia:         { annualRate: 0.16, perKm: 0.08 },
  nissan:      { annualRate: 0.16, perKm: 0.08 },
  volkswagen:  { annualRate: 0.16, perKm: 0.08 },
  bmw:         { annualRate: 0.20, perKm: 0.12 },
  mercedes:    { annualRate: 0.20, perKm: 0.12 },
  'mercedes-benz': { annualRate: 0.20, perKm: 0.12 },
  audi:        { annualRate: 0.20, perKm: 0.12 },
  ford:        { annualRate: 0.18, perKm: 0.09 },
  holden:      { annualRate: 0.18, perKm: 0.09 },
  jeep:        { annualRate: 0.20, perKm: 0.10 },
  landrover:   { annualRate: 0.22, perKm: 0.15 },
  'land rover':{ annualRate: 0.22, perKm: 0.15 },
  lexus:       { annualRate: 0.14, perKm: 0.07 },
  volvo:       { annualRate: 0.18, perKm: 0.09 },
  _default:    { annualRate: 0.16, perKm: 0.08 },
};
// Diesel 4WDs hold value significantly better than their make average
const DIESEL_4WD_MODELS = ['hilux','triton','ranger','bt-50','bt50','colorado','patrol',
  'landcruiser','land cruiser','pajero','prado','fortuner','d-max','dmax','mux','mu-x'];
function getDepRates(make, model) {
  const m = (model || '').toLowerCase();
  if (DIESEL_4WD_MODELS.some(d => m.includes(d))) return { annualRate: 0.10, perKm: 0.05 };
  return DEP_TABLE[(make || '').toLowerCase()] || DEP_TABLE._default;
}

// Confidence score: how much to trust this pricing source (0–1).
// Drives: AI skip threshold, border glow intensity, "confidence" display bar.
function calcConfidence(source, count = 0) {
  switch (source) {
    case 'vpx':         return Math.min(0.92, 0.52 + count * 0.025); // grows with AU samples
    case 'autograb':    return 0.87;  // RedBook industry data
    case 'csales':      return Math.min(0.82, 0.55 + count * 0.018); // grows with listing count
    case 'own_history': return Math.min(0.55, 0.28 + count * 0.015);
    default:            return 0.20;
  }
}

function extractState(location) {
  if (!location) return null;
  // location can be an object from Apify (e.g. { state: 'VIC', city: 'Melbourne' })
  // coerce safely — if it's an object with a state string, use that; otherwise stringify
  const locStr = (typeof location === 'object' && location !== null)
    ? (location.state || location.city || location.name || JSON.stringify(location))
    : String(location);
  const loc = locStr.toUpperCase();
  if (/\bVIC\b|VICTORIA|MELBOURNE/.test(loc))  return 'VIC';
  if (/\bNSW\b|NEW SOUTH WALES|SYDNEY/.test(loc)) return 'NSW';
  if (/\bQLD\b|QUEENSLAND|BRISBANE|GOLD COAST/.test(loc)) return 'QLD';
  if (/\bWA\b|WESTERN AUSTRALIA|PERTH/.test(loc))  return 'WA';
  if (/\bSA\b|SOUTH AUSTRALIA|ADELAIDE/.test(loc)) return 'SA';
  if (/\bTAS\b|TASMANIA|HOBART/.test(loc))  return 'TAS';
  if (/\bACT\b|CANBERRA/.test(loc))         return 'ACT';
  if (/\bNT\b|NORTHERN TERRITORY|DARWIN/.test(loc)) return 'NT';
  return null;
}

// Fallback model extraction when Apify's structured fields are missing
function extractModel(make, title) {
  const MODELS = {
    toyota:     ['camry','corolla','hilux','rav4','landcruiser','land cruiser','prado','kluger',
                 'yaris','prius','c-hr','chr','86','gr86','supra','aurion','fortuner','hiace','tarago'],
    ford:       ['ranger','escape','puma','focus','fiesta','mustang','f-150','transit','everest','mondeo','endura'],
    holden:     ['commodore','colorado','trax','trailblazer','astra','barina','cruze','captiva','spark'],
    honda:      ['civic','accord','cr-v','crv','hr-v','hrv','jazz','odyssey','integra','type r'],
    nissan:     ['navara','patrol','x-trail','xtrail','pathfinder','qashqai','leaf','370z','350z','gt-r','gtr','micra','pulsar'],
    mitsubishi: ['triton','pajero','outlander','asx','eclipse cross','lancer','galant','colt','mirage'],
    mazda:      ['cx-5','cx5','cx-3','cx3','cx-30','cx30','cx-9','cx9','mazda3','mazda6','bt-50','bt50','mx-5','mx5','mazda2'],
    subaru:     ['outback','forester','impreza','wrx','sti','xv','crosstrek','brz','ascent','legacy','liberty'],
    hyundai:    ['tucson','santa fe','kona','i30','i20','i10','i40','sonata','elantra','veloster','staria','ioniq5','ioniq6','ioniq'],
    kia:        ['sportage','sorento','cerato','stinger','carnival','niro','seltos','ev6','picanto','rio'],
    volkswagen: ['golf','polo','passat','tiguan','touareg','amarok','caddy','transporter','t-roc','id4','arteon'],
    bmw:        ['3 series','5 series','7 series','x3','x5','x1','x7','m3','m5','m4','4 series','1 series','2 series','x6','i4'],
    mercedes:   ['c-class','e-class','s-class','a-class','b-class','glc','gle','gla','glb','gls','cla','cls'],
    audi:       ['a3','a4','a5','a6','a7','a8','q3','q5','q7','rs3','rs4','rs6','s3','s4','s5','tt'],
    isuzu:      ['d-max','dmax','mu-x','mux'],
    ldv:        ['t60','d90','g10'],
    gwm:        ['ute','haval h6','haval','jolion'],
    mg:         ['hs','zs'],
    lexus:      ['is','es','rx','nx','ux','lx','gx','lc'],
    jeep:       ['wrangler','cherokee','grand cherokee','compass','renegade','gladiator'],
    'land rover': ['defender','discovery','range rover','sport','freelander','evoque','velar'],
    subaru:     ['outback','forester','impreza','wrx','sti','xv','brz'],
  };
  const t = (title || '').toLowerCase();
  const models = MODELS[(make || '').toLowerCase()] || [];
  for (const model of models) {
    if (t.includes(model)) return model;
  }
  return null;
}

// Normalize listed price to VPX_REF_KM equivalent for apples-to-apples comparison.
// Higher-km car listed at $10k → would have been $13k at 100k km → normPrice = $13k.
function normalizePriceToRefKm(price, mileage, make, model) {
  if (!price || price <= 0 || !mileage || mileage <= 0) return price;
  const { perKm } = getDepRates(make, model);
  return Math.round(price + (mileage - VPX_REF_KM) * perKm);
}

// Reverse: given median at VPX_REF_KM, what is market value at targetMileage?
function adjustMarketPriceToMileage(refMedian, targetMileage, make, model) {
  if (!refMedian || !targetMileage || targetMileage <= 0) return refMedian;
  const { perKm } = getDepRates(make, model);
  return Math.round(refMedian - (targetMileage - VPX_REF_KM) * perKm);
}

function parsePrice(raw) {
  if (!raw) return 0;
  if (typeof raw === 'number') return Math.round(raw);
  return Math.round(parseFloat(String(raw).replace(/[^0-9.]/g, '')) || 0);
}

// Prices sellers use as placeholders meaning "make an offer" / "contact me"
// $1 and $1234 are the most common on FB Marketplace AU
const OFFER_PRICES = new Set([1, 1234, 1111, 2345, 9999, 9998, 9997, 11111, 99999, 100000, 123456]);
function isOfferPrice(price) {
  if (!price || price <= 0) return false;
  // Exact known placeholder prices
  if (OFFER_PRICES.has(price)) return true;
  // Repeating digit pattern e.g. 2222, 3333, 5555
  const s = String(price);
  if (s.length >= 3 && s.split('').every(c => c === s[0])) return true;
  return false;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Shared scan cache TTL ────────────────────────────────
const SHARED_SCAN_TTL_MS = 50 * 60 * 1000; // 50 mins — covers both basic (30min) and premium (15min) intervals; halves Apify calls for non-overlapping keywords

// ── Distribute raw listings to a single user ─────────────
async function distributeListingsToUser(watcher, raw, opts = {}) {
  if (!Array.isArray(raw)) raw = []; // safety net
  const keyword      = watcher.keyword.toLowerCase();
  const userId       = watcher.userId;
  const seen         = await getUserSeen(userId);
  const userListings = await getUserListings(userId);
  let newCount       = 0;

  const excludeWords = Array.isArray(watcher.excludeWords) ? watcher.excludeWords : [];

  // ── Keyword synonym map ──────────────────────────────────
  // Known brands, models and aliases that count as a match even without exact keyword words
  const SYNONYMS = {

    // ── Electric scooters ─────────────────────────────────
    'electric scooter': ['ninebot', 'segway', 'xiaomi', 'mi scooter', 'gotrax', 'inokim', 'kaabo', 'dualtron', 'apollo', 'zero 8', 'zero 10', 'evo scooter', 'mearth', 'mercane', 'vsett', 'kugoo', 'fluidfreeride', 'turboant', 'hiboy', 'unagi', 'pure air', 'blade gt', 'mantis', 'wolf king', 'speedway', 'emove', 'joyor', 'navee', 'yadea', 'okai'],
    'e scooter':        ['ninebot', 'segway', 'xiaomi', 'gotrax', 'inokim', 'kaabo', 'dualtron', 'apollo', 'mearth', 'mercane', 'vsett', 'kugoo', 'emove', 'navee', 'yadea'],
    'scooter':          ['ninebot', 'segway', 'xiaomi', 'vespa', 'honda pcx', 'honda lead', 'yamaha nmax', 'yamaha vino', 'suzuki address', 'kymco', 'sym', 'peugeot scooter', 'piaggio', 'aprilia sr', 'genuine scooter', 'wolf scooter'],

    // ── Electric bikes ────────────────────────────────────
    'electric bike':    ['ebike', 'e-bike', 'e bike', 'bafang', 'bosch ebike', 'shimano steps', 'levo', 'turbo levo', 'specialized turbo', 'rad power', 'radpower', 'aventon', 'lectric', 'ride1up', 'juiced', 'super73', 'cake bike', 'riese muller', 'gazelle', 'trek powerfly', 'giant trance e', 'giant reign e', 'cannondale neo', 'bulls ebike', 'haibike', 'cube stereo hybrid', 'focus jam', 'orbea rise', 'yt decoy'],
    'ebike':            ['ebike', 'e-bike', 'e bike', 'bafang', 'bosch', 'shimano steps', 'levo', 'rad power', 'aventon', 'super73', 'haibike', 'cube hybrid'],
    'electric bicycle': ['ebike', 'e-bike', 'e bike', 'bafang', 'bosch', 'rad power', 'aventon', 'lectric'],

    // ── Mopeds ───────────────────────────────────────────
    'moped':            ['ninebot', 'segway', 'honda cub', 'ct110', 'postie bike', 'monkey bike', 'honda ct', 'yamaha cy', 'puch', 'tomos', 'garelli', 'derbi', 'piaggio ciao', 'vespa ciao'],

    // ── Motorcycles ──────────────────────────────────────
    'motorcycle':       ['honda cbr', 'honda cb', 'yamaha r1', 'yamaha r6', 'yamaha mt', 'kawasaki ninja', 'kawasaki z', 'suzuki gsxr', 'suzuki sv', 'ducati', 'bmw gs', 'bmw s1000', 'triumph', 'ktm duke', 'ktm exc', 'husqvarna', 'royal enfield', 'harley', 'indian scout', 'aprilia rsv', 'mv agusta', 'benelli', 'cfmoto', 'loncin'],
    'dirt bike':        ['ktm', 'husqvarna', 'yamaha yz', 'yamaha wr', 'honda crf', 'kawasaki kx', 'suzuki rmz', 'beta rr', 'sherco', 'gasgas', 'tm racing', 'pitbike', 'pit bike', 'stomp', 'thumpstar'],

    // ── Apple devices ─────────────────────────────────────
    'iphone':           ['apple iphone', 'iphone 15', 'iphone 14', 'iphone 13', 'iphone 12', 'iphone 11', 'iphone x', 'iphone se', 'iphone pro', 'iphone plus', 'iphone max'],
    'macbook':          ['apple macbook', 'macbook pro', 'macbook air', 'macbook m1', 'macbook m2', 'macbook m3', 'apple laptop', 'mac laptop'],
    'ipad':             ['apple ipad', 'ipad pro', 'ipad air', 'ipad mini', 'ipad 10th', 'ipad 9th', 'apple tablet'],
    'apple watch':      ['iwatch', 'series 9', 'series 8', 'series 7', 'apple watch ultra', 'watch ultra', 'watch se'],
    'airpods':          ['airpod pro', 'airpods pro', 'airpods max', 'apple earbuds', 'apple earphones', 'apple headphones'],

    // ── Gaming consoles ───────────────────────────────────
    'ps5':              ['playstation 5', 'playstation5', 'sony ps5', 'ps5 console', 'ps5 digital', 'ps5 disc', 'dualsense'],
    'ps4':              ['playstation 4', 'playstation4', 'sony ps4', 'ps4 console', 'ps4 pro', 'ps4 slim'],
    'xbox':             ['xbox series x', 'xbox series s', 'xbox one', 'microsoft xbox', 'series x', 'series s'],
    'nintendo switch':  ['switch oled', 'switch lite', 'nintendo oled', 'switch console', 'switch bundle'],
    'gaming pc':        ['gaming computer', 'gaming desktop', 'rtx gaming', 'rgb gaming', 'gaming rig', 'gaming setup', 'custom pc', 'prebuilt gaming'],

    // ── Golf ─────────────────────────────────────────────
    'golf clubs':       ['callaway', 'titleist', 'taylormade', 'ping', 'cleveland', 'mizuno', 'cobra golf', 'srixon', 'wilson golf', 'tour edge', 'honma', 'full set', 'iron set', 'golf set', 'driver set', 'wedge set'],
    'golf club':        ['callaway', 'titleist', 'taylormade', 'ping', 'cleveland', 'mizuno', 'cobra golf', 'srixon', 'driver', 'putter', 'wedge', 'iron', '3 wood', '5 wood'],
    'golf bag':         ['cart bag', 'stand bag', 'staff bag', 'pencil bag', 'titleist bag', 'callaway bag', 'taylormade bag', 'ping bag'],

    // ── Cameras ──────────────────────────────────────────
    'camera':           ['sony a7', 'sony a6', 'canon eos', 'canon r5', 'canon r6', 'nikon z', 'nikon d', 'fujifilm xt', 'fujifilm x100', 'panasonic gh', 'olympus om', 'leica', 'hasselblad', 'mirrorless', 'dslr'],
    'gopro':            ['hero 12', 'hero 11', 'hero 10', 'hero 9', 'gopro hero', 'action cam', 'action camera', 'dji action', 'insta360'],
    'drone':            ['dji mini', 'dji mavic', 'dji air', 'dji phantom', 'dji fpv', 'autel evo', 'skydio', 'fpv drone', 'quadcopter'],

    // ── Audio ─────────────────────────────────────────────
    'headphones':       ['sony wh', 'sony xm4', 'sony xm5', 'bose qc', 'bose 700', 'bose quietcomfort', 'sennheiser', 'audio technica', 'beats studio', 'beats pro', 'jabra evolve', 'beyerdynamic', 'akg', 'anker soundcore', 'jbl live'],
    'speakers':         ['jbl charge', 'jbl flip', 'jbl xtreme', 'bose soundlink', 'sonos', 'marshall speaker', 'ultimate ears', 'ue boom', 'harman kardon', 'klipsch', 'polk audio', 'audioengine', 'yamaha speaker'],
    'turntable':        ['record player', 'vinyl player', 'technics', 'audio technica lp', 'pro-ject', 'rega', 'pioneer plx', 'reloop', 'denon dp'],

    // ── Computers ────────────────────────────────────────
    'laptop':           ['macbook', 'thinkpad', 'dell xps', 'hp spectre', 'hp envy', 'lenovo yoga', 'asus rog', 'asus zenbook', 'surface pro', 'surface laptop', 'acer swift', 'razer blade', 'lg gram'],
    'graphics card':    ['rtx 4090', 'rtx 4080', 'rtx 4070', 'rtx 3090', 'rtx 3080', 'rtx 3070', 'rtx 3060', 'rx 7900', 'rx 6900', 'rx 6800', 'gpu', 'nvidia', 'radeon'],
    'monitor':          ['ultrawide', '4k monitor', '144hz', '240hz', 'oled monitor', 'curved monitor', 'dell ultrasharp', 'lg ultragear', 'samsung odyssey', 'asus rog monitor', 'benq'],

    // ── Tools & Equipment ─────────────────────────────────
    'power tools':      ['dewalt', 'milwaukee', 'makita', 'bosch tools', 'festool', 'hikoki', 'metabo', 'ryobi', 'ridgid', 'snap-on', 'impact driver', 'drill set', 'circular saw', 'angle grinder'],
    'generator':        ['honda generator', 'yamaha generator', 'kipor', 'hyundai generator', 'briggs stratton', 'powertech', 'genset', 'inverter generator'],
    'pressure washer':  ['karcher', 'gerni', 'ryobi pressure', 'dewalt pressure', 'simpson pressure', 'generac', 'pressure cleaner'],

    // ── Fitness ───────────────────────────────────────────
    'treadmill':        ['nordictrack', 'bowflex', 'sole treadmill', 'life fitness', 'concept2', 'peloton tread', 'reebok treadmill', 'running machine'],
    'weights':          ['dumbbells', 'barbell', 'kettlebell', 'weight plates', 'olympic weights', 'gym weights', 'bumper plates', 'cast iron weights'],
    'exercise bike':    ['spin bike', 'peloton', 'wattbike', 'schwinn', 'assault bike', 'concept2 bike', 'nordictrack bike', 'indoor cycle', 'stationary bike'],

    // ── Furniture ─────────────────────────────────────────
    'couch':            ['sofa', 'lounge', 'sectional', 'chesterfield', 'loveseat', '3 seater', '4 seater', '2 seater', 'corner sofa'],
    'sofa':             ['couch', 'lounge', 'sectional', 'chesterfield', '3 seater', '4 seater', 'corner lounge'],
    'dining table':     ['dining set', 'kitchen table', 'dinner table', 'table and chairs', 'dining suite'],

    // ── Cars (common searches) ────────────────────────────
    'ute':              ['hilux', 'ranger', 'navara', 'triton', 'colorado', 'd-max', 'bt-50', 'amarok', 'ram 1500', 'f-150', 'silverado', 'tundra'],
    'van':              ['transit', 'sprinter', 'vito', 'ducato', 'daily', 'hiace', 'nv200', 'master', 'vivaro', 'trafic', 'transporter'],
    '4wd':              ['landcruiser', 'prado', 'patrol', 'pajero', 'defender', 'discovery', 'wrangler', 'everest', 'fortuner', 'outlander', 'rav4', 'crv'],

    // ── Watches ───────────────────────────────────────────
    'watch':            ['rolex', 'omega', 'seiko', 'casio', 'citizen', 'tag heuer', 'tissot', 'breitling', 'iwc', 'panerai', 'tudor', 'oris', 'longines', 'hamilton', 'garmin watch', 'suunto'],
    'smartwatch':       ['apple watch', 'samsung galaxy watch', 'garmin fenix', 'garmin forerunner', 'fitbit', 'polar', 'suunto', 'huawei watch', 'pixel watch'],

    // ── Clothing & Fashion ────────────────────────────────
    'sneakers':         ['nike air', 'jordan', 'adidas yeezy', 'yeezy', 'new balance', 'asics gel', 'vans old skool', 'converse', 'reebok classic', 'puma', 'salehe', 'dunk', 'air force', 'air max', 'ultraboost'],
    'designer bag':     ['louis vuitton', 'lv bag', 'gucci bag', 'prada bag', 'chanel bag', 'hermes', 'balenciaga', 'burberry', 'coach bag', 'kate spade', 'michael kors', 'tory burch'],

    // ── Musical instruments ───────────────────────────────
    'guitar':           ['fender', 'gibson', 'martin guitar', 'taylor guitar', 'epiphone', 'ibanez', 'prs guitar', 'schecter', 'telecaster', 'stratocaster', 'les paul', 'sg guitar', 'acoustic guitar', 'electric guitar'],
    'keyboard':         ['yamaha keyboard', 'roland keyboard', 'korg', 'casio keyboard', 'nord piano', 'kawai', 'digital piano', 'midi keyboard', 'synthesizer'],

    // ── Baby & Kids ───────────────────────────────────────
    'pram':             ['stroller', 'bugaboo', 'uppababy', 'babyzen yoyo', 'silver cross', 'mountain buggy', 'baby jogger', 'icandy', 'nuna', 'cybex'],
    'baby car seat':    ['car seat', 'britax', 'maxi cosi', 'cybex seat', 'nuna rava', 'uppababy mesa', 'clek', 'jolly jumper'],
  };

  // Find synonyms for this keyword
  const kwSynonyms = SYNONYMS[keyword] || [];

  // Split keyword into words — all must appear in title OR a synonym matches
  const kwWords = keyword.replace(/['"]/g, '').toLowerCase().split(/\s+/).filter(w => w.length > 0);

  const relevant = raw.filter(l => {
    const title = (l.title || '').toLowerCase();
    const desc  = (l.description || '').toLowerCase();
    const full  = title + ' ' + desc;

    // Only block user-defined excluded words — AI handles all relevance filtering
    if (excludeWords.length && excludeWords.some(w => w && full.includes(w))) return false;

    return true;
  });

  const dropped = raw.length - relevant.length;
  if (dropped > 0) {
    console.log(`[Filter] "${keyword}" — dropped ${dropped} listing(s) (matched excluded words)`);
    // Save blocked listings so user can review them
    const blockedListings = raw.filter(l => !relevant.includes(l)).map(l => ({
      id: l.id, title: l.title, price: l.price, url: l.url,
      image: l.image, keyword, blockedAt: new Date().toISOString()
    }));
    redisGet(K.blocked(watcher.userId)).then(existing => {
      const all = Array.isArray(existing) ? existing : [];
      const merged = [...blockedListings, ...all.filter(e => !blockedListings.find(b => b.id === e.id))];
      redisSet(K.blocked(watcher.userId), merged.slice(0, 100)); // keep last 100
    }).catch(() => {});
  }

  let seenSkipped = 0;
  let seenModified = false; // tracks whether seen map changed without a new listing (Fix C)
  // On regular scans (after initial scan completed), drop any listing that was
  // posted before the initial scan finished — those should have been caught then.
  // This stops old listings trickling in on every 30-min scan.
  const initialScanCutoff = watcher.initialScanCompletedAt
    ? new Date(watcher.initialScanCompletedAt).getTime()
    : null;

  for (const listing of relevant) {
    const key    = `${keyword}:${listing.id}`;
    const seenTs = seen[key];
    if (seenTs && (Date.now() - seenTs) < SEEN_TTL_MS) {
      // During initial scan: refresh the timestamp so 48h TTL restarts from now.
      // Prevents entries from expiring and trickling back in on future scans.
      if (opts.initialScan) { seen[key] = Date.now(); seenModified = true; }
      seenSkipped++;
      continue;
    }
    if (watcher.maxPrice && listing.price > watcher.maxPrice) continue;
    if (watcher.minPrice && listing.price < watcher.minPrice) continue;

    // On regular scans: drop listings posted before the initial scan completed.
    // Backfill already covered everything older — this blocks old listings
    // from trickling in on subsequent 30-min scans.
    if (initialScanCutoff && !opts.initialScan && !opts.backfill) {
      // listedAtUnknown means Apify couldn't parse the date, so listedAt was set to
      // the current scrape time — it always passes the cutoff check even for old listings.
      // Treat these conservatively: mark seen and skip rather than risking a flood.
      if (listing.listedAtUnknown) {
        seen[key] = Date.now();
        seenModified = true;
        continue;
      }
      const listedTs = listing.listedAt ? new Date(listing.listedAt).getTime() : null;
      if (listedTs && listedTs < initialScanCutoff) {
        seen[key] = Date.now();
        seenModified = true;
        continue;
      }
    }

    seen[key] = Date.now();

    storeScanPrice(keyword, listing).catch(() => {});

    if (!userListings.find(l => l.id === listing.id)) {
      userListings.unshift(listing);
      userListings.sort((a, b) => {
        // Push listings with unknown dates to the bottom
        if (a.listedAtUnknown && !b.listedAtUnknown) return 1;
        if (!a.listedAtUnknown && b.listedAtUnknown) return -1;
        return new Date(b.listedAt || b.foundAt) - new Date(a.listedAt || a.foundAt);
      });
      if (userListings.length > 500) userListings.length = 500;
    }
    newCount++;
    const pToken   = watcher.pushoverToken || process.env.PUSHOVER_TOKEN;
    const pUser    = watcher.pushoverUser  || process.env.PUSHOVER_USER;
    const priceStr = listing.price ? `$${listing.price}` : 'Price unknown';
    // Pushover notification (if configured)
    await sendPushover(pToken, pUser, `FlipRadar: ${keyword}`, `${listing.title}\n${priceStr}`, listing.url);
    // Web push notification — works even when app is closed, no extra app needed
    sendWebPush(watcher.userId, {
      title:  `FlipRadar: ${listing.title}`,
      body:   `${priceStr} · ${listing.location || keyword}`,
      url:    listing.url,
      tag:    `listing-${listing.id}`,
    }).catch(() => {});
    await sleep(300);
  }

  if (newCount > 0) {
    await saveUserListings(userId, userListings);
    await saveUserSeen(userId, seen);
  } else if (seenModified) {
    // Seen map changed (cutoff blocks or initial-scan refreshes) but no new listings.
    // Must persist so those entries survive across the next scan cycle.
    await saveUserSeen(userId, seen);
  }

  return { newCount, userListings };
}

// ── Per-watch scan — shared cache across all users ────────
// If two users watch "mercedes benz", only ONE Apify call is made per 25 mins
// Both users get results from the shared cache — huge cost saving
async function scanWatchItem(watcher, opts = {}) {
  const keyword = watcher.keyword.toLowerCase();

  // ── Check shared scan cache first ────────────────────────
  let raw;
  const cached = await redisGet(K.sharedScan(keyword));
  if (!opts.initialScan && cached && (Date.now() - new Date(cached.scannedAt).getTime()) < SHARED_SCAN_TTL_MS) {
    // Serve from cache — slice to regular scan limit
    raw = (cached.listings || []).slice(0, 25);
    console.log(`[SharedCache] "${keyword}" → ${raw.length} listings from cache (no Apify call)`);
  } else {
    // ── No cache — run Apify scan and cache results ───────
    raw = await scrapeKeyword(keyword, {
      city: watcher.location, lat: watcher.lat, lng: watcher.lng,
      radius: watcher.radius, initialScan: opts.initialScan || false
    });
    // Save to shared cache so other users watching same keyword skip Apify
    await redisSet(K.sharedScan(keyword), { listings: raw, scannedAt: new Date().toISOString() });
    console.log(`[SharedCache] "${keyword}" → cached ${raw.length} listings`);

    // ── Also distribute to ALL other users watching this keyword ──
    // So when user 2's timer fires, they already have the results without an Apify call
    const otherWatchers = watchlist.filter(w =>
      w.keyword.toLowerCase() === keyword &&
      w.userId !== watcher.userId &&
      !w.paused
    );
    for (const other of otherWatchers) {
      await distributeListingsToUser(other, raw).catch(e =>
        console.error(`[SharedCache] Error distributing to user ${other.userId}:`, e.message)
      );
    }
  }

  // NOTE: We do NOT clear seen cache on initial scan anymore
  // This preserves existing listings in the feed when adding a new keyword

  // ── Distribute to this user ───────────────────────────────
  // Safety net — ensure raw is always an array
  if (!Array.isArray(raw)) raw = [];

  // On initial scan: sort by recency so the feed shows newest first.
  // No cap — let all scraped listings through (up to 50).
  if (opts.initialScan && raw.length > 1) {
    raw = [...raw].sort((a, b) => {
      if (a.listedAtUnknown && !b.listedAtUnknown) return 1;
      if (!a.listedAtUnknown && b.listedAtUnknown) return -1;
      return new Date(b.listedAt || b.foundAt || 0) - new Date(a.listedAt || a.foundAt || 0);
    });
    console.log(`[InitialScan] "${keyword}" → passing all ${raw.length} listings through`);
  }

  const { newCount, userListings } = await distributeListingsToUser(watcher, raw, opts);

  // ── Vehicle detail fallback ───────────────────────────────
  // Only for non-vehicle keywords where includeDetails was false
  const kwIsVehicle = isVehicleKeyword(keyword);
  const needsDetail = !kwIsVehicle ? userListings.filter(l =>
    l.keyword === keyword &&
    isVehicleListing(keyword, l.title, l.description) &&
    l.mileage === null &&
    l.url &&
    (Date.now() - new Date(l.foundAt).getTime()) < 2 * 60 * 1000
  ) : [];

  if (needsDetail.length > 0) {
    console.log(`[DetailScrape] ${needsDetail.length} vehicle listing(s) under non-vehicle keyword "${keyword}"`);
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
      const uid = watcher.userId;
      await saveUserListings(uid, userListings);
      console.log(`[DetailScrape] Updated ${needsDetail.length} listing(s) with vehicle details`);
    }
  }

  // Mark initial scan complete — regular scans will filter by listedAt after this timestamp
  if (opts.initialScan) {
    watcher.initialScanCompletedAt = new Date().toISOString();
  }

  watcher.lastScanned = new Date().toISOString();
  await saveWatch(watcher);
  console.log(`[Scan] "${keyword}" (${watcher.plan||'basic'}) → ${newCount} new`);
  return newCount;
}

// ── Per-watch timers ──────────────────────────────────────
const watchTimers = {};

function startWatchTimer(watcher) {
  if (watchTimers[watcher.id]) clearInterval(watchTimers[watcher.id]);
  const interval = PLAN_INTERVALS[getEffectivePlan(watcher)] || PLAN_INTERVALS.basic;
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

// ── Boot: load all watches from Redis ─────────────────────
async function loadAllWatches() {
  // Resolve owner userId so watcher-level plan checks work
  const ownerUid = await redisGet(K.emailIdx(OWNER_EMAIL));
  if (ownerUid) { ownerUserId = ownerUid; console.log(`[Boot] Owner account resolved: ${ownerUid}`); }

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
  apify:  APIFY_TOKEN     ? 'connected' : 'NO APIFY_TOKEN SET',
  redis:  REDIS_URL       ? 'connected' : 'not set',
  gemini: GEMINI_API_KEY  ? 'connected' : 'not set',
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
    const verifyCode   = String(Math.floor(100000 + Math.random() * 900000));
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
      verifyExpiry:  new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };
    await saveUser(user);
    await redisSet(K.emailIdx(user.email), user.id);
    const token = makeToken(user.id);
    console.log(`[Auth] Signup: ${user.email}`);
    verificationEmail(user.name, user.email, verifyCode).catch(e => console.error('[Email] Verify failed:', e.message));
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, plan: getEffectivePlan(user), emailVerified: false } });
  } catch (e) { console.error('[Signup]', e.message); res.status(500).json({ error: 'Server error' }); }
});

app.post('/auth/verify-email', authMiddleware, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Verification code required' });
    const user = await getUser(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.emailVerified) return res.json({ ok: true, alreadyVerified: true });
    if (!user.verifyCode || user.verifyCode !== String(code).trim())
      return res.status(400).json({ error: 'Incorrect code. Please check your email and try again.' });
    if (new Date(user.verifyExpiry) < new Date())
      return res.status(400).json({ error: 'Code expired. Request a new one.' });
    user.emailVerified = true;
    delete user.verifyCode;
    delete user.verifyExpiry;
    await saveUser(user);
    console.log(`[Auth] Email verified: ${user.email}`);
    welcomeEmail(user.name, user.email).catch(e => console.error('[Email] Welcome failed:', e.message));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/auth/resend-verify', authMiddleware, async (req, res) => {
  try {
    const user = await getUser(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.emailVerified) return res.json({ ok: true, alreadyVerified: true });
    const verifyCode  = String(Math.floor(100000 + Math.random() * 900000));
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
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, plan: getEffectivePlan(user) } });
  } catch (e) { console.error('[Login]', e.message); res.status(500).json({ error: 'Server error' }); }
});

app.post('/auth/ping', authMiddleware, async (req, res) => {
  try {
    const user = await getUser(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.lastSeen = new Date().toISOString();
    await saveUser(user);
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
    res.json({ id: user.id, email: user.email, name: user.name, plan: getEffectivePlan(user), lastSeen: user.lastSeen });
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
    const user = await getUser(req.userId);
    const planLimit = PLAN_WATCHLIST_LIMITS[getEffectivePlan(user)];
    const existingWatches = await getUserWatches(req.userId);
    if (!isOwner(user) && existingWatches.length >= planLimit)
      return res.status(403).json({ error: 'Watchlist limit reached for your plan', plan: getEffectivePlan(user), limit: planLimit });
    const watchPlan = plan || (speed === 'premium' ? 'premium' : 'basic');
    const rawExclude = req.body.excludeWords || [];
    const excludeWords = Array.isArray(rawExclude)
      ? rawExclude.map(w => w.toLowerCase().trim()).filter(Boolean)
      : [];

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
      excludeWords,  // stored on watch — used to filter listings before saving
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
    // Clear any stale seen entries for this keyword so the initial scan delivers fresh results
    getUserSeen(req.userId).then(seen => {
      const prefix = `${item.keyword}:`;
      if (!Object.keys(seen).some(k => k.startsWith(prefix))) return;
      const pruned = Object.fromEntries(Object.entries(seen).filter(([k]) => !k.startsWith(prefix)));
      return saveUserSeen(req.userId, pruned, { merge: false }); // replace — we're removing entries
    }).catch(() => {});
    // Initial backfill — runs once when watch is added
    // DO NOT also call /scan/now — that causes a double scan
    scanWatchItem(item, { initialScan: true })
      .then(n => console.log(`[InitialScan] "${item.keyword}" → ${n} listing(s)`))
      .catch(e => console.error(`[InitialScan] Error:`, e.message));
  } catch (e) { console.error('[AddWatch]', e.message); res.status(500).json({ error: 'Server error' }); }
});

// PATCH /watchlist/:id — update exclude words on existing watch
app.patch('/watchlist/:id', authMiddleware, async (req, res) => {
  try {
    const watch = await getWatch(req.params.id);
    if (!watch || watch.userId !== req.userId)
      return res.status(404).json({ error: 'Not found' });
    const { excludeWords } = req.body;
    if (Array.isArray(excludeWords)) {
      watch.excludeWords = excludeWords.map(w => w.toLowerCase().trim()).filter(Boolean);
      await saveWatch(watch);
      // Update in-memory watchlist too
      const idx = watchlist.findIndex(w => w.id === req.params.id);
      if (idx !== -1) watchlist[idx].excludeWords = watch.excludeWords;
    }
    res.json({ ok: true, excludeWords: watch.excludeWords });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/watchlist/:id', authMiddleware, async (req, res) => {
  try {
    const watch = await getWatch(req.params.id);
    if (!watch || watch.userId !== req.userId)
      return res.status(404).json({ error: 'Not found' });
    const keyword = watch.keyword;
    stopWatchTimer(req.params.id);
    await deleteWatch(req.params.id);
    await removeWatchId(req.userId, req.params.id);
    await removeFromGlobalWatchIndex(req.params.id);
    watchlist = watchlist.filter(w => w.id !== req.params.id);

    // Clear blocked listings for this keyword so they show fresh if re-added
    const blocked = await redisGet(K.blocked(req.userId)) || [];
    const remaining = blocked.filter(l => l.keyword !== keyword);
    await redisSet(K.blocked(req.userId), remaining);

    // Clear seen cache entries for this keyword so re-adding starts truly fresh
    const seen = await getUserSeen(req.userId);
    const prefix = `${keyword}:`;
    const prunedSeen = Object.fromEntries(Object.entries(seen).filter(([k]) => !k.startsWith(prefix)));
    await saveUserSeen(req.userId, prunedSeen, { merge: false }); // replace — we're removing entries
    const clearedSeen = Object.keys(seen).length - Object.keys(prunedSeen).length;
    console.log(`[Watch] Deleted "${keyword}" — cleared ${blocked.length - remaining.length} blocked, ${clearedSeen} seen entries`);

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
    result = [...result].sort((a, b) => {
        // Push listings with unknown dates to the bottom
        if (a.listedAtUnknown && !b.listedAtUnknown) return 1;
        if (!a.listedAtUnknown && b.listedAtUnknown) return -1;
        return new Date(b.listedAt || b.foundAt) - new Date(a.listedAt || a.foundAt);
      });
    res.json(result);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/listings', authMiddleware, async (req, res) => {
  try {
    await saveUserListings(req.userId, []);
    await saveUserSeen(req.userId, {}, { merge: false }); // full reset — replace, don't merge
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// GET /listings/blocked — get listings that were filtered out
app.get('/listings/blocked', authMiddleware, async (req, res) => {
  try {
    const blocked = await redisGet(K.blocked(req.userId)) || [];
    res.json(blocked);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// POST /listings/unblock — move a blocked listing back into the feed
app.post('/listings/unblock', authMiddleware, async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });
    const blocked = await redisGet(K.blocked(req.userId)) || [];
    const listing = blocked.find(l => l.id === id);
    if (!listing) return res.status(404).json({ error: 'Not found' });
    // Remove from blocked
    await redisSet(K.blocked(req.userId), blocked.filter(l => l.id !== id));
    // Add to user listings
    const listings = await getUserListings(req.userId);
    if (!listings.find(l => l.id === id)) {
      listings.unshift({ ...listing, foundAt: new Date().toISOString() });
      listings.sort((a, b) => {
        // Push listings with unknown dates to the bottom
        if (a.listedAtUnknown && !b.listedAtUnknown) return 1;
        if (!a.listedAtUnknown && b.listedAtUnknown) return -1;
        return new Date(b.listedAt || b.foundAt) - new Date(a.listedAt || a.foundAt);
      });
      await saveUserListings(req.userId, listings);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// POST /listings/remove — remove specific listings by ID (irrelevant ones flagged by AI)
app.post('/listings/remove', authMiddleware, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });
    const listings = await getUserListings(req.userId);
    const filtered = listings.filter(l => !ids.includes(l.id));
    await saveUserListings(req.userId, filtered);
    // Don't mark as permanently seen — if user re-adds the keyword they should see fresh listings
    console.log(`[Filter] Removed ${ids.length} irrelevant listing(s) for user ${req.userId}`);
    res.json({ ok: true, removed: ids.length });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Price cache route — lets frontend check own scan history before triggering AI ──
app.get('/prices', authMiddleware, async (req, res) => {
  try {
    const { keyword } = req.query;
    if (!keyword) return res.status(400).json({ error: 'keyword required' });
    const priceData = await getPriceCacheForKeyword(keyword);
    console.log('[Prices] Result for', keyword, ':', priceData ? 'found (' + priceData.count + ' prices, median $' + priceData.median + ')' : 'not found');
    if (!priceData) return res.json({ found: false, keyword });
    res.json({ found: true, keyword, ...priceData });
  } catch (e) { console.error('[Prices] Error:', e.message); res.status(500).json({ error: 'Server error' }); }
});

// GET /prices/vehicle?make=Toyota&model=Camry&year=2019&mileage=72000
// Returns VPX market stats for a specific vehicle cohort
app.get('/prices/vehicle', authMiddleware, async (req, res) => {
  try {
    const { make, model, year, mileage } = req.query;
    if (!make || !year) return res.status(400).json({ error: 'make and year required' });
    const resolvedModel = model || null;
    const stats = await getVehiclePriceStats(make, resolvedModel, parseInt(year), mileage ? parseInt(mileage) : null);
    if (!stats) return res.json({ found: false, make, model, year });
    res.json({ found: true, ...stats });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Appraisal route — limit check only, always defers to AI ──
// POST /appraise  { keyword, price }
app.post('/appraise', authMiddleware, async (req, res) => {
  try {
    const { keyword, price } = req.body;
    if (!keyword || !price) return res.status(400).json({ error: 'keyword and price required' });
    const user = await _getUserCached(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const today = new Date().toISOString().slice(0, 10);
    if (user.appraisalDate !== today) { user.appraisalsToday = 0; user.appraisalDate = today; }
    const limit = PLAN_APPRAISAL_LIMITS[getEffectivePlan(user)];
    if (limit !== Infinity && limit < 999 && user.appraisalsToday >= limit)
      return res.status(429).json({ error: 'Daily appraisal limit reached', limit, plan: getEffectivePlan(user) });
    res.json({ found: false, usedCache: false });
  } catch (e) { console.error('[Appraise]', e.message); res.status(500).json({ error: 'Server error' }); }
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

app.post('/stripe/create-intent', authMiddleware, async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
    const { priceId } = req.body;
    if (!priceId || !Object.values(PRICE_IDS).includes(priceId))
      return res.status(400).json({ error: 'Invalid price' });
    const user = await getUser(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, name: user.name, metadata: { userId: user.id } });
      customerId = customer.id;
      user.stripeCustomerId = customerId;
      await saveUser(user);
    }
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      expand: ['latest_invoice.payment_intent'],
      metadata: { userId: user.id, priceId },
    });
    const clientSecret = subscription.latest_invoice.payment_intent.client_secret;
    res.json({ clientSecret, subscriptionId: subscription.id });
  } catch (e) { console.error('[Stripe] Intent error:', e.message); res.status(500).json({ error: e.message }); }
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

app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.json({ ok: true });
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (e) { console.error('[Stripe] Webhook sig failed:', e.message); return res.status(400).send('Webhook Error'); }
  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId  = session.metadata?.userId;
      const priceId = session.metadata?.priceId;
      if (userId && priceId) {
        const user = await getUser(userId);
        if (user) {
          user.plan = PRICE_TO_PLAN[priceId] || 'basic';
          user.stripeCustomerId     = session.customer;
          user.stripeSubscriptionId = session.subscription;
          await saveUser(user);
          console.log(`[Stripe] Upgraded ${user.email} to ${user.plan}`);
        }
      }
    }
    if (event.type === 'customer.subscription.deleted' || event.type === 'customer.subscription.paused') {
      const sub    = event.data.object;
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
    const today    = new Date().toISOString().slice(0, 10);
    const appraised = user.appraisalDate === today ? (user.appraisalsToday || 0) : 0;
    const limit     = PLAN_APPRAISAL_LIMITS[getEffectivePlan(user)];
    res.json({
      plan: getEffectivePlan(user),
      appraisalsUsedToday: appraised,
      appraisalsLimit:     limit === Infinity ? -1 : limit,
      watchlistLimit:      PLAN_WATCHLIST_LIMITS[getEffectivePlan(user)],
    });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/auth/appraisal', authMiddleware, async (req, res) => {
  try {
    const cr = await consumeAppraisal(req.userId);
    if (!cr.ok) return res.status(cr.status).json({ error: cr.error, limit: cr.limit, plan: cr.plan });
    res.json({ ok: true, used: cr.used, limit: cr.limit });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Web Push notification sender ─────────────────────────
async function sendWebPush(userId, payload) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  try {
    const subs = await redisGet(K_push(userId));
    if (!subs || !subs.length) return;
    webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    const msg = JSON.stringify(payload);
    const results = await Promise.allSettled(
      subs.map(sub => webpush.sendNotification(sub, msg))
    );
    // Remove expired/invalid subscriptions
    const valid = subs.filter((_, i) => results[i].status === 'fulfilled');
    if (valid.length !== subs.length) await redisSet(K_push(userId), valid);
  } catch (e) {
    console.error('[WebPush] Error:', e.message);
  }
}

// POST /push/subscribe — save user's push subscription
app.post('/push/subscribe', authMiddleware, async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'subscription required' });
    const subs = await redisGet(K_push(req.userId)) || [];
    // Avoid duplicates
    const exists = subs.find(s => s.endpoint === subscription.endpoint);
    if (!exists) {
      subs.push(subscription);
      await redisSet(K_push(req.userId), subs);
    }
    console.log(`[WebPush] Subscribed user ${req.userId}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// DELETE /push/subscribe — remove subscription
app.delete('/push/subscribe', authMiddleware, async (req, res) => {
  try {
    const { endpoint } = req.body;
    const subs = await redisGet(K_push(req.userId)) || [];
    await redisSet(K_push(req.userId), subs.filter(s => s.endpoint !== endpoint));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// GET /push/vapid-key — gives frontend the public key to subscribe with
app.get('/push/vapid-key', (req, res) => {
  if (!VAPID_PUBLIC_KEY) return res.status(500).json({ error: 'Push not configured' });
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// ── AI proxy routes — keys live on server, never in browser ──
const GEMINI_API_KEY    = process.env.GEMINI_API_KEY    || null;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || null;

// ── Gemini call helper with retry + text-only fallback ────
// Retries once on 503/429 (Gemini overload) after a short delay.
// If an image+text call fails, automatically retries with text-only.
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`;
async function callGemini(parts, { retries = 2, timeout = 30000 } = {}) {
  const body = { contents: [{ parts }], generationConfig: { thinkingConfig: { thinkingBudget: 0 } } };
  const url   = `${GEMINI_URL}?key=${GEMINI_API_KEY}`;
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await axios.post(url, body, { headers: { 'Content-Type': 'application/json' }, timeout });
      const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (!text && attempt < retries) { await sleep(1500); continue; } // empty response — retry
      return text;
    } catch (e) {
      lastErr = e;
      const status = e.response?.status;
      if ((status === 503 || status === 429 || status === 500) && attempt < retries) {
        console.log(`[Gemini] ${status} on attempt ${attempt}, retrying in 2s...`);
        await sleep(2000);
        // If this was an image+text call, strip images on the last retry (text-only fallback)
        if (attempt === retries - 1) {
          const textOnly = parts.filter(p => p.text != null);
          if (textOnly.length < parts.length) {
            console.log('[Gemini] Falling back to text-only parts');
            body.contents[0].parts = textOnly;
          }
        }
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// ── Web Push (VAPID) ──────────────────────────────────────
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || null;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || null;
const VAPID_EMAIL       = process.env.VAPID_EMAIL       || 'mailto:admin@flip-radar.app';

// POST /seed/vehicles — owner-only: triggers Carsales seeding for all TOP_AU_SEED_MODELS
app.post('/seed/vehicles', authMiddleware, async (req, res) => {
  try {
    const user = await getUser(req.userId);
    if (!isOwner(user)) return res.status(403).json({ error: 'Owner only' });
    const total = TOP_AU_SEED_MODELS.length;
    res.json({ ok: true, message: `Seeding ${total} vehicle cohorts in background` });
    (async () => {
      let seeded = 0;
      for (const { make, model, year } of TOP_AU_SEED_MODELS) {
        try {
          const n = await scrapeCarsalesForModel(make, model, year);
          if (n > 0) seeded++;
          console.log(`[Seed/vehicles] ${make} ${model} ${year} → ${n} samples`);
        } catch (e) { console.error(`[Seed/vehicles] ${make} ${model} ${year}:`, e.message); }
        await sleep(2000);
      }
      console.log(`[Seed/vehicles] Done — ${seeded}/${total} cohorts seeded`);
    })();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Redis key for push subscriptions
const K_push = userId => `fr:push:${userId}`;

// POST /ai/vehicle — vehicle-specific AI appraisal (pure AI, no market data lookup)
// Body: { make, model, year, mileage, listingPrice, title, description, imageUrl?, imageBase64?, imageMime? }
app.post('/ai/vehicle', authMiddleware, async (req, res) => {
  try {
    if (!GEMINI_API_KEY && !ANTHROPIC_API_KEY) return res.status(500).json({ error: 'No AI keys configured' });

    const { make, model, year, mileage, transmission, listingPrice, title, description, imageUrl, imageBase64, imageMime } = req.body;
    if (!listingPrice) return res.status(400).json({ error: 'listingPrice required' });

    const cr = await consumeAppraisal(req.userId);
    if (!cr.ok) return res.status(cr.status).json({ error: cr.error, limit: cr.limit, plan: cr.plan });

    const carLabel = [year, make, model].filter(Boolean).join(' ') || 'this vehicle';
    const vehicleDetails = [
      `Make/Model/Year: ${carLabel}`,
      mileage ? `Mileage: ${Number(mileage).toLocaleString()} km` : null,
      transmission ? `Transmission: ${transmission}` : null,
      `Listing Price: $${Number(listingPrice).toLocaleString()}`,
    ].filter(Boolean).join('\n');

    const mileageGuide = mileage
      ? `Mileage context: <80k premium, 80-130k normal, 130-180k ~10-20% below median, 180-250k ~25-40% below, >250k hard sell.`
      : `Mileage not provided - flag as red flag, widen resell range to reflect uncertainty.`;

    // Patch E: inject FlipRadar's own AU scan data when we have enough samples.
    // Anchors Gemini to real AU private-sale prices instead of general knowledge.
    let vpxContext = '';
    if (make && model && year) {
      try {
        const vpx = await getVehiclePriceStats(make, model, parseInt(year), mileage ? parseInt(mileage) : null);
        if (vpx && vpx.samples >= 10) {
          const fmtP = n => '$' + (Math.round(n / 500) * 500).toLocaleString();
          vpxContext = `\nFLIPRADAR AU DATA (${vpx.samples} comparable AU private-sale listings):\n`
            + `Market median: ${fmtP(vpx.marketMedian)}${vpx.mileageAdjusted ? ' (mileage-adjusted)' : ''}\n`
            + `Range: ${fmtP(vpx.marketLow)} - ${fmtP(vpx.marketHigh)}\n`
            + `Use these as your primary pricing anchor. Estimates should be within ~20% of the median unless exceptional reason.`;
        }
      } catch (_) {} // VPX lookup is best-effort; never block appraisal
    }

    const prompt = `You are an expert Australian used-vehicle flipper. Analyse conservatively using AU private-sale market knowledge.

VEHICLE:
${vehicleDetails}
${mileageGuide}${vpxContext}

TITLE: ${title || '(not provided)'}
DESCRIPTION: ${description || '(not provided)'}

RULES:
- Deduct ~8% selling fees + $200-500 prep before calculating profit
- STEAL only if margin is genuinely exceptional after all costs
- Use round numbers ($500 increments) - no fake precision like $11,847
- If uncertain, use wider resell range and softer wording in whyItsWorth
- Broken/project (spares, not running, damage, blown HG, needs work, as-is): isBrokenOrProject true, realistic repairEstimate AUD, subtract from profit, cap verdict at FAIR

Respond ONLY with raw JSON (no markdown):
{"verdict":"STEAL|GOOD DEAL|FAIR|PASS","dealScore":0-100,"oneLiner":"punchy sentence","extractedTitle":"cleaned title","extractedPrice":number,"extractedMileage":number or null,"estimatedMarketValue":number,"estimatedResellLow":number,"estimatedResellHigh":number,"recommendedOffer":number,"walkAwayPrice":number,"estimatedProfit":number,"roiPercent":number,"timeToSell":"e.g. 1-3 days","demandLevel":"High or Moderate or Low","whyItsWorth":"1-2 sentences","greenFlags":["..."],"redFlags":["..."],"whatToCheckInPerson":["..."],"negotiationScript":"what to say","isBrokenOrProject":false,"repairEstimate":0,"repairNotes":"","aiGenerated":true}`;

    // Prefer Gemini when image is available, otherwise Claude Haiku
    let text = '';
    const hasImage = !!(imageBase64 || imageUrl);

    if (GEMINI_API_KEY && hasImage) {
      const parts = [];
      if (imageBase64 && imageMime) {
        parts.push({ inline_data: { mime_type: imageMime, data: imageBase64 } });
      } else if (imageUrl) {
        // Race image fetch vs 1.5s — expired FB CDN URLs can stall for 3–10s; proceed text-only on timeout
        try {
          const imgFetch = axios.get(imageUrl, {
            responseType: 'arraybuffer', timeout: 8000,
            headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.facebook.com/' },
          });
          const imgTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error('img_timeout')), 1500));
          const imgRes = await Promise.race([imgFetch, imgTimeout]);
          parts.push({ inline_data: { mime_type: imgRes.headers['content-type'] || 'image/jpeg', data: Buffer.from(imgRes.data).toString('base64') } });
        } catch (_) {
          console.log('[AI/vehicle] Image skipped (timeout/error), proceeding text-only');
        }
      }
      parts.push({ text: prompt });
      text = await callGemini(parts); // retry + text-only fallback on 503
    } else if (GEMINI_API_KEY) {
      text = await callGemini([{ text: prompt }]);
    } else {
      const claudeRes = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }, { headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, timeout: 60000 });
      text = claudeRes.data?.content?.[0]?.text || '';
    }

    // Parse structured JSON from AI response
    let parsed = null;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    } catch (_) {}

    if (parsed) {
      res.json({ ...parsed, text, usedCache: false });
    } else {
      res.json({ text, usedCache: false });
    }
  } catch (e) {
    console.error('[AI/vehicle]', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// POST /ai/image — image scan via Gemini Flash
// Body: { parts: [ { inline_data: { mime_type, data } }, { text: prompt } ] }
app.post('/ai/image', authMiddleware, async (req, res) => {
  try {
    if (!GEMINI_API_KEY) return res.status(500).json({ error: 'Gemini not configured on server' });
    const { parts } = req.body;
    if (!parts || !Array.isArray(parts)) return res.status(400).json({ error: 'parts array required' });

    // Check appraisal limit
    const cr = await consumeAppraisal(req.userId);
    if (!cr.ok) return res.status(cr.status).json({ error: cr.error, limit: cr.limit, plan: cr.plan });

    const text = await callGemini(parts); // retry on 503
    res.json({ text });
  } catch (e) {
    console.error('[AI/image]', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// POST /ai/text — text-only calls via Claude Haiku
// Body: { prompt: string }
app.post('/ai/text', authMiddleware, async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Anthropic not configured on server' });
    const { prompt, max_tokens } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    // Check appraisal limit
    const cr = await consumeAppraisal(req.userId);
    if (!cr.ok) return res.status(cr.status).json({ error: cr.error, limit: cr.limit, plan: cr.plan });

    const claudeRes = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: max_tokens || 1500,
      messages: [{ role: 'user', content: prompt }],
    }, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      timeout: 60000,
    });
    const text = claudeRes.data?.content?.[0]?.text || '';
    res.json({ text });
  } catch (e) {
    console.error('[AI/text]', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// POST /ai/text-image — text scan with an image fetched via URL (listing image)
// Body: { prompt: string, imageUrl: string }
app.post('/ai/text-image', authMiddleware, async (req, res) => {
  try {
    if (!GEMINI_API_KEY) return res.status(500).json({ error: 'Gemini not configured on server' });
    const { prompt, imageUrl } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    // Check appraisal limit
    const cr = await consumeAppraisal(req.userId);
    if (!cr.ok) return res.status(cr.status).json({ error: cr.error, limit: cr.limit, plan: cr.plan });

    var parts = [{ text: prompt }];

    // If there's an image URL, fetch and include it
    if (imageUrl) {
      try {
        const imgRes = await axios.get(imageUrl, {
          responseType: 'arraybuffer', timeout: 10000,
          headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.facebook.com/' }
        });
        const b64 = Buffer.from(imgRes.data).toString('base64');
        const mime = imgRes.headers['content-type'] || 'image/jpeg';
        parts = [{ inline_data: { mime_type: mime, data: b64 } }, { text: prompt }];
      } catch(e) {
        console.log('[AI/text-image] Could not fetch image, proceeding text-only');
      }
    }

    const text = await callGemini(parts); // retry + text-only fallback on 503
    res.json({ text });
  } catch (e) {
    console.error('[AI/text-image]', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// ── DEV: force-set plan (secret-gated, remove before public launch) ──
// POST /dev/set-plan  { secret: "...", plan: "premium" }
const DEV_SECRET = process.env.DEV_SECRET || 'flipradar-dev';
app.post('/dev/set-plan', authMiddleware, async (req, res) => {
  const { secret, plan } = req.body;
  if (secret !== DEV_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const validPlans = ['free', 'basic', 'premium'];
  if (!validPlans.includes(plan)) return res.status(400).json({ error: 'plan must be free, basic, or premium' });
  const user = await getUser(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.plan = plan;
  await saveUser(user);
  console.log(`[Dev] Set plan for ${user.email} → ${plan}`);
  res.json({ ok: true, plan });
});

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`FlipRadar backend on port ${PORT}`);
  console.log(`Apify:      ${APIFY_TOKEN     ? 'set' : 'NO TOKEN'}`);
  console.log(`Redis:      ${REDIS_URL        ? 'connected' : 'NOT SET'}`);
  console.log(`Gemini:     ${GEMINI_API_KEY   ? 'connected' : 'NOT SET — add GEMINI_API_KEY'}`);
  console.log(`Anthropic:  ${ANTHROPIC_API_KEY? 'connected' : 'NOT SET — add ANTHROPIC_API_KEY'}`);;
  await loadAllWatches();
  console.log('[Ready] Server fully loaded');
});
