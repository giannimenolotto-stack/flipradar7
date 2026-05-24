


server (24).js
JavaScript
can u display this so i can copy and paste it

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
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch(e) {}
    }
    return parsed;
  } catch (e) {
    console.error('[Redis] GET error:', e.message);
    return null;
  }
}

async function redisSet(key, value) {
  if (!REDIS_URL) return;
  try {
    await axios.post(
      `${REDIS_URL}/set/${encodeURIComponent(key)}`,
      JSON.stringify(value),
      {
        headers: {
          Authorization: `Bearer ${REDIS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (e) {
    console.error('[Redis] SET error:', e.message);
  }
}

async function redisDel(key) {
  if (!REDIS_URL) return;
  try {
    await axios.post(
      `${REDIS_URL}/del/${encodeURIComponent(key)}`,
      null,
      {
        headers: {
          Authorization: `Bearer ${REDIS_TOKEN}`
        }
      }
    );
  } catch (e) {
    console.error('[Redis] DEL error:', e.message);
  }
}

// Redis key helpers
const K = {
  user:        id  => `fr:user:${id}`,
  emailIdx:    em  => `fr:email:${em.toLowerCase()}`,
  userWatches: uid => `fr:user-watches:${uid}`,
  watch:       id  => `fr:watch:${id}`,
  listings:    uid => `fr:listings:${uid}`,
  seen:        uid => `fr:seen:${uid}`,
  ebay:        kw  => `fr:ebay:${kw.toLowerCase().trim()}`,
  prices:      kw  => `fr:prices:${kw.toLowerCase().trim()}`,
  sharedScan:  kw  => `fr:scan:${kw.toLowerCase().trim()}`,
  blocked:     uid => `fr:blocked:${uid}`,
};

// ── Auth ──────────────────────────────────────────────────
const JWT_SECRET     = process.env.AUTH_SECRET || 'flipradar-secret-change-me';
const RESEND_API_KEY = process.env.RESEND_API_KEY || null;
const EBAY_APP_ID    = process.env.EBAY_APP_ID || null;

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
  PRICE_TO_PLAN[priceId] =
    key.startsWith('basic') ? 'basic' : 'premium';
});

const PLAN_APPRAISAL_LIMITS = {
  free: 999,
  basic: 999,
  premium: 999
};

const PLAN_WATCHLIST_LIMITS = {
  free: 5,
  basic: 5,
  premium: 5
};

const FROM_EMAIL    =
  process.env.FROM_EMAIL || 'FlipRadar <noreply@yourdomain.com>';

const INACTIVE_DAYS = 7;
const BCRYPT_ROUNDS = 10;

// ── eBay price cache settings ─────────────────────────────
const EBAY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const EBAY_MIN_RESULTS  = 5;
const OWN_PRICE_MIN     = 10;

// ── Appraisal credit helper ───────────────────────────────
async function consumeAppraisal(userId) {
  const user = await getUser(userId);

  if (!user) {
    return {
      ok: false,
      status: 404,
      error: 'User not found'
    };
  }

  const today = new Date().toISOString().slice(0, 10);

  if (user.appraisalDate !== today) {
    user.appraisalsToday = 0;
    user.appraisalDate = today;
  }

  const limit =
    PLAN_APPRAISAL_LIMITS[getEffectivePlan(user)];

  if (
    limit !== Infinity &&
    limit < 999 &&
    user.appraisalsToday >= limit
  ) {
    return {
      ok: false,
      status: 429,
      error: 'Daily appraisal limit reached',
      limit,
      plan: getEffectivePlan(user)
    };
  }

  user.appraisalsToday =
    (user.appraisalsToday || 0) + 1;

  await saveUser(user);

  return {
    ok: true,
    user,
    used: user.appraisalsToday,
    limit: limit === Infinity ? -1 : limit
  };
}
Your uploaded file: 





