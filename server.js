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
const { Pool } = require('pg');
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));

// ── PostgreSQL (Neon) ─────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL || null;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (e) => console.error('[DB] Pool error:', e.message));

async function initDB() {
  try {
    // ── Core listings table ───────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS listings (
        id              BIGSERIAL PRIMARY KEY,
        listing_id      TEXT UNIQUE NOT NULL,
        title           TEXT NOT NULL,
        description     TEXT,
        price           INTEGER,
        is_offer_price  BOOLEAN DEFAULT FALSE,
        currency        TEXT DEFAULT 'AUD',
        location        TEXT,
        state           TEXT,
        seller_name     TEXT,
        seller_id       TEXT,
        image_url       TEXT,
        url             TEXT,

        -- ── Search context ────────────────────────────────
        keyword         TEXT,   -- the search term that found this listing

        -- ── Category ─────────────────────────────────────
        category        TEXT,   -- 'vehicle' | 'general'

        -- ── Vehicle identity — as precise as possible ─────
        -- These are the dimensions that determine price cohort.
        -- A VE Commodore SS is NOT comparable to a VE Omega.
        -- A 2008 with 250k km is NOT comparable to a 2012 with 80k km.
        make            TEXT,   -- e.g. 'Holden'
        model           TEXT,   -- e.g. 'Commodore'
        series          TEXT,   -- e.g. 'VE', 'VF', 'FG', 'BF', 'NP', 'GU'
        variant         TEXT,   -- e.g. 'SS', 'SV6', 'Omega', 'Calais', 'XR6', 'ST'
        body_style      TEXT,   -- e.g. 'sedan', 'wagon', 'ute', 'hatch', 'van'
        year            INTEGER,-- manufacture year
        year_band       TEXT,   -- bucketed: e.g. '2006-2010', '2011-2013'
        kms             INTEGER,-- odometer reading in km
        mileage_band    TEXT,   -- bucketed: e.g. '0-50k', '50k-100k', '100k-150k', '150k-200k', '200k+'
        transmission    TEXT,   -- 'auto' | 'manual'
        fuel_type       TEXT,   -- 'petrol' | 'diesel' | 'hybrid' | 'electric'
        engine          TEXT,   -- e.g. '3.6L V6', '6.0L V8', '2.0T'
        drive_type      TEXT,   -- '2WD' | '4WD' | 'AWD'
        colour          TEXT,

        -- ── General item fields ───────────────────────────
        brand           TEXT,   -- for non-vehicles: e.g. 'Apple', 'Sony'
        item_model      TEXT,   -- e.g. 'iPhone 14 Pro', 'PlayStation 5'
        storage         TEXT,   -- for electronics: e.g. '256GB'
        condition       TEXT,   -- 'new' | 'like new' | 'good' | 'fair' | 'poor'

        -- ── Flexible attributes ───────────────────────────
        attributes      JSONB DEFAULT '{}',

        -- ── Lifecycle ─────────────────────────────────────
        listing_status  TEXT DEFAULT 'active',
        -- 'active'  = still live on FB
        -- 'sold'    = gone from FB, assumed sold — STAYS in price pool
        -- 'removed' = spam/scam, excluded from pool

        -- ── Timestamps ───────────────────────────────────
        listed_at       TIMESTAMPTZ,
        scraped_at      TIMESTAMPTZ DEFAULT NOW(),
        last_seen_at    TIMESTAMPTZ DEFAULT NOW(),
        is_active       BOOLEAN DEFAULT TRUE,
        seen_count      INTEGER DEFAULT 1,

        -- ── Data quality ──────────────────────────────────
        price_quality   TEXT DEFAULT 'unscored',
        -- 'ok' | 'outlier' | 'not_for_sale' | 'suspicious' | 'spam' | 'offer_price'

        quality_flags   INTEGER DEFAULT 0,
        -- bit 1: damage/broken/spares
        -- bit 2: swap/trade listing
        -- bit 3: statistical outlier (IQR)
        -- bit 4: price below category floor
        -- bit 5: price above category ceiling
        -- bit 6: spam signals

        in_price_pool   BOOLEAN DEFAULT TRUE,
        -- FALSE if any quality flag set — never used in price calculations

        -- ── Price drop tracking ───────────────────────────
        previous_price    INTEGER,               -- price before the drop
        price_dropped_at  TIMESTAMPTZ            -- when the drop was detected
      );

      -- ── Indexes ───────────────────────────────────────────
      -- Keyword pool index (general items)
      CREATE INDEX IF NOT EXISTS idx_kw_pool
        ON listings(keyword, price)
        WHERE price > 0 AND is_offer_price = FALSE
          AND in_price_pool = TRUE AND category = 'general';

      -- Vehicle cohort index — the main one for precise vehicle matching
      CREATE INDEX IF NOT EXISTS idx_veh_cohort
        ON listings(make, model, series, variant, year, mileage_band, transmission)
        WHERE make IS NOT NULL AND price > 0
          AND is_offer_price = FALSE AND in_price_pool = TRUE;

      -- Vehicle broad index — fallback when cohort is too small
      CREATE INDEX IF NOT EXISTS idx_veh_broad
        ON listings(make, model, year_band)
        WHERE make IS NOT NULL AND price > 0
          AND is_offer_price = FALSE AND in_price_pool = TRUE;

      CREATE INDEX IF NOT EXISTS idx_listings_state     ON listings(state);
      CREATE INDEX IF NOT EXISTS idx_listings_scraped   ON listings(scraped_at DESC);
      CREATE INDEX IF NOT EXISTS idx_listings_status    ON listings(listing_status);
      CREATE INDEX IF NOT EXISTS idx_listings_quality   ON listings(price_quality);
      CREATE INDEX IF NOT EXISTS idx_listings_category  ON listings(category);
    `);

    // ── Pre-computed stats tables ──────────────────────────
    await pool.query(`
      -- General keyword stats (IQR-cleaned, rebuilt nightly)
      CREATE TABLE IF NOT EXISTS keyword_price_stats (
        keyword         TEXT PRIMARY KEY,
        sample_count    INTEGER,
        raw_count       INTEGER,
        median_price    INTEGER,
        p25_price       INTEGER,
        p75_price       INTEGER,
        iqr             INTEGER,
        floor_price     INTEGER,
        ceiling_price   INTEGER,
        low_price       INTEGER,
        high_price      INTEGER,
        anchor_price    INTEGER,
        is_broad        BOOLEAN DEFAULT FALSE,
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      );

      -- Vehicle cohort stats — keyed precisely
      -- cohort_key is the canonical lookup key built from all identity fields
      -- e.g. 'holden|commodore|ve|ss|sedan|2008|100k-150k|auto'
      CREATE TABLE IF NOT EXISTS vehicle_price_stats (
        cohort_key      TEXT PRIMARY KEY,
        make            TEXT NOT NULL,
        model           TEXT NOT NULL,
        series          TEXT,
        variant         TEXT,
        body_style      TEXT,
        year_band       TEXT NOT NULL,   -- e.g. '2006-2010'
        mileage_band    TEXT NOT NULL,   -- e.g. '100k-150k'
        transmission    TEXT,
        sample_count    INTEGER,
        raw_count       INTEGER,
        median_price    INTEGER,
        p25_price       INTEGER,
        p75_price       INTEGER,
        iqr             INTEGER,
        floor_price     INTEGER,
        ceiling_price   INTEGER,
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_vps_make_model
        ON vehicle_price_stats(make, model, series, variant);
    `);

    // ── Migrate existing tables (safe to run on already-created DBs) ──
    const migrations = [
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS series TEXT',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS variant TEXT',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS body_style TEXT',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS year_band TEXT',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS kms INTEGER',
      "ALTER TABLE listings ADD COLUMN IF NOT EXISTS kms INTEGER",
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS mileage_band TEXT',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS fuel_type TEXT',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS engine TEXT',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS drive_type TEXT',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS colour TEXT',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS brand TEXT',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS item_model TEXT',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS storage TEXT',
      "ALTER TABLE listings ADD COLUMN IF NOT EXISTS listing_status TEXT DEFAULT 'active'",
      "ALTER TABLE listings ADD COLUMN IF NOT EXISTS price_quality TEXT DEFAULT 'unscored'",
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS quality_flags INTEGER DEFAULT 0',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS seen_count INTEGER DEFAULT 1',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS in_price_pool BOOLEAN DEFAULT TRUE',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS extracted_product TEXT',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS extracted_brand TEXT',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS extracted_category TEXT',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS extracted_variant TEXT',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS extraction_confidence TEXT',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS extracted_at TIMESTAMPTZ',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS img_condition TEXT',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS img_matches_keyword BOOLEAN',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS img_mismatch_reason TEXT',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS img_analysed_at TIMESTAMPTZ',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS flip_score INTEGER',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS flip_deal_type TEXT',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS flip_demand TEXT',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS flip_estimated_resale INTEGER',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS flip_estimated_margin INTEGER',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS flip_fix_cost INTEGER',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS flip_reasoning TEXT',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS flip_scored_at TIMESTAMPTZ',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS is_bulk_lot BOOLEAN DEFAULT FALSE',
      'ALTER TABLE keyword_price_stats ADD COLUMN IF NOT EXISTS is_broad BOOLEAN DEFAULT FALSE',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS kms INTEGER',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS previous_price INTEGER',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS price_dropped_at TIMESTAMPTZ',
      'CREATE TABLE IF NOT EXISTS keyword_anchors (keyword TEXT PRIMARY KEY, anchor_price INTEGER NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW())',
      `CREATE TABLE IF NOT EXISTS product_price_stats (
        product_key     TEXT PRIMARY KEY,
        display_name    TEXT NOT NULL,
        brand           TEXT,
        category        TEXT,
        variant         TEXT,
        sample_count    INTEGER DEFAULT 0,
        median_price    INTEGER,
        p25_price       INTEGER,
        p75_price       INTEGER,
        low_price       INTEGER,
        high_price      INTEGER,
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )`,
      'CREATE INDEX IF NOT EXISTS idx_product_stats_brand ON product_price_stats(brand)',
      'CREATE INDEX IF NOT EXISTS idx_product_stats_category ON product_price_stats(category)',
      'CREATE INDEX IF NOT EXISTS idx_listings_extracted ON listings(extracted_product) WHERE extracted_product IS NOT NULL',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS norm_category TEXT',
    ];
    for (const sql of migrations) {
      await pool.query(sql).catch(() => {});
    }

    console.log('[DB] Tables and migrations ready');
  } catch (e) {
    console.error('[DB] initDB error:', e.message);
  }
}

// ── Build the precise cohort key for a vehicle ────────────
// This is the fingerprint used to group comparable listings.
// More fields filled in = smaller, more accurate cohort.
// Falls back gracefully when fields are missing.
function buildVehicleCohortKey(make, model, series, variant, yearBand, mileageBand, transmission) {
  return [
    (make         || 'unknown').toLowerCase().trim(),
    (model        || 'unknown').toLowerCase().trim().replace(/\s+/g, '-'),
    (series       || '').toLowerCase().trim(),
    (variant      || '').toLowerCase().trim(),
    (yearBand     || 'unknown'),
    (mileageBand  || 'unknown'),
    (transmission || '').toLowerCase().trim(),
  ].join('|');
}

// ── Band a year into a range ──────────────────────────────
// Groups close years together so small cohorts still get data
// e.g. 2008 → '2006-2010', 2019 → '2018-2022'
function bandYear(year) {
  if (!year) return null;
  // 5-year bands aligned to common AU model generations
  const bands = [
    [1990, 1994], [1995, 1999],
    [2000, 2004], [2005, 2007], [2008, 2010],
    [2011, 2013], [2014, 2016], [2017, 2019],
    [2020, 2022], [2023, 2026],
  ];
  for (const [lo, hi] of bands) {
    if (year >= lo && year <= hi) return `${lo}-${hi}`;
  }
  return `${year}`;
}

// ── Band mileage into a range ─────────────────────────────
// Reflects how buyers actually think about odometer readings
function bandMileage(mileage) {
  if (!mileage || mileage <= 0) return 'unknown';
  if (mileage <  50000)  return '0-50k';
  if (mileage < 100000)  return '50k-100k';
  if (mileage < 150000)  return '100k-150k';
  if (mileage < 200000)  return '150k-200k';
  if (mileage < 250000)  return '200k-250k';
  return '250k+';
}

// ── Extract vehicle series from title ────────────────────
// Series = body generation code, critical for AU cars
// e.g. Commodore: VT/VX/VY/VZ/VE/VF  Falcon: AU/BA/BF/FG  Patrol: GQ/GU
const AU_SERIES_PATTERNS = [
  // Holden Commodore
  { pattern: /(VT|VX|VY|VZ|VE|VF)/i,   make: 'holden',    model: 'commodore' },
  // Ford Falcon
  { pattern: /(AU|BA|BF|FG|FGX)/i,      make: 'ford',      model: 'falcon'    },
  // Nissan Patrol
  { pattern: /(GQ|GU|Y61|Y62)/i,        make: 'nissan',    model: 'patrol'    },
  // Toyota LandCruiser
  { pattern: /(80|100|200|300|series|HZJ|HDJ|FZJ|UZJ)/i, make: 'toyota', model: 'landcruiser' },
  // Toyota HiLux
  { pattern: /(N70|N80|N110|SR5|SR|Workmate|Rugged X)/i, make: 'toyota', model: 'hilux' },
  // Ford Ranger
  { pattern: /(PJ|PK|PX|PXII|PXIII|P703|Wildtrak|Raptor|XLT|XLS|XL)/i, make: 'ford', model: 'ranger' },
];

// ── Extract variant/grade from title ─────────────────────
// Variant = trim level / grade, massively affects price
const VARIANT_PATTERNS = [
  // Holden Commodore variants
  /(SS\s*V8|SSV|SS|SV6|Calais\s*V|Calais|Omega|Berlina|International|Equipe|Executive)/i,
  // Ford Falcon variants  
  /(XR8|XR6\s*Turbo|XR6T|XR6|XR5|XT|Futura|Fairmont|Ghia|Boss|G6E\s*Turbo|G6E|G6)/i,
  // Ford Ranger variants
  /(Raptor|Wildtrak|XLT|XLS|XL|Sport|Hi-Rider)/i,
  // Toyota variants
  /(SR5|SR|GX|GXL|VX|Sahara|Kakadu|WorkMate|Rugged\s*X|Rugged|Rogue)/i,
  // General
  /(Sport|SE|SL|SX|ST|ST-Line|GTi|GTD|R-Line|M\s*Sport|AMG|S\s*Line)/i,
];

function extractSeriesFromTitle(make, model, title) {
  const text = (title || '').toUpperCase();
  for (const { pattern, make: m, model: mo } of AU_SERIES_PATTERNS) {
    if ((make || '').toLowerCase() === m && (model || '').toLowerCase().includes(mo)) {
      const match = text.match(pattern);
      if (match) return match[1].toUpperCase();
    }
  }
  return null;
}

function extractVariantFromTitle(title) {
  const text = (title || '');
  for (const pattern of VARIANT_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[1].replace(/\s+/g, ' ').trim();
  }
  return null;
}

function extractBodyStyleFromTitle(title, description) {
  const text = (title + ' ' + (description || '')).toLowerCase();
  if (/(ute|utility|tray)/.test(text))        return 'ute';
  if (/(wagon|estate|touring)/.test(text))     return 'wagon';
  if (/(van|cargo|commercial)/.test(text))     return 'van';
  if (/(hatch|hatchback)/.test(text))          return 'hatch';
  if (/(coupe|fastback)/.test(text))           return 'coupe';
  if (/(convertible|cabriolet|roadster)/.test(text)) return 'convertible';
  if (/(sedan|saloon)/.test(text))             return 'sedan';
  if (/(suv|4wd|4x4|crossover)/.test(text))   return 'suv';
  return null;
}

function extractFuelTypeFromTitle(title, description) {
  const text = (title + ' ' + (description || '')).toLowerCase();
  if (/(diesel|turbo\s*diesel|tdi|tdci|crd|hdi)/.test(text)) return 'diesel';
  if (/(electric|ev|bev|phev|plug.?in)/.test(text))           return 'electric';
  if (/(hybrid)/.test(text))                                   return 'hybrid';
  if (/(lpg|gas|dual\s*fuel)/.test(text))                     return 'lpg';
  return 'petrol'; // default for AU market
}

function extractEngineFromTitle(title, description) {
  const text = (title + ' ' + (description || ''));
  const m = text.match(/(\d+\.\d+[Ll]?\s*(?:V6|V8|V12|I4|turbo|litre|ltr)?)/i)
         || text.match(/(V8|V6|V12|turbo|supercharged)/i);
  return m ? m[1].trim() : null;
}

// ── Enrich a listing with all precise vehicle identity fields ──
// Called before upsert — fills in series, variant, bands etc
function enrichVehicleIdentity(listing) {
  if (!listing.make) return listing;

  const title = listing.title || '';
  const desc  = listing.description || '';

  const series    = listing.series    || extractSeriesFromTitle(listing.make, listing.model, title);
  const variant   = listing.variant   || extractVariantFromTitle(title);
  const bodyStyle = listing.body_style || extractBodyStyleFromTitle(title, desc);
  const fuelType  = listing.fuel_type  || extractFuelTypeFromTitle(title, desc);
  const engine    = listing.engine     || extractEngineFromTitle(title, desc);
  const yearBand    = listing.year ? bandYear(listing.year)   : null;
  const mileageBand = listing.mileage ? bandMileage(listing.mileage) : 'unknown';
  const transmission = listing.transmission
    ? (listing.transmission.toLowerCase().includes('man') ? 'manual' : 'auto')
    : null;

  return {
    ...listing,
    series,
    variant,
    body_style:   bodyStyle,
    fuel_type:    fuelType,
    engine,
    year_band:    yearBand,
    mileage_band: mileageBand,
    transmission,
    // kms stays as-is from the listing object
  };
}

// ── Listing quality scoring ──────────────────────────────
// Run before DB write — returns { flags, quality, inPricePool }
// Catches bad listings BEFORE they pollute the price pool

// Category price floors/ceilings — reject physically impossible prices
const CATEGORY_PRICE_BOUNDS = {
  vehicle:     { floor: 200,  ceiling: 500000 },
  electronics: { floor: 5,    ceiling: 30000  },
  general:     { floor: 1,    ceiling: 100000 },
};

// Title patterns that signal a listing should never enter the price pool
const DAMAGE_PATTERNS    = /\b(broken|cracked|faulty|damaged|spares?|repairs?|parts? only|not working|doesn'?t work|dead|seized|blown|written off|wrecked|flood|hail|smash|project car|needs work|no rego|unregistered|as.?is|as is)\b/i;
const SWAP_PATTERNS      = /\b(swap|swaps|trade|trades|pto|part trade|part swap|swopping|swop)\b/i;
const SPAM_PATTERNS      = /\b(follow|instagram|whatsapp|contact me|dm me|text me|call me|click link|bit\.ly|t\.me|telegram)\b/i;
const HIRE_PATTERNS      = /\b(hire|rental|rent|hiring|for hire|available for hire|hire only|rent only|per day|per week|per hour|hourly rate|daily rate|weekly rate)\b/i;
const PLACEHOLDER_TITLES = /^(car|item|stuff|thing|product|misc|other|test|listing)\s*$/i;

// Catches accessories, parts, bundles — keeps them OUT of the price pool
const ACCESSORY_PATTERNS = /\b(controller|dualsense|dualshock|joy.?con|charger|charging dock|cable|hdmi|adapter|case|cover|skin|sticker|decal|faceplate|stand|mount|bracket|holder|bag|sleeve|strap|screen protector|tempered glass|remote|headset|earbuds?|game|games|disc|cartridge|manual|box only|empty box|wrecking|wrecked|parts?|spare|callipers?|caliper|rims?|wheels?|tyres?|tires?|bonnet|bumper|door trim|tail light|head light|headlight|taillight|grille|radiator|compressor|alternator|starter motor|diff|gearbox|engine only|motor only|air filter|brake pads?|suspension|strut|control arm|steering rack|window|glass|seat|seats|carpet|floor mat|number plate|reg plate|rego plate|sticker|banner|flag|poster|toy|model|die.?cast|miniature|collectible|hot wheels|merchandise)\b/i;
const BUNDLE_PATTERNS = /\b(bundle|lot of|job.?lot|x ?\d{1,2} games?|\+ games?|with games?|plus games?|collection of|\d+ items?)\b/i;

// Scrub personal contact info from listing text before storing
function scrubPII(text) {
  if (!text) return text;
  let t = String(text);
  t = t.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[removed]');
  t = t.replace(/\b(?:\+?61[\s-]?|0)4\d{2}[\s-]?\d{3}[\s-]?\d{3}\b/g, '[removed]');
  t = t.replace(/\(?\b0[2-8]\)?[\s-]?\d{4}[\s-]?\d{4}\b/g, '[removed]');
  t = t.replace(/\b(wa\.me|t\.me|m\.me)\S*/gi, '[removed]');
  return t;
}

function scoreListingQuality(listing) {
  const price = listing.price || 0;
  const title = (listing.title || '').toLowerCase();
  const desc  = (listing.description || '').toLowerCase();
  const full  = title + ' ' + desc;
  let flags = 0;

  // Bit 0 — already handled by isOfferPrice, but double-check
  if (isOfferPrice(price)) flags |= 1;

  // Bit 1 — damage / broken / spares
  if (DAMAGE_PATTERNS.test(full)) flags |= 2;

  // Bit 2 — swap / trade listings (not a sale price)
  if (SWAP_PATTERNS.test(full)) flags |= 4;

  // Bit 4 — price below category floor (too cheap to be real)
  const category = listing.make ? 'vehicle' : 'general';
  const bounds   = CATEGORY_PRICE_BOUNDS[category] || CATEGORY_PRICE_BOUNDS.general;
  if (price > 0 && price < bounds.floor)   flags |= 16;

  // Bit 5 — price above category ceiling (data entry error / scam)
  if (price > 0 && price > bounds.ceiling) flags |= 32;

  // Bit 6 — spam signals in title/description
  if (SPAM_PATTERNS.test(full)) flags |= 64;
  if (HIRE_PATTERNS.test(title)) { flags |= 64; quality = 'spam'; } // hire/rental = never a deal

  // Placeholder titles that give no useful signal
  if (PLACEHOLDER_TITLES.test(listing.title || '')) flags |= 64;

  // Bit 7 — accessory, part, or bundle — not the product itself
  if (ACCESSORY_PATTERNS.test(full) || BUNDLE_PATTERNS.test(full)) flags |= 128;

  // Vehicle-specific: mileage sanity (> 900k km is almost certainly a data error)
  if (listing.mileage && listing.mileage > 900000) flags |= 8;

  // Determine quality label
  let quality = 'ok';
  if (flags & 64) quality = 'spam';
  else if (flags & 128) quality = 'accessory';
  else if (flags & (2 | 4)) quality = 'not_for_sale';  // damage or swap
  else if (flags & (16 | 32)) quality = 'suspicious';  // price bounds
  else if (flags & 1) quality = 'offer_price';

  const inPricePool = quality === 'ok';

  return { flags, quality, inPricePool };
}

// ── Quick Gemini photo check — runs async at upsert time ────────────────────
// Fires immediately when a new listing lands. Non-blocking — upsert doesn't
// wait for it. Updates the DB row once the result comes back.
// Checks: does the photo match the keyword, rough condition, stock photo flag.
// Result feeds straight into price_quality and img fields so the border is
// accurate the first time the card appears in the Feed.

async function upsertListingToDB(rawListing) {
  try {
    // Enrich with precise vehicle identity fields before writing
    const listing = rawListing.make ? enrichVehicleIdentity(rawListing) : rawListing;

    const price      = (listing.price && !isOfferPrice(listing.price)) ? listing.price : null;
    const offerPrice = isOfferPrice(listing.price);
    const { flags, quality, inPricePool } = scoreListingQuality({ ...listing, price: listing.price });

    // Bulk lot detection — flag bundles/lots so they don't pollute single-item medians
    const titleLower = (listing.title || '').toLowerCase();
    const isBulkLot = /\b(bundle|lot|job lot|bulk|set of|x\d+|\d+x|pack of|collection|joblot|wholesale|mixed lot|assorted|combo kit|\d+\s*piece|\d+\s*pcs|\d+\s*items?)\b/.test(titleLower)
      && !/\b(single|one|1x|solo)\b/.test(titleLower);



    await pool.query(`
      INSERT INTO listings
        (listing_id, title, description, price, is_offer_price, location, state,
         seller_name, image_url, url, keyword, category,
         make, model, series, variant, body_style, year, year_band,
         kms, mileage_band, transmission, fuel_type, engine,
         price_quality, quality_flags, in_price_pool,
         is_bulk_lot,
         listed_at, scraped_at, last_seen_at, is_active, listing_status, seen_count)
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
        $13,$14,$15,$16,$17,$18,$19,
        $20,$21,$22,$23,$24,
        $25,$26,$27,
        $28,
        $29,NOW(),NOW(),TRUE,'active',1
      )
      ON CONFLICT (listing_id) DO UPDATE SET
        price          = EXCLUDED.price,
        last_seen_at   = NOW(),
        is_active      = TRUE,
        listing_status = 'active',
        seen_count     = listings.seen_count + 1,
        -- Enrich identity fields if we now have better data
        series         = COALESCE(EXCLUDED.series,      listings.series),
        variant        = COALESCE(EXCLUDED.variant,     listings.variant),
        body_style     = COALESCE(EXCLUDED.body_style,  listings.body_style),
        kms            = COALESCE(EXCLUDED.kms,          listings.kms),
        mileage_band   = COALESCE(EXCLUDED.mileage_band,listings.mileage_band),
        fuel_type      = COALESCE(EXCLUDED.fuel_type,   listings.fuel_type),
        engine         = COALESCE(EXCLUDED.engine,      listings.engine),
        description    = COALESCE(EXCLUDED.description, listings.description),
        price_quality    = EXCLUDED.price_quality,
        quality_flags    = EXCLUDED.quality_flags,
        in_price_pool    = EXCLUDED.in_price_pool,
        is_bulk_lot      = EXCLUDED.is_bulk_lot
    `, [
      listing.id,
      scrubPII(listing.title),
      scrubPII(listing.description)   || null,
      price,
      offerPrice,
      listing.location      || null,
      extractState(listing.location),
      null,
      listing.image         || null,
      listing.url           || null,
      listing.keyword       ? listing.keyword.toLowerCase().trim() : null,
      listing.make          ? 'vehicle' : 'general',
      // Vehicle identity
      listing.make          || null,
      listing.model         || null,
      listing.series        || null,
      listing.variant       || null,
      listing.body_style    || null,
      listing.year          || null,
      listing.year_band     || null,
      listing.mileage       || null,
      listing.mileage_band  || null,
      listing.transmission  || null,
      listing.fuel_type     || null,
      listing.engine        || null,
      // Quality
      quality,
      flags,
      inPricePool,
      isBulkLot,
      listing.listedAt      ? new Date(listing.listedAt) : null,
    ]);

  } catch (e) {
    if (!e.message.includes('duplicate')) {
      console.error('[DB] upsertListing error:', e.message.slice(0, 120));
    }
  }
}

async function getDBPriceStats(keyword, minSamples = 5) {
  try {
    const kw = keyword.toLowerCase().trim();

    // ── Fast path: pre-computed IQR-cleaned stats ──────────
    const fast = await pool.query(
      `SELECT * FROM keyword_price_stats WHERE keyword = $1`, [kw]
    );
    if (fast.rows.length && fast.rows[0].sample_count >= minSamples) {
      const r = fast.rows[0];
      return {
        count:       r.sample_count,
        rawCount:    r.raw_count || r.sample_count,
        median:      r.median_price,
        p25:         r.p25_price,
        p75:         r.p75_price,
        iqr:         r.iqr,
        floor:       r.floor_price,
        ceiling:     r.ceiling_price,
        low:         r.low_price,
        high:        r.high_price,
        source:      'flipradar_db',
        sourceLabel: `FlipRadar DB · ${r.sample_count} verified sales`,
      };
    }

    // ── Live path: IQR outlier removal in SQL ──────────────
    // Step 1: get raw percentiles from the clean pool
    const percResult = await pool.query(`
      SELECT
        PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY price)::INT AS p25,
        PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY price)::INT AS p75,
        COUNT(*)::INT AS raw_count
      FROM listings
      WHERE keyword = $1
        AND price > 0
        AND is_offer_price = FALSE
        AND in_price_pool = TRUE
        AND is_active = TRUE
        AND scraped_at > NOW() - INTERVAL '90 days'
    `, [kw]);

    const perc = percResult.rows[0];
    if (!perc || perc.raw_count < minSamples) return null;

    const iqr      = perc.p75 - perc.p25;
    const fence_lo = Math.max(0, perc.p25 - 1.5 * iqr);
    const fence_hi = perc.p75 + 1.5 * iqr;

    // Step 2: stats using only prices within IQR fences
    const result = await pool.query(`
      SELECT
        COUNT(*)::INT                                                    AS cnt,
        PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY price)::INT        AS median,
        PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY price)::INT        AS p25,
        PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY price)::INT        AS p75,
        MIN(price)::INT                                                  AS low,
        MAX(price)::INT                                                  AS high
      FROM listings
      WHERE keyword = $1
        AND price BETWEEN $2 AND $3
        AND is_offer_price = FALSE
        AND in_price_pool = TRUE
        AND is_active = TRUE
        AND scraped_at > NOW() - INTERVAL '90 days'
    `, [kw, Math.round(fence_lo), Math.round(fence_hi)]);

    const row = result.rows[0];
    if (!row || row.cnt < minSamples) return null;

    return {
      count:       row.cnt,
      rawCount:    perc.raw_count,
      median:      row.median,
      p25:         row.p25,
      p75:         row.p75,
      iqr,
      floor:       Math.round(fence_lo),
      ceiling:     Math.round(fence_hi),
      low:         row.low,
      high:        row.high,
      source:      'flipradar_db',
      sourceLabel: `FlipRadar DB · ${row.cnt} verified comparables`,
    };
  } catch (e) {
    console.error('[DB] getDBPriceStats error:', e.message);
    return null;
  }
}

// ── IQR-clean stats from a set of prices ─────────────────
// Used by all vehicle lookup tiers — same logic every time
function calcIQRStats(prices) {
  if (!prices || prices.length < 3) return null;
  const sorted = [...prices].sort((a, b) => a - b);
  const p25 = sorted[Math.floor(sorted.length * 0.25)];
  const p75 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr  = p75 - p25;
  const lo   = Math.max(0, p25 - 1.5 * iqr);
  const hi   = p75 + 1.5 * iqr;
  const clean = sorted.filter(p => p >= lo && p <= hi);
  if (clean.length < 3) return null;
  const median = clean[Math.floor(clean.length / 2)];
  return {
    count:    clean.length,
    rawCount: sorted.length,
    median,
    p25:      clean[Math.floor(clean.length * 0.25)],
    p75:      clean[Math.floor(clean.length * 0.75)],
    low:      clean[0],
    high:     clean[clean.length - 1],
    iqr:      Math.round(iqr),
    floor:    Math.round(lo),
    ceiling:  Math.round(hi),
  };
}

// ── Run IQR-cleaned price query for any WHERE clause ──────
async function queryCleanPrices(whereSql, params) {
  const r = await pool.query(`
    SELECT price FROM listings
    WHERE ${whereSql}
      AND price > 0 AND is_offer_price = FALSE
      AND in_price_pool = TRUE
      AND listing_status IN ('active','sold')
  `, params);
  return r.rows.map(r => r.price);
}

// ── Vehicle price lookup — precision-first waterfall ──────
//
// Tries increasingly broad cohorts until it finds enough data.
// Narrow cohort = more accurate.  Broad cohort = more samples.
//
// Tier 1 (most precise): make + model + series + variant + year_band + mileage_band + transmission
// Tier 2:                make + model + series + variant + year_band + mileage_band
// Tier 3:                make + model + series + variant + year_band
// Tier 4:                make + model + series + year_band + mileage_band
// Tier 5:                make + model + year_band + mileage_band
// Tier 6 (broadest):     make + model + year_band
//
// Each tier needs DB_MIN_SAMPLES to be accepted.
// Falls back to AI if no tier has enough data.

async function getDBVehicleStats(make, model, year, mileage, opts = {}) {
  if (!make || !year) return null;

  const { series, variant, transmission } = opts;
  const yearBand    = bandYear(year);
  const mileageBand = mileage ? bandMileage(mileage) : null;
  const MIN         = DB_MIN_SAMPLES;

  // ── Fast path: pre-computed cohort stats table ──────────
  // Check for the most precise cohort key first, then widen
  const cohortKey = buildVehicleCohortKey(make, model, series, variant, yearBand, mileageBand || 'unknown', transmission);
  const fastResult = await pool.query(
    `SELECT * FROM vehicle_price_stats WHERE cohort_key = $1`, [cohortKey]
  );
  if (fastResult.rows.length && fastResult.rows[0].sample_count >= MIN) {
    const r = fastResult.rows[0];
    return formatVehicleStats(r.median_price, r.p25_price, r.p75_price,
      r.sample_count, r.raw_count, r.iqr, r.floor_price, r.ceiling_price,
      make, model, series, variant, yearBand, mileageBand, r.cohort_key, 'precomputed');
  }

  // ── Live waterfall — try each tier in order ─────────────

  // Helper: run a tier query and return stats if enough data
  async function tryTier(label, whereSql, params) {
    const prices = await queryCleanPrices(whereSql, params);
    const stats  = calcIQRStats(prices);
    if (stats && stats.count >= MIN) {
      console.log(`[VehiclePrice] ${make} ${model} ${year} — Tier ${label}: ${stats.count} samples`);
      return { ...stats, tierLabel: label };
    }
    return null;
  }

  let result = null;

  // Tier 1 — fully precise
  if (!result && series && variant && mileageBand && transmission) {
    result = await tryTier('1 (exact)',
      `make=$1 AND model=$2 AND series=$3 AND variant=$4 AND year_band=$5 AND mileage_band=$6 AND transmission=$7`,
      [make, model, series, variant, yearBand, mileageBand, transmission]
    );
  }

  // Tier 2 — drop transmission
  if (!result && series && variant && mileageBand) {
    result = await tryTier('2 (no transmission)',
      `make=$1 AND model=$2 AND series=$3 AND variant=$4 AND year_band=$5 AND mileage_band=$6`,
      [make, model, series, variant, yearBand, mileageBand]
    );
  }

  // Tier 3 — drop mileage band
  if (!result && series && variant) {
    result = await tryTier('3 (no mileage)',
      `make=$1 AND model=$2 AND series=$3 AND variant=$4 AND year_band=$5`,
      [make, model, series, variant, yearBand]
    );
  }

  // Tier 4 — drop variant, keep series + mileage
  if (!result && series && mileageBand) {
    result = await tryTier('4 (series+mileage)',
      `make=$1 AND model=$2 AND series=$3 AND year_band=$4 AND mileage_band=$5`,
      [make, model, series, yearBand, mileageBand]
    );
  }

  // Tier 5 — make + model + year band + mileage band (no series/variant)
  if (!result && mileageBand) {
    result = await tryTier('5 (model+mileage)',
      `make=$1 AND model=$2 AND year_band=$3 AND mileage_band=$4`,
      [make, model, yearBand, mileageBand]
    );
  }

  // Tier 6 — make + model + year band only (broadest)
  if (!result) {
    result = await tryTier('6 (model+year)',
      `make=$1 AND model=$2 AND year_band=$3`,
      [make, model, yearBand]
    );
  }

  if (!result) {
    console.log(`[VehiclePrice] No data for ${make} ${model} ${year} — AI needed`);
    return null;
  }

  return formatVehicleStats(
    result.median, result.p25, result.p75,
    result.count, result.rawCount, result.iqr, result.floor, result.ceiling,
    make, model, series, variant, yearBand, mileageBand, null, result.tierLabel
  );
}

function formatVehicleStats(median, p25, p75, count, rawCount, iqr, floor, ceiling,
  make, model, series, variant, yearBand, mileageBand, cohortKey, tier) {
  const label = [make, model, series, variant].filter(Boolean).join(' ');
  const mileageStr = mileageBand && mileageBand !== 'unknown' ? ` · ${mileageBand} km` : '';
  return {
    marketMedian:    median,
    marketLow:       p25,
    marketHigh:      p75,
    samples:         count,
    rawSamples:      rawCount || count,
    iqr,
    floor,
    ceiling,
    yearBand,
    mileageBand,
    cohortKey,
    tier,
    source:          'flipradar_db',
    sourceLabel:     `FlipRadar DB · ${count} comparable ${label}${mileageStr}`,
    confidence:      calcConfidence('vpx', count),
    make, model, series, variant,
  };
}

async function getDBComparables(keyword, limit = 10) {
  try {
    const result = await pool.query(`
      SELECT listing_id, title, price, location, state, url, listed_at, scraped_at
      FROM listings
      WHERE keyword = $1 AND price > 0 AND is_offer_price = FALSE
        AND is_active = TRUE AND scraped_at > NOW() - INTERVAL '60 days'
      ORDER BY scraped_at DESC LIMIT $2
    `, [keyword.toLowerCase().trim(), limit]);
    return result.rows;
  } catch (e) { return []; }
}

async function getDBSummary() {
  try {
    const r = await pool.query(`
      SELECT COUNT(*)::INT AS total_listings,
        COUNT(DISTINCT keyword)::INT AS unique_keywords,
        COUNT(DISTINCT make)::INT    AS unique_makes,
        COUNT(*) FILTER (WHERE is_active)::INT AS active_listings,
        MAX(scraped_at) AS last_scraped
      FROM listings
    `);
    return r.rows[0];
  } catch (e) { return null; }
}

// ── Upstash Redis ─────────────────────────────────────────
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
  // Appraisal result cache — keyed by listing ID (most specific) or content hash
  appraisalById:   (listingId) => `fr:apr:id:${listingId}`,
  appraisalByHash: (hash)      => `fr:apr:h:${hash}`,
  // Price history per listing — tracks last known price for drop detection
  listingPrice:    (id)        => `fr:lp:${id}`,
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
  pro_weekly:      'price_pro_weekly_placeholder',    // TODO: replace with real Stripe price ID
  pro_monthly:     'price_pro_monthly_placeholder',   // TODO: replace with real Stripe price ID
  pro_yearly:      'price_pro_yearly_placeholder',    // TODO: replace with real Stripe price ID
  premium_weekly:  'price_1Ta7PsPDjYUYNInHMvbMiWvV',
  premium_monthly: 'price_1Ta7QDPDjYUYNInHDQTp70Mt',
  premium_yearly:  'price_1Ta7QSPDjYUYNInHLG2F4aT3',
};
const PRICE_TO_PLAN = {};
Object.entries(PRICE_IDS).forEach(([key, priceId]) => {
  if (key.startsWith('basic'))   PRICE_TO_PLAN[priceId] = 'basic';
  else if (key.startsWith('pro')) PRICE_TO_PLAN[priceId] = 'pro';
  else                            PRICE_TO_PLAN[priceId] = 'premium';
});
const PLAN_APPRAISAL_LIMITS = { free: 999, basic: 999, pro: 999, premium: 999 }; // TEMP — reset before launch
const PLAN_WATCHLIST_LIMITS = { free: 0, basic: 2, pro: 2, premium: 5 };
const FROM_EMAIL    = process.env.FROM_EMAIL || 'FlipRadar <noreply@yourdomain.com>';
const INACTIVE_DAYS = 7;
const BCRYPT_ROUNDS = 10;

const SEEN_TTL_MS         = 48 * 60 * 60 * 1000;
const SEEN_MAX_ENTRIES    = 5000;



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
// ── AI field extraction for DB storage ───────────────────
// Called when regex extraction missed key fields from the title.
// Uses a cheap single AI call to pull year, kms, make, model,
// series, variant from the raw title — only fires when needed.
async function aiExtractVehicleFields(title, keyword, description = '') {
  if (!GEMINI_API_KEY && !ANTHROPIC_API_KEY) return null;
  try {
    const prompt = [
      'Extract vehicle details from this Australian Facebook Marketplace listing title.',
      'Return ONLY valid JSON, no markdown, no extra text.',
      `Title: "${title}"`,
      description ? `Description: "${String(description).slice(0, 400)}"` : '',
      'Search keyword: "' + keyword + '"',
      '{',
      '  "year": number or null,',
      '  "make": "brand name or null",',
      '  "model": "model name or null",',
      '  "series": "generation code e.g. VE, FG, GU, NP, BF or null",',
      '  "variant": "trim level e.g. SS, XR6, SV6, Calais, SR5 or null",',
      '  "kms": number or null,',
      '  "transmission": "auto or manual or null",',
      '  "body_style": "sedan/wagon/ute/hatch/suv/van/coupe or null",',
      '  "fuel_type": "petrol/diesel/hybrid/electric or null",',
      '  "engine": "e.g. 3.6L V6 or null"',
      '}',
    ].join('\n');

    let text = '';
    if (GEMINI_API_KEY) {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
        { contents: [{ parts: [{ text: prompt }] }], generationConfig: { thinkingConfig: { thinkingBudget: 0 } } },
        { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
      );
      text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else {
      const res = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-haiku-4-5-20251001', max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }, { headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, timeout: 10000 });
      text = res.data?.content?.[0]?.text || '';
    }
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch (e) {
    console.error('[AIExtract] Error:', e.message);
    return null;
  }
}

// ── Price drop detection ─────────────────────────────────
// Checks the last known price for a listing against the current price.
// If the price dropped, flags the listing and persists to Neon.
// Stored in Redis with a 14-day TTL — long enough to catch slow drops.
const PRICE_TTL_SECS = 14 * 24 * 3600;

async function checkPriceDrop(listing) {
  if (!listing.id || !listing.price || listing.isOfferPrice) return listing;
  try {
    const key      = K.listingPrice(listing.id);
    const lastData = await redisGet(key);
    const lastPrice = lastData?.price || null;

    // Store current price for next scan
    await redisSet(key, { price: listing.price, seenAt: Date.now() }, PRICE_TTL_SECS);

    // No previous price — first time we've seen this listing
    if (!lastPrice || lastPrice === listing.price) return listing;

    // Price went up or stayed same — not a drop
    if (listing.price >= lastPrice) return listing;

    // Price dropped — flag it
    const dropAmount  = lastPrice - listing.price;
    const dropPercent = Math.round((dropAmount / lastPrice) * 100);
    console.log(`[PriceDrop] ${listing.title?.slice(0,40)} — $${lastPrice} → $${listing.price} (-$${dropAmount}, -${dropPercent}%)`);

    // Update Neon with previous price
    pool.query(
      `UPDATE listings SET previous_price = $1, price_dropped_at = NOW() WHERE listing_id = $2`,
      [lastPrice, listing.id]
    ).catch(() => {});

    return {
      ...listing,
      priceDropped:  true,
      previousPrice: lastPrice,
      dropAmount,
      dropPercent,
    };
  } catch (e) {
    console.error('[PriceDrop] Error:', e.message);
    return listing;
  }
}

async function storeScanPrice(keyword, listing) {
  // Only write to DB if the listing has a real price.
  if (!listing.price || listing.price <= 0 || listing.isOfferPrice) return;

  // For vehicle listings, fill in missing fields with AI if regex missed them.
  // Only fires when key fields are absent — most titles regex just fine.
  let enriched = { ...listing, keyword };
  const isVehicle = listing.make || isVehicleKeyword(keyword);

  if (isVehicle && (!listing.year || !listing.mileage || !listing.make || !listing.model)) {
    const aiFields = await aiExtractVehicleFields(listing.title, keyword).catch(() => null);
    if (aiFields) {
      enriched = {
        ...enriched,
        year:         enriched.year         || aiFields.year         || null,
        make:         enriched.make         || aiFields.make         || null,
        model:        enriched.model        || aiFields.model        || null,
        series:       enriched.series       || aiFields.series       || null,
        variant:      enriched.variant      || aiFields.variant      || null,
        mileage:      enriched.mileage       || aiFields.kms          || null,
        transmission: enriched.transmission || aiFields.transmission || null,
        body_style:   enriched.body_style   || aiFields.body_style   || null,
        fuel_type:    enriched.fuel_type    || aiFields.fuel_type    || null,
        engine:       enriched.engine       || aiFields.engine       || null,
      };
      console.log(`[AIExtract] "${listing.title.slice(0,50)}" → year:${enriched.year} mileage:${enriched.mileage} make:${enriched.make} model:${enriched.model} series:${enriched.series}`);
    }
  }

  upsertListingToDB(enriched).catch(() => {});
}

// VPX / Carsales / AutoGrab removed — FlipRadar DB is the only pricing source

// ── Appraisal result cache ────────────────────────────────
// Stores full AI appraisal results so identical listings cost 0 points for subsequent users.
// Cache key priority:
//   1. Listing ID  — exact match, most reliable (7-day TTL)
//   2. Content hash — title + normalised price + keyword (3-day TTL, catches reposts)
const APPRAISAL_CACHE_TTL_BY_ID   = 7 * 24 * 3600;   // 7 days — listing unlikely to change
const APPRAISAL_CACHE_TTL_BY_HASH = 3 * 24 * 3600;   // 3 days — same item, different listing

function buildAppraisalHash(title, price, keyword) {
  // Normalise inputs so minor differences don't bust the cache.
  // Price rounding is tiered — coarser for expensive items (market noise is larger),
  // finer for cheap items where $50 is a meaningful difference.
  const normTitle   = (title   || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
  const normKeyword = (keyword || '').toLowerCase().trim().slice(0, 30);
  const p           = parseFloat(price) || 0;
  const bucket      = p < 500 ? 10 : p < 2000 ? 25 : 50; // $10 / $25 / $50 buckets
  const normPrice   = Math.round(p / bucket) * bucket;
  const raw = `${normKeyword}|${normTitle}|${normPrice}`;
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

async function getAppraisalCache(listingId, title, price, keyword) {
  // Try listing ID first (exact match)
  if (listingId) {
    const hit = await redisGet(K.appraisalById(listingId));
    if (hit) {
      console.log(`[AprCache] HIT by listingId: ${listingId}`);
      return { ...hit, fromCache: true };
    }
  }
  // Fall back to content hash
  const hash = buildAppraisalHash(title, price, keyword);
  const hit  = await redisGet(K.appraisalByHash(hash));
  if (hit) {
    console.log(`[AprCache] HIT by hash: ${hash} (${keyword}, ~$${price})`);
    return { ...hit, fromCache: true };
  }
  return null;
}

async function setAppraisalCache(listingId, title, price, keyword, result) {
  // Strip fields that shouldn't be cached (per-user, transient)
  const toCache = { ...result };
  delete toCache.fromCache;
  delete toCache.usedCache;

  if (listingId) {
    await redisSet(K.appraisalById(listingId), toCache, APPRAISAL_CACHE_TTL_BY_ID);
  }
  const hash = buildAppraisalHash(title, price, keyword);
  await redisSet(K.appraisalByHash(hash), toCache, APPRAISAL_CACHE_TTL_BY_HASH);
  console.log(`[AprCache] Stored: listingId=${listingId || 'none'} hash=${hash}`);
}

// AutoGrab removed — DB is the only pricing source


// ── DB vs AI decision engine ─────────────────────────────
//
// The DB only wins when it's genuinely more reliable than AI.
// AI has broad training data but no real-time AU market prices.
// Our DB has real AU listings but needs enough of them, from a
// tight-enough cohort, to beat AI's generalised knowledge.
//
// Score is 0–100. We use DB if score >= DB_TRUST_THRESHOLD.
//
// Scoring factors:
//   Cohort precision  — tier 1 (exact match) >> tier 6 (broad)
//   Sample count      — more samples = more reliable
//   IQR tightness     — narrow spread = consistent market = reliable
//   Recency           — handled by listing_status filter in queries
//
// We never expose this score to the user.

const DB_MIN_SAMPLES    = 4;  // minimum listings in a cohort to use DB pricing
const DB_TRUST_THRESHOLD = 65; // minimum score to prefer DB over AI

// ── Category-aware sell price discounts ──────────────────────────────────────
// FB Marketplace asking prices vs what things actually sell for.
// Derived from AU market behaviour — fast-moving commodity items sell close to
// asking; niche/slow items require deeper discounts to move.
//
// sellDiscount: fraction below asking median to get a realistic sell price
// flipCostLow:  minimum prep cost for this category (clean, list, meet buyer)
// flipCostHigh: higher end when item needs more work / is more complex to sell
const CATEGORY_SELL_RATES = {
  // Phones — huge demand, sell within days, minimal prep
  phone:         { sellDiscount: 0.08, flipCostLow: 50,  flipCostHigh: 150 },
  // Laptops — good demand but need testing, factory reset
  laptop:        { sellDiscount: 0.10, flipCostLow: 100, flipCostHigh: 250 },
  // Tablets — similar to phones
  tablet:        { sellDiscount: 0.08, flipCostLow: 50,  flipCostHigh: 150 },
  // Gaming — PS5/Xbox sell fast at right price, minor cleaning
  gaming:        { sellDiscount: 0.10, flipCostLow: 50,  flipCostHigh: 200 },
  // TVs — harder to transport, need testing, slower to sell
  tv:            { sellDiscount: 0.15, flipCostLow: 100, flipCostHigh: 300 },
  // Audio — varies wildly, speakers awkward to move
  audio:         { sellDiscount: 0.12, flipCostLow: 50,  flipCostHigh: 200 },
  // Power tools — good demand, condition matters a lot
  power_tool:    { sellDiscount: 0.12, flipCostLow: 50,  flipCostHigh: 200 },
  // Cameras — niche buyers, can sit for weeks
  camera:        { sellDiscount: 0.15, flipCostLow: 50,  flipCostHigh: 150 },
  // Vehicles — wide price variance, selling costs high (rego, RWC, time)
  vehicle:       { sellDiscount: 0.12, flipCostLow: 500, flipCostHigh: 1500 },
  // Motorcycles — similar to vehicles
  motorcycle:    { sellDiscount: 0.12, flipCostLow: 300, flipCostHigh: 800 },
  // Bikes — popular, easy to sell
  bike:          { sellDiscount: 0.12, flipCostLow: 50,  flipCostHigh: 200 },
  // Camping/outdoor — seasonal, niche buyers
  camping:       { sellDiscount: 0.15, flipCostLow: 100, flipCostHigh: 300 },
  // Gym equipment — bulky, hard to move, slower market
  fitness:       { sellDiscount: 0.18, flipCostLow: 100, flipCostHigh: 300 },
  // Watches — collector market, can wait for right buyer
  watch:         { sellDiscount: 0.10, flipCostLow: 50,  flipCostHigh: 150 },
  // Sneakers — fast market if you know it
  sneakers:      { sellDiscount: 0.10, flipCostLow: 20,  flipCostHigh: 50  },
  // Coffee machines / premium appliances
  appliance:     { sellDiscount: 0.15, flipCostLow: 50,  flipCostHigh: 200 },
  // Default for anything unrecognised
  _default:      { sellDiscount: 0.15, flipCostLow: 100, flipCostHigh: 300 },
};

// Map a keyword to a CATEGORY_SELL_RATES key
function kwToSellCategory(keyword) {
  const k = (keyword || '').toLowerCase();
  if (/iphone|samsung.*galaxy|google pixel|oneplus|oppo/.test(k))   return 'phone';
  if (/macbook|imac|laptop|thinkpad|dell xps|surface pro|razer blade|asus rog/.test(k)) return 'laptop';
  if (/ipad|galaxy tab/.test(k))                                     return 'tablet';
  if (/ps5|ps4|xbox|nintendo switch|steam deck|meta quest|gaming pc|rtx/.test(k)) return 'gaming';
  if (/oled tv|qled|bravia|inch tv|samsung.*tv|lg.*tv/.test(k))      return 'tv';
  if (/sony wh|airpods|bose|sonos|marshall speaker/.test(k))         return 'audio';
  if (/milwaukee|dewalt|makita|festool|hilti|chainsaw|pressure washer|mower|welder|generator/.test(k)) return 'power_tool';
  if (/sony a7|canon eos|nikon|fujifilm|dji|gopro/.test(k))          return 'camera';
  if (/hilux|landcruiser|patrol|ranger|triton|dmax|pajero|prado|rav4|commodore|mustang|bmw|mercedes|audi|volkswagen|subaru wrx|jeep/.test(k)) return 'vehicle';
  if (/motorcycle|dirt bike|ktm|ducati|harley|kawasaki ninja|honda cbr|yamaha r1/.test(k)) return 'motorcycle';
  if (/mountain bike|road bike|electric bike|trek|specialized|santa cruz|giant trance/.test(k)) return 'bike';
  if (/engel|waeco|dometic|arb fridge|roof top tent|camper trailer|weber bbq|traeger|big green egg/.test(k)) return 'camping';
  if (/squat rack|barbell|dumbbells|weight plates|bench press|treadmill|concept2|peloton/.test(k)) return 'fitness';
  if (/rolex|omega|seiko prospex|tag heuer|ap royal oak|grand seiko/.test(k)) return 'watch';
  if (/jordan|yeezy|nike dunk|air max|new balance 550/.test(k))      return 'sneakers';
  if (/thermomix|kitchenaid|breville barista|breville oracle|delonghi|jura|dyson v/.test(k)) return 'appliance';
  return '_default';
}

function scoreDBResult(stats) {
  if (!stats || !stats.samples) return 0;

  let score = 0;

  // ── Cohort precision (0–35 points) ─────────────────────
  // Tier 1 = exact match on all fields = most valuable
  // Tier 6 = just make+model+year = barely better than AI
  const tierScores = {
    '1 (exact)':             35,
    '2 (no transmission)':   30,
    '3 (no mileage)':        22,
    '4 (series+mileage)':    25,
    '5 (model+mileage)':     18,
    '6 (model+year)':        10,
    'precomputed':           30, // precomputed = was already a good cohort
  };
  score += tierScores[stats.tier] || 10;

  // ── Sample count (0–35 points) ──────────────────────────
  // Need at least 8 to be useful; 30+ is solid; 60+ is excellent
  const n = stats.samples;
  if      (n >= 60) score += 35;
  else if (n >= 30) score += 28;
  else if (n >= 20) score += 22;
  else if (n >= 12) score += 16;
  else if (n >=  8) score += 10;
  else              score +=  0; // < 8: not enough

  // ── IQR tightness (0–30 points) ─────────────────────────
  // Tight IQR = consistent market = we trust the median
  // Wide IQR = noisy / mixed cohort = AI might do better
  // Measured as IQR / median (coefficient of variation proxy)
  if (stats.iqr != null && stats.marketMedian > 0) {
    const cv = stats.iqr / stats.marketMedian;
    if      (cv < 0.10) score += 30; // very tight — e.g. ±5% of median
    else if (cv < 0.20) score += 22;
    else if (cv < 0.30) score += 14;
    else if (cv < 0.45) score +=  7;
    else                score +=  0; // too wide — AI likely better
  }

  return Math.min(100, score);
}

function scoreDBKeywordResult(stats) {
  if (!stats || !stats.count) return 0;
  let score = 0;
  const n = stats.count;
  if      (n >= 50) score += 50;
  else if (n >= 30) score += 40;
  else if (n >= 20) score += 30;
  else if (n >= 12) score += 20;
  else if (n >=  8) score += 10;
  if (stats.iqr != null && stats.median > 0) {
    const cv = stats.iqr / stats.median;
    if      (cv < 0.15) score += 50;
    else if (cv < 0.25) score += 35;
    else if (cv < 0.40) score += 20;
    else if (cv < 0.55) score += 10;
  }
  return Math.min(100, score);
}

async function fetchBestVehiclePrice(make, model, year, mileage, opts = {}) {
  const dbVehicle = await getDBVehicleStats(make, model, year, mileage, opts);
  if (!dbVehicle) {
    console.log(`[VehiclePrice] No DB data for ${make} ${model} ${year} — using AI`);
    return null;
  }
  const score = scoreDBResult(dbVehicle);
  if (score >= DB_TRUST_THRESHOLD) {
    console.log(`[VehiclePrice] DB preferred (score ${score}) — ${make} ${model} ${year} tier ${dbVehicle.tier} n=${dbVehicle.samples}`);
    return dbVehicle;
  }
  console.log(`[VehiclePrice] DB score ${score} < ${DB_TRUST_THRESHOLD} — AI preferred for ${make} ${model} ${year}`);
  // Still return it so the AI route can use it to sanity-check its output
  return { ...dbVehicle, belowThreshold: true };
}

async function getPriceCacheForKeyword(keyword) {
  const dbStats = await getDBPriceStats(keyword);
  const score   = dbStats ? scoreDBKeywordResult(dbStats) : 0;

  if (dbStats && score >= DB_TRUST_THRESHOLD) {
    // DB has enough clean data — use it as primary source
    console.log(`[PriceCache] "${keyword}" → DB preferred (score ${score}, n=${dbStats.count})`);
    return { ...dbStats, low: dbStats.p25 || dbStats.low, high: dbStats.p75 || dbStats.high };
  }

  // DB data is thin or missing — get AI anchor and blend with any DB data we have
  // The anchor call is cached for 30 days so this is cheap after first hit
  const sampleTitles = [];
  if (dbStats && dbStats.count > 0) {
    // Pull a few recent titles so AI has real context to price against
    try {
      const { rows } = await pool.query(
        `SELECT title FROM listings WHERE keyword = $1 AND price > 0 AND is_active = TRUE
         ORDER BY scraped_at DESC LIMIT 5`,
        [keyword.toLowerCase().trim()]
      );
      rows.forEach(r => r.title && sampleTitles.push(r.title));
    } catch (_) {}
  }

  const anchor = await getKeywordPriceAnchor(keyword, sampleTitles);

  if (!anchor) {
    // No AI anchor either — nothing to work with
    console.log(`[PriceCache] "${keyword}" → no data available`);
    return null;
  }

  if (dbStats && dbStats.count >= 2) {
    // Blend: weight DB median by sample count, anchor by (1 - weight)
    // Small DB sample still pulls the estimate toward real AU listings
    const dbWeight  = Math.min(0.7, dbStats.count / 20); // caps at 70% weight at 20+ samples
    const aiWeight  = 1 - dbWeight;
    const blended   = Math.round(dbStats.median * dbWeight + anchor.asking_median * aiWeight);
    console.log(`[PriceCache] "${keyword}" → blended (DB ${dbStats.count} samples @ ${Math.round(dbWeight*100)}%, AI anchor @ ${Math.round(aiWeight*100)}%) → $${blended}`);
    return {
      count:       dbStats.count,
      median:      blended,
      p25:         dbStats.p25 || Math.round(anchor.price_low),
      p75:         dbStats.p75 || Math.round(anchor.price_high),
      low:         dbStats.p25 || Math.round(anchor.price_low),
      high:        dbStats.p75 || Math.round(anchor.price_high),
      sell_price:  anchor.sell_price,
      source:      'blended',
      sourceLabel: `FlipRadar DB (${dbStats.count} listings) + AI estimate`,
    };
  }

  // Pure AI anchor — no DB data at all
  console.log(`[PriceCache] "${keyword}" → AI anchor only → asking $${anchor.asking_median}, sell ~$${anchor.sell_price}`);
  return {
    count:       0,
    median:      anchor.asking_median,
    p25:         anchor.price_low,
    p75:         anchor.price_high,
    low:         anchor.price_low,
    high:        anchor.price_high,
    sell_price:  anchor.sell_price,
    source:      'ai_anchor',
    sourceLabel: 'AI market estimate (building DB data)',
  };
}

// Build a verdict from price data alone (no AI)
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
  free:    2 * 60 * 60 * 1000,  // 2 hours
  basic:   30 * 60 * 1000,      // 30 mins
  pro:     30 * 60 * 1000,      // 30 mins
  premium: 30 * 60 * 1000,      // 30 mins
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

// ── SociaVault ────────────────────────────────────────────
const SOCIAVAULT_API_KEY = process.env.SOCIAVAULT_API_KEY || null;
const SOCIAVAULT_BASE    = 'https://api.sociavault.com/v1/scrape/facebook-marketplace';

// Cache city → {latitude, longitude} to avoid repeated location lookups
const _cityCoordCache = new Map();

async function resolveCity(city) {
  const key = (city || 'Melbourne').toLowerCase().trim();
  if (_cityCoordCache.has(key)) return _cityCoordCache.get(key);
  try {
    const res = await axios.get(`${SOCIAVAULT_BASE}/location-search`, {
      params: { query: city || 'Melbourne, Australia' },
      headers: { 'x-api-key': SOCIAVAULT_API_KEY },
      timeout: 10000,
    });
    const loc = (res.data?.locations || [])[0];
    if (!loc) return null;
    const coords = { latitude: loc.latitude, longitude: loc.longitude };
    _cityCoordCache.set(key, coords);
    return coords;
  } catch (e) {
    console.error('[SociaVault] Location lookup failed:', e.message);
    return null;
  }
}

async function sociaVaultKeywordScan(keyword, opts = {}) {
  if (!SOCIAVAULT_API_KEY) return [];
  const t0  = Date.now();
  const cap = opts.initialScan ? 50 : 96;  // 50 on first seed, max on ongoing
  try {
    // Resolve city to coordinates
    const city   = opts.city || 'Melbourne';
    const coords = await resolveCity(city) || { latitude: -37.8136, longitude: 144.9631 }; // Melbourne fallback

    const params = {
      query:       keyword,
      lat:         coords.latitude,
      lng:         coords.longitude,
      radius_km:   opts.radius || 50,
      count:       cap,
      sort_by:     'creation_time_descend',  // newest first
      ...(opts.initialScan ? { date_listed: 'last_7_days' } : {}),
      // Pass price filters to SociaVault so all 24 results are already in range
      ...(opts.minPrice ? { min_price: opts.minPrice } : {}),
      ...(opts.maxPrice ? { max_price: opts.maxPrice } : {}),
    };

    const res = await axios.get(`${SOCIAVAULT_BASE}/search`, {
      params,
      headers: { 'x-api-key': SOCIAVAULT_API_KEY },
      timeout: 30000,
    });

    const elapsed  = Date.now() - t0;
    const listings = res.data?.data?.listings || res.data?.listings || {};
    // SociaVault returns listings as an object with numeric keys
    const allRows  = Object.values(listings);
    const raw      = allRows.filter(r => !r.is_sold && r.is_live !== false).slice(0, cap);
    console.log(`[SociaVault] "${keyword}" → ${raw.length}/${allRows.length} items in ${elapsed}ms`);
    const withDesc = raw.filter(r => r.description && r.description.trim().length > 0).length;
    console.log(`[SociaVault] "${keyword}" → ${withDesc}/${raw.length} items have description in search results`);

    return raw.map(item => {
      const id = item.id || (() => {
        const m = (item.url || '').match(/\/item\/(\d+)\//);
        return m ? m[1] : null;
      })();

      const rawTitle    = item.title || '';
      const description = item.description || null;
      const rawPrice    = item.price?.amount ?? parsePrice(item.price);

      // Decide if this listing is vehicle-like
      const isVehicle = isVehicleKeyword(keyword) || isVehicleListing(keyword, rawTitle, description);

      // Vehicle-specific fields via regex fallback (SociaVault doesn't return structured vehicle data)
      const year  = isVehicle ? extractYear(rawTitle, description)      : null;
      const make  = isVehicle ? extractMake(keyword, rawTitle)          : null;
      const model = isVehicle ? extractModel(make, rawTitle)            : null;
      const title = isVehicle ? normalizeVehicleTitle(rawTitle, year, make) : rawTitle;

      // Date — SociaVault doesn't return listing_date in search results, use foundAt
      const listedAt        = new Date().toISOString();
      const listedAtUnknown = true;

      // Extract series and variant from title for vehicle listings
      const series  = isVehicle ? extractSeriesFromTitle(make, model, rawTitle) : null;
      const variant = isVehicle ? extractVariantFromTitle(rawTitle)             : null;
      const mileage = isVehicle ? (item.mileage?.value || extractMileage(rawTitle, description)) : null;

      return {
        id,
        title,
        price:         rawPrice,
        isOfferPrice:  isOfferPrice(rawPrice),
        url:           item.url || `https://www.facebook.com/marketplace/item/${id}/`,
        image:         item.primary_photo?.url || null,
        location:      item.location?.city || item.location?.display_name || null,
        description,
        keyword,
        listedAt,
        listedAtUnknown,
        foundAt:       new Date().toISOString(),
        // Vehicle-specific — mileage kept for frontend compatibility, stored as kms in Neon
        mileage,
        year,
        make,
        model,
        series,
        variant,
        transmission:  isVehicle ? extractTransmission(rawTitle, description) : null,
        body_style:    isVehicle ? extractBodyStyleFromTitle(rawTitle, description) : null,
        fuel_type:     isVehicle ? extractFuelTypeFromTitle(rawTitle, description) : null,
        engine:        isVehicle ? extractEngineFromTitle(rawTitle, description)   : null,
        // General marketplace fields
        condition:     item.condition || null,
        brand:         null,
        category:      null,
      };
    }).filter(l => l.id);
  } catch (e) {
    const status = e.response?.status;
    if (status === 503 || status === 502 || status === 504) {
      console.warn(`[SociaVault] "${keyword}" — server unavailable (${status}), will retry next scan`);
    } else if (status === 402) {
      console.error(`[SociaVault] OUT OF CREDITS — top up at sociavault.com/dashboard`);
    } else if (status === 401) {
      console.error(`[SociaVault] INVALID API KEY — check SOCIAVAULT_API_KEY in Render env vars`);
    } else {
      console.error(`[SociaVault] Error for "${keyword}" (${Date.now()-t0}ms):`, e.response ? JSON.stringify(e.response.data).slice(0, 200) : e.message);
    }
    return [];
  }
}

