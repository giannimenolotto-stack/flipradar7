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
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── PostgreSQL (Neon) ─────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL ||
  'postgresql://neondb_owner:npg_XVfnxmq2HCU1@ep-spring-hall-appvfgub-pooler.c-7.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

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
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS kms INTEGER',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS previous_price INTEGER',
      'ALTER TABLE listings ADD COLUMN IF NOT EXISTS price_dropped_at TIMESTAMPTZ',
      'CREATE TABLE IF NOT EXISTS keyword_anchors (keyword TEXT PRIMARY KEY, anchor_price INTEGER NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW())',
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


// ══════════════════════════════════════════════════════════════════════
// VEHICLE GENERATION RESOLVER
// Knows which year ranges belong to which chassis/generation code.
// e.g. BMW 318i 1995 → E36. Holden Commodore 1999 → VT.
// Lookup table covers AU market. AI fills the gaps and caches 1 year.
// ══════════════════════════════════════════════════════════════════════

const VEHICLE_GENERATIONS = {
  holden: {
    commodore: [
      { series:'VP', from:1991, to:1993 },
      { series:'VR', from:1993, to:1995 },
      { series:'VS', from:1995, to:1997 },
      { series:'VT', from:1997, to:2000 },
      { series:'VX', from:2000, to:2002 },
      { series:'VY', from:2002, to:2004 },
      { series:'VZ', from:2004, to:2006 },
      { series:'VE', from:2006, to:2013 },
      { series:'VF', from:2013, to:2017 },
    ],
    colorado: [
      { series:'RC', from:2008, to:2012 },
      { series:'RG', from:2012, to:2020 },
      { series:'RG Facelift', from:2016, to:2020 },
    ],
    captiva: [
      { series:'CG', from:2006, to:2018 },
    ],
  },
  ford: {
    falcon: [
      { series:'EA', from:1988, to:1991 },
      { series:'EB', from:1991, to:1993 },
      { series:'EF', from:1994, to:1996 },
      { series:'EL', from:1996, to:1998 },
      { series:'AU', from:1998, to:2002 },
      { series:'BA', from:2002, to:2005 },
      { series:'BF', from:2005, to:2008 },
      { series:'FG', from:2008, to:2014 },
      { series:'FG X', from:2014, to:2016 },
    ],
    ranger: [
      { series:'PX', from:2011, to:2015 },
      { series:'PX MkII', from:2015, to:2018 },
      { series:'PX MkIII', from:2018, to:2022 },
      { series:'P703', from:2022, to:2099 },
    ],
    territory: [
      { series:'SX', from:2004, to:2005 },
      { series:'SY', from:2005, to:2011 },
      { series:'SZ', from:2011, to:2016 },
    ],
    everest: [
      { series:'UA', from:2015, to:2022 },
      { series:'UB', from:2022, to:2099 },
    ],
  },
  toyota: {
    landcruiser: [
      { series:'40 Series', from:1960, to:1984 },
      { series:'60 Series', from:1980, to:1987 },
      { series:'70 Series', from:1984, to:2099 },
      { series:'80 Series', from:1989, to:1998 },
      { series:'100 Series', from:1997, to:2007 },
      { series:'200 Series', from:2007, to:2021 },
      { series:'300 Series', from:2021, to:2099 },
    ],
    prado: [
      { series:'J70',  from:1984, to:1990 },
      { series:'J80',  from:1990, to:1996 },
      { series:'J90',  from:1996, to:2002 },
      { series:'J120', from:2002, to:2009 },
      { series:'J150', from:2009, to:2099 },
    ],
    hilux: [
      { series:'N60',      from:1983, to:1988 },
      { series:'5th Gen',  from:1988, to:1997 },
      { series:'6th Gen',  from:1997, to:2005 },
      { series:'N70',      from:2005, to:2015 },
      { series:'N80',      from:2015, to:2099 },
    ],
    camry: [
      { series:'XV10', from:1991, to:1996 },
      { series:'XV20', from:1996, to:2001 },
      { series:'XV30', from:2001, to:2006 },
      { series:'XV40', from:2006, to:2011 },
      { series:'XV50', from:2011, to:2017 },
      { series:'XV70', from:2017, to:2099 },
    ],
    corolla: [
      { series:'E100', from:1991, to:1997 },
      { series:'E110', from:1997, to:2002 },
      { series:'E120', from:2001, to:2007 },
      { series:'E140', from:2006, to:2013 },
      { series:'E170', from:2013, to:2018 },
      { series:'E210', from:2018, to:2099 },
    ],
    kluger: [
      { series:'XU20',  from:2003, to:2007 },
      { series:'GSU40', from:2007, to:2014 },
      { series:'GSU50', from:2014, to:2020 },
      { series:'AXUH80',from:2020, to:2099 },
    ],
    'rav4': [
      { series:'XA10', from:1994, to:2000 },
      { series:'XA20', from:2000, to:2005 },
      { series:'XA30', from:2005, to:2012 },
      { series:'XA40', from:2012, to:2018 },
      { series:'XA50', from:2018, to:2099 },
    ],
    'hiace': [
      { series:'H100', from:1989, to:2004 },
      { series:'H200', from:2004, to:2019 },
      { series:'H300', from:2019, to:2099 },
    ],
    'tarago': [
      { series:'XR50', from:2006, to:2017 },
    ],
  },
  nissan: {
    patrol: [
      { series:'GQ', from:1987, to:1997 },
      { series:'GU', from:1997, to:2016 },
      { series:'Y62', from:2010, to:2099 },
    ],
    navara: [
      { series:'D21', from:1986, to:1997 },
      { series:'D22', from:1997, to:2015 },
      { series:'D40', from:2004, to:2015 },
      { series:'D23', from:2015, to:2099 },
    ],
    skyline: [
      { series:'R31', from:1985, to:1990 },
      { series:'R32', from:1989, to:1993 },
      { series:'R33', from:1993, to:1998 },
      { series:'R34', from:1998, to:2002 },
      { series:'V35', from:2001, to:2006 },
      { series:'V36', from:2006, to:2014 },
    ],
    silvia: [
      { series:'S12', from:1984, to:1988 },
      { series:'S13', from:1988, to:1994 },
      { series:'S14', from:1993, to:1999 },
      { series:'S15', from:1999, to:2002 },
    ],
    'x-trail': [
      { series:'T30', from:2001, to:2007 },
      { series:'T31', from:2007, to:2013 },
      { series:'T32', from:2013, to:2022 },
      { series:'T33', from:2022, to:2099 },
    ],
  },
  mitsubishi: {
    triton: [
      { series:'Mk2/L200', from:1986, to:1996 },
      { series:'MK',       from:1996, to:2006 },
      { series:'ML',       from:2006, to:2009 },
      { series:'MN',       from:2009, to:2015 },
      { series:'MQ',       from:2015, to:2019 },
      { series:'MR',       from:2018, to:2099 },
    ],
    pajero: [
      { series:'NH/NJ/NK/NL', from:1991, to:1999 },
      { series:'NM/NP',       from:1999, to:2006 },
      { series:'NS/NT/NW/NX', from:2006, to:2021 },
    ],
    lancer: [
      { series:'CE', from:1996, to:2003 },
      { series:'CH', from:2002, to:2007 },
      { series:'CJ', from:2007, to:2017 },
    ],
    'evolution': [
      { series:'Evo I-III', from:1992, to:1995 },
      { series:'Evo IV',    from:1996, to:1998 },
      { series:'Evo V',     from:1998, to:1999 },
      { series:'Evo VI',    from:1999, to:2001 },
      { series:'Evo VII',   from:2001, to:2003 },
      { series:'Evo VIII',  from:2003, to:2005 },
      { series:'Evo IX',    from:2005, to:2007 },
      { series:'Evo X',     from:2007, to:2016 },
    ],
    outlander: [
      { series:'ZG', from:2006, to:2012 },
      { series:'ZJ', from:2012, to:2021 },
      { series:'ZM', from:2021, to:2099 },
    ],
  },
  subaru: {
    impreza: [
      { series:'GC/GF',   from:1992, to:2000 },
      { series:'GD/GG',   from:2000, to:2007 },
      { series:'GE/GH/GR',from:2007, to:2011 },
      { series:'GJ/GP',   from:2011, to:2016 },
      { series:'GT',      from:2016, to:2023 },
    ],
    wrx: [
      { series:'GC WRX',  from:1994, to:2000 },
      { series:'GD WRX',  from:2000, to:2007 },
      { series:'GE WRX',  from:2007, to:2014 },
      { series:'VA',      from:2014, to:2021 },
      { series:'VB',      from:2021, to:2099 },
    ],
    'wrx sti': [
      { series:'GC STI',  from:1994, to:2000 },
      { series:'GD STI',  from:2000, to:2007 },
      { series:'GR STI',  from:2007, to:2014 },
      { series:'VA STI',  from:2014, to:2021 },
    ],
    forester: [
      { series:'SF', from:1997, to:2002 },
      { series:'SG', from:2002, to:2008 },
      { series:'SH', from:2008, to:2012 },
      { series:'SJ', from:2012, to:2018 },
      { series:'SK', from:2018, to:2099 },
    ],
    outback: [
      { series:'BH', from:1999, to:2003 },
      { series:'BP', from:2003, to:2009 },
      { series:'BR', from:2009, to:2014 },
      { series:'BS', from:2014, to:2020 },
      { series:'BT', from:2020, to:2099 },
    ],
    liberty: [
      { series:'BH', from:1998, to:2003 },
      { series:'BP', from:2003, to:2009 },
      { series:'BR', from:2009, to:2014 },
      { series:'BS', from:2014, to:2020 },
    ],
  },
  bmw: {
    // 3 series: 316-340, M3
    '3': [
      { series:'E21', from:1975, to:1983 },
      { series:'E30', from:1982, to:1994 },
      { series:'E36', from:1990, to:2000 },
      { series:'E46', from:1997, to:2006 },
      { series:'E90', from:2004, to:2013 },
      { series:'F30', from:2011, to:2019 },
      { series:'G20', from:2018, to:2099 },
    ],
    // 5 series: 518-550, M5
    '5': [
      { series:'E28', from:1981, to:1988 },
      { series:'E34', from:1987, to:1996 },
      { series:'E39', from:1995, to:2003 },
      { series:'E60', from:2003, to:2010 },
      { series:'F10', from:2009, to:2017 },
      { series:'G30', from:2016, to:2099 },
    ],
    // 7 series: 728-760
    '7': [
      { series:'E23', from:1977, to:1986 },
      { series:'E32', from:1986, to:1994 },
      { series:'E38', from:1994, to:2001 },
      { series:'E65', from:2001, to:2008 },
      { series:'F01', from:2008, to:2015 },
      { series:'G11', from:2015, to:2099 },
    ],
    // 1 series
    '1': [
      { series:'E87', from:2004, to:2012 },
      { series:'F20', from:2011, to:2019 },
      { series:'F40', from:2019, to:2099 },
    ],
    // 2 series
    '2': [
      { series:'F22', from:2013, to:2021 },
      { series:'G42', from:2021, to:2099 },
    ],
    // 4 series (coupe/convertible of 3)
    '4': [
      { series:'F32', from:2013, to:2020 },
      { series:'G22', from:2020, to:2099 },
    ],
    // X models
    'x1': [
      { series:'E84', from:2009, to:2015 },
      { series:'F48', from:2015, to:2022 },
      { series:'U11', from:2022, to:2099 },
    ],
    'x3': [
      { series:'E83', from:2003, to:2010 },
      { series:'F25', from:2010, to:2017 },
      { series:'G01', from:2017, to:2099 },
    ],
    'x5': [
      { series:'E53', from:1999, to:2006 },
      { series:'E70', from:2006, to:2013 },
      { series:'F15', from:2013, to:2018 },
      { series:'G05', from:2018, to:2099 },
    ],
    'x6': [
      { series:'E71', from:2008, to:2014 },
      { series:'F16', from:2014, to:2019 },
      { series:'G06', from:2019, to:2099 },
    ],
    'm3': [
      { series:'E30 M3', from:1986, to:1991 },
      { series:'E36 M3', from:1992, to:1999 },
      { series:'E46 M3', from:2000, to:2006 },
      { series:'E92 M3', from:2007, to:2013 },
      { series:'F80 M3', from:2014, to:2018 },
      { series:'G80 M3', from:2020, to:2099 },
    ],
    'm4': [
      { series:'F82 M4', from:2014, to:2020 },
      { series:'G82 M4', from:2020, to:2099 },
    ],
  },
  mercedes: {
    'c-class': [
      { series:'W202', from:1993, to:2000 },
      { series:'W203', from:2000, to:2007 },
      { series:'W204', from:2007, to:2014 },
      { series:'W205', from:2014, to:2022 },
      { series:'W206', from:2021, to:2099 },
    ],
    'e-class': [
      { series:'W124', from:1984, to:1997 },
      { series:'W210', from:1995, to:2002 },
      { series:'W211', from:2002, to:2009 },
      { series:'W212', from:2009, to:2016 },
      { series:'W213', from:2016, to:2099 },
    ],
    's-class': [
      { series:'W126', from:1979, to:1991 },
      { series:'W140', from:1991, to:1998 },
      { series:'W220', from:1998, to:2005 },
      { series:'W221', from:2005, to:2013 },
      { series:'W222', from:2013, to:2020 },
      { series:'W223', from:2020, to:2099 },
    ],
    'sprinter': [
      { series:'T1N', from:1995, to:2006 },
      { series:'W906', from:2006, to:2018 },
      { series:'W907', from:2018, to:2099 },
    ],
    'vito': [
      { series:'W638', from:1996, to:2003 },
      { series:'W639', from:2003, to:2014 },
      { series:'W447', from:2014, to:2099 },
    ],
  },
  audi: {
    'a3': [
      { series:'8L', from:1996, to:2003 },
      { series:'8P', from:2003, to:2013 },
      { series:'8V', from:2012, to:2020 },
      { series:'8Y', from:2020, to:2099 },
    ],
    'a4': [
      { series:'B5', from:1994, to:2001 },
      { series:'B6', from:2000, to:2004 },
      { series:'B7', from:2004, to:2008 },
      { series:'B8', from:2007, to:2015 },
      { series:'B9', from:2015, to:2099 },
    ],
    'a6': [
      { series:'C4', from:1994, to:1997 },
      { series:'C5', from:1997, to:2004 },
      { series:'C6', from:2004, to:2011 },
      { series:'C7', from:2011, to:2018 },
      { series:'C8', from:2018, to:2099 },
    ],
    'tt': [
      { series:'8N', from:1998, to:2006 },
      { series:'8J', from:2006, to:2014 },
      { series:'8S', from:2014, to:2023 },
    ],
    'q5': [
      { series:'8R', from:2008, to:2017 },
      { series:'FY', from:2016, to:2099 },
    ],
  },
  volkswagen: {
    golf: [
      { series:'MK1', from:1974, to:1983 },
      { series:'MK2', from:1983, to:1992 },
      { series:'MK3', from:1992, to:1998 },
      { series:'MK4', from:1998, to:2006 },
      { series:'MK5', from:2004, to:2009 },
      { series:'MK6', from:2008, to:2014 },
      { series:'MK7', from:2012, to:2020 },
      { series:'MK8', from:2020, to:2099 },
    ],
    polo: [
      { series:'9N', from:2001, to:2009 },
      { series:'6R', from:2009, to:2014 },
      { series:'6C', from:2014, to:2017 },
      { series:'AW', from:2017, to:2099 },
    ],
    passat: [
      { series:'B5', from:1996, to:2005 },
      { series:'B6', from:2005, to:2010 },
      { series:'B7', from:2010, to:2014 },
      { series:'B8', from:2014, to:2099 },
    ],
    tiguan: [
      { series:'5N', from:2007, to:2016 },
      { series:'AD', from:2016, to:2099 },
    ],
    amarok: [
      { series:'2H', from:2010, to:2022 },
      { series:'NF', from:2022, to:2099 },
    ],
  },
  mazda: {
    '3': [
      { series:'BK', from:2003, to:2009 },
      { series:'BL', from:2009, to:2013 },
      { series:'BM', from:2013, to:2019 },
      { series:'BP', from:2019, to:2099 },
    ],
    '6': [
      { series:'GG', from:2002, to:2007 },
      { series:'GH', from:2007, to:2012 },
      { series:'GJ', from:2012, to:2022 },
    ],
    'cx-5': [
      { series:'KE', from:2012, to:2017 },
      { series:'KF', from:2017, to:2099 },
    ],
    'cx-9': [
      { series:'TB', from:2007, to:2016 },
      { series:'TC', from:2016, to:2099 },
    ],
    'rx-7': [
      { series:'FB', from:1978, to:1985 },
      { series:'FC', from:1985, to:1992 },
      { series:'FD', from:1992, to:2002 },
    ],
    'mx-5': [
      { series:'NA', from:1989, to:1997 },
      { series:'NB', from:1997, to:2005 },
      { series:'NC', from:2005, to:2014 },
      { series:'ND', from:2015, to:2099 },
    ],
  },
  honda: {
    civic: [
      { series:'EG', from:1991, to:1995 },
      { series:'EK', from:1995, to:2001 },
      { series:'EP', from:2001, to:2005 },
      { series:'FD', from:2005, to:2011 },
      { series:'FB', from:2011, to:2016 },
      { series:'FC', from:2015, to:2021 },
      { series:'FL', from:2021, to:2099 },
    ],
    crv: [
      { series:'RD', from:1995, to:2001 },
      { series:'RD/RE', from:2001, to:2012 },
      { series:'RM', from:2012, to:2016 },
      { series:'RW', from:2016, to:2022 },
      { series:'RS', from:2022, to:2099 },
    ],
    jazz: [
      { series:'GD', from:2001, to:2008 },
      { series:'GE', from:2008, to:2014 },
      { series:'GK', from:2014, to:2020 },
      { series:'GR', from:2020, to:2099 },
    ],
  },
  hyundai: {
    'i30': [
      { series:'FD', from:2007, to:2012 },
      { series:'GD', from:2011, to:2017 },
      { series:'PD', from:2016, to:2099 },
    ],
    'tucson': [
      { series:'JM', from:2004, to:2010 },
      { series:'LM', from:2009, to:2015 },
      { series:'TL', from:2015, to:2020 },
      { series:'NX4', from:2020, to:2099 },
    ],
    'santa fe': [
      { series:'SM', from:2000, to:2006 },
      { series:'CM', from:2006, to:2012 },
      { series:'DM', from:2012, to:2018 },
      { series:'TM', from:2018, to:2099 },
    ],
  },
  kia: {
    'sportage': [
      { series:'JA', from:1993, to:2004 },
      { series:'KM', from:2004, to:2010 },
      { series:'SL', from:2010, to:2016 },
      { series:'QL', from:2015, to:2022 },
      { series:'NQ5', from:2021, to:2099 },
    ],
    'cerato': [
      { series:'LD', from:2003, to:2008 },
      { series:'TD', from:2008, to:2013 },
      { series:'YD', from:2012, to:2018 },
      { series:'BD', from:2018, to:2099 },
    ],
  },
};

