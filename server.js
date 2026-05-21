const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');
const axios   = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

let watchlist     = [];
let seenListings  = new Set();
let listings      = [];
let lastScanTime  = null;
let lastScanCount = 0;

async function sendPushover(title, message, url) {
  const token = process.env.PUSHOVER_TOKEN;
  const user  = process.env.PUSHOVER_USER;
  if (!token || !user) { console.log('[Pushover] Skipped — tokens not set'); return; }
  try {
    const payload = { token, user, title: title.slice(0,250), message: message.slice(0,1024), sound: 'cashregister' };
    if (url) payload.url = url;
    await axios.post('https://api.pushover.net/1/messages.json', payload);
    console.log('[Pushover] Sent:', title);
  } catch (e) { console.error('[Pushover] Error:', e.message); }
}

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const APIFY_ACTOR = 'curious_coder~facebook-marketplace';

async function scrapeKeyword(keyword, maxPrice) {
  if (!APIFY_TOKEN) { console.warn('[Apify] No token'); return []; }

  const encoded    = encodeURIComponent(keyword);
  const priceParam = maxPrice ? `&maxPrice=${maxPrice}` : '';
  const fbUrl      = `https://www.facebook.com/marketplace/melbourne/search/?query=${encoded}${priceParam}&sortBy=creation_time_descend&daysSinceListed=1`;

  const input = {
    urls: [fbUrl],
    maxItems: 25,
  };

  try {
    const runRes = await axios.post(
      `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items`,
      input,
      {
        params:  { token: APIFY_TOKEN },
        headers: { 'Content-Type': 'application/json' },
        timeout: 120000,
      }
    );

    const items = Array.isArray(runRes.data) ? runRes.data : [];
    console.log(`[Apify] "${keyword}" -> ${items.length} item(s)`);
    if (items.length > 0) console.log('[Apify] Sample:', JSON.stringify(items[0]).slice(0, 300));

    return items.map(item => {
      const id = item.id || String(item.marketplace_listing_id || '');
      const price = parsePrice(
        item.listing_price?.amount ||
        item.listing_price?.formatted_amount ||
        item.price
      );
      return {
        id,
        title:    item.marketplace_listing_title || item.title || item.name || keyword,
        price,
        url:      item.listingUrl || item.url || `https://www.facebook.com/marketplace/item/${id}/`,
        image:    item.primary_listing_photo_url || item.primary_listing_photo?.image?.uri || null,
        location: item.location?.reverse_geocode?.city || null,
        keyword,
        foundAt:  new Date().toISOString(),
      };
    }).filter(l => l.id);

  } catch (e) {
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
  if (typeof raw === 'number') return Math.round(raw);
  var f = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
  return Math.round(f) || 0;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runScan() {
  if (watchlist.length === 0) { console.log('[Scan] No keywords'); return; }
  console.log(`[Scan] Starting — ${watchlist.length} keyword(s)`);
  lastScanTime = new Date().toISOString();
  let totalNew = 0;
  let pushCount = 0;
  const MAX_PUSH = 3;

  for (const item of watchlist) {
    try {
      const found = await scrapeKeyword(item.keyword, item.maxPrice);
      for (const listing of found) {
        const key = `${item.keyword}:${listing.id}`;
        if (seenListings.has(key)) {
          console.log(`[Skip] Already seen: ${key}`);
          continue;
        }
        seenListings.add(key);
        if (item.maxPrice && listing.price > item.maxPrice) {
          console.log(`[Skip] Over max price: ${listing.title} $${listing.price} > $${item.maxPrice}`);
          continue;
        }
        totalNew++;
        listings.unshift(listing);
        if (listings.length > 200) listings = listings.slice(0, 200);

        if (pushCount < MAX_PUSH) {
          const priceStr = listing.price ? `$${listing.price}` : 'Price unknown';
          await sendPushover(`FlipRadar: ${item.keyword}`, `${listing.title}\n${priceStr}`, listing.url);
          pushCount++;
          await sleep(500);
        }
      }
    } catch (e) { console.error(`[Scan] Error on "${item.keyword}":`, e.message); }
  }

  if (totalNew > MAX_PUSH) {
    await sendPushover('FlipRadar', `+${totalNew - MAX_PUSH} more new listings found`, null);
  }

  lastScanCount = totalNew;
  console.log(`[Scan] Done — ${totalNew} new listing(s), ${pushCount} alerts sent`);
}

cron.schedule('*/15 * * * *', () => {
  runScan().catch(e => console.error('[Cron]', e.message));
});

app.get('/', (req, res) => res.json({
  status: 'ok',
  apify: APIFY_TOKEN ? 'connected' : 'NO APIFY_TOKEN SET',
  watchlist: watchlist.length,
  listingsCount: listings.length,
  lastScan: lastScanTime,
  lastScanNewListings: lastScanCount,
  seenTotal: seenListings.size,
}));

app.get('/watchlist', (req, res) => res.json(watchlist));

app.post('/watchlist', (req, res) => {
  const { keyword, maxPrice } = req.body;
  if (!keyword || typeof keyword !== 'string' || keyword.trim().length < 2)
    return res.status(400).json({ error: 'keyword required' });
  const item = { id: uuidv4(), keyword: keyword.trim(), maxPrice: maxPrice ? parseInt(maxPrice) : null, addedAt: new Date().toISOString() };
  watchlist.push(item);
  console.log(`[Watchlist] Added: "${item.keyword}"`);
  res.json(item);
});

app.delete('/watchlist/:id', (req, res) => {
  const before = watchlist.length;
  watchlist = watchlist.filter(w => w.id !== req.params.id);
  if (watchlist.length === before) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

app.get('/listings', (req, res) => res.json(listings));

app.delete('/listings', (req, res) => {
  listings = [];
  seenListings = new Set();
  console.log('[Clear] Listings and seenListings cleared');
  res.json({ ok: true });
});

app.post('/scan/now', async (req, res) => {
  res.json({ ok: true, message: 'Scan started' });
  runScan().catch(e => console.error('[Scan/now]', e.message));
});

app.post('/scan/test', async (req, res) => {
  const { keyword, maxPrice } = req.body;
  if (!keyword) return res.status(400).json({ error: 'keyword required' });
  try {
    const found = await scrapeKeyword(keyword, maxPrice ? parseInt(maxPrice) : null);
    res.json({ keyword, count: found.length, listings: found });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FlipRadar backend on port ${PORT}`);
  console.log(`Apify: ${APIFY_TOKEN ? 'token set' : 'NO TOKEN'}`);
  console.log(`Pushover: ${process.env.PUSHOVER_TOKEN ? 'set' : 'not set'}`);
});
