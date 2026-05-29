// ============================================================
// vehicle-blend-valuation.js  —  thin-data-proof car pricing
//
// One value for any target car, built by blending:
//   • every comparable, each SLID to the target's km (depreciation formula)
//   • weighted so the CLOSEST-km comps count most (least adjustment = most trust)
//   • an AI estimate, leaned on MORE the less real data there is
// Confidence drops as the AI carries more of the answer.
//
// Reuses your DEP_TABLE, pool, and Gemini/Haiku transport.
// ============================================================

const REF_FALLBACK_PERKM = 0.08;   // $/km value lost if a make isn't in DEP_TABLE
const KM_HALF_WEIGHT = 50000;      // a comp 50k km away counts half as much
const ENOUGH_COMPS = 8;            // at/above this, real data carries it fully


// ── the "slider": move a comp's price from its km to the target's km ──
function slideToKm(price, fromKm, toKm, make) {
  // VERIFY: DEP_TABLE must be keyed by lowercase make ('toyota') with a `perKm` field.
  // If the keys differ, this silently falls back to REF_FALLBACK_PERKM for every car.
  const perKm = (DEP_TABLE?.[String(make || '').toLowerCase()]?.perKm) || REF_FALLBACK_PERKM;
  // fewer km than the comp ⇒ worth more; more km ⇒ worth less
  const adjusted = price + (fromKm - toKm) * perKm;
  return Math.max(price * 0.25, adjusted);   // never let the slide push it below a sane floor
}


// ── gather comparables, widening scope only if we're short on data ──
async function getVehicleComps(target) {
  const scopes = [
    `make=$1 AND model=$2 AND series IS NOT DISTINCT FROM $3 AND variant IS NOT DISTINCT FROM $4`, // tightest
    `make=$1 AND model=$2 AND series IS NOT DISTINCT FROM $3`,                                       // drop variant
    `make=$1 AND model=$2`,                                                                          // drop series
  ];
  for (const where of scopes) {
    const { rows } = await pool.query(`
      SELECT price, kms, year, scraped_at FROM listings
      WHERE category='vehicle' AND is_active=TRUE AND in_price_pool=TRUE
        AND price>0 AND kms>0 AND ${where}
        AND scraped_at > NOW() - INTERVAL '120 days'`,
      [target.make, target.model, target.series || null, target.variant || null]);
    if (rows.length >= 3) return rows;   // enough to work with — stop widening
  }
  return [];
}