// Map a raw model string to the correct lookup key in VEHICLE_GENERATIONS
function getModelLineKey(make, rawModel) {
  if (!rawModel) return null;
  const m = String(rawModel).toLowerCase().trim();

  if (make === 'bmw') {
    // M models first (specific)
    if (/m3/.test(m)) return 'm3';
    if (/m4/.test(m)) return 'm4';
    if (/m5/.test(m)) return 'm5';
    // X models
    if (/x1/.test(m)) return 'x1';
    if (/x3/.test(m)) return 'x3';
    if (/x5/.test(m)) return 'x5';
    if (/x6/.test(m)) return 'x6';
    if (/x7/.test(m)) return 'x7';
    // Number series: extract leading digit from model like "320d", "318i", "520d"
    const numLine = m.match(/\b([1-8])\d{2}/);
    if (numLine) return numLine[1]; // '3', '5', '7' etc.
    // Already just a number ("3 series", "3-series", "3")
    const justNum = m.match(/^([1-8])(?:\s*series)?$/);
    if (justNum) return justNum[1];
    return null;
  }

  if (make === 'mercedes') {
    if (/\bc.?class\b|\bc ?\d{3}\b|\bc63\b|\bc43\b|\bc45\b/.test(m)) return 'c-class';
    if (/\be.?class\b|\be ?\d{3}\b|\be63\b|\be53\b/.test(m)) return 'e-class';
    if (/\bs.?class\b|\bs ?\d{3}\b/.test(m)) return 's-class';
    if (/\bvito\b/.test(m)) return 'vito';
    if (/\bsprinter\b/.test(m)) return 'sprinter';
    return m.split(' ')[0]; // fallback to first word
  }

  if (make === 'audi') {
    // A3, S3, RS3 → a3 table
    if (/\b[sr]?s?3\b|\ba3\b/.test(m)) return 'a3';
    // A4, S4, RS4 → a4 table
    if (/\b[sr]?s?4\b|\ba4\b/.test(m)) return 'a4';
    if (/\ba6\b|\bs6\b|\brs6\b/.test(m)) return 'a6';
    if (/\btt\b/.test(m)) return 'tt';
    if (/\bq5\b/.test(m)) return 'q5';
    return m.split(' ')[0];
  }

  if (make === 'volkswagen') {
    if (/\bgolf\b/.test(m)) return 'golf';
    if (/\bpolo\b/.test(m)) return 'polo';
    if (/\bpassat\b/.test(m)) return 'passat';
    if (/\btiguan\b/.test(m)) return 'tiguan';
    if (/\bamarok\b/.test(m)) return 'amarok';
  }

  // For Toyota, Nissan, Holden, Ford, Mazda, etc. — model is usually the key directly
  // Clean it up: "3 series" → "3", "hilux sr5" → "hilux", etc.
  return m.replace(/\s*(sr5?|sr|glx?|dx|gl|vx|vn|executive|elite|sport|turbo|diesel|petrol|auto|manual|4wd|2wd)\s*$/i,'').trim();
}