async function scrapeKeyword(keyword, opts = {}) {
  return sociaVaultKeywordScan(keyword, opts);
}

// Fetch full listing details from SociaVault item endpoint (1 credit)
// Returns enriched fields: description, creation_time, all photos, attributes (condition)
async function fetchListingDetails(listingId, listingUrl) {
  if (!SOCIAVAULT_API_KEY || (!listingId && !listingUrl)) return null;
  try {
    const params = listingId ? { id: listingId } : { url: listingUrl };
    const res = await axios.get(`${SOCIAVAULT_BASE}/item`, {
      params,
      headers: { 'x-api-key': SOCIAVAULT_API_KEY },
      timeout: 15000,
    });
    const d = res.data?.data;
    if (!d) return null;
    // Extract condition from attributes array/object
    const attrs = d.attributes ? Object.values(d.attributes) : [];
    const conditionAttr = attrs.find(a => a.attribute_name === 'Condition');
    // Extract all photo URLs
    const photos = d.photos ? Object.values(d.photos).map(p => p.url).filter(Boolean) : [];
    return {
      description:  d.description  || null,
      creationTime: d.creation_time || null,
      condition:    conditionAttr?.label || null,
      photos,
      locationText: d.location_text || null,
      vehicle:      parseVehicleInfoFields(d),
    };
  } catch (e) {
    console.error(`[SociaVault] fetchListingDetails error (${listingId || listingUrl}):`, e.message);
    return null;
  }
}


