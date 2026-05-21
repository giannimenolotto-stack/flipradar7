const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');
const axios   = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

let watchlist    = [];
let seenListings = new Set();
let listings     = [];
let lastScanTime  = null;
let lastScanCount = 0;

async function sendPushover(token, user, title, message, url) {
  if (!token || !user) return;
  try {
    const payload = { token, user, title: title.slice(0,250), message: message.slice(0,1024), sound: 'cashregister' };
    if (url) payload.url = url;
    await axios.post('https://api.pushover.net/1/messages.json', payload);
  } catch (e) { console.error('[Pushover] Error:', e.message); }
}

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const APIFY_ACTOR = 'curious_coder~facebook-marketplace';

async function scrapeKeyword(keyword) {
  if (!APIFY_TOKEN) return [];

  const fbUrl = `https://www.facebook.com/marketplace/melbourne/search/?query=${encodeURIComponent(keyword)}&sortBy=creation_time_descend&daysSinceListed=1`;

  const input = {
    urls: [fbUrl],
    maxItems: 25,
    includeDetails: true,
  };

  try {
    const res = await axios.post(
      `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items`,
      input,
      { params: { token: APIFY_TOKEN }, headers: { 'Content-Type': 'application/json' }, timeout: 180000 }
    );

    const items = Array.isArray(res.data) ? res.data : [];
    const valid = items.filter(i => !i.error);
    console.log(`[Apify] "${keyword}" -> ${valid.length} item(s)`);
    if (valid.length > 0) console.log('[Apify] Sample:', JSON.stringify(valid[0]).slice(0, 500));

    return valid.map(item => {
      const id = item.id || item.listingId || String(item.marketplace_listing_id || '');
      return {
        id,
        title:       item.marketplace_listing_title || item.title || item.name || keyword,
        price:       parsePrice(item.listing_price?.amount || item.listing_price?.formatted_amount || item.price),
        url:         item.listingUrl || item.url || `https://www.facebook.com/marketplace/item/${id}/`,
        image:       item.primary_listing_photo_url || item.primary_listing_photo?.image?.uri || item.imageUrl || null,
        location:    typeof item.location === 'string' ? item.location : (item.location?.reverse_geocode?.city || null),
        description: item.redacted_description?.text || item.description || item.listing_description || null,
        keyword,
        foundAt:     new Date().toISOString(),
      };
    }).filter(l => l.id);

  } catch (e) {
    console.error(`[Apify] Error for "${keyword}":`, e.response ? JSON.stringify(e.response.data).slice(0,300) : e.message);
    return [];
  }
}

function parsePrice(raw) {
  if (!raw) return 0;
  if (typeof raw === 'number') return Math.round(raw);
  return Math.round(parseFloat(String(raw).replace(/[^0-9.]/g, '')) || 0);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
      if (seenListings.has(key)) continue;
      seenListings.add(key);

      listings.unshift(listing);
      if (listings.length > 500) listings = listings.slice(0, 500);
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
  console.log(`[Scan] Done — ${totalNew} new listing(s) from ${uniqueKeywords.length} unique keyword(s)`);
}

cron.schedule('*/15 * * * *', () => {
  runScan().catch(e => console.error('[Cron]', e.message));
});

app.get('/', (req, res) => res.json({
  status: 'ok',
  apify: APIFY_TOKEN ? 'connected' : 'NO APIFY_TOKEN SET',
  watches: watchlist.length,
  uniqueKeywords: [...new Set(watchlist.map(w => w.keyword.toLowerCase()))].length,
  listingsCount: listings.length,
  lastScan: lastScanTime,
  lastScanNewListings: lastScanCount,
  seenTotal: seenListings.size,
}));

app.get('/watchlist', (req, res) => {
  const userId = req.query.userId;
  res.json(userId ? watchlist.filter(w => w.userId === userId) : watchlist);
});

app.post('/watchlist', (req, res) => {
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
  console.log(`[Watch] Added "${item.keyword}" for user ${item.userId}`);
  res.json(item);
});

app.delete('/watchlist/:id', (req, res) => {
  const before = watchlist.length;
  watchlist = watchlist.filter(w => w.id !== req.params.id);
  if (watchlist.length === before) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

app.get('/listings', (req, res) => {
  const { keyword } = req.query;
  res.json(keyword ? listings.filter(l => l.keyword === keyword) : listings);
});

app.delete('/listings', (req, res) => {
  listings = [];
  seenListings = new Set();
  console.log('[Clear] Feed cleared');
  res.json({ ok: true });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FlipRadar backend on port ${PORT}`);
  console.log(`Apify: ${APIFY_TOKEN ? 'token set' : 'NO TOKEN'}`);
  console.log(`Pushover: ${process.env.PUSHOVER_TOKEN ? 'set' : 'not set'}`);
});