// Sync lookup: given make+model+year, return the chassis/generation series.
// Returns null if not found — caller can then try aiResolveGeneration().
function lookupGenerationByYear(make, rawModel, year) {
  if (!make || !year || year < 1960) return null;
  const mk = String(make).toLowerCase().trim();
  const modelKey = getModelLineKey(mk, rawModel);
  if (!modelKey) return null;

  const gens = VEHICLE_GENERATIONS[mk]?.[modelKey];
  if (!gens || !gens.length) return null;

  // Find all generations whose year range covers this year
  const matches = gens.filter(g => year >= g.from && year <= g.to);
  if (!matches.length) return null;
  // Overlap (changeover year): prefer the newer generation (higher from)
  return matches.sort((a, b) => b.from - a.from)[0].series;
}

// AI fallback: asks Gemini/Haiku to identify the generation.
// Cached for 1 year per (make, model, year) — static automotive knowledge.
async function aiResolveGeneration(make, model, year) {
  if (!make || !year) return null;
  const ck = ('gen:' + String(make) + ':' + String(model||'') + ':' + String(year)).toLowerCase().replace(/\s/g,'_');
  try {
    const cached = await redisGet(ck);
    if (cached && cached.s !== undefined) return cached.s || null;
  } catch(_) {}

  if (!GEMINI_API_KEY && !ANTHROPIC_API_KEY) return null;

  const prompt = [
    'You are an automotive expert. What is the chassis/generation code for this vehicle?',
    `Year: ${year}, Make: ${make}, Model: ${model || 'unknown'}`,
    'Examples: BMW E36, Holden VT Commodore, Ford BF Falcon, Toyota N70 HiLux, Nissan GU Patrol, VW MK4 Golf, Mazda BL Mazda3',
    'Return ONLY JSON — no explanation: { "series": "code" } or { "series": null } if unknown.',
  ].join('\n');

  try {
    let text = '';
    if (GEMINI_API_KEY) {
      const r = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
        { contents:[{parts:[{text:prompt}]}], generationConfig:{ thinkingConfig:{thinkingBudget:0} } },
        { headers:{'Content-Type':'application/json'}, timeout:8000 });
      text = r.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else {
      const r = await axios.post('https://api.anthropic.com/v1/messages',
        { model:'claude-haiku-4-5-20251001', max_tokens:60, messages:[{role:'user',content:prompt}] },
        { headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'}, timeout:8000 });
      text = r.data?.content?.[0]?.text || '';
    }
    const mj = text.match(/\{[\s\S]*?\}/);
    const parsed = mj ? JSON.parse(mj[0]) : null;
    const s = (parsed?.series && typeof parsed.series === 'string') ? parsed.series.trim() : null;
    await redisSet(ck, { s }, 365 * 24 * 3600).catch(()=>{});
    return s;
  } catch(e) { console.error('[GenAI]', make, model, year, e.message); return null; }
}

// ── Enrich a listing with all precise vehicle identity fields ──
// Called before upsert — fills in series, variant, bands etc
function enrichVehicleIdentity(listing) {
  if (!listing.make) return listing;

  const title = listing.title || '';
  const desc  = listing.description || '';

  const series    = listing.series    || extractSeriesFromTitle(listing.make, listing.model, title)
                  || lookupGenerationByYear(listing.make, listing.model, listing.year);
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

async function upsertListingToDB(rawListing) {
  try {
    // Enrich with precise vehicle identity fields before writing
    const listing = rawListing.make ? enrichVehicleIdentity(rawListing) : rawListing;

    const price      = (listing.price && !isOfferPrice(listing.price)) ? listing.price : null;
    const offerPrice = isOfferPrice(listing.price);
    const { flags, quality, inPricePool } = scoreListingQuality({ ...listing, price: listing.price });

    await pool.query(`
      INSERT INTO listings
        (listing_id, title, description, price, is_offer_price, location, state,
         seller_name, image_url, url, keyword, category,
         make, model, series, variant, body_style, year, year_band,
         kms, mileage_band, transmission, fuel_type, engine,
         price_quality, quality_flags, in_price_pool,
         listed_at, scraped_at, last_seen_at, is_active, listing_status, seen_count)
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
        $13,$14,$15,$16,$17,$18,$19,
        $20,$21,$22,$23,$24,
        $25,$26,$27,
        $28,NOW(),NOW(),TRUE,'active',1
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
        price_quality  = EXCLUDED.price_quality,
        quality_flags  = EXCLUDED.quality_flags,
        in_price_pool  = EXCLUDED.in_price_pool
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
  // Normalise inputs so minor differences don't bust the cache
  const normTitle   = (title   || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
  const normKeyword = (keyword || '').toLowerCase().trim().slice(0, 30);
  const normPrice   = Math.round((parseFloat(price) || 0) / 50) * 50; // round to nearest $50
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

const DB_TRUST_THRESHOLD = 65; // minimum score to prefer DB over AI

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
  if (!dbStats) {
    console.log(`[PriceCache] "${keyword}" → no DB data, using AI`);
    return null;
  }
  const score = scoreDBKeywordResult(dbStats);
  if (score >= DB_TRUST_THRESHOLD) {
    console.log(`[PriceCache] "${keyword}" → DB preferred (score ${score}, n=${dbStats.count})`);
    return { ...dbStats, low: dbStats.p25 || dbStats.low, high: dbStats.p75 || dbStats.high };
  }
  console.log(`[PriceCache] "${keyword}" → DB score ${score} < ${DB_TRUST_THRESHOLD} — AI preferred`);
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

// Mileage-aware verdict from DB price data (used when DB beats AI threshold).
function buildVehicleVerdict(listingPrice, priceSource, mileage) {
  const { marketMedian, marketLow, marketHigh, mileageAdjusted, make, model, year } = priceSource;

  const feeAdj          = marketMedian * 0.92;  // ~8% selling fees (FB/Gumtree)
  const roi             = marketMedian > 0 ? Math.round(((feeAdj - listingPrice) / listingPrice) * 100) : 0;
  const estimatedProfit = Math.max(0, Math.round(feeAdj - listingPrice));

  let verdict, oneLiner, dealScore;
  if (roi >= 50) {
    verdict = 'STEAL'; dealScore = 95;
    oneLiner = `Listed ${roi}% below market median — exceptional flip potential`;
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

  if (!mileageAdjusted)          dealScore = Math.max(0, dealScore - 8);
  if (mileage && mileage > 200000) dealScore = Math.max(0, dealScore - 5);  // mileage param = kms value

  const carLabel         = [year, make, model].filter(Boolean).join(' ');
  const mileageWarning   = !mileageAdjusted ? ' Kms not listed — actual value may vary.' : '';
  const whyItsWorth      = `Based on comparable ${carLabel} listings currently on the AU market.${mileageWarning}`;

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
    low:    marketLow,
    median: marketMedian,
    high:   marketHigh,
    negotiationScript: `Similar ${carLabel}s are going for around $${marketMedian.toLocaleString()} — would you take $${Math.round(listingPrice * 0.82).toLocaleString()}?`,
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
  free:    30 * 60 * 1000,  // 30 minutes
  basic:   30 * 60 * 1000,  // 30 minutes
  pro:     30 * 60 * 1000,  // 30 minutes
  premium: 30 * 60 * 1000,  // 30 minutes
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
const SHARED_SCAN_TTL_MS = 110 * 60 * 1000; // 110 mins — slightly under the 2hr scan interval

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
  let seenModified = false;
  // Debug counters — logged at end to show exactly where listings went
  let dropMaxPrice = 0, dropMinPrice = 0;
  // On regular scans (after initial scan completed), drop any listing that was
  // posted before the initial scan finished — those should have been caught then.
  // This stops old listings trickling in on every 30-min scan.
  const initialScanCutoff = watcher.initialScanCompletedAt
    ? new Date(watcher.initialScanCompletedAt).getTime()
    : null;

  for (let listing of relevant) {
    // ── Check for price drop + write to Neon DB ───────────
    // Price drop check runs first — enriches the listing object with
    // priceDropped/previousPrice flags before anything else sees it.
    listing = await checkPriceDrop(listing);
    storeScanPrice(keyword, listing).catch(() => {});

    const key    = `${keyword}:${listing.id}`;
    const seenTs = seen[key];

    // Price-dropped listings always get through to the feed even if seen before
    // — the user needs to know the price changed
    const isPriceDrop = listing.priceDropped && listing.price < (listing.previousPrice || Infinity);
    if (seenTs && (Date.now() - seenTs) < SEEN_TTL_MS && !isPriceDrop) {
      if (!opts.initialScan) { seenSkipped++; continue; }
    }
    // Price range filter — only applies when the user has set a min/max
    if (watcher.maxPrice && listing.price && listing.price > watcher.maxPrice) { dropMaxPrice++; continue; }
    if (watcher.minPrice && listing.price && listing.price < watcher.minPrice) { dropMinPrice++; continue; }
    // Vehicle filters
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
    const pushTitle = listing.priceDropped
      ? `💸 Price Drop: ${keyword}`
      : `FlipRadar: ${keyword}`;
    // Pushover notification (if configured)
    await sendPushover(pToken, pUser, pushTitle, `${listing.title}\n${priceStr}${dropStr}`, listing.url);
    // Web push notification — works even when app is closed, no extra app needed
    sendWebPush(watcher.userId, {
      title: pushTitle,
      body:  `${priceStr}${dropStr} · ${listing.location || keyword}`,
      url:   listing.url,
      tag:   `listing-${listing.id}`,
    }).catch(() => {});
    await sleep(300);
  }

  // Log the breakdown so we can see exactly where listings went
  const totalIn = relevant.length;
  const totalOut = newCount;
  if (totalIn > 0) {
    console.log(`[Distribute] "${keyword}" → ${totalIn} in, ${totalOut} new, ${seenSkipped} already seen, ${dropMaxPrice + dropMinPrice} outside price range`);
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
// If two users watch "mercedes benz", only ONE BrightData call is made per 25 mins
// Both users get results from the shared cache — huge cost saving
async function scanWatchItem(watcher, opts = {}) {
  const keyword = watcher.keyword.toLowerCase();

  // ── Check shared scan cache first ────────────────────────
  let raw;
  const cached = await redisGet(K.sharedScan(keyword));
  if (!opts.initialScan && cached && (Date.now() - new Date(cached.scannedAt).getTime()) < SHARED_SCAN_TTL_MS) {
    // Serve from cache — no limit, serve everything cached
    raw = cached.listings || [];
    console.log(`[SharedCache] "${keyword}" → ${raw.length} listings from cache (no SociaVault call)`);
  } else {
    raw = await scrapeKeyword(keyword, {
      city: watcher.location, lat: watcher.lat, lng: watcher.lng,
      radius: watcher.radius, initialScan: opts.initialScan || false,
      minPrice: watcher.minPrice || null,
      maxPrice: watcher.maxPrice || null,
    });
    await redisSet(K.sharedScan(keyword), { listings: raw, scannedAt: new Date().toISOString() });
    console.log(`[SharedCache] "${keyword}" → cached ${raw.length} listings`);

    // ── Also distribute to ALL other users watching this keyword ──
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

    // ── Step 4: Rebuild keyword_price_stats with IQR data ──
    await pool.query(`
      INSERT INTO keyword_price_stats
        (keyword, sample_count, raw_count, median_price, p25_price, p75_price,
         iqr, floor_price, ceiling_price, low_price, high_price, updated_at)
      WITH base AS (
        SELECT keyword,
          COUNT(*)::INT AS raw_count,
          PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY price)::INT AS p25,
          PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY price)::INT AS p75
        FROM listings
        WHERE keyword IS NOT NULL AND price > 0
          AND is_offer_price = FALSE AND in_price_pool = TRUE AND is_active = TRUE
          AND scraped_at > NOW() - INTERVAL '90 days'
        GROUP BY keyword HAVING COUNT(*) >= 5
      ),
      fenced AS (
        SELECT l.keyword,
          b.raw_count,
          b.p25, b.p75,
          (b.p75 - b.p25)                               AS iqr,
          GREATEST(0, b.p25 - 1.5*(b.p75-b.p25))::INT  AS fence_lo,
          (b.p75 + 1.5*(b.p75-b.p25))::INT             AS fence_hi,
          COUNT(*)::INT                                 AS clean_count,
          PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY l.price)::INT AS median,
          MIN(l.price)::INT                             AS low,
          MAX(l.price)::INT                             AS high
        FROM listings l JOIN base b ON l.keyword = b.keyword
        WHERE l.price BETWEEN GREATEST(0, b.p25 - 1.5*(b.p75-b.p25))
                          AND (b.p75 + 1.5*(b.p75-b.p25))
          AND l.is_offer_price = FALSE AND l.in_price_pool = TRUE
          AND l.is_active = TRUE
          AND l.scraped_at > NOW() - INTERVAL '90 days'
        GROUP BY l.keyword, b.raw_count, b.p25, b.p75
        HAVING COUNT(*) >= 5
      )
      SELECT keyword, clean_count, raw_count, median, p25, p75,
             iqr::INT, fence_lo, fence_hi, low, high, NOW()
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
  } catch (e) {
    console.error('[Cron] Stats rebuild error:', e.message);
  }
});

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
      'The market median shown above is what sellers are ASKING. What things actually SELL for is different.',
      'In Australian FB Marketplace, most items sell for 10–20% below the asking median.',
      'Your estimatedResellLow must be what a buyer will realistically pay — not what you hope to get.',
      'Price it to sell in 1–2 weeks. If it would take longer, the price is too high.',
      '',
      'CALCULATE PROFIT STEP BY STEP — show your working in whyItsWorth:',
      'Step 1 — Realistic sell price: take market median, subtract 12% (AU market discount off asking)',
      'Step 2 — Detailing/clean: $200 minimum, $400 if condition is average or unknown',
      'Step 3 — Minor repairs: $0 if genuinely perfect, $300–800 if any issues mentioned or kms are high',
      'Step 4 — Rego/RWC if unregistered or interstate: add $400–800',
      'Step 5 — Your time: minimum 2 hours to list, negotiate, show, sell — factor it in',
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
        // DB is fully trusted — lock the price fields
        // AI still owns: verdict rationale, flags, negotiation script, inspection checklist
        parsed.estimatedMarketValue = dbResult.marketMedian;
        parsed.estimatedResellLow   = dbResult.marketLow;
        parsed.estimatedResellHigh  = dbResult.marketHigh;
        parsed.low                  = dbResult.marketLow;
        parsed.median               = dbResult.marketMedian;
        parsed.high                 = dbResult.marketHigh;
        // Realistic sell price = 10% below median (priced to actually sell, not sit)
        const realisticSellPrice = Math.round(dbResult.marketMedian * 0.90);
        // Realistic costs: detailing + minor prep (conservative estimate)
        const flipCosts = listingPrice < 5000 ? 300 : listingPrice < 15000 ? 500 : 800;
        const realisticProfit = realisticSellPrice - listingPrice - flipCosts;

        parsed.estimatedResellLow   = realisticSellPrice;
        parsed.estimatedResellHigh  = Math.round(dbResult.marketMedian * 0.97); // best case just under median
        parsed.estimatedMarketValue = dbResult.marketMedian;
        parsed.low                  = dbResult.marketLow;
        parsed.median               = dbResult.marketMedian;
        parsed.high                 = dbResult.marketHigh;
        if (realisticProfit <= 0) {
          // Negative flip — set resell to around what was paid, profit to 0
          parsed.estimatedProfit      = 0;
          parsed.roiPercent           = 0;
          parsed.estimatedResellLow   = listingPrice;
          parsed.estimatedResellHigh  = Math.round(listingPrice * 1.04);
        } else {
          parsed.estimatedProfit      = Math.round(realisticProfit);
          parsed.roiPercent           = Math.round((realisticProfit / listingPrice) * 100);
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
async function getKeywordPriceAnchor(keyword,sampleTitles=[]){
  const cacheKey=`anchor:${_slug(keyword).slice(0,60)}`;
  const cached=await redisGet(cacheKey);if(cached&&cached.anchor)return cached.anchor;
  if(!GEMINI_API_KEY&&!ANTHROPIC_API_KEY)return null;
  const prompt=['You estimate the typical USED resale price in AUD on Australian Facebook Marketplace.',`Product keyword: "${keyword}"`,sampleTitles.length?`Example titles:\n- ${sampleTitles.slice(0,6).join('\n- ')}`:'','Give ONE rough typical price for the MAIN product in good used condition (NOT accessories/parts).','Return ONLY JSON: { "anchor_aud": number }'].filter(Boolean).join('\n');
  try{
    let text='';
    if(GEMINI_API_KEY){const r=await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,{contents:[{parts:[{text:prompt}]}],generationConfig:{thinkingConfig:{thinkingBudget:0}}},{headers:{'Content-Type':'application/json'},timeout:10000});text=r.data?.candidates?.[0]?.content?.parts?.[0]?.text||'';}
    else{const r=await axios.post('https://api.anthropic.com/v1/messages',{model:'claude-haiku-4-5-20251001',max_tokens:100,messages:[{role:'user',content:prompt}]},{headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},timeout:10000});text=r.data?.content?.[0]?.text||'';}
    const m=text.match(/\{[\s\S]*\}/);const anchor=m?Math.round(JSON.parse(m[0]).anchor_aud):null;
    if(anchor&&anchor>0){await redisSet(cacheKey,{anchor},30*24*3600);return anchor;}
  }catch(e){console.error('[Anchor]',keyword,e.message);}
  return null;
}
async function refreshKeywordAnchors(){
  try{
    const{rows}=await pool.query(`SELECT keyword,COUNT(*)::INT AS n,(ARRAY_AGG(title ORDER BY scraped_at DESC))[1:6] AS sample_titles FROM listings WHERE keyword IS NOT NULL AND category!='vehicle' AND price>0 AND is_active=TRUE GROUP BY keyword HAVING COUNT(*)>=8`);
    for(const r of rows){if(isBroadKeyword(r.keyword))continue;const anchor=await getKeywordPriceAnchor(r.keyword,r.sample_titles||[]);if(anchor){await pool.query(`INSERT INTO keyword_anchors(keyword,anchor_price,updated_at)VALUES($1,$2,NOW())ON CONFLICT(keyword)DO UPDATE SET anchor_price=EXCLUDED.anchor_price,updated_at=NOW()`,[r.keyword,anchor]);}await new Promise(res=>setTimeout(res,200));}
    console.log(`[Anchor] refreshed ${rows.length} keyword anchors`);
  }catch(e){console.error('[Anchor] refresh error:',e.message);}
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`FlipRadar backend on port ${PORT}`);
  console.log(`SociaVault: ${SOCIAVAULT_API_KEY ? 'set' : 'NO TOKEN — add SOCIAVAULT_API_KEY'}`);
  console.log(`Redis:      ${REDIS_URL           ? 'connected' : 'NOT SET'}`);
  console.log(`Gemini:     ${GEMINI_API_KEY   ? 'connected' : 'NOT SET — add GEMINI_API_KEY'}`);
  console.log(`Anthropic:  ${ANTHROPIC_API_KEY? 'connected' : 'NOT SET — add ANTHROPIC_API_KEY'}`);;
  await initDB();          // create tables if not exist
  await loadAllWatches();
  const dbSummary = await getDBSummary();
  if (dbSummary) {
    console.log(`[DB] ${dbSummary.total_listings} listings · ${dbSummary.unique_keywords} keywords · ${dbSummary.unique_makes} vehicle makes`);
  }
  console.log('[Ready] Server fully loaded');
});