// ── Vehicle helpers ───────────────────────────────────────
const VEHICLE_KEYWORDS = ['car','ute','van','truck','motorcycle','suv','4wd','wagon',
  'sedan','hatch','coupe','convertible','tractor','forklift','boat','caravan',
  'camper','excavator','loader','hilux','landcruiser','patrol','hiace','tarago','kluger',
  'ranger','triton','navara','colorado','dmax','bt50','pajero','prado','defender','discovery',
  'transit','sprinter','vito','ducato','daily','commodore','falcon','camry','corolla',
  'civic','accord','mazda','subaru','toyota','ford','holden','honda','nissan','mitsubishi',
  'hyundai','kia','bmw','mercedes','audi','volkswagen','vw','jeep','ram','dodge',
  'amarok','everest','fortuner','outlander','asx','eclipse','cx5','cx-5','rav4',
  'forester','impreza','wrx','outback','liberty','insignia','astra','captiva'];
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

// Extract mileage from structured vehicle_info block (more accurate than regex)
function extractMileageFromVehicleInfo(item) {
  // Priority 1: subtitle chips — FB returns ["2005", "175,000 km", "Automatic"] here
  const subs = item.custom_sub_titles || item.listing_subtitle || item.subtitle || [];
  const subArr = Array.isArray(subs) ? subs : String(subs || '').split(/[·|]/);
  for (const chip of subArr) {
    const c = String(chip || '').trim();
    const m = c.match(/^(\d{1,3}(?:[,\s]\d{3})+)\s*k(?:m|ms|ilometres?)?$/i)
           || c.match(/^(\d{4,6})\s*k(?:m|ms|ilometres?)?$/i);
    if (m) {
      const val = parseInt(m[1].replace(/[,\s]/g, ''));
      if (val > 1000 && val < 2000000) return val;
    }
  }
  // Priority 2: vehicle_odometer_data — string like "250,000 km"
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
    /odo(?:meter)?[\s:]*(\d{1,3}(?:,\d{3})+)/,         // odo: 210,000
    /odo(?:meter)?[\s:]*(\d{4,6})/,                      // odo: 210000
    /odometer[\s:]*(\d{1,3}(?:,\d{3})+)/,
    /odometer[\s:]*(\d{4,6})/,
  ];
  for (const p of odoPatterns) {
    const m = text.match(p);
    if (m) {
      const val = parseInt(m[1].replace(/,/g, ''));
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
const VPX_REF_KM = 100000;  // mileage reference for normalisation (100k km baseline)
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
  const loc = location.toUpperCase();
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

// Fallback model extraction when structured fields are missing
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
const SHARED_SCAN_TTL_MS = 28 * 60 * 1000; // 28 mins — just under 30-min scan interval

// ── Distribute raw listings to a single user ─────────────
// ── Stage 1: Text-only AI filter ─────────────────────────────────────────────
// One Haiku call for the whole batch. Returns array of listing IDs that passed.
// Runs BEFORE listings hit the feed or DB — keeps junk out entirely.
async function aiTextFilter(listings, keyword) {
  if (!ANTHROPIC_API_KEY && !GEMINI_API_KEY) return listings; // no key — pass all through
  if (!listings.length) return listings;

  try {
    const lines = listings.map((l, i) => {
      const price = l.price ? `$${l.price}` : 'no price';
      const spec  = [l.year, l.mileage ? `${Number(l.mileage).toLocaleString()}km` : null, l.make]
        .filter(Boolean).join(', ');
      return `${i}|${(l.title || '').slice(0, 100)}|${price}${spec ? '|' + spec : ''}`;
    }).join('\n');

    const prompt = `You are filtering Australian Facebook Marketplace listings for a flipper searching: "${keyword}"

For each listing decide:
- relevant: is this actually the item being searched for? Strict — accessories, parts, services, wrong category = false
- pass: would a flipper even consider this? False if: hire/rental, wanted ad, placeholder price, obvious junk with no resale value

Return ONLY a JSON array, one entry per line, same order as input:
[{"i":0,"relevant":true,"pass":true},...]

Listings (index|title|price|specs):
${lines}`;

    let text = '';
    if (ANTHROPIC_API_KEY) {
      const r = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-haiku-4-5-20251001', max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      }, {
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        timeout: 15000,
      });
      text = r.data?.content?.[0]?.text || '';
    } else {
      const r = await geminiPost(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
        { contents: [{ parts: [{ text: prompt }] }], generationConfig: { thinkingConfig: { thinkingBudget: 0 } } },
        { timeout: 15000 }
      );
      text = r.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }

    const match = text.match(/\[[\s\S]*\]/);
    if (!match) {
      console.warn('[TextFilter] Bad AI response — passing all through');
      return listings;
    }

    const results = JSON.parse(match[0]);
    const passSet = new Set(
      results.filter(r => r.relevant !== false && r.pass !== false).map(r => r.i)
    );

    const passed  = listings.filter((_, i) => passSet.has(i));
    const removed = listings.length - passed.length;
    if (removed > 0) {
      const removedTitles = listings
        .filter((_, i) => !passSet.has(i))
        .map(l => `"${(l.title || '').slice(0, 50)}"`)
        .join(', ');
      console.log(`[TextFilter] "${keyword}" → removed ${removed}: ${removedTitles}`);
    }
    console.log(`[TextFilter] "${keyword}" → ${passed.length}/${listings.length} passed text filter`);
    return passed;

  } catch (e) {
    console.error('[TextFilter] Error:', e.message);
    return listings; // fail open — don't lose listings on API error
  }
}

// ── Stage 2: Image filter ─────────────────────────────────────────────────────
// Runs on text-filtered listings while FB image URLs are still fresh.
// One Gemini Flash call per listing (parallel, capped at 6 concurrent).
// Rejects: wrong item in photo, derelict/destroyed condition, pure stock photos
// that hide real condition, photos that clearly mismatch the title.
async function aiImageFilter(listings, keyword) {
  if (!GEMINI_API_KEY) return listings;
  if (!listings.length) return listings;

  const CONCURRENCY = 6;
  const results     = new Array(listings.length).fill(null);

  async function checkOne(listing, idx) {
    if (!listing.image) {
      results[idx] = { pass: true, reason: 'no_image' };
      return;
    }
    try {
      // Fetch image — if it's already expired just pass through (text filter already ran)
      let imgBase64, imgMime = 'image/jpeg';
      try {
        const imgRes = await axios.get(listing.image, {
          responseType: 'arraybuffer', timeout: 8000,
          headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.facebook.com/' },
        });
        imgBase64 = Buffer.from(imgRes.data).toString('base64');
        imgMime   = imgRes.headers['content-type']?.split(';')[0] || 'image/jpeg';
      } catch (_) {
        // Image expired or unreachable — pass through, text filter already ran
        results[idx] = { pass: true, reason: 'image_unavailable' };
        return;
      }

      const prompt = `Australian Facebook Marketplace listing photo check.
Keyword searched: "${keyword}"
Title: "${(listing.title || '').slice(0, 120)}"
Price: ${listing.price ? '$' + listing.price : 'unknown'} AUD

Look at the photo. Return ONLY JSON:
{
  "pass": true|false,
  "condition": "new"|"like_new"|"good"|"fair"|"poor"|"damaged"|"cannot_assess",
  "reject_reason": null|"brief reason e.g. photo shows a rusted wreck"|"wrong item — photo shows X not Y"
}

Reject (pass:false) ONLY if:
- Photo clearly shows a completely DIFFERENT type of item to the keyword
- Item is obviously destroyed/derelict/unsalvageable (not just worn — actually wrecked)
- Photo is clearly a placeholder/no-item (blank wall, random object, meme)
Approve everything else — minor wear, fair condition, stock photos are all fine.`;

      const gemRes = await geminiPost(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
        { contents: [{ parts: [
          { inline_data: { mime_type: imgMime, data: imgBase64 } },
          { text: prompt }
        ]}], generationConfig: { thinkingConfig: { thinkingBudget: 0 } } },
        { timeout: 12000 }
      );

      const raw   = gemRes.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const mJson = raw.match(/\{[\s\S]*\}/);
      if (!mJson) { results[idx] = { pass: true, reason: 'parse_error' }; return; }

      const r = JSON.parse(mJson[0]);
      results[idx] = { pass: r.pass !== false, condition: r.condition, reason: r.reject_reason };

      // Save image analysis to DB so nightly batch skips it
      // Damaged items also excluded from price pool — a smashed phone skews medians down
      if (listing.id) {
        const isDamaged = r.condition === 'damaged' || r.condition === 'poor';
        const isWrong   = r.pass === false;
        pool.query(`
          UPDATE listings SET
            img_condition       = $1,
            img_matches_keyword = $2,
            img_mismatch_reason = $3,
            img_analysed_at     = NOW(),
            price_quality = CASE
              WHEN $2 = FALSE THEN 'spam'
              WHEN $4 = TRUE  THEN 'damage'
              ELSE price_quality
            END,
            in_price_pool = CASE
              WHEN $2 = FALSE THEN FALSE
              WHEN $4 = TRUE  THEN FALSE
              ELSE in_price_pool
            END
          WHERE listing_id = $5
        `, [r.condition || null, !isWrong, r.reject_reason || null, isDamaged, listing.id])
        .catch(() => {});
      }

    } catch (e) {
      console.error(`[ImageFilter] Error on "${(listing.title||'').slice(0,40)}":`, e.message);
      results[idx] = { pass: true, reason: 'error' }; // fail open
    }
  }

  // Run with concurrency cap — don't hammer Gemini with 50 simultaneous calls
  for (let i = 0; i < listings.length; i += CONCURRENCY) {
    const batch = listings.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map((l, j) => checkOne(l, i + j)));
  }

  const passed  = listings.filter((_, i) => results[i]?.pass !== false);
  const removed = listings.length - passed.length;
  if (removed > 0) {
    listings
      .filter((_, i) => results[i]?.pass === false)
      .forEach(l => console.log(`[ImageFilter] ❌ "${(l.title||'').slice(0,60)}" — ${results[listings.indexOf(l)]?.reason}`));
  }
  console.log(`[ImageFilter] "${keyword}" → ${passed.length}/${listings.length} passed image filter`);
  return passed;
}

// ── Two-stage AI gate — runs once per scrape, shared across all users ─────────
// Text filter first (cheap), then image filter on survivors (more expensive but
// only runs on listings that already passed text — keeps cost down).
// Result is cached so multiple users watching the same keyword share the work.
async function runAIGate(listings, keyword) {
  if (!listings.length) return listings;
  const stage1 = await aiTextFilter(listings, keyword);
  const stage2 = await aiImageFilter(stage1, keyword);
  console.log(`[AIGate] "${keyword}" → ${listings.length} in → ${stage1.length} after text → ${stage2.length} after image`);
  return stage2;
}

async function distributeListingsToUser(watcher, raw, opts = {}) {
  if (!Array.isArray(raw)) raw = [];
  const keyword      = watcher.keyword.toLowerCase();
  const userId       = watcher.userId;
  const seen         = await getUserSeen(userId);
  const userListings = await getUserListings(userId);
  let newCount       = 0;

  const excludeWords = Array.isArray(watcher.excludeWords) ? watcher.excludeWords : [];

  // Apply user-defined exclude words — everything else handled by AI gate upstream
  const relevant = raw.filter(l => {
    if (!excludeWords.length) return true;
    const full = ((l.title || '') + ' ' + (l.description || '')).toLowerCase();
    return !excludeWords.some(w => w && full.includes(w));
  });

  const dropped = raw.length - relevant.length;
  if (dropped > 0) {
    console.log(`[Filter] "${keyword}" — dropped ${dropped} listing(s) (excluded words)`);
    const blockedListings = raw.filter(l => !relevant.includes(l)).map(l => ({
      id: l.id, title: l.title, price: l.price, url: l.url,
      image: l.image, keyword, blockedAt: new Date().toISOString()
    }));
    redisGet(K.blocked(watcher.userId)).then(existing => {
      const all    = Array.isArray(existing) ? existing : [];
      const merged = [...blockedListings, ...all.filter(e => !blockedListings.find(b => b.id === e.id))];
      redisSet(K.blocked(watcher.userId), merged.slice(0, 100));
    }).catch(() => {});
  }

  let seenSkipped = 0;
  let dropMaxPrice = 0, dropMinPrice = 0;

  for (let listing of relevant) {
    listing = await checkPriceDrop(listing);
    storeScanPrice(keyword, listing).catch(() => {});

    const key    = `${keyword}:${listing.id}`;
    const seenTs = seen[key];

    const isPriceDrop = listing.priceDropped && listing.price < (listing.previousPrice || Infinity);
    if (seenTs && (Date.now() - seenTs) < SEEN_TTL_MS && !isPriceDrop) {
      if (!opts.initialScan) { seenSkipped++; continue; }
    }

    if (watcher.maxPrice && listing.price && listing.price > watcher.maxPrice) { dropMaxPrice++; continue; }
    if (watcher.minPrice && listing.price && listing.price < watcher.minPrice) { dropMinPrice++; continue; }
    if (watcher.minYear && listing.year && listing.year < watcher.minYear) continue;
    if (watcher.maxYear && listing.year && listing.year > watcher.maxYear) continue;
    if (watcher.minKms  && listing.mileage && listing.mileage < watcher.minKms) continue;
    if (watcher.maxKms  && listing.mileage && listing.mileage > watcher.maxKms) continue;
    if (watcher.transmission && listing.transmission &&
        listing.transmission.toLowerCase() !== watcher.transmission.toLowerCase()) continue;

    seen[key] = Date.now();

    if (!userListings.find(l => l.id === listing.id)) {
      userListings.push(listing);
      userListings.sort((a, b) =>
        new Date(b.foundAt || b.listedAt) - new Date(a.foundAt || a.listedAt)
      );
      if (userListings.length > 500) userListings.length = 500;
    }
    newCount++;

    const pToken   = watcher.pushoverToken || process.env.PUSHOVER_TOKEN;
    const pUser    = watcher.pushoverUser  || process.env.PUSHOVER_USER;
    const priceStr = listing.price ? `$${listing.price}` : 'Price unknown';
    const dropStr  = listing.priceDropped
      ? ` 🔻 Price dropped from $${listing.previousPrice} (-$${listing.dropAmount})`
      : '';
    const pushTitle = listing.priceDropped ? `💸 Price Drop: ${keyword}` : `FlipRadar: ${keyword}`;

    await sendPushover(pToken, pUser, pushTitle, `${listing.title}\n${priceStr}${dropStr}`, listing.url);
    sendWebPush(watcher.userId, {
      title: pushTitle,
      body:  `${priceStr}${dropStr} · ${listing.location || keyword}`,
      url:   listing.url,
      tag:   `listing-${listing.id}`,
    }).catch(() => {});
    await sleep(300);
  }

  if (relevant.length > 0) {
    console.log(`[Distribute] "${keyword}" → ${relevant.length} in, ${newCount} new, ${seenSkipped} seen, ${dropMaxPrice + dropMinPrice} outside price range`);
  }

  if (newCount > 0) {
    await saveUserListings(userId, userListings);
    await saveUserSeen(userId, seen);
  }

  return { newCount, userListings };
}