// ── AI ballpark for the specific car (used as the thin-data backstop) ──
async function aiEstimateVehicle(target) {
  const ck = `vest:${[target.make,target.model,target.series,target.year,Math.round((target.kms||0)/20000)].join('|')}`;
  const cached = await redisGet(ck);
  if (cached?.est) return cached.est;
  if (!GEMINI_API_KEY && !ANTHROPIC_API_KEY) return null;
  const prompt = `Typical USED private-sale price in AUD on Australian Facebook Marketplace for:
${target.year||''} ${target.make||''} ${target.model||''} ${target.series||''} ${target.variant||''}, ${target.kms||'?'} km.
Return ONLY JSON: { "est_aud": number }`;
  try {
    let text = '';
    if (GEMINI_API_KEY) {
      const r = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
        { contents:[{parts:[{text:prompt}]}], generationConfig:{thinkingConfig:{thinkingBudget:0}} },
        { headers:{'Content-Type':'application/json'}, timeout:10000 });
      text = r.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else {
      const r = await axios.post('https://api.anthropic.com/v1/messages',
        { model:'claude-haiku-4-5-20251001', max_tokens:80, messages:[{role:'user',content:prompt}] },
        { headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'}, timeout:10000 });
      text = r.data?.content?.[0]?.text || '';
    }
    const m = text.match(/\{[\s\S]*\}/);
    const est = m ? Math.round(JSON.parse(m[0]).est_aud) : null;
    if (est > 0) { await redisSet(ck, { est }, 14*24*3600); return est; }
  } catch (e) { console.error('[VEst]', e.message); }
  return null;
}


// ── the blend: one value + confidence for the target car ──
async function appraiseVehicleValue(target) {
  // Guard: no km on the target ⇒ we can't slide comps to it. Fall back to AI only,
  // rather than treating the car as 0 km (brand new) and inflating everything.
  if (!target.kms || target.kms <= 0) {
    const aiEst = await aiEstimateVehicle(target);
    return aiEst
      ? { value: aiEst, confidence: 15, source: 'ai_only', poolN: 0, aiEst }
      : { value: null, confidence: 0, source: 'none', poolN: 0 };
  }

  const comps = await getVehicleComps(target);

  // slide every comp to the target km, weight by km-closeness (+ a little recency)
  const adj = comps.map(c => {
    const price = slideToKm(c.price, c.kms, target.kms, target.make);
    const kmW   = 1 / (1 + Math.abs(c.kms - target.kms) / KM_HALF_WEIGHT);   // nearest km wins
    const ageDays = (Date.now() - new Date(c.scraped_at)) / 86400000;
    const recW  = ageDays < 30 ? 1 : ageDays < 90 ? 0.7 : 0.4;
    return { price, w: kmW * recW, kmGap: Math.abs(c.kms - target.kms) };
  });

  // trim outliers (IQR) on the slid prices, then weighted average of survivors
  let poolValue = null, poolN = 0;
  if (adj.length) {
    const sorted = adj.map(a => a.price).sort((x,y)=>x-y);
    const q = p => sorted[Math.floor(p*(sorted.length-1))];
    const lo = q(0.25) - 1.5*(q(0.75)-q(0.25)), hi = q(0.75) + 1.5*(q(0.75)-q(0.25));
    const kept = adj.filter(a => a.price>=lo && a.price<=hi);
    const wsum = kept.reduce((s,a)=>s+a.w,0);
    poolValue = wsum ? Math.round(kept.reduce((s,a)=>s+a.price*a.w,0)/wsum) : null;
    poolN = kept.length;
  }

  const aiEst = await aiEstimateVehicle(target);

  // how much do we trust the real data? full at ENOUGH_COMPS, scaled below it.
  const trust = Math.min(poolN / ENOUGH_COMPS, 1);   // 0..1

  let value, source;
  if (poolN > 0 && aiEst) { value = Math.round(poolValue*trust + aiEst*(1-trust)); source = 'blend'; }
  else if (poolN > 0)     { value = poolValue; source = 'comps_only'; }
  else if (aiEst)         { value = aiEst;     source = 'ai_only'; }
  else                    { return { value:null, confidence:0, source:'none', poolN:0 }; }

  // confidence: real data drives it up; heavy AI reliance and far-km comps drag it down
  const nearestGap = adj.length ? Math.min(...adj.map(a=>a.kmGap)) : Infinity;
  let confidence = Math.round(
    55*trust +                                   // sample sufficiency
    20*(poolN>0 && aiEst ? agreement(poolValue,aiEst) : 0) +  // do comps & AI agree?
    15*(nearestGap < 30000 ? 1 : nearestGap < 80000 ? 0.5 : 0) +  // is a close-km comp available?
    10*(source==='comps_only'?1:source==='blend'?0.6:0)          // pure data > blend > ai-only
  );
  confidence = Math.max(5, Math.min(confidence, 100));

  return { value, confidence, source, poolN, aiEst, poolValue };
}

function agreement(a, b) {
  if (!a || !b) return 0;
  const diff = Math.abs(a-b)/Math.max(a,b);
  return diff<0.07?1 : diff<0.15?0.6 : diff<0.25?0.2 : 0;
}


// ── INTEGRATION ──
// Call appraiseVehicleValue() at appraisal time (where you already detail-fetch the
// description). It replaces "look up one cohort band and hope it has data".
//   const v = await appraiseVehicleValue({ make, model, series, variant, year, kms });
//   // v.value, v.confidence, v.source ('comps_only' | 'blend' | 'ai_only')
// No change to your bulk scan — this only runs when a specific car is being valued.