// ── Per-watch scan — shared cache + shared AI gate across all users ────────────
// One SociaVault call + one AI gate pass per keyword per scan interval.
// All users watching the same keyword share both the scrape and the filtering.
async function scanWatchItem(watcher, opts = {}) {
  const keyword = watcher.keyword.toLowerCase();

  let raw;
  const cached = await redisGet(K.sharedScan(keyword));
  if (!opts.initialScan && cached && (Date.now() - new Date(cached.scannedAt).getTime()) < SHARED_SCAN_TTL_MS) {
    raw = cached.listings || [];
    console.log(`[SharedCache] "${keyword}" → ${raw.length} listings from cache`);
  } else {
    // Scrape fresh
    const scraped = await scrapeKeyword(keyword, {
      city: watcher.location, lat: watcher.lat, lng: watcher.lng,
      radius: watcher.radius, initialScan: opts.initialScan || false,
      minPrice: watcher.minPrice || null,
      maxPrice: watcher.maxPrice || null,
    });

    // ── Run two-stage AI gate before caching ──────────────
    // Filters here means every user who hits this cache gets clean listings.
    // Image URLs are still fresh at this point — critical for image filter.
    raw = await runAIGate(scraped, keyword);

    await redisSet(K.sharedScan(keyword), { listings: raw, scannedAt: new Date().toISOString() });
    console.log(`[SharedCache] "${keyword}" → cached ${raw.length} clean listings (${scraped.length - raw.length} removed by AI gate)`);

    // Distribute to other users watching this keyword
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

  if (!Array.isArray(raw)) raw = [];

  if (opts.initialScan && raw.length > 1) {
    raw = [...raw].sort((a, b) => {
      if (a.listedAtUnknown && !b.listedAtUnknown) return 1;
      if (!a.listedAtUnknown && b.listedAtUnknown) return -1;
      return new Date(b.listedAt || b.foundAt || 0) - new Date(a.listedAt || a.foundAt || 0);
    });
    console.log(`[InitialScan] "${keyword}" → passing all ${raw.length} AI-filtered listings`);
  }

  const { newCount, userListings } = await distributeListingsToUser(watcher, raw, opts);

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

// ── Nightly DB stats rebuild + IQR outlier pass (2am AEST) ──
// 1. Back-scores any unscored/changed listings with quality flags
// 2. Runs per-keyword IQR pass to tag statistical outliers
// 3. Rebuilds pre-computed stats tables so appraisals are instant
cron.schedule('0 2 * * *', async () => {
  console.log('[Cron] Starting nightly quality pass + stats rebuild...');
  try {

    // ── Step 1: Re-score listings flagged unscored or with stale quality ──
    // Catches any listings written before quality scoring was added
    await pool.query(`
      UPDATE listings SET
        quality_flags = (
          CASE WHEN title ~* '\\m(broken|cracked|faulty|damaged|spares?|repairs?|parts? only|not working|dead|seized|blown|written off|wrecked|flood|hail|project car|needs work|as.?is)\\M' THEN 2 ELSE 0 END |
          CASE WHEN title ~* '\\m(swap|swaps|trade|trades|pto|part trade|part swap)\\M'  THEN 4 ELSE 0 END |
          CASE WHEN title ~* '\\m(follow|instagram|whatsapp|telegram|bit\\.ly|t\\.me)\\M' THEN 64 ELSE 0 END
        ),
        price_quality = CASE
          WHEN title ~* '\\m(broken|cracked|faulty|damaged|spares?|repairs?|parts? only|not working|dead|seized|blown|written off|wrecked|flood|hail|project car|needs work|as.?is)\\M' THEN 'not_for_sale'
          WHEN title ~* '\\m(swap|swaps|trade|trades|pto|part trade|part swap)\\M'  THEN 'not_for_sale'
          WHEN title ~* '\\m(follow|instagram|whatsapp|telegram|bit\\.ly|t\\.me)\\M' THEN 'spam'
          ELSE 'ok'
        END,
        in_price_pool = CASE
          WHEN title ~* '\\m(broken|cracked|faulty|damaged|spares?|repairs?|parts? only|not working|dead|seized|blown|written off|wrecked|flood|hail|project car|needs work|as.?is)\\M' THEN FALSE
          WHEN title ~* '\\m(swap|swaps|trade|trades|pto|part trade|part swap)\\M'  THEN FALSE
          WHEN title ~* '\\m(follow|instagram|whatsapp|telegram|bit\\.ly|t\\.me)\\M' THEN FALSE
          ELSE TRUE
        END
      WHERE price_quality = 'unscored' OR price_quality IS NULL
    `);

    // ── Step 2: IQR outlier pass — per keyword ─────────────
    // Marks listings whose price falls outside p25-1.5*IQR .. p75+1.5*IQR as outliers
    // This catches listings like "$50 iPhone 14 Pro" or "$200,000 Toyota Corolla"
    await pool.query(`
      WITH cohort_fences AS (
        SELECT
          keyword,
          PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY price) AS p25,
          PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY price) AS p75
        FROM listings
        WHERE keyword IS NOT NULL
          AND price > 0 AND is_offer_price = FALSE
          AND price_quality = 'ok'
          AND is_active = TRUE
          AND scraped_at > NOW() - INTERVAL '90 days'
        GROUP BY keyword
        HAVING COUNT(*) >= 8
      )
      UPDATE listings l SET
        price_quality = 'outlier',
        quality_flags = quality_flags | 8,
        in_price_pool = FALSE
      FROM cohort_fences f
      WHERE l.keyword = f.keyword
        AND l.price_quality = 'ok'
        AND l.is_active = TRUE
        AND (
          l.price < GREATEST(0, f.p25 - 1.5 * (f.p75 - f.p25))
          OR
          l.price > f.p75 + 1.5 * (f.p75 - f.p25)
        )
    `);

    // ── Step 3: IQR outlier pass — per vehicle cohort ──────
    await pool.query(`
      WITH vehicle_fences AS (
        SELECT
          make, model, year,
          PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY price) AS p25,
          PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY price) AS p75
        FROM listings
        WHERE make IS NOT NULL AND year IS NOT NULL
          AND price > 0 AND is_offer_price = FALSE
          AND price_quality = 'ok'
          AND is_active = TRUE
        GROUP BY make, model, year
        HAVING COUNT(*) >= 8
      )
      UPDATE listings l SET
        price_quality = 'outlier',
        quality_flags = quality_flags | 8,
        in_price_pool = FALSE
      FROM vehicle_fences f
      WHERE l.make = f.make
        AND (l.model = f.model OR (l.model IS NULL AND f.model IS NULL))
        AND l.year = f.year
        AND l.price_quality = 'ok'
        AND l.is_active = TRUE
        AND (
          l.price < GREATEST(0, f.p25 - 1.5 * (f.p75 - f.p25))
          OR
          l.price > f.p75 + 1.5 * (f.p75 - f.p25)
        )
    `);

    // ── Step 4: Rebuild keyword_price_stats ──
    // Anchor-gated, IQR-cleaned, bulk-excluded, condition-split, broad-flagged.
    await pool.query(`
      INSERT INTO keyword_price_stats
        (keyword, sample_count, raw_count, median_price, p25_price, p75_price,
         iqr, floor_price, ceiling_price, low_price, high_price,
         is_broad, updated_at)
      WITH anchors AS (
        SELECT keyword, anchor_price FROM keyword_anchors
      ),
      base AS (
        SELECT l.keyword,
          COUNT(*)::INT AS raw_count,
          PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY l.price)::INT AS p25,
          PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY l.price)::INT AS p75
        FROM listings l
        LEFT JOIN anchors a ON a.keyword = l.keyword
        WHERE l.keyword IS NOT NULL AND l.price > 0
          AND l.is_offer_price = FALSE AND l.in_price_pool = TRUE AND l.is_active = TRUE
          AND l.scraped_at > NOW() - INTERVAL '90 days'
          AND (l.is_bulk_lot IS NULL OR l.is_bulk_lot = FALSE)
          AND (a.anchor_price IS NULL
            OR l.price BETWEEN a.anchor_price * 0.30 AND a.anchor_price * 2.20)
        GROUP BY l.keyword HAVING COUNT(*) >= 5
      ),
      fenced AS (
        SELECT l.keyword,
          b.raw_count, b.p25, b.p75,
          (b.p75 - b.p25)                               AS iqr,
          GREATEST(0, b.p25 - 1.5*(b.p75-b.p25))::INT  AS fence_lo,
          (b.p75 + 1.5*(b.p75-b.p25))::INT             AS fence_hi,
          COUNT(*)::INT                                 AS clean_count,
          PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY l.price)::INT AS median,
          MIN(l.price)::INT AS low, MAX(l.price)::INT AS high,

        FROM listings l
        JOIN base b ON l.keyword = b.keyword
        LEFT JOIN anchors a ON a.keyword = l.keyword
        WHERE l.price BETWEEN GREATEST(0, b.p25 - 1.5*(b.p75-b.p25))
                          AND (b.p75 + 1.5*(b.p75-b.p25))
          AND (a.anchor_price IS NULL
            OR l.price BETWEEN a.anchor_price * 0.30 AND a.anchor_price * 2.20)
          AND l.is_offer_price = FALSE AND l.in_price_pool = TRUE
          AND l.is_active = TRUE
          AND (l.is_bulk_lot IS NULL OR l.is_bulk_lot = FALSE)
          AND l.scraped_at > NOW() - INTERVAL '90 days'
        GROUP BY l.keyword, b.raw_count, b.p25, b.p75
        HAVING COUNT(*) >= 5
      )
      SELECT keyword, clean_count, raw_count, median, p25, p75,
             iqr::INT, fence_lo, fence_hi, low, high,
             (iqr > median * 1.5) AS is_broad,
             NOW()
      FROM fenced
      ON CONFLICT (keyword) DO UPDATE SET
        sample_count  = EXCLUDED.sample_count,
        raw_count     = EXCLUDED.raw_count,
        median_price  = EXCLUDED.median_price,
        p25_price     = EXCLUDED.p25_price,
        p75_price     = EXCLUDED.p75_price,
        iqr           = EXCLUDED.iqr,
        floor_price   = EXCLUDED.floor_price,
        ceiling_price = EXCLUDED.ceiling_price,
        low_price     = EXCLUDED.low_price,
        high_price    = EXCLUDED.high_price,
        is_broad      = EXCLUDED.is_broad,
        updated_at    = NOW()
    `);

    // ── Step 5: Rebuild vehicle_price_stats — keyed by precise cohort ──
    // Groups by every identity dimension, building one row per unique cohort.
    // cohort_key = make|model|series|variant|year_band|mileage_band|transmission
    await pool.query(`
      INSERT INTO vehicle_price_stats
        (cohort_key, make, model, series, variant, body_style,
         year_band, mileage_band, transmission,
         sample_count, raw_count,
         median_price, p25_price, p75_price,
         iqr, floor_price, ceiling_price, updated_at)
      WITH raw_cohorts AS (
        SELECT
          LOWER(make)
            || '|' || LOWER(COALESCE(model,''))
            || '|' || LOWER(COALESCE(series,''))
            || '|' || LOWER(COALESCE(variant,''))
            || '|' || COALESCE(year_band,'unknown')
            || '|' || COALESCE(mileage_band,'unknown')
            || '|' || LOWER(COALESCE(transmission,''))   AS cohort_key,
          make, COALESCE(model,'') AS model,
          series, variant, body_style,
          year_band, mileage_band, transmission,
          COUNT(*)::INT AS raw_count,
          PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY price)::INT AS p25,
          PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY price)::INT AS p75
        FROM listings
        WHERE make IS NOT NULL AND year_band IS NOT NULL
          AND price > 0 AND is_offer_price = FALSE
          AND in_price_pool = TRUE
          AND listing_status IN ('active','sold')
        GROUP BY cohort_key, make, COALESCE(model,''), series, variant,
                 body_style, year_band, mileage_band, transmission
        HAVING COUNT(*) >= 5
      ),
      fenced AS (
        SELECT
          rc.cohort_key, rc.make, rc.model, rc.series, rc.variant,
          rc.body_style, rc.year_band, rc.mileage_band, rc.transmission,
          rc.raw_count,
          (rc.p75 - rc.p25)                                AS iqr,
          GREATEST(0, rc.p25 - 1.5*(rc.p75-rc.p25))::INT  AS fence_lo,
          (rc.p75 + 1.5*(rc.p75-rc.p25))::INT             AS fence_hi,
          COUNT(l.id)::INT                                 AS clean_count,
          PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY l.price)::INT AS median,
          PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY l.price)::INT AS p25_clean,
          PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY l.price)::INT AS p75_clean
        FROM listings l
        JOIN raw_cohorts rc ON (
          LOWER(l.make) = LOWER(rc.make)
          AND COALESCE(l.model,'') = rc.model
          AND COALESCE(l.series,'')       = COALESCE(rc.series,'')
          AND COALESCE(l.variant,'')      = COALESCE(rc.variant,'')
          AND COALESCE(l.year_band,'unknown')    = COALESCE(rc.year_band,'unknown')
          AND COALESCE(l.mileage_band,'unknown') = COALESCE(rc.mileage_band,'unknown')
          AND COALESCE(l.transmission,'')        = COALESCE(rc.transmission,'')
        )
        WHERE l.price BETWEEN GREATEST(0, rc.p25 - 1.5*(rc.p75-rc.p25))
                          AND (rc.p75 + 1.5*(rc.p75-rc.p25))
          AND l.is_offer_price = FALSE
          AND l.in_price_pool = TRUE
          AND l.listing_status IN ('active','sold')
        GROUP BY rc.cohort_key, rc.make, rc.model, rc.series, rc.variant,
                 rc.body_style, rc.year_band, rc.mileage_band, rc.transmission,
                 rc.raw_count, rc.p25, rc.p75
        HAVING COUNT(l.id) >= 5
      )
      SELECT cohort_key, make, model, series, variant, body_style,
             year_band, mileage_band, transmission,
             clean_count, raw_count,
             median, p25_clean, p75_clean,
             iqr::INT, fence_lo, fence_hi, NOW()
      FROM fenced
      ON CONFLICT (cohort_key) DO UPDATE SET
        sample_count  = EXCLUDED.sample_count,
        raw_count     = EXCLUDED.raw_count,
        median_price  = EXCLUDED.median_price,
        p25_price     = EXCLUDED.p25_price,
        p75_price     = EXCLUDED.p75_price,
        iqr           = EXCLUDED.iqr,
        floor_price   = EXCLUDED.floor_price,
        ceiling_price = EXCLUDED.ceiling_price,
        updated_at    = NOW()
    `);

    // ── Step 6: Mark gone listings as sold (not inactive) ──
    // Listings not seen in 30 days assumed sold — price stays in pool
    const sold = await pool.query(`
      UPDATE listings
      SET listing_status = 'sold',
          is_active      = FALSE
      WHERE last_seen_at < NOW() - INTERVAL '30 days'
        AND listing_status = 'active'
        AND is_active = TRUE
      RETURNING id
    `);

    // ── Step 7: Report ─────────────────────────────────────
    const [summary, outlierCount, poolCount] = await Promise.all([
      getDBSummary(),
      pool.query(`SELECT COUNT(*)::INT AS cnt FROM listings WHERE price_quality = 'outlier'`),
      pool.query(`SELECT COUNT(*)::INT AS cnt FROM listings WHERE in_price_pool = TRUE AND is_active = TRUE`),
    ]);
    const soldCount = await pool.query(`SELECT COUNT(*)::INT AS cnt FROM listings WHERE listing_status='sold'`);
    console.log(
      `[Cron] Done. Total: ${summary?.total_listings} listings · ` +
      `In price pool: ${poolCount.rows[0].cnt} · ` +
      `Outliers tagged: ${outlierCount.rows[0].cnt} · ` +
      `Marked sold: ${sold.rowCount} · ` +
      `Total sold in DB: ${soldCount.rows[0].cnt}`
    );
    // ── Step 8: AI product extraction ────────────────────────
    await extractProductsNightly();

    // ── Step 9: Rebuild product_price_stats ────────────────
    await rebuildProductPriceStats();

    // ── Step 10: AI flip scoring ──────────────────────────────
    await scoreDealsWithAINightly();

  } catch (e) {
    console.error('[Cron] Stats rebuild error:', e.message);
  }
});

// ── AI Flip Scoring ─────────────────────────────────────────────────────────
// Reads title + description + price + image analysis results and asks Gemini
// to score each listing as a flip opportunity. One API call per listing.
// Runs nightly, never re-scores. Only scores listings that are in the price pool.

async function scoreDealsWithAINightly() {
  if (!GEMINI_API_KEY && !ANTHROPIC_API_KEY) {
    console.log('[FlipScore] No AI key — skipping'); return;
  }

  const BATCH = 30;
  let processed = 0;

  while (true) {
    // Pick unscored listings that are active, real-priced, not already spam/damage-excluded
    const { rows } = await pool.query(`
      SELECT
        l.id, l.listing_id, l.title, l.description, l.price,
        l.keyword, l.category, l.make, l.model, l.year, l.kms,
        l.image_url, l.img_condition, l.img_matches_keyword,
        l.extracted_product, l.extracted_category, l.extracted_brand,
        k.median_price, k.p25_price, k.p75_price
      FROM listings l
      LEFT JOIN keyword_price_stats k ON k.keyword = l.keyword
      WHERE l.flip_scored_at IS NULL
        AND l.price > 0
        AND l.is_offer_price = FALSE
        AND l.is_active = TRUE
        AND l.price_quality NOT IN ('spam','swap','accessory')
        AND l.img_matches_keyword IS NOT FALSE
        -- Only score listings from flipper-relevant seed keywords
        AND l.keyword = ANY($2)
        -- Minimum price floor — nothing under $50 is worth scoring
        AND l.price >= 50
        -- Exclude obvious household junk from scoring budget
        AND l.title !~* '\\m(casserole|saucepan|pot set|cutlery|crockery|dinner set|plate set|vase|ornament|curtain|cushion|doona|pillow|towel|rug|lamp|candle|dining chair|coffee table|bedside table|chest of drawers|tv unit|bunk bed)\\M'
      ORDER BY l.price DESC, l.scraped_at DESC
      LIMIT $1
    `, [BATCH, SEED_KEYWORDS]);

    if (!rows.length) break;
    console.log(`[FlipScore] Scoring batch of ${rows.length} listings...`);

    for (const row of rows) {
      try {
        const median    = row.median_price || null;
        const product   = row.extracted_product || row.title || row.keyword || 'unknown item';
        const condition = row.img_condition || 'unknown';
        const desc      = (row.description || '').slice(0, 300);
        const isBroken  = /\b(broken|faulty|not working|dead|cracked|smashed|parts only|as is|for parts|damaged|repair|needs work|spares)\b/i.test((row.title || '') + ' ' + desc);

        const prompt = `You are an expert Australian marketplace flipper scoring a Facebook Marketplace listing as a flip opportunity.

Listing:
- Product: ${product}
- Title: "${(row.title||'').slice(0,120)}"
- Description: "${desc}"
- Listed price: ${row.price} AUD
- Photo condition assessment: ${condition}
- Keyword median market price: ${median ? '$'+median+' AUD' : 'unknown'}
- Market p25/p75: ${row.p25_price ? '$'+row.p25_price : '?'} / ${row.p75_price ? '$'+row.p75_price : '?'}

- Appears broken/faulty: ${isBroken}

Score this as a FLIP OPPORTUNITY for someone who buys cheap and resells for profit in Australia.
Consider: actual resale value, condition, demand, how fast it sells, fix cost if broken.

Return ONLY valid JSON (no markdown, no explanation):
{
  "flip_score": <0-100 integer. 0=waste of time, 100=exceptional flip>,
  "deal_type": "underpriced" | "broken_fixable" | "rare_find" | "bulk_lot" | "not_a_deal",
  "demand": "high" | "medium" | "low",
  "estimated_resale": <realistic AUD resale price as integer, or null>,
  "estimated_margin": <estimated profit after buy + fix costs, or null>,
  "fix_cost_estimate": <estimated repair cost in AUD if broken, else null>,
  "reasoning": "<one concise sentence explaining the score, max 80 chars>"
}

Scoring guide:
- 85-100: Exceptional — clear undervalue, high demand, easy flip, great margin
- 65-84: Solid — good margin, reasonable demand, low risk  
- 45-64: Worth a look — some upside but competition or condition concerns
- 20-44: Marginal — thin margin, slow seller, or condition risk
- 0-19: Not worth it — overpriced, no demand, or too risky
- broken_fixable: only if fixable by a competent hobbyist for <30% of resale value
- rare_find: limited supply, collector interest, or hard to find locally`;

        let text = '';
        if (GEMINI_API_KEY) {
          const parts = [{ text: prompt }];
          // Add image if available
          if (row.image_url) {
            try {
              const imgRes = await axios.get(row.image_url, {
                responseType: 'arraybuffer', timeout: 10000,
                headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.facebook.com/' },
              });
              parts.unshift({ inline_data: {
                mime_type: imgRes.headers['content-type']?.split(';')[0] || 'image/jpeg',
                data: Buffer.from(imgRes.data).toString('base64'),
              }});
            } catch (_) {}
          }
          const res = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
            { contents: [{ parts }], generationConfig: { thinkingConfig: { thinkingBudget: 0 } } },
            { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
          );
          text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        } else {
          const res = await axios.post('https://api.anthropic.com/v1/messages', {
            model: 'claude-haiku-4-5-20251001', max_tokens: 300,
            messages: [{ role: 'user', content: prompt }],
          }, { headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, timeout: 20000 });
          text = res.data?.content?.[0]?.text || '';
        }

        const match = text.match(/\{[\s\S]*\}/);
        if (!match) {
          await pool.query('UPDATE listings SET flip_scored_at = NOW() WHERE id = $1', [row.id]);
          continue;
        }

        const r = JSON.parse(match[0]);
        const flipScore = Math.max(0, Math.min(100, parseInt(r.flip_score) || 0));

        await pool.query(`
          UPDATE listings SET
            flip_score            = $1,
            flip_deal_type        = $2,
            flip_demand           = $3,
            flip_estimated_resale = $4,
            flip_estimated_margin = $5,
            flip_fix_cost         = $6,
            flip_reasoning        = $7,
            flip_scored_at        = NOW()
          WHERE id = $8
        `, [
          flipScore,
          r.deal_type            || 'not_a_deal',
          r.demand               || 'medium',
          r.estimated_resale     ? parseInt(r.estimated_resale)  : null,
          r.estimated_margin     ? parseInt(r.estimated_margin)  : null,
          r.fix_cost_estimate    ? parseInt(r.fix_cost_estimate) : null,
          (r.reasoning || '').slice(0, 120),
          row.id,
        ]);

        processed++;
        await new Promise(res => setTimeout(res, 500));

      } catch (e) {
        console.error(`[FlipScore] Error on ${row.listing_id}:`, e.message);
        await pool.query('UPDATE listings SET flip_scored_at = NOW() WHERE id = $1', [row.id]);
      }
    }

    console.log(`[FlipScore] ${processed} listings scored so far...`);
  }

  console.log(`[FlipScore] ✅ Done — ${processed} listings AI-scored`);
}

// ── Gemini Image Analysis ───────────────────────────────────────────────────
// Analyses each listing photo to:
//   1. Assess item condition (new/like_new/good/fair/poor/damaged)
//   2. Verify the photo actually matches the keyword — flags mismatches (e.g. moped listed as electric scooter)
// Runs nightly, never re-analyses a listing. Costs ~$0.000075 per image.

// ── Product Extraction ────────────────────────────────────
// Reads unprocessed listing titles in batches of 50, asks Claude to identify
// the exact product, saves back to DB. Runs nightly — never re-processes a listing.

async function extractProductsNightly() {
  if (!ANTHROPIC_API_KEY) { console.log('[Extract] No Anthropic key — skipping'); return; }

  const BATCH = 50;
  let processed = 0;

  while (true) {
    // Grab next batch of unextracted listings (non-vehicle, has a real price)
    const { rows } = await pool.query(`
      SELECT id, listing_id, title, keyword, price
      FROM listings
      WHERE extracted_at IS NULL
        AND category != 'vehicle'
        AND price > 0
        AND is_offer_price = FALSE
        AND price_quality IN ('ok', 'unscored')
        AND title IS NOT NULL AND title != ''
      ORDER BY scraped_at DESC
      LIMIT $1
    `, [BATCH]);

    if (!rows.length) break;

    console.log(`[Extract] Processing batch of ${rows.length} listings...`);

    // Build prompt — ask Claude to classify all titles in one call
    const items = rows.map((r, i) => `${i+1}. "${r.title.replace(/"/g, "'").slice(0, 120)}" (keyword: ${r.keyword || 'unknown'}, price: ${r.price})`).join('\n');

    const prompt = `You are extracting structured product data from Australian Facebook Marketplace listing titles.

For each listing, identify the EXACT product being sold. Focus on the specific model/item, not accessories or bundles.

Rules:
- extracted_product: the clean standardised product name (e.g. "Milwaukee M18 Impact Driver", "iPhone 15 Pro 256GB", "Weber Q2200 BBQ", "Dyson V15 Detect", "Trek Marlin 7 Mountain Bike")
- brand: the manufacturer/brand (e.g. "Milwaukee", "Apple", "Weber", "Trek")  
- category: one of: phones | laptops | tablets | gaming | tvs | audio | power_tools | hand_tools | garden | camping | vehicles | bikes | furniture | appliances | fitness | musical_instruments | photography | baby_kids | clothing | watches | collectibles | trade_industrial | general
- variant: any key differentiator like storage size, colour, voltage, size (e.g. "256GB", "18V", "65 inch", "XL") — null if none
- confidence: "high" if you are certain of the exact product, "medium" if you made a reasonable guess, "low" if the title is too vague

Listings:
${items}

Return ONLY a JSON array with ${rows.length} objects in the same order:
[{"extracted_product":"...","brand":"...","category":"...","variant":"...","confidence":"..."},...]

No explanation. No markdown. Start with [ and end with ].`;

    try {
      const resp = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
      }, {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        timeout: 30000,
      });

      const text = resp.data?.content?.[0]?.text || '';
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) { console.error('[Extract] Bad response, skipping batch'); break; }

      const results = JSON.parse(match[0]);

      // Write results back to DB
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const r = results[i] || {};
        await pool.query(`
          UPDATE listings SET
            extracted_product     = $1,
            extracted_brand       = $2,
            extracted_category    = $3,
            extracted_variant     = $4,
            extraction_confidence = $5,
            extracted_at          = NOW()
          WHERE id = $6
        `, [
          r.extracted_product || null,
          r.brand             || null,
          r.category          || null,
          r.variant           || null,
          r.confidence        || 'low',
          row.id,
        ]);
      }

      processed += rows.length;
      console.log(`[Extract] ${processed} listings extracted so far...`);

      // Small delay between batches — be gentle on API
      await new Promise(res => setTimeout(res, 1000));

    } catch (e) {
      console.error('[Extract] Batch failed:', e.message);
      // Mark these as attempted so we don't retry in an infinite loop
      const ids = rows.map(r => r.id);
      await pool.query(`UPDATE listings SET extracted_at = NOW() WHERE id = ANY($1)`, [ids]);
      break;
    }
  }

  console.log(`[Extract] ✅ Done — ${processed} listings extracted`);
}

// Rebuild product_price_stats from extracted data
// Groups by extracted_product, runs IQR clean, computes median/p25/p75
async function rebuildProductPriceStats() {
  try {
    await pool.query(`
      INSERT INTO product_price_stats
        (product_key, display_name, brand, category, variant,
         sample_count, median_price, p25_price, p75_price,
         low_price, high_price, updated_at)
      WITH base AS (
        SELECT
          LOWER(REGEXP_REPLACE(extracted_product, '[^a-z0-9]+', '-', 'gi')) AS product_key,
          extracted_product  AS display_name,
          extracted_brand    AS brand,
          extracted_category AS category,
          extracted_variant  AS variant,
          COUNT(*)::INT AS raw_count,
          PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY price)::INT AS p25,
          PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY price)::INT AS p75
        FROM listings
        WHERE extracted_product IS NOT NULL
          AND extraction_confidence IN ('high', 'medium')
          AND price > 0
          AND is_offer_price = FALSE
          AND price_quality = 'ok'
          AND is_active = TRUE
          AND scraped_at > NOW() - INTERVAL '90 days'
        GROUP BY product_key, display_name, brand, category, variant
        HAVING COUNT(*) >= 4
      ),
      fenced AS (
        SELECT
          b.product_key, b.display_name, b.brand, b.category, b.variant,
          b.raw_count,
          COUNT(l.id)::INT AS clean_count,
          PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY l.price)::INT AS median,
          PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY l.price)::INT AS p25_clean,
          PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY l.price)::INT AS p75_clean,
          MIN(l.price)::INT AS low,
          MAX(l.price)::INT AS high
        FROM listings l
        JOIN base b ON LOWER(REGEXP_REPLACE(l.extracted_product, '[^a-z0-9]+', '-', 'gi')) = b.product_key
        WHERE l.price BETWEEN GREATEST(0, b.p25 - 1.5*(b.p75-b.p25))
                          AND (b.p75 + 1.5*(b.p75-b.p25))
          AND l.is_offer_price = FALSE
          AND l.price_quality = 'ok'
          AND l.is_active = TRUE
          AND l.scraped_at > NOW() - INTERVAL '90 days'
        GROUP BY b.product_key, b.display_name, b.brand, b.category, b.variant, b.raw_count
        HAVING COUNT(l.id) >= 4
      )
      SELECT product_key, display_name, brand, category, variant,
             clean_count, raw_count, median, p25_clean, p75_clean, low, high, NOW()
      FROM fenced
      ON CONFLICT (product_key) DO UPDATE SET
        display_name  = EXCLUDED.display_name,
        brand         = EXCLUDED.brand,
        category      = EXCLUDED.category,
        variant       = EXCLUDED.variant,
        sample_count  = EXCLUDED.sample_count,
        median_price  = EXCLUDED.median_price,
        p25_price     = EXCLUDED.p25_price,
        p75_price     = EXCLUDED.p75_price,
        low_price     = EXCLUDED.low_price,
        high_price    = EXCLUDED.high_price,
        updated_at    = NOW()
    `);

    const { rows } = await pool.query('SELECT COUNT(*)::INT AS cnt FROM product_price_stats');
    console.log(`[ProductStats] ✅ Rebuilt — ${rows[0].cnt} unique products in stats table`);
  } catch (e) {
    console.error('[ProductStats] Rebuild failed:', e.message);
  }
}

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
app.get('/', async (req, res) => {
  const dbSummary = await getDBSummary().catch(() => null);
  res.json({
    status:   'ok',
    redis:    REDIS_URL ? 'connected' : 'not set',
    database: DATABASE_URL ? 'connected' : 'not set',
    db: dbSummary ? {
      totalListings:    dbSummary.total_listings,
      activeListings:   dbSummary.active_listings,
      uniqueKeywords:   dbSummary.unique_keywords,
      uniqueMakes:      dbSummary.unique_makes,
      lastScraped:      dbSummary.last_scraped,
    } : null,
    watches:  watchlist.length,
    timers:   Object.keys(watchTimers).length,
    lastScan: lastScanTime,
    lastScanNewListings: lastScanCount,
  });
});

// GET /db/stats — detailed database statistics (owner-gated)
app.get('/db/stats', authMiddleware, async (req, res) => {
  try {
    const user = await getUser(req.userId);
    if (!isOwner(user)) return res.status(403).json({ error: 'Owner only' });

    const [summary, topKeywords, topMakes, recentActivity] = await Promise.all([
      getDBSummary(),
      pool.query(`
        SELECT keyword, sample_count, median_price, p25_price, p75_price, updated_at
        FROM keyword_price_stats
        ORDER BY sample_count DESC LIMIT 20
      `),
      pool.query(`
        SELECT make, COUNT(*)::INT AS count, AVG(price)::INT AS avg_price,
               PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price)::INT AS median_price
        FROM listings
        WHERE make IS NOT NULL AND price > 0 AND is_offer_price = FALSE
        GROUP BY make ORDER BY count DESC LIMIT 15
      `),
      pool.query(`
        SELECT DATE(scraped_at) AS day, COUNT(*)::INT AS listings_scraped
        FROM listings
        WHERE scraped_at > NOW() - INTERVAL '14 days'
        GROUP BY day ORDER BY day DESC
      `),
    ]);

    res.json({
      summary,
      topKeywords:    topKeywords.rows,
      topVehicleMakes: topMakes.rows,
      dailyActivity:  recentActivity.rows,
    });
  } catch (e) {
    console.error('[DB/stats]', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /db/comparables?keyword=ps5&limit=20 — raw comparables for a keyword
app.get('/db/comparables', authMiddleware, async (req, res) => {
  try {
    const { keyword, limit } = req.query;
    if (!keyword) return res.status(400).json({ error: 'keyword required' });
    const rows = await getDBComparables(keyword, parseInt(limit) || 20);
    res.json({ keyword, count: rows.length, comparables: rows });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /db/prices?keyword=hilux — price stats for a keyword
app.get('/db/prices', authMiddleware, async (req, res) => {
  try {
    const { keyword, make, model, year, mileage } = req.query;
    if (make && year) {
      const stats = await getDBVehicleStats(make, model, parseInt(year), mileage ? parseInt(mileage) : null);
      return res.json({ found: !!stats, type: 'vehicle', ...stats });
    }
    if (!keyword) return res.status(400).json({ error: 'keyword or make+year required' });
    const stats = await getDBPriceStats(keyword);
    res.json({ found: !!stats, type: 'keyword', ...stats });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

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
      excludeWords,
      // Vehicle-specific filters
      minYear:       req.body.minYear       ? parseInt(req.body.minYear)       : null,
      maxYear:       req.body.maxYear       ? parseInt(req.body.maxYear)       : null,
      minKms:        req.body.minKms        ? parseInt(req.body.minKms)        : null,
      maxKms:        req.body.maxKms        ? parseInt(req.body.maxKms)        : null,
      transmission:  req.body.transmission  ? req.body.transmission.trim()     : null, // 'auto', 'manual', or null
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
    // Initial backfill — runs once when watch is added
    scanWatchItem(item, { initialScan: true })
      .then(n => console.log(`[InitialScan] "${item.keyword}" → ${n} listing(s)`))
      .catch(e => console.error(`[InitialScan] Error:`, e.message));
  } catch (e) { console.error('[AddWatch]', e.message); res.status(500).json({ error: 'Server error' }); }
});

// PATCH /watchlist/:id — update watch filters
app.patch('/watchlist/:id', authMiddleware, async (req, res) => {
  try {
    const watch = await getWatch(req.params.id);
    if (!watch || watch.userId !== req.userId)
      return res.status(404).json({ error: 'Not found' });

    const { excludeWords, minYear, maxYear, minKms, maxKms, transmission, minPrice, maxPrice } = req.body;

    if (Array.isArray(excludeWords))
      watch.excludeWords = excludeWords.map(w => w.toLowerCase().trim()).filter(Boolean);
    if (minPrice  !== undefined) watch.minPrice  = minPrice  ? parseInt(minPrice)  : null;
    if (maxPrice  !== undefined) watch.maxPrice  = maxPrice  ? parseInt(maxPrice)  : null;
    if (minYear   !== undefined) watch.minYear   = minYear   ? parseInt(minYear)   : null;
    if (maxYear   !== undefined) watch.maxYear   = maxYear   ? parseInt(maxYear)   : null;
    if (minKms    !== undefined) watch.minKms    = minKms    ? parseInt(minKms)    : null;
    if (maxKms    !== undefined) watch.maxKms    = maxKms    ? parseInt(maxKms)    : null;
    if (transmission !== undefined) watch.transmission = transmission ? transmission.trim() : null;

    await saveWatch(watch);
    const idx = watchlist.findIndex(w => w.id === req.params.id);
    if (idx !== -1) watchlist[idx] = { ...watchlist[idx], ...watch };

    res.json({ ok: true, watch });
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
        return new Date(b.foundAt || b.listedAt) - new Date(a.foundAt || a.listedAt);
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
        return new Date(b.foundAt || b.listedAt) - new Date(a.foundAt || a.listedAt);
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
    const stats = await getDBVehicleStats(make, resolvedModel, parseInt(year), mileage ? parseInt(mileage) : null);
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

// ── Global Deals ─────────────────────────────────────────
// Rebuilds every 90 min — no SociaVault credits used.
// Pulls listings from the DB that have a known median (so we can compute % off),
// filters to active + real-price, scores by discount depth, adds small jitter.

async function rebuildGlobalDeals() {
  console.log('[Deals] Rebuilding deals:global cache via DB pass...');
  try {
    // Pull recent listings — prefer flip_score ranked first, unscored listings also included
    // so the deals feed is never empty while nightly scoring catches up.
    const { rows } = await pool.query(`
      SELECT
        l.listing_id,
        l.title,
        l.price,
        l.image_url,
        l.url,
        l.location,
        l.state,
        l.keyword,
        l.category,
        l.make,
        l.model,
        l.year,
        l.kms         AS mileage,
        l.transmission,
        l.fuel_type   AS "fuelType",
        l.listed_at   AS "listedAt",
        l.img_condition,
        l.img_matches_keyword,
        l.flip_score,
        l.flip_deal_type,
        l.flip_demand,
        l.flip_estimated_resale,
        l.flip_estimated_margin,
        l.flip_fix_cost,
        l.flip_reasoning,
        k.median_price  AS kw_median,
        k.p25_price     AS kw_p25
      FROM listings l
      LEFT JOIN keyword_price_stats k ON k.keyword = l.keyword
      WHERE l.is_active = TRUE
        AND l.is_offer_price = FALSE
        AND l.price > 0
        AND l.price_quality NOT IN ('spam','swap','accessory')
        AND l.scraped_at > NOW() - INTERVAL '3 days'
        AND l.keyword = ANY($1)
      ORDER BY l.flip_score DESC NULLS LAST, l.scraped_at DESC
      LIMIT 500
    `, [SEED_KEYWORDS]);

    if (!rows.length) {
      console.log('[Deals] No listings found — cache unchanged');
      return;
    }

    console.log(`[Deals] Pulled ${rows.length} candidates — applying deal filter...`);

    const approved = [];

    // ── Category minimum prices — anything below these is never worth flipping ──
    // Based on real AU FB Marketplace flip economics: you need at least $150+ margin
    // after transport, time and relisting fees to make it worth your while.
    const CATEGORY_FLOORS = {
      // Tech
      phone:        300,   // anything under $300 is a parts phone, not a flip
      laptop:       400,
      tablet:       200,
      gaming:       150,   // some accessories are fine
      tv:           300,
      audio:        150,
      camera:       300,
      // Tools
      power_tool:   100,   // even a single Milwaukee battery is worth flipping
      // Vehicles & outdoor
      vehicle:      2000,
      motorcycle:   1500,
      bike:         300,
      camping:      200,
      // Fitness
      fitness:      200,
      // Watches/fashion
      watch:        300,
      sneakers:     150,
      // General catch-all
      _default:     150,
    };

    // ── Category whitelist — only these are worth flipping on FB Marketplace ──
    // Anything not in this list gets rejected regardless of price/discount.
    const FLIPPABLE_KEYWORDS = new Set([
      'phone','laptop','tablet','gaming','tv','audio','camera','power_tool',
      'vehicle','motorcycle','bike','camping','fitness','watch','sneakers',
      'appliance','photography','music',
    ]);

    // Map keyword → category bucket for floor check
    function dealsBucket(kw) {
      const k = (kw || '').toLowerCase();
      if (/iphone|samsung.*galaxy|google pixel|oneplus|oppo find/.test(k)) return 'phone';
      if (/macbook|imac|laptop|thinkpad|dell xps|surface pro|razer blade|asus rog/.test(k)) return 'laptop';
      if (/ipad|galaxy tab/.test(k)) return 'tablet';
      if (/ps5|ps4|xbox|nintendo switch|steam deck|meta quest|gaming pc|rtx|gaming monitor/.test(k)) return 'gaming';
      if (/oled tv|qled|bravia|samsung.*tv|lg.*tv|inch tv/.test(k)) return 'tv';
      if (/sony wh|airpods|bose|sonos|marshall speaker/.test(k)) return 'audio';
      if (/milwaukee|dewalt|makita|festool|hilti|snap on|mac tools|ryobi|hikoki|bosch 18v/.test(k)) return 'power_tool';
      if (/chainsaw|pressure washer|husqvarna|stihl|mower|ride on/.test(k)) return 'power_tool';
      if (/hilux|landcruiser|patrol|ranger|triton|dmax|pajero|prado|rav4|commodore|mustang|bmw|mercedes|audi|volkswagen|subaru wrx|jeep/.test(k)) return 'vehicle';
      if (/motorcycle|dirt bike|ktm|ducati|harley|kawasaki ninja|honda cbr|yamaha r1/.test(k)) return 'motorcycle';
      if (/bull bar|winch|lift kit|roof rack|drawer system|dual battery|arb|tjm/.test(k)) return 'vehicle'; // 4wd accessories
      if (/mountain bike|road bike|electric bike|trek|specialized|santa cruz|yeti|giant trance|pinarello|cervelo|scott bike/.test(k)) return 'bike';
      if (/engel fridge|waeco|dometic|arb fridge|roof top tent|camper trailer|camp trailer/.test(k)) return 'camping';
      if (/weber bbq|traeger|big green egg|kamado joe/.test(k)) return 'camping';
      if (/squat rack|barbell|dumbbells|weight plates|bench press|cable machine|rogue|treadmill|concept2|assault bike|peloton/.test(k)) return 'fitness';
      if (/sony a7|canon eos|nikon z|fujifilm|dji mavic|dji mini|gopro/.test(k)) return 'camera';
      if (/thermomix|kitchenaid|breville barista|breville oracle|delonghi|jura|dyson v/.test(k)) return 'appliance';
      if (/rolex|omega seamaster|omega speedmaster|tag heuer|ap royal oak|seiko prospex|grand seiko/.test(k)) return 'watch';
      if (/jordan|yeezy|nike dunk|air max|new balance 550/.test(k)) return 'sneakers';
      if (/callaway|titleist|taylormade|ping|scotty cameron/.test(k)) return 'fitness'; // golf
      if (/honda generator|yamaha generator|inverter generator|welder|trailer/.test(k)) return 'power_tool';
      return '_default';
    }

    for (const row of rows) {
      const t   = (row.title || '').toLowerCase();
      const kw  = (row.keyword || '').toLowerCase();

      // ── Hard rejects — never flip these ──────────────────
      if (/\b(hire|rental|for hire|per day|per week|hourly|service|installation|wanted|wtb|wtt)\b/.test(t)) continue;
      if (/^(tools?|stuff|items?|electronics?|misc|other|various|assorted|junk|lot|furniture|clothing|clothes)\s*$/.test(t)) continue;
      // Reject low-value household junk regardless of keyword
      if (/\b(casserole|saucepan|pot set|cutlery|crockery|dinner set|plate set|bowl set|vase|ornament|picture frame|curtain|cushion|doona|pillow|towel|sheet set|rug|mat|lamp|candle|decor)\b/.test(t)) continue;
      // Reject generic furniture (not worth the effort on FB Marketplace)
      if (/\b(dining chair|dining table|coffee table|side table|bedside table|wardrobe|dresser|bookshelf|shelf|shelving unit|chest of drawers|tv unit|entertainment unit|kids bed|bunk bed)\b/.test(t) && !/\b(herman miller|aeron|embody|jarvis|standing desk)\b/.test(t)) continue;
      // Reject cheap single items not worth flipping
      if (row.price && row.price < 50) continue;

      // ── Category-based minimum price floor ────────────────
      const bucket = dealsBucket(kw);
      const floor  = CATEGORY_FLOORS[bucket] || CATEGORY_FLOORS._default;
      if (row.price && row.price < floor) continue;

      const isBroken = /\b(broken|faulty|not working|dead|cracked|smashed|parts only|as is|for parts|damaged|needs work|spares|repair)\b/.test(t);

      let tint = null;
      const score  = row.flip_score  || 0;
      const margin = row.flip_estimated_margin || 0;

      if (row.flip_score !== null) {
        // Path A: nightly AI score is available — use it directly
        if (score >= 75 || margin >= 500) tint = 'rainbow';
        else if (score >= 55 || margin >= 150) tint = 'green';
      } else if (row.kw_median && row.price) {
        // Path B: no AI score yet — use discount depth vs keyword median
        const pctOff = (row.kw_median - row.price) / row.kw_median;
        if (pctOff >= 0.40) tint = 'rainbow';
        else if (pctOff >= 0.20) tint = 'green';
      }

      if (!tint) continue;

      approved.push({
        id:           row.listing_id,
        title:        row.title,
        price:        row.price,
        image:        row.image_url || null,
        url:          row.url || null,
        location:     row.location || null,
        state:        row.state || null,
        keyword:      row.keyword || null,
        category:     row.category || 'general',
        make:         row.make || null,
        model:        row.model || null,
        year:         row.year || null,
        mileage:      row.mileage || null,
        transmission: row.transmission || null,
        fuelType:     row.fuelType || null,
        listedAt:     row.listedAt ? row.listedAt.toISOString() : null,
        imgCondition: row.img_condition || null,
        flipScore:    row.flip_score || null,
        dealType:     isBroken ? 'broken_fixable' : (row.flip_deal_type || null),
        demand:       row.flip_demand || null,
        estResale:    row.flip_estimated_resale || null,
        estMargin:    row.flip_estimated_margin || null,
        fixCost:      row.flip_fix_cost || null,
        reasoning:    row.flip_reasoning || null,
        tint,
        geminiReason: row.flip_reasoning ? row.flip_reasoning.slice(0, 80) : null,
      });
      console.log(`[Deals] ✅ "${(row.title||'').slice(0,50)}" — ${tint} (score: ${score}, margin: $${margin})`);
    }

    await redisSet('deals:global', { deals: approved, builtAt: new Date().toISOString() }, 6000);
    console.log(`[Deals] ✅ Rebuilt deals:global — ${approved.length} deals from ${rows.length} candidates`);
  } catch (e) {
    console.error('[Deals] Rebuild failed:', e.message, '|', e.detail || '', '| position:', e.position || '');
  }
}


// Boot sequence is handled by runFullBootSequence() — see below
async function quickStatsAndDealsRebuild() {
  try {
    console.log('[Boot] Running quick keyword stats pass...');
    await pool.query(`
      INSERT INTO keyword_price_stats
        (keyword, raw_count, sample_count, median_price, p25_price, p75_price,
         floor_price, ceiling_price, updated_at)
      WITH anchors AS (
        SELECT keyword, anchor_price FROM keyword_anchors
      ),
      base AS (
        SELECT l.keyword,
          COUNT(*)::INT AS raw_count,
          PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY l.price)::INT AS p25_raw,
          PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY l.price)::INT AS p75_raw
        FROM listings l
        LEFT JOIN anchors a ON a.keyword = l.keyword
        WHERE l.price > 0 AND l.is_offer_price = FALSE AND l.is_active = TRUE
          AND l.price_quality NOT IN ('spam','damage','broken','swap','accessory')
          AND (a.anchor_price IS NULL
            OR l.price BETWEEN a.anchor_price * 0.30 AND a.anchor_price * 2.20)
        GROUP BY l.keyword HAVING COUNT(*) >= 4
      )
      SELECT
        b.keyword,
        b.raw_count,
        COUNT(l.id)::INT,
        PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY l.price)::INT,
        PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY l.price)::INT,
        PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY l.price)::INT,
        GREATEST(0, b.p25_raw - 1.5*(b.p75_raw - b.p25_raw))::INT,
        (b.p75_raw + 1.5*(b.p75_raw - b.p25_raw))::INT,
        NOW()
      FROM listings l
      JOIN base b ON b.keyword = l.keyword
      LEFT JOIN anchors a ON a.keyword = l.keyword
      WHERE l.price BETWEEN GREATEST(0, b.p25_raw - 1.5*(b.p75_raw-b.p25_raw))
                        AND (b.p75_raw + 1.5*(b.p75_raw-b.p25_raw))
        AND (a.anchor_price IS NULL
          OR l.price BETWEEN a.anchor_price * 0.30 AND a.anchor_price * 2.20)
        AND l.price > 0 AND l.is_offer_price = FALSE AND l.is_active = TRUE
        AND l.price_quality NOT IN ('spam','damage','broken','swap','accessory')
      GROUP BY b.keyword, b.raw_count, b.p25_raw, b.p75_raw
      HAVING COUNT(l.id) >= 4
      ON CONFLICT (keyword) DO UPDATE SET
        raw_count    = EXCLUDED.raw_count,
        sample_count = EXCLUDED.sample_count,
        median_price = EXCLUDED.median_price,
        p25_price    = EXCLUDED.p25_price,
        p75_price    = EXCLUDED.p75_price,
        floor_price  = EXCLUDED.floor_price,
        ceiling_price= EXCLUDED.ceiling_price,
        updated_at   = NOW()
    `);
    const { rows } = await pool.query('SELECT COUNT(*)::INT AS cnt FROM keyword_price_stats');
    console.log(`[Boot] Quick stats done — ${rows[0].cnt} keywords in stats table`);
    await rebuildGlobalDeals();
  } catch (e) {
    console.error('[Boot] Quick stats/deals rebuild failed:', e.message);
  }
}

// Run quick stats rebuild 5 minutes after boot (gives seed scan time to fill some data)
// Boot sequence handles stats rebuild — see runFullBootSequence()
cron.schedule('0 */2 * * *', () => rebuildGlobalDeals().catch(e => console.error('[Deals Cron]', e.message)));

// ── Full boot sequence ────────────────────────────────────────────────────────
// Runs everything in the right order immediately on deploy.
// Steps are chained so each one has data from the previous step.

async function runFullBootSequence() {
  console.log('[Boot] Starting full boot sequence...');
  try {
    // Step 1: Seed scan — fills DB with fresh listings across all 332 keywords
    // This runs in background and doesn't block the rest of the sequence
    console.log('[Boot] Step 1 — Starting seed scan in background...');
    runFullSeedScanOnce().catch(e => console.error('[Boot] Seed scan error:', e.message));

    // Step 2: Rebuild deals immediately from existing data
    console.log('[Boot] Step 2 — Rebuilding deals from existing listings...');
    await redisSet('deals:global', null);
    await rebuildGlobalDeals();
    console.log('[Boot] ✅ Deals rebuilt — Today\'s Picks is live');

    // Step 3: Stats rebuild in background — doesn't block deals
    console.log('[Boot] Step 3 — Rebuilding keyword stats in background...');
    quickStatsAndDealsRebuild().catch(e => console.error('[Boot] Stats error:', e.message));

  } catch (e) {
    console.error('[Boot] Sequence error:', e.message, e.stack?.split('\n')[1]);
  }
}

// ── Seed Keyword Scanner ──────────────────────────────────
// Scans a broad list of keywords to build the price database independently
// of user watchlists. 1 credit per keyword per scan. Staggered so we don't
// hammer all keywords at once — splits into 6 batches across 6 hours.
// Full rotation = 6 hours. At ~150 keywords that's 150 credits per rotation.

const SEED_KEYWORDS = [
  // ── iPhones — high demand, fast flip, easy to price ──────
  'iphone 16 pro', 'iphone 16', 'iphone 15 pro', 'iphone 15', 'iphone 14 pro',
  'iphone 14', 'iphone 13', 'iphone 12', 'iphone 11',

  // ── Samsung flagships ─────────────────────────────────────
  'samsung galaxy s25', 'samsung galaxy s24', 'samsung galaxy s23', 'samsung galaxy s22',
  'google pixel 9', 'google pixel 8',

  // ── MacBooks — premium, liquid market ────────────────────
  'macbook pro m3', 'macbook pro m2', 'macbook pro m1',
  'macbook air m3', 'macbook air m2', 'macbook air m1',
  'imac m3', 'imac m1',

  // ── Other laptops with real resale ───────────────────────
  'dell xps 15', 'dell xps 13', 'lenovo thinkpad x1',
  'asus rog laptop', 'razer blade laptop', 'surface pro',

  // ── Tablets ───────────────────────────────────────────────
  'ipad pro', 'ipad air', 'ipad mini',
  'samsung galaxy tab s9', 'samsung galaxy tab s8',

  // ── Gaming consoles — best flip category on FB Marketplace
  'ps5 console', 'ps5 digital',
  'ps4 pro', 'ps4 console',
  'xbox series x', 'xbox series s',
  'nintendo switch oled', 'nintendo switch',
  'steam deck', 'meta quest 3', 'meta quest 2',

  // ── Gaming PCs & monitors ────────────────────────────────
  'gaming pc', 'rtx 4090', 'rtx 4080', 'rtx 4070', 'rtx 3090', 'rtx 3080',
  'gaming monitor', 'ultrawide monitor',

  // ── TVs — large format hold value ────────────────────────
  'lg oled tv', 'samsung qled tv', 'sony bravia tv',
  'samsung 65 inch tv', 'samsung 75 inch tv', 'lg 65 tv',

  // ── Premium audio ─────────────────────────────────────────
  'sony wh1000xm5', 'sony wh1000xm4', 'airpods pro', 'airpods max',
  'bose quietcomfort', 'sonos speaker',

  // ── Milwaukee — king of FB Marketplace tool flips ────────
  'milwaukee m18 drill', 'milwaukee m18 impact driver', 'milwaukee m18 grinder',
  'milwaukee m18 circular saw', 'milwaukee m18 jigsaw', 'milwaukee m18 multi tool',
  'milwaukee m18 reciprocating saw', 'milwaukee m18 kit', 'milwaukee m18 fuel',
  'milwaukee m12', 'milwaukee packout',

  // ── DeWalt ───────────────────────────────────────────────
  'dewalt 18v drill', 'dewalt 18v impact driver', 'dewalt 18v grinder',
  'dewalt 18v circular saw', 'dewalt xr kit', 'dewalt flexvolt',

  // ── Makita ───────────────────────────────────────────────
  'makita 18v drill', 'makita 18v impact driver', 'makita 18v grinder',
  'makita 18v circular saw', 'makita combo kit',

  // ── Festool — elite tier, holds value like nothing else ──
  'festool track saw', 'festool sander', 'festool router', 'festool drill',

  // ── Other high-value tools ───────────────────────────────
  'air compressor', 'drop saw', 'table saw', 'thicknesser', 'laser level',
  'snap on tool box', 'mac tools', 'hilti drill',

  // ── Outdoor power — great margins ────────────────────────
  'husqvarna chainsaw', 'stihl chainsaw', 'stihl ms', 'echo chainsaw',
  'husqvarna mower', 'ride on mower', 'zero turn mower',
  'karcher pressure washer', 'pressure washer',

  // ── Camping/4WD gear — premium brands only ────────────────
  'engel fridge', 'waeco fridge', 'dometic fridge', 'arb fridge',
  'roof top tent', 'arb awning', 'snorkel patrol', 'snorkel hilux',
  'camp trailer', 'camper trailer',

  // ── BBQs — Weber/Traeger/Big Green Egg only ───────────────
  'weber bbq', 'traeger bbq', 'big green egg', 'kamado joe', 'webber genesis',

  // ── Vehicles — high demand makes, quick to flip ───────────
  'toyota hilux', 'toyota landcruiser 200', 'toyota landcruiser 79',
  'toyota prado', 'toyota rav4',
  'ford ranger', 'ford everest', 'ford mustang',
  'nissan patrol', 'nissan navara',
  'mitsubishi triton', 'isuzu dmax',
  'mazda cx5', 'subaru wrx', 'subaru forester',
  'jeep wrangler', 'holden commodore v8',
  'bmw m3', 'bmw m4', 'bmw 3 series',
  'mercedes amg', 'mercedes c class',
  'audi rs', 'volkswagen golf r',

  // ── Motorcycles ───────────────────────────────────────────
  'honda cbr', 'yamaha r1', 'kawasaki ninja', 'suzuki gsxr',
  'ducati', 'bmw gs', 'ktm duke', 'harley davidson',
  'dirt bike', 'ktm exc', 'husqvarna enduro',

  // ── 4WD accessories — bolt-on margin ─────────────────────
  'arb bull bar', 'tjm bull bar', 'warn winch', 'arb winch',
  'lift kit', 'roof rack', 'drawer system', 'dual battery system',

  // ── Premium bikes ─────────────────────────────────────────
  'trek mountain bike', 'specialized mountain bike', 'santa cruz bike',
  'yeti bike', 'giant trance', 'scott bike',
  'trek road bike', 'specialized road bike', 'pinarello', 'cervelo',
  'electric bike', 'bosch ebike', 'specialized turbo levo',

  // ── Gym equipment — home gym boom created liquid market ──
  'squat rack', 'barbell set', 'dumbbells', 'weight plates',
  'bench press', 'cable machine', 'rogue barbell',
  'treadmill', 'concept2 rower', 'assault bike', 'peloton',

  // ── Golf — brand-name clubs flip fast ─────────────────────
  'callaway driver', 'titleist irons', 'taylormade driver',
  'ping irons', 'ping driver', 'titleist driver',
  'scotty cameron putter',

  // ── Cameras — depreciates fast, good flip category ────────
  'sony a7', 'sony a7iv', 'sony a6700', 'canon eos r5', 'canon eos r6',
  'nikon z6', 'nikon z8', 'fujifilm xt5', 'fujifilm x100v',
  'dji mavic 3', 'dji mini 4 pro', 'dji air 3',
  'gopro hero 12', 'gopro hero 11',

  // ── Appliances with actual resale value ───────────────────
  'thermomix tm6', 'thermomix tm5', 'kitchenaid mixer',
  'breville barista express', 'breville oracle touch',
  'delonghi dinamica', 'jura coffee machine',
  'dyson v15', 'dyson v12', 'dyson v11',

  // ── Watches — serious money ───────────────────────────────
  'rolex submariner', 'rolex datejust', 'omega seamaster',
  'omega speedmaster', 'tag heuer', 'ap royal oak',
  'seiko prospex', 'seiko presage', 'grand seiko',

  // ── Sneakers — clean resale market ────────────────────────
  'nike air jordan 1', 'jordan 4', 'jordan 11',
  'adidas yeezy 350', 'adidas yeezy 700',
  'nike dunk low', 'nike air max 1', 'new balance 550',

  // ── Generators & trade gear ───────────────────────────────
  'honda generator', 'yamaha generator', 'inverter generator',
  'mig welder', 'tig welder', 'lincoln welder',
  'trailer', 'box trailer', 'car trailer',
];

// How many keywords per batch// How many keywords per batch — spread evenly across 6 hourly slots
const SEED_BATCH_SIZE = Math.ceil(SEED_KEYWORDS.length / 6);
let _seedBatchIndex = 0;

async function runSeedBatch() {
  const start = _seedBatchIndex * SEED_BATCH_SIZE;
  const batch = SEED_KEYWORDS.slice(start, start + SEED_BATCH_SIZE);
  _seedBatchIndex = (_seedBatchIndex + 1) % 6;

  console.log(`[SeedScan] Batch ${_seedBatchIndex}/${6} — scanning ${batch.length} keywords (starting at index ${start})`);

  let saved = 0;
  for (const keyword of batch) {
    try {
      // Use shared scan cache — if recently cached, costs 0 credits
      const cached = await redisGet(K.sharedScan(keyword));
      if (cached && (Date.now() - new Date(cached.scannedAt).getTime()) < SHARED_SCAN_TTL_MS) {
        console.log(`[SeedScan] "${keyword}" — cache hit, skipping`);
        continue;
      }

      const raw = await scrapeKeyword(keyword, {
        city: 'Melbourne', lat: -37.8136, lng: 144.9631, radius: 100,
      });

      if (!Array.isArray(raw) || !raw.length) continue;

      // Cache for shared use by user watchlists
      await redisSet(K.sharedScan(keyword), { listings: raw, scannedAt: new Date().toISOString() });

      // Save to DB for price stats
      for (const item of raw) {
        try { await upsertListingToDB({ ...item, keyword }); } catch (e) { /* skip bad rows */ }
      }

      saved += raw.length;
      console.log(`[SeedScan] "${keyword}" → ${raw.length} listings saved`);

      // Small delay between keywords — be gentle on SociaVault
      await new Promise(r => setTimeout(r, 800));
    } catch (e) {
      console.error(`[SeedScan] "${keyword}" failed:`, e.message);
    }
  }
  console.log(`[SeedScan] Batch done — ${saved} total listings saved`);
}

// One-time full scan on boot — scans all seed keywords once, then stops.
// Re-deploy to trigger again. No recurring cron.
async function runFullSeedScanOnce() {
  const SEED_FLAG = 'fr:seed-scan-done-v3'; // v3 = flipper-focused keywords
  const alreadyDone = await redisGet(SEED_FLAG);
  if (alreadyDone) {
    console.log('[SeedScan] Already completed — skipping. Delete fr:seed-scan-done-v1 in Redis to re-run.');
    return;
  }
  console.log(`[SeedScan] Starting one-time full scan of ${SEED_KEYWORDS.length} keywords...`);

  // Pre-load DB counts for all seed keywords in one query — avoids N queries in the loop
  const dbCountRes = await pool.query(`
    SELECT keyword, COUNT(*)::INT as n
    FROM listings
    WHERE keyword = ANY($1)
      AND is_active = TRUE
      AND scraped_at > NOW() - INTERVAL '14 days'
    GROUP BY keyword
  `, [SEED_KEYWORDS]);
  const dbCounts = {};
  for (const r of dbCountRes.rows) dbCounts[r.keyword] = r.n;

  let totalSaved = 0;
  let skippedDb = 0;
  for (let i = 0; i < SEED_KEYWORDS.length; i++) {
    const keyword = SEED_KEYWORDS[i];
    try {
      // Skip if Redis cache is still fresh
      const cached = await redisGet(K.sharedScan(keyword));
      if (cached && (Date.now() - new Date(cached.scannedAt).getTime()) < SHARED_SCAN_TTL_MS) {
        console.log(`[SeedScan] (${i+1}/${SEED_KEYWORDS.length}) "${keyword}" — cache hit, skipping`);
        continue;
      }
      // Skip if DB already has 15+ recent listings for this keyword — no point re-scanning
      if ((dbCounts[keyword] || 0) >= 15) {
        console.log(`[SeedScan] (${i+1}/${SEED_KEYWORDS.length}) "${keyword}" — ${dbCounts[keyword]} in DB, skipping`);
        skippedDb++;
        continue;
      }
      const raw = await scrapeKeyword(keyword, {
        city: 'Melbourne', lat: -37.8136, lng: 144.9631, radius: 100,
      });
      if (!Array.isArray(raw) || !raw.length) {
        console.log(`[SeedScan] (${i+1}/${SEED_KEYWORDS.length}) "${keyword}" — 0 results`);
        continue;
      }
      await redisSet(K.sharedScan(keyword), { listings: raw, scannedAt: new Date().toISOString() });
      for (const item of raw) {
        try { await upsertListingToDB({ ...item, keyword }); } catch (e) { /* skip bad rows */ }
      }
      totalSaved += raw.length;
      console.log(`[SeedScan] (${i+1}/${SEED_KEYWORDS.length}) "${keyword}" → ${raw.length} listings`);
      await new Promise(r => setTimeout(r, 600));
    } catch (e) {
      console.error(`[SeedScan] (${i+1}/${SEED_KEYWORDS.length}) "${keyword}" failed:`, e.message);
    }
  }
  console.log(`[SeedScan] ✅ Done — ${totalSaved} new listings saved, ${skippedDb} keywords skipped (already in DB)`);
  await redisSet(SEED_FLAG, { doneAt: new Date().toISOString() });
}

// Seed scan triggered by runFullBootSequence()

// Admin endpoint to check seed scan status
app.get('/admin/seed-status', authMiddleware, async (req, res) => {
  try {
    const user = await getUser(req.userId);
    if (!isOwner(user)) return res.status(403).json({ error: 'Owner only' });
    const counts = await Promise.all(SEED_KEYWORDS.map(async kw => {
      const cached = await redisGet(K.sharedScan(kw));
      return { keyword: kw, cached: !!cached, cachedAt: cached?.scannedAt || null, count: cached?.listings?.length || 0 };
    }));
    const dbCount = await pool.query('SELECT keyword, COUNT(*)::INT as n FROM listings WHERE keyword = ANY($1) GROUP BY keyword ORDER BY n DESC', [SEED_KEYWORDS]);
    res.json({ total: SEED_KEYWORDS.length, batchSize: SEED_BATCH_SIZE, nextBatch: _seedBatchIndex, cache: counts, db: dbCount.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin endpoint to manually re-trigger the full one-time scan
app.post('/admin/seed-scan-all', authMiddleware, async (req, res) => {
  try {
    const user = await getUser(req.userId);
    if (!isOwner(user)) return res.status(403).json({ error: 'Owner only' });
    res.json({ ok: true, message: `Starting full scan of ${SEED_KEYWORDS.length} keywords in background` });
    runFullSeedScanOnce().catch(e => console.error('[SeedScan Manual]', e.message));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: full deals pipeline diagnostic
app.get('/admin/deals-debug', authMiddleware, async (req, res) => {
  try {
    const user = await getUser(req.userId);
    if (!isOwner(user)) return res.status(403).json({ error: 'Owner only' });

    const [
      totalListings,
      activeListings,
      inPricePool,
      withImages,
      statsCount,
      dealsCache,
      qualityBreakdown,
      sampleDeals,
    ] = await Promise.all([
      pool.query('SELECT COUNT(*)::INT AS n FROM listings'),
      pool.query("SELECT COUNT(*)::INT AS n FROM listings WHERE is_active = TRUE"),
      pool.query("SELECT COUNT(*)::INT AS n FROM listings WHERE in_price_pool = TRUE AND is_active = TRUE"),
      pool.query("SELECT COUNT(*)::INT AS n FROM listings WHERE image_url IS NOT NULL AND image_url != ''"),
      pool.query('SELECT COUNT(*)::INT AS n FROM keyword_price_stats'),
      redisGet('deals:global'),
      pool.query("SELECT price_quality, COUNT(*)::INT AS n FROM listings GROUP BY price_quality ORDER BY n DESC"),
      // Try the exact deals query and return first 5 results
      pool.query(`
        WITH kmedians AS (
          SELECT keyword,
            COUNT(*)::INT AS cnt,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price)::INT AS median_price
          FROM listings
          WHERE price > 0 AND is_offer_price = FALSE AND is_active = TRUE
            AND scraped_at > NOW() - INTERVAL '30 days'
            AND price_quality NOT IN ('spam','damage','broken','swap','accessory')
          GROUP BY keyword HAVING COUNT(*) >= 4
        )
        SELECT l.title, l.price, l.keyword, k.median_price,
               (k.median_price - l.price) AS saving,
               ROUND(((k.median_price - l.price)::float / k.median_price * 100)::numeric, 1) AS pct_off
        FROM listings l
        JOIN kmedians k ON k.keyword = l.keyword
        WHERE l.is_active = TRUE AND l.is_offer_price = FALSE AND l.price > 0
          AND l.price_quality NOT IN ('spam','damage','broken','swap','accessory')
          AND l.scraped_at > NOW() - INTERVAL '30 days'
          AND l.price < k.median_price * 0.92
          AND (k.median_price - l.price) >= 100
        ORDER BY saving DESC LIMIT 5
      `),
    ]);

    res.json({
      db: {
        total_listings:   totalListings.rows[0].n,
        active_listings:  activeListings.rows[0].n,
        in_price_pool:    inPricePool.rows[0].n,
        with_images:      withImages.rows[0].n,
        keyword_stats_rows: statsCount.rows[0].n,
        quality_breakdown: qualityBreakdown.rows,
      },
      deals_cache: {
        exists:    !!(dealsCache?.deals),
        count:     dealsCache?.deals?.length || 0,
        built_at:  dealsCache?.builtAt || null,
      },
      sample_qualifying_deals: sampleDeals.rows,
      diagnosis: !totalListings.rows[0].n
        ? '❌ No listings in DB at all — seed scan hasnt run or failed'
        : !activeListings.rows[0].n
        ? '❌ No active listings — check is_active flag on upsert'
        : !statsCount.rows[0].n
        ? '⚠️ keyword_price_stats empty — quickStats rebuild hasnt run yet (fires 5min after boot)'
        : !sampleDeals.rows.length
        ? '⚠️ No qualifying deals — not enough price spread yet, need more listings per keyword'
        : dealsCache?.deals?.length
        ? `✅ ${dealsCache.deals.length} deals in cache — check frontend auth/premium flag`
        : '⚠️ Deals qualify in DB but cache is empty — trigger /admin/deals-rebuild',
    });
  } catch (e) { res.status(500).json({ error: e.message, stack: e.stack }); }
});

// Admin: force rebuild deals cache right now
app.post('/admin/deals-rebuild', authMiddleware, async (req, res) => {
  try {
    const user = await getUser(req.userId);
    if (!isOwner(user)) return res.status(403).json({ error: 'Owner only' });
    await quickStatsAndDealsRebuild();
    const cache = await redisGet('deals:global');
    res.json({ ok: true, deals_in_cache: cache?.deals?.length || 0, built_at: cache?.builtAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Browser-driven photo check ────────────────────────────────────────────────
// Called from the frontend after an image loads in the Feed.
// Browser sends base64 image data — avoids Facebook CDN expiry issues entirely.
// Gemini checks: does the photo match the keyword, and what's the condition?
// Result is saved to the listing and returned so the card border updates live.

app.post('/photo-check', authMiddleware, async (req, res) => {
  try {
    if (!GEMINI_API_KEY) return res.json({ ok: false, reason: 'no_gemini_key' });

    const { listingId, imageBase64, mimeType, title, keyword, price } = req.body;
    if (!listingId || !imageBase64) return res.status(400).json({ error: 'Missing listingId or imageBase64' });

    // Skip if already analysed
    const existing = await pool.query(
      'SELECT img_analysed_at, img_condition, img_matches_keyword FROM listings WHERE listing_id = $1',
      [listingId]
    );
    if (existing.rows[0]?.img_analysed_at) {
      return res.json({
        ok: true,
        cached: true,
        condition:       existing.rows[0].img_condition,
        matchesKeyword:  existing.rows[0].img_matches_keyword,
      });
    }

    const prompt = `You are doing a quick quality check on a Facebook Marketplace listing photo.

Listing:
- Search keyword: "${(keyword||'').slice(0,80)}"
- Title: "${(title||'').slice(0,120)}"
- Price: ${price || '?'} AUD

Look at the photo and return ONLY this JSON (no markdown):
{
  "matches_keyword": true | false,
  "mismatch_reason": null | "brief reason if wrong item e.g. photo shows a petrol moped not an electric scooter",
  "condition": "new" | "like_new" | "good" | "fair" | "poor" | "damaged" | "cannot_assess",
  "visible_damage": true | false,
  "is_stock_photo": true | false
}

Only mark matches_keyword false if it is clearly a DIFFERENT type of product.`;

    const geminiRes = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      { contents: [{ parts: [
        { inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } },
        { text: prompt }
      ]}], generationConfig: { thinkingConfig: { thinkingBudget: 0 } } },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );

    const raw = geminiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return res.json({ ok: false, reason: 'bad_response' });

    const result = JSON.parse(match[0]);

    // Determine quality penalty
    let newQuality = null;
    if (result.matches_keyword === false) {
      newQuality = 'spam';
      console.log(`[PhotoCheck] ❌ MISMATCH "${(title||'').slice(0,60)}" — ${result.mismatch_reason}`);

      // Add to the requesting user's blocked list so it never shows in their feed again
      try {
        const existing = await redisGet(K.blocked(req.userId)) || [];
        const already  = existing.some(b => b.id === listingId);
        if (!already) {
          const entry = {
            id:          listingId,
            title:       title       || null,
            price:       price       || null,
            url:         req.body.url || null,
            image:       req.body.imageUrl || null,
            keyword:     keyword     || null,
            blockedAt:   new Date().toISOString(),
            blockedBy:   'photo_mismatch',
            reason:      result.mismatch_reason || 'Photo does not match keyword',
          };
          await redisSet(K.blocked(req.userId), [entry, ...existing].slice(0, 200));
          console.log(`[PhotoCheck] 🚫 Added to blocked: "${(title||'').slice(0,50)}"`);
        }
      } catch (blockErr) {
        console.error('[PhotoCheck] Failed to add to blocked:', blockErr.message);
      }
    } else if (result.condition === 'damaged' || result.visible_damage) {
      newQuality = 'damage';
    }

    await pool.query(`
      UPDATE listings SET
        img_condition        = $1,
        img_matches_keyword  = $2,
        img_mismatch_reason  = $3,
        img_analysed_at      = NOW(),
        in_price_pool        = CASE WHEN $4::TEXT IN ('spam','damage') THEN FALSE ELSE in_price_pool END,
        price_quality        = CASE WHEN $4::TEXT IS NOT NULL THEN $4 ELSE price_quality END
      WHERE listing_id = $5
    `, [
      result.condition || null,
      result.matches_keyword !== false,
      result.mismatch_reason || null,
      newQuality,
      listingId,
    ]);

    res.json({
      ok:             true,
      cached:         false,
      condition:      result.condition,
      matchesKeyword: result.matches_keyword !== false,
      mismatchReason: result.mismatch_reason || null,
      isStockPhoto:   result.is_stock_photo || false,
      qualityFlag:    newQuality,
    });

  } catch (e) {
    console.error('[PhotoCheck]', e.message?.slice(0, 100));
    res.status(500).json({ error: e.message });
  }
});

// GET /deals — personalised deal feed for premium users
// Scores deals against the user's watchlist keywords/makes with jitter so order shifts each visit.
// ── Interest category map ─────────────────────────────────
// When a user watches something, we also boost adjacent categories.
// Mirrors how Facebook surfaces related items you didn't explicitly search for.
const INTEREST_ADJACENCY = {
  // Vehicles → tools, trailers, camping
  'vehicles':    ['power_tools', 'camping', 'trailers', '4wd_accessories'],
  // Tools → vehicles, trade gear, gardening
  'power_tools': ['vehicles', 'trade_industrial', 'garden'],
  // Phones → laptops, tablets, audio
  'phones':      ['laptops', 'tablets', 'audio'],
  // Gaming → TVs, electronics
  'gaming':      ['tvs', 'laptops'],
  // Camping → vehicles, bikes, outdoor
  'camping':     ['vehicles', 'bikes', 'garden'],
  // Fitness → bikes, outdoor
  'fitness':     ['bikes', 'camping'],
};

// Map seed keywords to broad interest buckets
function kwToBucket(kw) {
  const k = (kw || '').toLowerCase();
  if (/iphone|samsung|pixel|oneplus|oppo|galaxy.*phone|mobile phone/.test(k)) return 'phones';
  if (/macbook|laptop|imac|desktop|computer|lenovo|dell|hp.*spec|surface|razer|asus.*book/.test(k)) return 'laptops';
  if (/ipad|tablet|galaxy.*tab/.test(k)) return 'tablets';
  if (/ps5|ps4|xbox|nintendo|switch|steam deck|gaming.*chair|gaming.*monitor/.test(k)) return 'gaming';
  if (/tv|television|oled|qled|bravia|hisense|tcl/.test(k)) return 'tvs';
  if (/sonos|jbl|bose|marshall|airpods|speaker|headphone|wh1000/.test(k)) return 'audio';
  if (/milwaukee|dewalt|makita|ryobi|bosch|hikoki|festool|drill|grinder|saw|compressor/.test(k)) return 'power_tools';
  if (/mower|chainsaw|pressure washer|leaf blower|chipper|post hole/.test(k)) return 'garden';
  if (/engel|waeco|dometic|arb.*fridge|camping|swag|roof.*tent|tent|sleeping bag|kayak|paddle/.test(k)) return 'camping';
  if (/weber|bbq|traeger|kamado/.test(k)) return 'camping';
  if (/hilux|landcruiser|patrol|ranger|triton|dmax|pajero|prado|rav4|commodore|falcon|mustang|bmw|mercedes|audi|subaru|hyundai|kia|mazda|ford|toyota|nissan|mitsubishi|isuzu|jeep/.test(k)) return 'vehicles';
  if (/motorcycle|dirt.*bike|trail.*bike|enduro|cbr|ninja|gsxr|kawasaki|harley/.test(k)) return 'motorcycles';
  if (/caravan|camper.*trailer|pop.*top/.test(k)) return 'caravans';
  if (/bull.*bar|winch|lift.*kit|snorkel|roof.*rack|drawer.*system|dual.*battery/.test(k)) return '4wd_accessories';
  if (/mountain.*bike|road.*bike|electric.*bike|ebike|trek|specialized|giant|scott/.test(k)) return 'bikes';
  if (/electric.*scooter|ninebot|segway/.test(k)) return 'bikes';
  if (/couch|lounge|sofa|dining.*table|bed.*frame|wardrobe|bookshelf|coffee.*table/.test(k)) return 'furniture';
  if (/treadmill|rowing|spin.*bike|barbell|dumbbell|squat.*rack|home.*gym/.test(k)) return 'fitness';
  if (/golf|surfboard|skateboard|snowboard|tennis|basketball/.test(k)) return 'sports';
  if (/guitar|amp|drum|keyboard.*piano|bass|ukulele/.test(k)) return 'music';
  if (/camera|sony.*a7|canon|nikon|fujifilm|dji|drone|gopro/.test(k)) return 'photography';
  if (/thermomix|kitchenaid|coffee.*machine|dyson|roomba|washing.*machine|dishwasher|air.*fryer/.test(k)) return 'appliances';
  if (/generator|welder|scaffolding|forklift|pallet.*jack|scissor.*lift/.test(k)) return 'trade_industrial';
  if (/pram|baby|cot|kids.*bike|trampoline|lego/.test(k)) return 'baby_kids';
  if (/trailer|box.*trailer|car.*trailer|boat.*trailer/.test(k)) return 'trailers';
  return 'general';
}

app.get('/deals', authMiddleware, async (req, res) => {
  try {
    const user = await getUser(req.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (getEffectivePlan(user) !== 'premium') return res.status(403).json({ error: 'premium_required' });

    const cached = await redisGet('deals:global');
    if (!cached || !cached.deals || !cached.deals.length) {
      return res.json({ deals: [], builtAt: null });
    }

    // ── Build user interest profile ────────────────────────
    const watches = await getUserWatches(req.userId);
    const saved   = []; // saved are in localStorage on client — server doesn't have them yet

    // Primary interests — explicit watchlist keywords (highest weight)
    const primaryKeywords = watches.map(w => (w.keyword || '').toLowerCase().trim()).filter(Boolean);
    const primaryBuckets  = [...new Set(primaryKeywords.map(kwToBucket))];

    // Adjacent interests — categories related to what they watch
    const adjacentBuckets = new Set();
    primaryBuckets.forEach(b => {
      (INTEREST_ADJACENCY[b] || []).forEach(adj => adjacentBuckets.add(adj));
    });
    // Remove buckets already in primary
    primaryBuckets.forEach(b => adjacentBuckets.delete(b));

    // Seen listings — don't repeat what they've already been shown
    const seenMap = await getUserSeen(req.userId);

    // ── Score every deal ───────────────────────────────────
    const scored = cached.deals.map(d => {
      const kw     = (d.keyword || '').toLowerCase();
      const bucket = kwToBucket(kw);
      const make   = (d.make || '').toLowerCase();

      let score = 50; // base

      // Primary interest match — strong boost
      if (primaryBuckets.includes(bucket)) score += 40;

      // Exact keyword match — even stronger
      if (primaryKeywords.some(pk => kw === pk || kw.includes(pk) || pk.includes(kw))) score += 30;

      // Make match for vehicles
      if (make && primaryKeywords.some(pk => pk.includes(make) || make.includes(pk))) score += 25;

      // Adjacent interest — medium boost
      if (adjacentBuckets.has(bucket)) score += 15;

      // Tint quality boost
      if (d.tint === 'rainbow') score += 20;
      else if (d.tint === 'green') score += 10;

      // Flip score boost
      if (d.flipScore) score += Math.round(d.flipScore * 0.15);

      // Recency boost — newer listings score higher
      if (d.listedAt) {
        const ageHours = (Date.now() - new Date(d.listedAt).getTime()) / 3600000;
        if (ageHours < 2)  score += 25;
        else if (ageHours < 6)  score += 15;
        else if (ageHours < 24) score += 8;
        else if (ageHours < 48) score += 3;
      }

      // Already seen penalty
      if (seenMap[d.id]) score -= 60;

      // Random jitter — keeps the feed feeling alive on refresh
      score += (Math.random() - 0.5) * 12;

      // Watched badge
      const _watched = primaryKeywords.some(pk => kw === pk || kw.includes(pk) || pk.includes(kw)) ||
                       (make && primaryKeywords.some(pk => pk.includes(make)));

      return { ...d, _score: score, _watched };
    });

    // Sort by score descending
    scored.sort((a, b) => b._score - a._score);

    // ── Composition: 60% interests, 25% adjacent, 15% discovery ──
    // This gives the Facebook effect — mostly relevant, occasionally surprising
    const primary   = scored.filter(d => primaryBuckets.includes(kwToBucket((d.keyword||'').toLowerCase())));
    const adjacent  = scored.filter(d => adjacentBuckets.has(kwToBucket((d.keyword||'').toLowerCase())));
    const discovery = scored.filter(d => {
      const b = kwToBucket((d.keyword||'').toLowerCase());
      return !primaryBuckets.includes(b) && !adjacentBuckets.has(b);
    });

    const total = 200; // max deals to return
    const nPrimary   = Math.min(primary.length,   Math.round(total * 0.60));
    const nAdjacent  = Math.min(adjacent.length,  Math.round(total * 0.25));
    const nDiscovery = Math.min(discovery.length, total - nPrimary - nAdjacent);

    // Interleave so it doesn't feel like blocks of the same category
    const merged = [];
    const pSlice = primary.slice(0, nPrimary);
    const aSlice = adjacent.slice(0, nAdjacent);
    const dSlice = discovery.slice(0, nDiscovery);

    const maxLen = Math.max(pSlice.length, aSlice.length, dSlice.length);
    for (let i = 0; i < maxLen; i++) {
      // 60/25/15 interleave ratio — roughly every 4 primary, 2 adjacent, 1 discovery
      if (i < pSlice.length)   merged.push(pSlice[i]);
      if (i < pSlice.length)   { if (pSlice[i+1]) merged.push(pSlice[i+1]); i++; }
      if (i < aSlice.length)   merged.push(aSlice[Math.floor(i/2)]);
      if (i % 4 === 0 && dSlice[Math.floor(i/4)]) merged.push(dSlice[Math.floor(i/4)]);
    }

    // Deduplicate (id might appear in multiple slices)
    const seen = new Set();
    const deals = merged
      .filter(d => { if (seen.has(d.id)) return false; seen.add(d.id); return true; })
      .slice(0, total)
      .map(({ _score, ...d }) => d);

    // Mark these as shown in seen map so next request doesn't repeat them
    const nowTs = Date.now();
    const newSeen = {};
    deals.forEach(d => { if (d.id) newSeen[d.id] = nowTs; });
    saveUserSeen(req.userId, newSeen).catch(() => {});

    res.json({ deals, builtAt: cached.builtAt });
  } catch (e) {
    console.error('[Deals]', e.message);
    res.status(500).json({ error: 'Server error' });
  }
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

// GET /onboarding — tells the frontend what state the user is in
// Used to show/hide onboarding screen and tips
app.get('/onboarding', authMiddleware, async (req, res) => {
  try {
    const user    = await getUser(req.userId);
    const watches = await getUserWatches(req.userId);
    const listings = await getUserListings(req.userId);
    res.json({
      hasWatches:    watches.length > 0,
      watchCount:    watches.length,
      hasListings:   listings.length > 0,
      listingCount:  listings.length,
      plan:          getEffectivePlan(user),
      watchLimit:    PLAN_WATCHLIST_LIMITS[getEffectivePlan(user)],
      // Steps completed
      steps: {
        addedWatch:    watches.length > 0,
        gotListings:   listings.length > 0,
        usedAppraisal: (user.appraisalsToday || 0) > 0 || user.appraisalDate != null,
      },
    });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// GET /listings/price-drops — listings that have dropped in price recently
app.get('/listings/price-drops', authMiddleware, async (req, res) => {
  try {
    const listings = await getUserListings(req.userId);
    const drops = listings.filter(l => l.priceDropped && l.previousPrice);
    res.json(drops);
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

// ── Web Push (VAPID) ──────────────────────────────────────
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || null;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || null;
const VAPID_EMAIL       = process.env.VAPID_EMAIL       || 'mailto:admin@flip-radar.app';


// Redis key for push subscriptions
const K_push = userId => `fr:push:${userId}`;

// POST /ai/vehicle — vehicle appraisal grounded in DB data when available
// DB data is fetched FIRST so AI can reason from real market numbers.
app.post('/ai/vehicle', authMiddleware, async (req, res) => {
  try {
    if (!GEMINI_API_KEY && !ANTHROPIC_API_KEY) return res.status(500).json({ error: 'No AI keys configured' });

    const { make, model, year, mileage, transmission, listingPrice, title, description,
            imageUrl, imageBase64, imageMime, listingId, listingUrl } = req.body;
    if (!listingPrice) return res.status(400).json({ error: 'listingPrice required' });

    // ── Appraisal cache check — free hit, no point consumed ──
    const keyword = req.body.keyword || [make, model, year].filter(Boolean).join(' ');
    const cached  = await getAppraisalCache(listingId, title, listingPrice, keyword);
    if (cached) {
      console.log(`[AI/vehicle] Cache hit — skipping AI + appraisal deduction`);
      return res.json({ ...cached, usedCache: true });
    }

    const cr = await consumeAppraisal(req.userId);
    if (!cr.ok) return res.status(cr.status).json({ error: cr.error, limit: cr.limit, plan: cr.plan });

    // ── Step 1: Fetch DB market data BEFORE building prompt ──
    // Key change: DB data feeds INTO the prompt so AI reasons from
    // real AU market numbers rather than training data alone.
    const dbResult = (make && model && year)
      ? await fetchBestVehiclePrice(make, model, year, mileage, {
          series: req.body.series, variant: req.body.variant, transmission
        }).catch(() => null)
      : null;

    const dbPreferred = dbResult && !dbResult.belowThreshold;
    const dbAvailable = !!dbResult;

    // ── Step 2: Fetch full listing details from SociaVault ──
    let fullDescription = description || '';
    let condition = null;
    if (listingId || listingUrl) {
      const details = await fetchListingDetails(listingId, listingUrl);
      if (details) {
        if (details.description && details.description.length > (fullDescription?.length || 0)) {
          fullDescription = details.description;
        }
        condition = details.condition || null;
        console.log(`[AI/vehicle] Fetched full details — desc: ${fullDescription.length} chars, condition: ${condition}`);
      }
    }

    // ── Step 3: Build DB market context block ────────────────
    // Injected into the prompt — AI uses these real numbers as its anchor.
    let dbMarketContext = '';
    if (dbAvailable && dbResult.marketMedian) {
      const mb        = dbResult.mileageBand || 'unknown mileage range';
      const yb        = dbResult.yearBand    || String(year);
      const cohortStr = [make, model, dbResult.series, dbResult.variant].filter(Boolean).join(' ');
      const listingMileageBand = mileage ? bandMileage(mileage) : null;
      const mileageMismatch = listingMileageBand && dbResult.mileageBand && listingMileageBand !== dbResult.mileageBand;

      if (dbPreferred) {
        const consistency = dbResult.iqr && dbResult.marketMedian
          ? (dbResult.iqr / dbResult.marketMedian < 0.2 ? 'tight, consistent market' : 'moderate spread')
          : '';
        const mileageNote = mileageMismatch
          ? `NOTE: Listing mileage (${Number(mileage).toLocaleString()} km) is outside the ${mb} cohort. ` +
            `Use the cohort data as a baseline and adjust using the depreciation guide below.`
          : `Listing mileage matches this cohort — use the market data directly, adjusted for condition signals.`;

        dbMarketContext = [
          '',
          'REAL MARKET DATA FROM AU LISTINGS (use as your pricing anchor — actual observed data, not estimates):',
          `- Vehicle cohort: ${cohortStr} · ${yb} · ${mb}`,
          `- Market median price for this cohort: $${dbResult.marketMedian.toLocaleString()}`,
          `- Price range (P25–P75): $${dbResult.marketLow.toLocaleString()} – $${dbResult.marketHigh.toLocaleString()}`,
          `- Sample size: ${dbResult.samples} comparable AU listings`,
          dbResult.iqr ? `- Market consistency (IQR): $${dbResult.iqr.toLocaleString()} — ${consistency}` : '',
          '',
          mileageNote,
          'Your estimatedMarketValue MUST be grounded in these numbers.',
          'Adjust up or down based on condition/extras/description but do not deviate >25% without stating why in whyItsWorth.',
        ].filter(l => l !== null).join('\n');

      } else {
        dbMarketContext = [
          '',
          'PARTIAL MARKET DATA FROM AU LISTINGS (small sample — directional reference only):',
          `- Vehicle cohort: ${cohortStr} · ${yb} · ${mb}`,
          `- Observed median: $${dbResult.marketMedian.toLocaleString()}`,
          `- Observed range: $${dbResult.marketLow.toLocaleString()} – $${dbResult.marketHigh.toLocaleString()}`,
          `- Sample size: ${dbResult.samples} listings`,
          mileageMismatch
            ? `Listing mileage (${Number(mileage).toLocaleString()} km) differs from ${mb} cohort — interpolate using the depreciation guide.`
            : '',
          'Use alongside your own knowledge. If figures conflict with your knowledge, use judgment.',
        ].filter(l => l !== null).join('\n');
      }
    } else {
      dbMarketContext = '\nNO DATABASE DATA AVAILABLE for this vehicle cohort yet.\nUse your knowledge of the AU used-car market. Be conservative.';
    }

    // ── Step 4: Build the full prompt ─────────────────────
    const carLabel = [year, make, model].filter(Boolean).join(' ') || 'this vehicle';
    const vehicleDetails = [
      `Make/Model/Year: ${carLabel}`,
      req.body.series  ? `Series: ${req.body.series}`   : null,
      req.body.variant ? `Variant: ${req.body.variant}` : null,
      mileage     ? `Kms: ${Number(mileage).toLocaleString()} km` : null,
      transmission ? `Transmission: ${transmission}` : null,
      condition    ? `Condition: ${condition}` : null,
      `Listing Price: $${Number(listingPrice).toLocaleString()}`,
    ].filter(Boolean).join('\n');

    const mileageGuide = [
      '',
      'KMS DEPRECIATION GUIDE (AU market — use when interpolating from cohort data):',
      '- Under 80,000 km:    premium — add 10–20% above cohort median',
      '- 80,000–130,000 km:  normal use — at cohort median',
      '- 130,000–180,000 km: moderate discount (~10–20% below median)',
      '- 180,000–250,000 km: significant discount (~25–40% below median)',
      '- Over 250,000 km:    hard sell — well below median, long time-to-sell',
    ].join('\n');

    const prompt = [
      'You are an expert Australian used-vehicle flipper and market analyst. Your goal is accurate, conservative valuation grounded in real market data.',
      dbMarketContext,
      '',
      'VEHICLE DETAILS:',
      vehicleDetails,
      mileageGuide,
      '',
      `LISTING TITLE: ${title || '(not provided)'}`,
      'FULL LISTING DESCRIPTION:',
      '"""',
      fullDescription || '(not provided)',
      '"""',
      '',
      'EXTRACT AND FACTOR IN FROM DESCRIPTION:',
      '- Exact variant/trim/series (VE SS, FG XR6, GU TDI, SR5 etc) — significantly affects value',
      '- Engine (3.6L V6, 6.0L V8, 3.0 diesel etc) — extract if not in title',
      '- Extras (towbar, lift kit, ARB gear, new tyres, canopy, leather, sunroof) — add value',
      '- Service history (logbooks, one owner, recently serviced) — adds significant value',
      '- Defects (rust, oil leaks, engine noise, worn interior, needs RWC, accident history) — reduce value, add red flags',
      '- Urgency signals (must sell, moving, price reduced) — negotiation leverage',
      '- Rego status (registered until X, unregistered, interstate) — affects buyer cost',
      '',
      'MISSING INFORMATION RULES — absence of info is NOT neutral, treat it as a red flag:',
      '- No service history mentioned → assume none exists, reduce value 10–15%, add as red flag',
      '- No condition mentioned → assume average/fair condition, not good',
      '- No kms mentioned → assume high kms, reduce value accordingly',
      '- Vague description (one line, no detail) → seller is hiding something, flag it',
      '',
      'CRITICAL — WHAT THINGS ACTUALLY SELL FOR IN AU (not asking price):',
      'The market median shown above is what comparable listings are ASKING. Actual sale prices are lower.',
      `Category: ${kwToSellCategory(keyword)} — typical FB Marketplace sell discount off asking median: ${Math.round((CATEGORY_SELL_RATES[kwToSellCategory(keyword)] || CATEGORY_SELL_RATES._default).sellDiscount * 100)}%`,
      `Typical flip costs for this category: $${(CATEGORY_SELL_RATES[kwToSellCategory(keyword)] || CATEGORY_SELL_RATES._default).flipCostLow}–$${(CATEGORY_SELL_RATES[kwToSellCategory(keyword)] || CATEGORY_SELL_RATES._default).flipCostHigh} (cleaning, listing, time, meeting buyer)`,
      'Your estimatedResellLow = market median minus the category sell discount above.',
      'Your estimatedResellHigh = market median minus 2% (best case — perfect condition, patient seller).',
      '',
      'CALCULATE PROFIT STEP BY STEP — show your working in whyItsWorth:',
      `Step 1 — Realistic sell price: market median × ${1 - (CATEGORY_SELL_RATES[kwToSellCategory(keyword)] || CATEGORY_SELL_RATES._default).sellDiscount} (category discount)`,
      `Step 2 — Flip costs: $${(CATEGORY_SELL_RATES[kwToSellCategory(keyword)] || CATEGORY_SELL_RATES._default).flipCostLow}–$${(CATEGORY_SELL_RATES[kwToSellCategory(keyword)] || CATEGORY_SELL_RATES._default).flipCostHigh} for this category (use midpoint unless condition is poor — then upper end)`,
      'Step 3 — Repairs if needed: $0 if perfect, otherwise estimate based on what description says',
      'Step 4 — Rego/RWC if vehicle is unregistered or interstate: add $400–800',
      'Step 5 — Your time: factor in 2+ hours for listing, negotiation, meetup',
      'Step 6 — estimatedProfit = realistic sell price MINUS buy price MINUS steps 2–4',
      'Step 7 — roiPercent = estimatedProfit divided by buy price, expressed as percentage',
      '',
      'estimatedResellLow = Step 1 result (realistic sell, priced to move)',
      'estimatedResellHigh = market median minus 5% (best case, patient seller)',
      'estimatedProfit = estimatedResellLow minus listingPrice minus all costs from steps 2–4',
      '',
      'VERDICT RULES — apply strictly:',
      '- roiPercent > 30% after ALL costs → STEAL',
      '- roiPercent 15–30% after ALL costs → GOOD DEAL',
      '- roiPercent 5–15% after ALL costs → FAIR',
      '- roiPercent 0–5% after ALL costs → FAIR (barely worth it)',
      '- roiPercent < 0% → PASS',
      '- A $300 profit on a $4000 car is FAIR, not GOOD DEAL. Be honest.',
      '',
      'NEGATIVE PROFIT RULE — critical:',
      'If your calculation produces a negative profit (you would lose money flipping this):',
      '- DO NOT show a negative estimatedProfit — set it to 0',
      '- DO NOT show a negative roiPercent — set it to 0',
      '- Set estimatedResellLow to approximately the listing price (what you paid)',
      '- Set estimatedResellHigh to listing price plus 3–5% at most',
      '- The message to the user is: you would need to sell for roughly what you paid just to break even',
      '- Set verdict to PASS and dealScore to 15 or lower',
      '- The oneLiner should honestly say something like "You would need to sell for at least $X just to break even after costs"',
      '- Do not invent profit that does not exist',
      '',
      'Broken/project cars: if listing mentions "spares or repairs", "not running", "blown", "needs work", "as-is" — set isBrokenOrProject true, provide repairEstimate, cap verdict at FAIR unless post-repair ROI is exceptional.',
      '',
      'Respond ONLY in this exact JSON format (no markdown, no text outside JSON):',
      '{',
      '  "verdict": "STEAL|GOOD DEAL|FAIR|PASS",',
      '  "dealScore": 0-100,',
      '  "oneLiner": "one punchy sentence",',
      '  "extractedTitle": "cleaned listing title",',
      '  "extractedPrice": number,',
      '  "estimatedMarketValue": number,',
      '  "estimatedResellLow": number,',
      '  "estimatedResellHigh": number,',
      '  "recommendedOffer": number,',
      '  "walkAwayPrice": number,',
      '  "estimatedProfit": number,',
      '  "roiPercent": number,',
      '  "timeToSell": "1-3 days / 3-7 days / 1-2 weeks / 2-4 weeks",',
      '  "demandLevel": "🔥 High or 📈 Moderate or 📉 Low",',
      '  "whyItsWorth": "1-2 sentences referencing the actual price numbers",',
      '  "greenFlags": ["..."],',
      '  "redFlags": ["..."],',
      '  "whatToCheckInPerson": ["..."],',
      '  "negotiationScript": "what to say to the seller",',
      '  "isBrokenOrProject": false,',
      '  "repairEstimate": 0,',
      '  "repairNotes": "",',
      '  "aiGenerated": true',
      '}',
    ].join('\n');

    // ── Step 5: Call AI ────────────────────────────────────
    let text = '';
    const hasImage = !!(imageBase64 || imageUrl);

    if (GEMINI_API_KEY && hasImage) {
      const parts = [];
      if (imageBase64 && imageMime) {
        parts.push({ inline_data: { mime_type: imageMime, data: imageBase64 } });
      } else if (imageUrl) {
        try {
          const imgRes = await axios.get(imageUrl, {
            responseType: 'arraybuffer', timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.facebook.com/' },
          });
          parts.push({ inline_data: { mime_type: imgRes.headers['content-type'] || 'image/jpeg', data: Buffer.from(imgRes.data).toString('base64') } });
        } catch (_) {}
      }
      parts.push({ text: prompt });
      const geminiRes = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
        { contents: [{ parts }], generationConfig: { thinkingConfig: { thinkingBudget: 0 } } },
        { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
      );
      text = geminiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else if (GEMINI_API_KEY) {
      const geminiRes = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
        { contents: [{ parts: [{ text: prompt }] }], generationConfig: { thinkingConfig: { thinkingBudget: 0 } } },
        { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
      );
      text = geminiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else {
      const claudeRes = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }, { headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, timeout: 60000 });
      text = claudeRes.data?.content?.[0]?.text || '';
    }

    // ── Step 6: Parse and apply DB hard-override if trusted ──
    let parsed = null;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    } catch (_) {}

    if (parsed) {
      if (dbPreferred) {
        // DB is fully trusted — lock the price fields to real market data.
        // Use category-aware sell discount so a PS5 and a treadmill aren't
        // treated identically — they have very different sell dynamics.
        const sellCat   = kwToSellCategory(keyword);
        const sellRates = CATEGORY_SELL_RATES[sellCat] || CATEGORY_SELL_RATES._default;

        // Realistic sell price: median minus category-specific FB Marketplace discount
        const realisticSellPrice = Math.round(dbResult.marketMedian * (1 - sellRates.sellDiscount));

        // Flip costs: use midpoint of category range as base estimate
        // Condition info from image analysis can refine this (if available)
        const conditionModifier = (condition === 'poor' || condition === 'fair') ? 1.5 : 1.0;
        const flipCosts = Math.round(
          ((sellRates.flipCostLow + sellRates.flipCostHigh) / 2) * conditionModifier
        );

        const realisticProfit = realisticSellPrice - listingPrice - flipCosts;

        parsed.estimatedMarketValue = dbResult.marketMedian;
        parsed.estimatedResellLow   = realisticSellPrice;
        // Best case = sell at median with no discount (patient seller, great condition)
        parsed.estimatedResellHigh  = Math.round(dbResult.marketMedian * 0.98);
        parsed.low                  = dbResult.marketLow;
        parsed.median               = dbResult.marketMedian;
        parsed.high                 = dbResult.marketHigh;

        if (realisticProfit <= 0) {
          parsed.estimatedProfit      = 0;
          parsed.roiPercent           = 0;
          parsed.estimatedResellLow   = listingPrice;
          parsed.estimatedResellHigh  = Math.round(listingPrice * (1 + sellRates.sellDiscount * 0.5));
        } else {
          parsed.estimatedProfit = Math.round(realisticProfit);
          parsed.roiPercent      = Math.round((realisticProfit / listingPrice) * 100);
        }

        // Verdict anchored to realistic ROI after all costs
        if      (parsed.roiPercent >= 30) { parsed.verdict = 'STEAL';     parsed.dealScore = Math.min(95, Math.max(parsed.dealScore || 0, 85)); }
        else if (parsed.roiPercent >= 15) { parsed.verdict = 'GOOD DEAL'; parsed.dealScore = Math.min(84, Math.max(parsed.dealScore || 0, 65)); }
        else if (parsed.roiPercent >= 5)  { parsed.verdict = 'FAIR';      parsed.dealScore = Math.min(64, Math.max(parsed.dealScore || 0, 45)); }
        else if (parsed.roiPercent >= 0)  { parsed.verdict = 'FAIR';      parsed.dealScore = Math.min(44, 40); }
        else                              { parsed.verdict = 'PASS';      parsed.dealScore = Math.min(parsed.dealScore || 25, 25); }
      }

      // Strip internal fields — never send to user
      delete parsed.sourceLabel;
      delete parsed.confidence;
      delete parsed.dataPoints;
      delete parsed.dbData;
      delete parsed._pricingCorrected;

      const finalResult = { ...parsed, text, usedCache: false };
      await setAppraisalCache(listingId, title, listingPrice, keyword, finalResult).catch(e =>
        console.error('[AprCache] Write error:', e.message)
      );
      res.json(finalResult);
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

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const geminiRes = await axios.post(url, { contents: [{ parts }], generationConfig: { thinkingConfig: { thinkingBudget: 0 } } }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    });
    const text = geminiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
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
    const { prompt, max_tokens, listingId, title, price, keyword } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    // ── Appraisal cache check — free hit, no point consumed ──
    const cached = await getAppraisalCache(listingId, title, price, keyword);
    if (cached) {
      console.log(`[AI/text] Cache hit — skipping AI + appraisal deduction`);
      return res.json({ ...cached, usedCache: true });
    }

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
    const result = { text, usedCache: false };

    // Store in cache for future users
    if (listingId || (title && price)) {
      await setAppraisalCache(listingId, title, price, keyword, result).catch(e =>
        console.error('[AprCache] Write error (text):', e.message)
      );
    }

    res.json(result);
  } catch (e) {
    console.error('[AI/text]', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// POST /ai/text-image — text scan with an image fetched via URL (listing image)
// Body: { prompt: string, imageUrl: string }
// ── Smart Appraisal — DB-backed + Gemini vision ─────────────────────────────
// Full pipeline:
// 1. Gemini reads the listing + photo and identifies all items (handles kits/bundles)
// 2. Each item is looked up in product_price_stats for AU FB Marketplace second-hand prices
// 3. If not in DB, Gemini's own knowledge of AU second-hand prices is used explicitly
// 4. For bundles: each item gets its own price lookup, tallied up, compared to ask
// 5. Final verdict based on real market data, not RRP or retail

app.post('/ai/appraise', authMiddleware, async (req, res) => {
  try {
    if (!GEMINI_API_KEY) return res.status(500).json({ error: 'Gemini not configured' });

    const { prompt, imageUrl, imageB64, mediaType, listingId, title, price, keyword } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    // Check cache first
    const cached = await getAppraisalCache(listingId, title, price, keyword);
    if (cached) {
      console.log(`[Appraise] Cache hit`);
      return res.json({ ...cached, usedCache: true });
    }

    // Check appraisal limit
    const cr = await consumeAppraisal(req.userId);
    if (!cr.ok) return res.status(cr.status).json({ error: cr.error, limit: cr.limit, plan: cr.plan });

    // ── Step 1: Identify items in the listing (especially for kits/bundles) ──
    const identifyParts = [{ text: `You are identifying items in an Australian Facebook Marketplace listing for price research.

Title: "${(title||'').slice(0,150)}"
Listed price: ${price || '?'} AUD
Search keyword: ${keyword || ''}

Task: Identify ALL distinct items being sold. For a single item return one entry. For a kit/bundle/lot return each item separately.

Return ONLY JSON (no markdown):
{
  "is_bundle": true | false,
  "items": [
    { "name": "exact product name e.g. Milwaukee M18 Impact Driver", "brand": "Milwaukee", "category": "power_tools", "qty": 1 }
  ]
}` }];

    // Add image to identification step if available
    let imgData = null;
    if (imageB64 && mediaType) {
      imgData = { mime_type: mediaType, data: imageB64 };
    } else if (imageUrl) {
      try {
        const imgRes = await axios.get(imageUrl, {
          responseType: 'arraybuffer', timeout: 10000,
          headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.facebook.com/' }
        });
        imgData = { mime_type: imgRes.headers['content-type'] || 'image/jpeg', data: Buffer.from(imgRes.data).toString('base64') };
      } catch(_) {}
    }

    if (imgData) identifyParts.unshift({ inline_data: imgData });

    const identRes = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      { contents: [{ parts: identifyParts }], generationConfig: { thinkingConfig: { thinkingBudget: 0 } } },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    const identText = identRes.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const identMatch = identText.match(/\{[\s\S]*\}/);
    let identified = { is_bundle: false, items: [{ name: title || keyword || 'unknown item', brand: null, category: null, qty: 1 }] };
    try { if (identMatch) identified = JSON.parse(identMatch[0]); } catch(_) {}

    // ── Step 2: Look up each item in product_price_stats ──
    const itemsWithPrices = await Promise.all((identified.items || []).map(async item => {
      // Try product_price_stats first (most specific)
      const { rows: prodRows } = await pool.query(`
        SELECT product_key, display_name, median_price, p25_price, p75_price, sample_count
        FROM product_price_stats
        WHERE LOWER(display_name) LIKE LOWER($1)
           OR LOWER(display_name) LIKE LOWER($2)
        ORDER BY sample_count DESC
        LIMIT 1
      `, [
        `%${(item.name||'').split(' ').slice(0,3).join('%')}%`,
        `%${(item.name||'').split(' ').slice(0,2).join('%')}%`,
      ]);
      // Fall back to keyword_price_stats — skip broad keywords
      let kwMedian = null;
      if (!prodRows[0]) {
        const kw = (item.name||'').toLowerCase().split(' ').slice(0,3).join(' ');
        const { rows: kwRows } = await pool.query(
          'SELECT median_price, is_broad FROM keyword_price_stats WHERE keyword = $1', [kw]
        );
        if (kwRows[0] && !kwRows[0].is_broad) kwMedian = kwRows[0].median_price;
      }
      const dbPrice = prodRows[0] || null;
      return {
        ...item,
        db_median:   dbPrice?.median_price || kwMedian || null,
        db_p25:      dbPrice?.p25_price    || null,
        db_p75:      dbPrice?.p75_price    || null,
        db_samples:  dbPrice?.sample_count || null,
        db_name:     dbPrice?.display_name || null,
        db_source:   dbPrice ? 'flipradar_db' : kwMedian ? 'keyword_stats' : 'gemini_knowledge',
      };
    }));

    // Build DB context block for the appraisal prompt
    const dbContext = itemsWithPrices.map(item => {
      if (item.db_median) {
        return `- ${item.name} (qty: ${item.qty||1}): FlipRadar DB median ${item.db_median} AUD [${item.db_samples} FB Marketplace AU sales, p25=${item.db_p25}, p75=${item.db_p75}]`;
      } else {
        return `- ${item.name} (qty: ${item.qty||1}): No DB data — use your knowledge of current AU Facebook Marketplace second-hand prices`;
      }
    }).join('\n');

    const isBundle = identified.is_bundle && itemsWithPrices.length > 1;
    const dbTotal = itemsWithPrices.reduce((sum, i) => sum + (i.db_median || 0) * (i.qty || 1), 0);

    // ── Step 3: Build the full appraisal prompt with DB context injected ──
    const appraisalPrompt = `${prompt}

=== MARKET DATA (Australian Facebook Marketplace second-hand prices) ===
${isBundle ? `This is a BUNDLE/KIT containing ${itemsWithPrices.length} items:` : 'Single item:'}
${dbContext}
${isBundle && dbTotal > 0 ? `\nDB total value if sold individually: ${dbTotal} AUD` : ''}

CRITICAL PRICING RULES:
- All prices must reflect USED condition on Australian Facebook Marketplace — NOT RRP, NOT eBay, NOT retail
- Australian FB Marketplace prices typically run 40-60% below RRP for electronics/tools
- A seller on FB Marketplace needs to price below what they could buy it for at JB Hi-Fi or Bunnings
- If DB data is available, anchor your estimate to it — it's real AU second-hand sales data
- If no DB data, use realistic AU FB Marketplace pricing from your training knowledge
- For bundles: buying as a kit is worth slightly less than individual items (buyer wants discount for bulk)`;

    // ── Step 4: Final appraisal call with full context ──
    const appraisalParts = [{ text: appraisalPrompt }];
    if (imgData) appraisalParts.unshift({ inline_data: imgData });

    const appraisalRes = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      { contents: [{ parts: appraisalParts }], generationConfig: { thinkingConfig: { thinkingBudget: 0 } } },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
    );

    const text = appraisalRes.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Try to parse and enrich with bundle breakdown
    let parsed = null;
    try {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        parsed = JSON.parse(m[0]);
        // Inject bundle breakdown into response
        if (isBundle) {
          parsed._bundleItems = itemsWithPrices.map(i => ({
            name:      i.name,
            qty:       i.qty || 1,
            median:    i.db_median,
            source:    i.db_source,
            samples:   i.db_samples,
          }));
          parsed._bundleDbTotal = dbTotal || null;
        }
      }
    } catch(_) {}

    const result = parsed ? { ...parsed, text, usedCache: false } : { text, usedCache: false };

    // Cache for future users
    if (listingId || (title && price)) {
      await setAppraisalCache(listingId, title, price, keyword, result).catch(() => {});
    }

    console.log(`[Appraise] ${isBundle ? 'Bundle' : 'Single'} — ${itemsWithPrices.length} item(s), ${itemsWithPrices.filter(i=>i.db_median).length} from DB`);
    res.json(result);

  } catch (e) {
    console.error('[Appraise]', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// ── Batch feed rating with DB price context ──────────────────────────────────
// Called by autoAppraise() in the frontend for every batch of feed cards.
// Looks up DB median for each listing's keyword/product before asking AI to rate.
// This means the rating is anchored to real AU FB Marketplace second-hand prices.

app.post('/ai/rate-batch', authMiddleware, async (req, res) => {
  try {
    const { listings, keyword } = req.body;
    if (!Array.isArray(listings) || !listings.length) return res.status(400).json({ error: 'listings array required' });

    // Look up DB prices for each listing
    const enriched = await Promise.all(listings.map(async (l, i) => {
      const kw = (l.keyword || keyword || '').toLowerCase().trim();
      let dbMedian = null, dbSamples = null, dbP25 = null, dbP75 = null;

      // 1. Exact keyword match against keyword_price_stats (most reliable)
      if (kw) {
        const { rows: kwExact } = await pool.query(
          `SELECT median_price, p25_price, p75_price, sample_count, is_broad
           FROM keyword_price_stats WHERE keyword = $1`, [kw]
        );
        if (kwExact[0]?.median_price && !kwExact[0].is_broad) {
          dbMedian  = kwExact[0].median_price;
          dbP25     = kwExact[0].p25_price;
          dbP75     = kwExact[0].p75_price;
          dbSamples = kwExact[0].sample_count;
        }
      }

      // 2. Fallback: product_price_stats fuzzy match (requires 8+ samples)
      if (!dbMedian && l.title) {
        const words = l.title.split(' ').filter(w => w.length > 2).slice(0, 3).join('%');
        const { rows: prodRows } = await pool.query(
          `SELECT median_price, p25_price, p75_price, sample_count
           FROM product_price_stats
           WHERE LOWER(display_name) LIKE LOWER($1)
           ORDER BY sample_count DESC LIMIT 1`, [`%${words}%`]
        );
        if (prodRows[0]?.median_price && prodRows[0].sample_count >= 4) {
          dbMedian  = prodRows[0].median_price;
          dbP25     = prodRows[0].p25_price;
          dbP75     = prodRows[0].p75_price;
          dbSamples = prodRows[0].sample_count;
        }
      }

      const priceStr = l.price ? `AUD $${l.price}` : 'price not listed';
      const dbStr = dbMedian
        ? ` [DB avg: $${dbMedian}, p25: $${dbP25}, p75: $${dbP75}, ${dbSamples} AU FB sales]`
        : ` [No DB data — use AU FB Marketplace second-hand knowledge]`;
      // Include year/mileage so AI prices the specific vehicle, not just the keyword average
      const specParts = [
        l.year    ? `${l.year}`                                       : null,
        l.mileage ? `${Number(l.mileage||0).toLocaleString()}km`      : null,
        l.make    ? l.make                                            : null,
      ].filter(Boolean);
      const specStr = specParts.length ? ` (${specParts.join(', ')})` : '';

      return { idx: i, line: `${i}. "${(l.title||'').slice(0,100)}"${specStr} listed ${priceStr}${dbStr}` };
    }));

    const lines = enriched.map(e => e.line).join(' | ');

    const prompt = `You are an Australian Facebook Marketplace second-hand pricing expert rating listings for a flipper searching: "${keyword || 'unknown'}".

KEYWORD RELEVANCE — THIS IS THE MOST IMPORTANT CHECK:
The search keyword is: "${keyword || 'unknown'}"
Mark relevant:false if the listing is NOT the actual item being searched for. Be strict:
- Searching "moped" → only actual mopeds/50cc motorised bikes. NOT: electric scooters, mobility scooters, push scooters, bike parts, hub motors, accessories
- Searching "iphone 13" → only actual iPhone 13 devices. NOT: cases, cables, chargers, screen protectors, other iPhone models
- Searching "milwaukee drill" → only actual Milwaukee drills. NOT: other brands, batteries only, accessories, cases
- Searching "ps5" → only actual PS5 consoles. NOT: controllers only, games only, headsets
- General rule: if it's an accessory, part, or different category to what was searched — relevant:false
- If genuinely unsure whether it matches the keyword → relevant:false (be strict)

PRICING RULES:
- All ratings based on USED AU Facebook Marketplace prices only — NOT RRP, NOT retail
- VEHICLES: price based on the SPECIFIC year and km shown — never use all-years average
- High mileage (150k+) and old age (15+ years) significantly reduce value
- Only green/rainbow if REAL profit margin after all costs (buy, relist, 8% fees, time)
- rainbow = exceptional flip, 40%+ below real AU FB value
- green = good deal, 20-40% below real AU FB value  
- yellow = fair price
- red = overpriced or marginal
- relevant:false = wrong item, part/accessory, or no realistic profit

Listings (year, km, make shown in brackets where available):
${lines}

Reply ONLY as JSON array: [{"idx":0,"rating":"yellow","reason":"Fair for 210k km 2005","relevant":true}]
Max 8 words per reason. Be specific about year/km impact on value.`;

    const useGemini = !!GEMINI_API_KEY;
    let text = '';

    if (useGemini) {
      const r = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
        { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1 } },
        { headers: { 'Content-Type': 'application/json' }, timeout: 25000 }
      );
      text = r.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else if (ANTHROPIC_API_KEY) {
      const r = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-haiku-4-5-20251001', max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }],
      }, { headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, timeout: 20000 });
      text = r.data?.content?.[0]?.text || '';
    }

    res.json({ text });
  } catch (e) {
    console.error('[RateBatch]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/ai/text-image', authMiddleware, async (req, res) => {
  try {
    if (!GEMINI_API_KEY) return res.status(500).json({ error: 'Gemini not configured on server' });
    const { prompt, imageUrl, listingId, title, price, keyword } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    // ── Appraisal cache check — free hit, no point consumed ──
    const cached = await getAppraisalCache(listingId, title, price, keyword);
    if (cached) {
      console.log(`[AI/text-image] Cache hit — skipping AI + appraisal deduction`);
      return res.json({ ...cached, usedCache: true });
    }

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

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const geminiRes = await axios.post(url, { contents: [{ parts }], generationConfig: { thinkingConfig: { thinkingBudget: 0 } } }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    });
    const text = geminiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const result = { text, usedCache: false };

    // Store in cache for future users
    if (listingId || (title && price)) {
      await setAppraisalCache(listingId, title, price, keyword, result).catch(e =>
        console.error('[AprCache] Write error (text-image):', e.message)
      );
    }

    res.json(result);
  } catch (e) {
    console.error('[AI/text-image]', e.response?.data || e.message);
    res.status(500).json({ error: e.response?.data?.error?.message || e.message });
  }
});

// ── Appraisal cache admin ─────────────────────────────────
// GET /appraisal-cache?listingId=xxx  — check if a result is cached
app.get('/appraisal-cache', authMiddleware, async (req, res) => {
  try {
    const { listingId, title, price, keyword } = req.query;
    const cached = await getAppraisalCache(listingId, title, price, keyword);
    res.json({ found: !!cached, cached: cached || null });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// DELETE /appraisal-cache?listingId=xxx  — bust a specific cache entry (owner only)
app.delete('/appraisal-cache', authMiddleware, async (req, res) => {
  try {
    const user = await getUser(req.userId);
    if (!isOwner(user)) return res.status(403).json({ error: 'Owner only' });
    const { listingId, title, price, keyword } = req.query;
    if (listingId) await redisDel(K.appraisalById(listingId));
    if (title && price) {
      const hash = buildAppraisalHash(title, price, keyword);
      await redisDel(K.appraisalByHash(hash));
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
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

// ── Vehicle identity helpers ─────────────────────────────
// Reads make/model/year/km from SociaVault structured fields first,
// falls back to what the scan already extracted from the title.
function parseVehicleInfoFields(item) {
  if (!item) return {};
  const vi = item.vehicle_info || item.listing_vehicle_data || item.vehicleInfo || {};
  const attrs = item.attributes ? Object.values(item.attributes) : [];
  const attr = (name) => {
    const a = attrs.find(x => String(x.attribute_name || x.name || '').toLowerCase() === name.toLowerCase());
    return a ? (a.label || a.value || null) : null;
  };
  const toInt = (v) => { if (v == null) return null; const n = parseInt(String(v).replace(/[^0-9]/g,''),10); return Number.isFinite(n)?n:null; };
  const year = toInt(vi.year || vi.model_year || vi.manufacture_year || attr('Year'));
  return {
    make:         vi.make || vi.manufacturer || vi.brand || attr('Make') || null,
    model:        vi.model || vi.model_name || attr('Model') || null,
    year:         (year >= 1970 && year <= new Date().getFullYear()+1) ? year : null,
    kms:          toInt(vi.odometer || vi.mileage || vi.kilometres || vi.kilometers || attr('Odometer')),
    transmission: vi.transmission || vi.gearbox || attr('Transmission') || null,
    fuel_type:    vi.fuel_type || vi.fuel || attr('Fuel type') || null,
    body_style:   vi.body_style || vi.body || vi.body_type || attr('Body style') || null,
  };
}

// ── Vehicle blend valuation ──────────────────────────────
// Prices a specific car by sliding comparable listings to its km,
// weighting closest-km comps most, and blending with AI when data is thin.
const REF_FALLBACK_PERKM = 0.08;
const KM_HALF_WEIGHT = 50000;
const ENOUGH_COMPS = 8;

function slideToKm(price, fromKm, toKm, make) {
  // VERIFY: DEP_TABLE must be keyed by lowercase make with a perKm field
  const perKm = (DEP_TABLE?.[String(make||'').toLowerCase()]?.perKm) || REF_FALLBACK_PERKM;
  const adjusted = price + (fromKm - toKm) * perKm;
  return Math.max(price * 0.25, adjusted);
}

async function getVehicleComps(target) {
  const scopes = [
    'make=$1 AND model=$2 AND series IS NOT DISTINCT FROM $3 AND variant IS NOT DISTINCT FROM $4',
    'make=$1 AND model=$2 AND series IS NOT DISTINCT FROM $3',
    'make=$1 AND model=$2',
  ];
  for (const where of scopes) {
    const { rows } = await pool.query(
      `SELECT price, kms, year, scraped_at FROM listings WHERE category='vehicle' AND is_active=TRUE AND in_price_pool=TRUE AND price>0 AND kms>0 AND ${where} AND scraped_at > NOW() - INTERVAL '120 days'`,
      [target.make, target.model, target.series||null, target.variant||null]);
    if (rows.length >= 3) return rows;
  }
  return [];
}

async function aiEstimateVehicle(target) {
  const ck = `vest:${[target.make,target.model,target.series,target.year,Math.round((target.kms||0)/20000)].join('|')}`;
  const cached = await redisGet(ck);
  if (cached?.est) return cached.est;
  if (!GEMINI_API_KEY && !ANTHROPIC_API_KEY) return null;
  const prompt = `Typical USED private-sale price AUD on Australian Facebook Marketplace:\n${target.year||''} ${target.make||''} ${target.model||''} ${target.series||''} ${target.variant||''}, ${target.kms||'?'} km.\nReturn ONLY JSON: { "est_aud": number }`;
  try {
    let text = '';
    if (GEMINI_API_KEY) {
      const r = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
        {contents:[{parts:[{text:prompt}]}],generationConfig:{thinkingConfig:{thinkingBudget:0}}},
        {headers:{'Content-Type':'application/json'},timeout:10000});
      text = r.data?.candidates?.[0]?.content?.parts?.[0]?.text||'';
    } else {
      const r = await axios.post('https://api.anthropic.com/v1/messages',
        {model:'claude-haiku-4-5-20251001',max_tokens:80,messages:[{role:'user',content:prompt}]},
        {headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},timeout:10000});
      text = r.data?.content?.[0]?.text||'';
    }
    const m = text.match(/\{[\s\S]*\}/);
    const est = m ? Math.round(JSON.parse(m[0]).est_aud) : null;
    if (est > 0) { await redisSet(ck,{est},14*24*3600); return est; }
  } catch(e) { console.error('[VEst]',e.message); }
  return null;
}

async function appraiseVehicleValue(target) {
  if (!target.kms || target.kms <= 0) {
    const aiEst = await aiEstimateVehicle(target);
    return aiEst ? {value:aiEst,confidence:15,source:'ai_only',poolN:0,aiEst} : {value:null,confidence:0,source:'none',poolN:0};
  }
  const comps = await getVehicleComps(target);
  const adj = comps.map(c => {
    const price = slideToKm(c.price, c.kms, target.kms, target.make);
    const kmW = 1/(1+Math.abs(c.kms-target.kms)/KM_HALF_WEIGHT);
    const ageDays = (Date.now()-new Date(c.scraped_at))/86400000;
    const recW = ageDays<30?1:ageDays<90?0.7:0.4;
    return {price, w:kmW*recW, kmGap:Math.abs(c.kms-target.kms)};
  });
  let poolValue=null, poolN=0;
  if (adj.length) {
    const sorted = adj.map(a=>a.price).sort((x,y)=>x-y);
    const q = p => sorted[Math.floor(p*(sorted.length-1))];
    const lo=q(0.25)-1.5*(q(0.75)-q(0.25)), hi=q(0.75)+1.5*(q(0.75)-q(0.25));
    const kept = adj.filter(a=>a.price>=lo&&a.price<=hi);
    const wsum = kept.reduce((s,a)=>s+a.w,0);
    poolValue = wsum?Math.round(kept.reduce((s,a)=>s+a.price*a.w,0)/wsum):null;
    poolN = kept.length;
  }
  const aiEst = await aiEstimateVehicle(target);
  const trust = Math.min(poolN/ENOUGH_COMPS,1);
  let value, source;
  if (poolN>0&&aiEst) { value=Math.round(poolValue*trust+aiEst*(1-trust)); source='blend'; }
  else if (poolN>0) { value=poolValue; source='comps_only'; }
  else if (aiEst) { value=aiEst; source='ai_only'; }
  else { return {value:null,confidence:0,source:'none',poolN:0}; }
  const nearestGap = adj.length?Math.min(...adj.map(a=>a.kmGap)):Infinity;
  const agr = (a,b)=>{ if(!a||!b)return 0; const d=Math.abs(a-b)/Math.max(a,b); return d<0.07?1:d<0.15?0.6:d<0.25?0.2:0; };
  let confidence = Math.round(55*trust+20*(poolN>0&&aiEst?agr(poolValue,aiEst):0)+15*(nearestGap<30000?1:nearestGap<80000?0.5:0)+10*(source==='comps_only'?1:source==='blend'?0.6:0));
  confidence = Math.max(5,Math.min(confidence,100));
  return {value,confidence,source,poolN,aiEst,poolValue};
}

// ── General goods normaliser ─────────────────────────────
// Turns a title into { category, brand, product_line, variant, norm_key }
// so general items get precise cohorts instead of broad keyword buckets.
const _slug = s => String(s||'').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const _tc   = s => String(s||'').replace(/-/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
const _pick = (pairs,t) => { for(const [k,re] of pairs) if(re.test(t)) return k; return null; };
const CATEGORY_SIGNALS=[['gaming',/\b(ps5|ps4|playstation|xbox|series x|series s|nintendo switch|steam deck|quest ?[23]|oculus)\b/i],['phone',/\b(iphone|galaxy s\d|galaxy note|pixel \d|ipad)\b/i],['power_tool',/\b(milwaukee|makita|de ?walt|ryobi|festool|hilti|metabo|hikoki|m18|m12|18v|impact driver|angle grinder|circular saw|hammer drill)\b/i],['computer',/\b(macbook|imac|thinkpad|dell xps|rtx ?\d{3,4}|graphics card)\b/i],['audio',/\b(sonos|airpods|bose|wh.?1000|quietcomfort|soundbar|turntable)\b/i],['vacuum',/\b(dyson|stick vac|cordless vacuum)\b/i]];
function detectNormCategory(text){for(const[cat,re]of CATEGORY_SIGNALS)if(re.test(text))return cat;return 'general';}
const PT_BRANDS=[['milwaukee',/\bmilwaukee\b/i],['makita',/\bmakita\b/i],['dewalt',/\bde ?walt\b/i],['ryobi',/\bryobi\b/i],['festool',/\bfestool\b/i],['hilti',/\bhilti\b/i],['metabo',/\b(metabo|hikoki|hitachi)\b/i],['bosch',/\bbosch\b/i],['ego',/\bego\b/i]];
const PT_LINE={milwaukee:[['m18',/\bm18\b/i],['m12',/\bm12\b/i]],makita:[['xgt-40v',/\bxgt\b|\b40v\b/i],['cxt-12v',/\bcxt\b|\b12v\b/i],['lxt-18v',/\blxt\b|\b18v\b/i]],dewalt:[['xr-18v',/\bxr\b|\b18v\b|\b20v\b/i]],ryobi:[['one-plus-18v',/\bone\+?\b|\b18v\b/i]]};
const PT_TOOL=[['hammer-drill',/hammer ?drill|combi ?drill/i],['impact-driver',/impact ?driver/i],['impact-wrench',/impact ?wrench|rattle ?gun/i],['drill',/\bdrill( ?driver)?\b/i],['angle-grinder',/angle ?grinder|\bgrinder\b/i],['circular-saw',/circular ?saw/i],['recip-saw',/recip(rocating)? ?saw|sawzall/i],['multi-tool',/multi ?tool|oscillating/i],['blower',/\bblower\b/i],['nailer',/nail ?gun|nailer/i]];
function resolvePowerTool(t){const brand=_pick(PT_BRANDS,t);const line=brand&&PT_LINE[brand]?_pick(PT_LINE[brand],t):null;const tool=_pick(PT_TOOL,t);const isKit=/\b(kit|combo|set)\b/i.test(t);const isBare=/\b(bare|skin only|tool only|body only)\b/i.test(t);return{brand,product_line:[line,tool].filter(Boolean).join(' ')||null,variant:isBare?'bare':(isKit?'kit':null),attributes:{kit:isKit,bare:isBare}};}
const IPHONE=[['iphone-16-pro-max',/iphone ?16 ?pro ?max/i],['iphone-16-pro',/iphone ?16 ?pro/i],['iphone-16',/iphone ?16/i],['iphone-15-pro-max',/iphone ?15 ?pro ?max/i],['iphone-15-pro',/iphone ?15 ?pro/i],['iphone-15',/iphone ?15/i],['iphone-14-pro-max',/iphone ?14 ?pro ?max/i],['iphone-14-pro',/iphone ?14 ?pro/i],['iphone-14',/iphone ?14/i],['iphone-13-pro',/iphone ?13 ?pro/i],['iphone-13',/iphone ?13/i],['iphone-12',/iphone ?12/i],['iphone-11',/iphone ?11/i]];
const GALAXY=[['galaxy-s24-ultra',/s24 ?ultra/i],['galaxy-s24',/galaxy ?s24/i],['galaxy-s23-ultra',/s23 ?ultra/i],['galaxy-s23',/galaxy ?s23/i],['galaxy-s22',/galaxy ?s22/i]];
function resolvePhone(t){const brand=/\b(iphone|apple)\b/i.test(t)?'apple':/\b(samsung|galaxy)\b/i.test(t)?'samsung':/\b(pixel|google)\b/i.test(t)?'google':null;const model=brand==='apple'?_pick(IPHONE,t):brand==='samsung'?_pick(GALAXY,t):null;const gb=(t.match(/\b(64|128|256|512)\s?gb\b/i)||[])[1]||(/\b1\s?tb\b/i.test(t)?'1024':null);const locked=/\blocked\b/i.test(t)&&!/\bunlocked\b/i.test(t);return{brand,product_line:model,variant:[gb?`${gb}gb`:null,locked?'locked':null].filter(Boolean).join('-')||null,attributes:{storage_gb:gb?+gb:null,locked}};}
const CONSOLE=[['ps5-pro',/ps5 ?pro/i],['ps5-slim',/ps5 ?slim/i],['ps5',/ps5|playstation ?5/i],['ps4-pro',/ps4 ?pro/i],['ps4',/ps4|playstation ?4/i],['xbox-series-x',/series ?x/i],['xbox-series-s',/series ?s/i],['switch-oled',/switch ?oled/i],['switch-lite',/switch ?lite/i],['switch',/nintendo ?switch|\bswitch\b/i],['steam-deck',/steam ?deck/i],['quest-3',/quest ?3/i],['quest-2',/quest ?2/i]];
const CONSOLE_BRAND={'ps5':'sony','ps5-pro':'sony','ps5-slim':'sony','ps4':'sony','ps4-pro':'sony','xbox-series-x':'microsoft','xbox-series-s':'microsoft','switch':'nintendo','switch-oled':'nintendo','switch-lite':'nintendo','steam-deck':'valve','quest-3':'meta','quest-2':'meta'};
function resolveGaming(t){const model=_pick(CONSOLE,t);let edition=null;if(model&&(model.startsWith('ps5')||model==='xbox-series-x')){if(/digital/i.test(t))edition='digital';else if(/disc/i.test(t))edition='disc';}return{brand:model?CONSOLE_BRAND[model]||null:null,product_line:model,variant:edition,attributes:{edition}};}
const DYSON_MODELS=[['v15',/v15/i],['v12',/v12/i],['v11',/v11/i],['v10',/v10/i],['v8',/v8/i]];
function resolveVacuum(t){const brand=/dyson/i.test(t)?'dyson':null;return{brand,product_line:brand?_pick(DYSON_MODELS,t):null,variant:null,attributes:{}};}
const AUDIO_LIST=[['apple','airpods-pro-2',/airpods ?pro ?(2|2nd)/i],['apple','airpods-pro',/airpods ?pro/i],['apple','airpods-max',/airpods ?max/i],['apple','airpods',/airpods/i],['sony','wh-1000xm5',/wh.?1000xm5|\bxm5\b/i],['sony','wh-1000xm4',/wh.?1000xm4|\bxm4\b/i],['bose','quietcomfort',/quietcomfort|\bqc\b/i],['sonos','sonos',/sonos/i]];
function resolveAudio(t){for(const[brand,line,re]of AUDIO_LIST)if(re.test(t))return{brand,product_line:line,variant:null,attributes:{}};return{};}
const MAC_MODELS=[['macbook-pro-16',/macbook ?pro ?16/i],['macbook-pro-14',/macbook ?pro ?14/i],['macbook-pro',/macbook ?pro/i],['macbook-air',/macbook ?air/i],['imac',/imac/i]];
function resolveComputer(t){const brand=/macbook|imac|apple/i.test(t)?'apple':null;const chip=(t.match(/\bm([1234])\b/i)||[])[1];return{brand,product_line:brand?_pick(MAC_MODELS,t):null,variant:chip?`m${chip}`:null,attributes:{chip:chip?`m${chip}`:null}};}
const NORM_RESOLVERS={power_tool:resolvePowerTool,phone:resolvePhone,gaming:resolveGaming,vacuum:resolveVacuum,audio:resolveAudio,computer:resolveComputer};
function normalizeGeneralProduct(listing){
  const text=`${listing.keyword||''} ${listing.title||''}`;
  const category=detectNormCategory(text);
  const r=(NORM_RESOLVERS[category]?NORM_RESOLVERS[category](text):{})||{};
  const brand=r.brand||null;const product_line=r.product_line||null;const variant=r.variant||null;
  const resolved=!!(brand&&product_line);
  return{category,brand,product_line,variant,attributes:r.attributes||{},
    norm_key:resolved?_slug([category,brand,product_line,variant].filter(Boolean).join(' ')):null,
    display_name:resolved?_tc([brand,product_line,variant].filter(Boolean).join(' ')):null,resolved};
}

// ── Keyword price anchor (AI ballpark for the real product) ──────────
const BROAD_KEYWORD_STOPLIST=new Set(['bmw','mercedes','audi','toyota','ford','holden','honda','nissan','mazda','mitsubishi','hyundai','kia','subaru','volkswagen','vw','jeep','lexus','volvo','car','cars','ute','van','truck','phone','laptop','tv','furniture','tools','desk','chair','table','couch','sofa']);
function isBroadKeyword(kw){return BROAD_KEYWORD_STOPLIST.has(String(kw||'').toLowerCase().trim());}
async function getKeywordPriceAnchor(keyword, sampleTitles = []) {
  const cacheKey = `anchor2:${_slug(keyword).slice(0, 60)}`; // v2 key — returns object not scalar
  const cached   = await redisGet(cacheKey);
  if (cached && cached.asking_median) return cached;
  if (!GEMINI_API_KEY && !ANTHROPIC_API_KEY) return null;

  const cat      = kwToSellCategory(keyword);
  const rates    = CATEGORY_SELL_RATES[cat] || CATEGORY_SELL_RATES._default;
  const discPct  = Math.round(rates.sellDiscount * 100);

  const prompt = [
    'You are an Australian Facebook Marketplace second-hand pricing expert.',
    `Product keyword: "${keyword}"`,
    sampleTitles.length ? `Example listing titles from real AU FB Marketplace:
- ${sampleTitles.slice(0, 6).join('
- ')}` : '',
    '',
    'Give pricing for the MAIN product in good used condition (not accessories, not broken).',
    'All prices in AUD.',
    '',
    'Return ONLY valid JSON:',
    '{',
    '  "asking_median": <typical asking price on AU FB Marketplace>,',
    `  "sell_price": <what it ACTUALLY sells for — typically ${discPct}% below asking on FB Marketplace>,`,
    '  "price_low": <bottom 25% of market — worn/old/high-kms>,',
    '  "price_high": <top 25% — near-new, low-use, great condition>',
    '}',
  ].filter(Boolean).join('
');

  try {
    let text = '';
    if (GEMINI_API_KEY) {
      const r = await geminiPost(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
        { contents: [{ parts: [{ text: prompt }] }], generationConfig: { thinkingConfig: { thinkingBudget: 0 } } },
        { timeout: 10000 }
      );
      text = r.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else {
      const r = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-haiku-4-5-20251001', max_tokens: 150,
        messages: [{ role: 'user', content: prompt }],
      }, { headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, timeout: 10000 });
      text = r.data?.content?.[0]?.text || '';
    }

    const m      = text.match(/\{[\s\S]*\}/);
    const result = m ? JSON.parse(m[0]) : null;
    if (result && result.asking_median > 0) {
      // Sanity check — sell price shouldn't be more than 5% above asking
      if (!result.sell_price || result.sell_price > result.asking_median * 1.05) {
        result.sell_price = Math.round(result.asking_median * (1 - rates.sellDiscount));
      }
      const toCache = {
        asking_median: Math.round(result.asking_median),
        sell_price:    Math.round(result.sell_price),
        price_low:     Math.round(result.price_low  || result.asking_median * 0.70),
        price_high:    Math.round(result.price_high || result.asking_median * 1.10),
        category:      cat,
      };
      await redisSet(cacheKey, toCache, 30 * 24 * 3600); // cache 30 days
      return toCache;
    }
  } catch (e) {
    console.error('[Anchor]', keyword, e.message);
  }
  return null;
}
async function refreshKeywordAnchors() {
  try {
    const { rows } = await pool.query(`
      SELECT keyword, COUNT(*)::INT AS n,
        (ARRAY_AGG(title ORDER BY scraped_at DESC))[1:6] AS sample_titles
      FROM listings
      WHERE keyword IS NOT NULL
        AND category != 'vehicle'
        AND price > 0
        AND is_active = TRUE
      GROUP BY keyword
      HAVING COUNT(*) >= 4
    `);
    for (const r of rows) {
      if (isBroadKeyword(r.keyword)) continue;
      const anchor = await getKeywordPriceAnchor(r.keyword, r.sample_titles || []);
      if (anchor && anchor.asking_median) {
        // Store the asking_median as the anchor price (used for IQR fence gating)
        await pool.query(
          `INSERT INTO keyword_anchors(keyword, anchor_price, updated_at)
           VALUES($1, $2, NOW())
           ON CONFLICT(keyword) DO UPDATE SET anchor_price = EXCLUDED.anchor_price, updated_at = NOW()`,
          [r.keyword, anchor.asking_median]
        );
      }
      await new Promise(res => setTimeout(res, 200));
    }
    console.log(`[Anchor] refreshed ${rows.length} keyword anchors`);
  } catch (e) {
    console.error('[Anchor] refresh error:', e.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`FlipRadar backend on port ${PORT}`);
  console.log(`SociaVault: ${SOCIAVAULT_API_KEY ? 'set' : 'NO TOKEN — add SOCIAVAULT_API_KEY'}`);
  console.log(`Redis:      ${REDIS_URL           ? 'connected' : 'NOT SET'}`);
  console.log(`Gemini:     ${GEMINI_API_KEY   ? 'connected' : 'NOT SET — add GEMINI_API_KEY'}`);
  console.log(`Anthropic:  ${ANTHROPIC_API_KEY? 'connected' : 'NOT SET — add ANTHROPIC_API_KEY'}`);;
  await initDB();          // create tables if not exist

  // ── One-time data quality reset ──────────────────────────────────────────
  // Runs once per deploy via a flag in Redis. Clears polluted price stats
  // and resets price pool flags so tonight's nightly rebuilds everything
  // cleanly with the anchor gate in place.
  const RESET_FLAG = 'fr:migration:anchor-reset-v2'; // v2 = after keyword overhaul
  const alreadyReset = await redisGet(RESET_FLAG);
  if (!alreadyReset) {
    try {
      console.log('[Migration] Running one-time anchor reset...');

      // Clear polluted stats tables — will be rebuilt cleanly at 2am
      await pool.query('TRUNCATE keyword_price_stats');
      await pool.query('TRUNCATE keyword_anchors');

      // Reset price_quality on non-vehicle listings that weren't manually flagged
      // so the nightly re-scores them through the anchor filter
      const { rowCount } = await pool.query(`
        UPDATE listings
        SET in_price_pool = TRUE,
            price_quality = 'unscored'
        WHERE category != 'vehicle'
          AND price_quality NOT IN ('spam','damage','broken','swap','accessory')
      `);

      await redisSet(RESET_FLAG, { doneAt: new Date().toISOString() });
      console.log(`[Migration] ✅ Done — reset ${rowCount} listings, cleared price stats.`);
    } catch (e) {
      console.error('[Migration] Reset failed:', e.message);
    }
  }
  // ─────────────────────────────────────────────────────────────────────────
  await loadAllWatches();
  const dbSummary = await getDBSummary();
  if (dbSummary) {
    console.log(`[DB] ${dbSummary.total_listings} listings · ${dbSummary.unique_keywords} keywords · ${dbSummary.unique_makes} vehicle makes`);
  }
  console.log('[Ready] Server fully loaded');

  // Kick off full boot sequence — runs everything now rather than waiting for cron
  setTimeout(() => runFullBootSequence(), 5000);
});
