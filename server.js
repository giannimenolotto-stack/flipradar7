// ── All AI calls go through your backend — no API keys needed in browser ──
var API_KEY    = ''; // kept for legacy fallback only
var GEMINI_KEY = ''; // kept for legacy fallback only
try { API_KEY    = localStorage.getItem('fr_api_key')    || ''; } catch(e) {}
try { GEMINI_KEY = localStorage.getItem('fr_gemini_key') || ''; } catch(e) {}

// ── Backend AI proxy — calls your Render server which holds the keys ──
function callBackendAI(endpoint, body) {
  var url = getBackendUrl();
  if (!url) return Promise.reject(new Error('No backend URL configured'));
  return fetchWithRetry(url + endpoint, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
    body: JSON.stringify(body)
  }).then(function(r) { return r.json(); }).then(function(data) {
    if (data.error) throw new Error(data.error);
    // Extract JSON from text response
    var text = data.text || '';
    var start = text.indexOf('{');
    var end   = text.lastIndexOf('}');
    if (start !== -1 && end !== -1) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch(e) {}
    }
    var arrStart = text.indexOf('[');
    var arrEnd   = text.lastIndexOf(']');
    if (arrStart !== -1 && arrEnd !== -1) {
      try { return JSON.parse(text.slice(arrStart, arrEnd + 1)); } catch(e) {}
    }
    // Return raw text if no JSON found
    return { _raw: text };
  });
}

// Legacy Gemini direct call — only used if no backend URL set
function callGemini(parts) {
  if (!GEMINI_KEY) return null;
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + GEMINI_KEY;
  return fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: parts }] })
  }).then(function(r) { return r.json(); }).then(function(data) {
    if (data.error) throw new Error(data.error.message || 'Gemini error');
    var text = data.candidates && data.candidates[0] ? (data.candidates[0].content.parts[0].text || '') : '';
    var start = text.indexOf('{'); var end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1) { try { return JSON.parse(text.slice(start, end + 1)); } catch(e) {} }
    throw new Error('Could not read Gemini response');
  });
}

function toGeminiImage(block) {
  return { inline_data: { mime_type: block.source.media_type || 'image/jpeg', data: block.source.data } };
}

var VD = {
  'STEAL':    {e:'🌈',c:'#ffc800',bg:'rgba(255,50,50,0.22)',bo:'rgba(255,50,50,0.6)',g:'rgba(255,80,0,0.15)'},
  'GOOD DEAL':{e:'✅',c:'#00dd55',bg:'rgba(0,221,85,0.22)',bo:'rgba(0,221,85,0.55)',g:'rgba(0,200,70,0.15)'},
  'FAIR':     {e:'⚖️',c:'#ffc800',bg:'rgba(255,200,0,0.20)',bo:'rgba(255,200,0,0.55)',g:'rgba(255,200,0,0.12)'},
  'PASS':     {e:'🚫',c:'#ff4f4f',bg:'rgba(255,60,60,0.22)',bo:'rgba(255,60,60,0.6)',g:'rgba(255,60,60,0.12)'}
};

// Clamp appraisal results for offer/placeholder price listings.
// ROI and profit figures are meaningless when the listed price is fake ($1, $1234, $9999, etc.).
// Verdict forced to 'OFFER PRICE' so VD fallback yields neutral yellow styling.
function normalizeOfferPriceResult(r) {
  r.verdict             = 'MAKE OFFER';
  r.dealScore           = Math.min(r.dealScore || 0, 35);
  r.roiPercent          = 0;
  r.estimatedProfit     = 0;
  if (r.median) {
    r.recommendedOffer = Math.round(r.median * 0.85);
    r.oneLiner = 'Offer $' + r.recommendedOffer.toLocaleString() + ' — that\'s a good deal on this item';
  }
  r.isOfferPriceListing = true;
  return r;
}

// ── Sell Scanner ──────────────────────────────────────────
var _sellPhotoBase64 = null;
var _sellPrices = [];
var _selectedSellPrice = 0;
var _sellListingTitle = '';
var _sellListingDesc = '';

function handleSellPhoto(input) {
  var file = input.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    var dataUrl = e.target.result;
    _sellPhotoBase64 = dataUrl.split(',')[1];
    document.getElementById('sellPreviewImg').src = dataUrl;
    document.getElementById('sellPreview').style.display = 'block';
    document.getElementById('sellUploadArea').style.display = 'none';
    document.getElementById('sellAnalyseBtn').style.display = 'block';
    document.getElementById('sellResults').style.display = 'none';
  };
  reader.readAsDataURL(file);
}

function clearSellPhoto() {
  _sellPhotoBase64 = null;
  var c = document.getElementById('sellPhotoInputCamera');
  var lb = document.getElementById('sellPhotoInputLibrary');
  if (c) c.value = '';
  if (lb) lb.value = '';
  document.getElementById('sellPreview').style.display = 'none';
  document.getElementById('sellUploadArea').style.display = 'block';
  document.getElementById('sellAnalyseBtn').style.display = 'none';
  document.getElementById('sellResults').style.display = 'none';
  document.getElementById('sellLoading').style.display = 'none';
}

function selectSellPrice(idx) {
  _selectedSellPrice = idx;
  var cards = ['sellPrice1','sellPrice2','sellPrice3'];
  cards.forEach(function(id, i) {
    var el = document.getElementById(id);
    if (el) el.style.borderColor = i === idx ? '#00ff88' : 'var(--bd)';
  });
  // Update description with selected price
  if (_sellPrices[idx]) {
    document.getElementById('sellListingTitle').textContent = _sellListingTitle + ' - $' + _sellPrices[idx].price;
  }
}

function copySellListing() {
  var price = _sellPrices[_selectedSellPrice] ? '$' + _sellPrices[_selectedSellPrice].price : '';
  var text = _sellListingTitle + ' - ' + price + '\n\n' + _sellListingDesc;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(function() { toast('📋 Copied to clipboard!'); });
  } else {
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    toast('📋 Copied!');
  }
}

function analyseSellPhoto() {
  if (!_sellPhotoBase64) { toast('Upload a photo first'); return; }
  checkAppraisalLimit().then(function(allowed) { if (allowed) _doAnalyseSellPhoto(); });
}
function _doAnalyseSellPhoto() {
  if (!_sellPhotoBase64) { toast('Upload a photo first'); return; }
  document.getElementById('sellAnalyseBtn').style.display = 'none';
  document.getElementById('sellLoading').style.display = 'block';
  document.getElementById('sellResults').style.display = 'none';

  var userDesc = document.getElementById('sellUserDesc') ? document.getElementById('sellUserDesc').value.trim() : '';
  var prompt = 'You are an expert Australian secondhand market appraiser. Look at this photo and: 1) Identify the exact item (brand, model, year if visible, condition), 2) Suggest 3 REALISTIC sell prices based on actual Australian Facebook Marketplace and Gumtree prices - be conservative and realistic, most secondhand items sell for significantly less than RRP. A quick sale price should be what it would genuinely sell for in 2-3 days. Maximum price is the absolute top of the market for that exact item in that condition. 3) Write a compelling Facebook Marketplace listing description. ' + (userDesc ? 'Additional context from seller: ' + userDesc + '. ' : '') + 'Use web search to check current Australian market prices if possible. Reply ONLY as valid JSON: {"item":"exact item name and year","condition":"condition assessment","prices":[{"label":"Quick Sale","price":number,"timeframe":"1-3 days","reasoning":"why this price"},{"label":"Good Profit","price":number,"timeframe":"1-2 weeks","reasoning":"typical market price"},{"label":"Maximum","price":number,"timeframe":"3-6 weeks","reasoning":"top of market"}],"listingTitle":"short catchy title","listingDescription":"full marketplace description with condition, specs, what is included and pickup/postage details"}';

  // ── Use backend proxy — keys stored on server, not browser ──
  var useBackend = !!getBackendUrl();
  var apiPromise = useBackend
    ? callBackendAI('/ai/image', { parts: [
        { inline_data: { mime_type: 'image/jpeg', data: _sellPhotoBase64 } },
        { text: prompt }
      ]})
    : (GEMINI_KEY
        ? callGemini([
            { inline_data: { mime_type: 'image/jpeg', data: _sellPhotoBase64 } },
            { text: prompt }
          ])
        : fetchWithRetry('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type':'application/json','x-api-key':API_KEY,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true' },
            body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:1500, messages:[{ role:'user', content:[
              { type:'image', source:{ type:'base64', media_type:'image/jpeg', data:_sellPhotoBase64 } },
              { type:'text', text:prompt }
            ]}]})
          }).then(function(r){return r.json();}).then(function(data){
            var text = '';
            if (data.content) data.content.forEach(function(b){ if(b.type==='text') text+=b.text; });
            var m = text.match(/\{[\s\S]*\}/); if(!m) throw new Error('no json');
            return JSON.parse(m[0]);
          }));

  apiPromise
  .then(function(result) {
    document.getElementById('sellLoading').style.display = 'none';
    if (!result) { toast('Could not analyse photo. Try again.'); document.getElementById('sellAnalyseBtn').style.display = 'block'; return; }
    try {
      _sellPrices = result.prices || [];
      _sellListingTitle = result.listingTitle || result.item || '';
      _sellListingDesc = result.listingDescription || '';

      document.getElementById('sellItemName').textContent = result.item || '—';
      document.getElementById('sellItemCondition').textContent = result.condition || '';

      var priceIds = ['P1','P2','P3'];
      var timeIds  = ['T1','T2','T3'];
      _sellPrices.forEach(function(p, i) {
        var pel = document.getElementById('sell' + priceIds[i]);
        var tel = document.getElementById('sell' + timeIds[i]);
        if (pel) pel.textContent = '$' + p.price;
        if (tel) tel.textContent = p.timeframe + (p.reasoning ? ' · ' + p.reasoning : '');
      });

      document.getElementById('sellListingTitle').textContent = _sellListingTitle + ' - $' + (_sellPrices[1] ? _sellPrices[1].price : '');
      document.getElementById('sellListingDesc').textContent = _sellListingDesc;
      document.getElementById('sellResults').style.display = 'block';
      selectSellPrice(1); // default to middle option

      // Save to history so it appears in flip tracker
      var sellEntry = {
        id: Date.now(),
        title: result.item || _sellListingTitle,
        price: _sellPrices[1] ? _sellPrices[1].price : 0,
        image: null,
        url: null,
        date: new Date().toLocaleDateString('en-AU'),
        source: 'sell_scanner',
        result: {
          verdict: 'SELL',
          dealScore: 80,
          extractedTitle: result.item || _sellListingTitle,
          extractedPrice: _sellPrices[1] ? _sellPrices[1].price : 0,
          oneLiner: result.condition || 'Your item — ready to sell',
          buyPrice: null,
          offerPrice: _sellPrices[0] ? _sellPrices[0].price : null,
          negotiationScript: 'Listed at $' + (_sellPrices[1] ? _sellPrices[1].price : '') + '. Quick sale at $' + (_sellPrices[0] ? _sellPrices[0].price : '') + '.',
          estimatedProfit: _sellPrices[2] ? _sellPrices[2].price - (_sellPrices[0] ? _sellPrices[0].price : 0) : 0,
          sellPrices: _sellPrices,
          listingTitle: _sellListingTitle,
          listingDesc: _sellListingDesc
        }
      };
      hist.unshift(sellEntry);
      sv();
      updatePill();
    } catch(e) {
      document.getElementById('sellAnalyseBtn').style.display = 'block';
      toast('Error parsing results. Try again.');
    }
  })
  .catch(function(e) {
    document.getElementById('sellLoading').style.display = 'none';
    document.getElementById('sellAnalyseBtn').style.display = 'block';
    toast('Error: ' + e.message);
  });
}


// ── Manual Flip Logger ────────────────────────────────────
var manualFlips = {};
try { manualFlips = JSON.parse(localStorage.getItem('fr_manual_flips') || '{}'); } catch(e) { manualFlips = {}; }
function saveManualFlips() { try { localStorage.setItem('fr_manual_flips', JSON.stringify(manualFlips)); } catch(e) {} }

function openManualFlip() {
  document.getElementById('mfTitle').value = '';
  document.getElementById('mfBought').value = '';
  document.getElementById('mfSold').value = '';
  document.getElementById('mfNotes').value = '';
  document.getElementById('manualFlipPanel').style.display = 'block';
}

function closeManualFlip() {
  document.getElementById('manualFlipPanel').style.display = 'none';
}

function saveManualFlip() {
  var title  = document.getElementById('mfTitle').value.trim();
  var bought = parseFloat(document.getElementById('mfBought').value);
  var sold   = parseFloat(document.getElementById('mfSold').value) || null;
  var notes  = document.getElementById('mfNotes').value.trim();
  if (!title) { toast('Enter an item name'); return; }
  if (!bought || bought <= 0) { toast('Enter what you paid'); return; }
  var id = 'manual_' + Date.now();
  manualFlips[id] = { id, title, bought, sold, notes, date: new Date().toLocaleDateString('en-AU') };
  saveManualFlips();
  updateFlipStats();
  renderManualFlips();
  closeManualFlip();
  var profit = sold ? ' · +$' + (sold - bought) + ' profit' : '';
  toast('✅ Logged: ' + title + profit);
}

function deleteManualFlip(id) {
  delete manualFlips[id];
  saveManualFlips();
  updateFlipStats();
  renderManualFlips();
}

function renderManualFlips() {
  var existing = document.getElementById('manualFlipList');
  if (!existing) return;
  var items = Object.values(manualFlips).sort(function(a,b) { return b.id.localeCompare(a.id); });
  if (!items.length) { existing.innerHTML = ''; return; }
  existing.onclick = function(ev) { var btn = ev.target.closest('.del-manual-btn'); if (btn) { deleteManualFlip(btn.getAttribute('data-mid')); } };
  existing.innerHTML = items.map(function(f) {
    var profit = f.sold ? f.sold - f.bought : null;
    var profitStr = profit !== null ? '<span style="color:var(--g);font-size:12px">+$' + profit + ' profit</span>' : '<span style="color:var(--mu);font-size:12px">not sold yet</span>';
    return '<div class="hi" style="flex-direction:column;gap:6px">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start">' +
        '<div>' +
          '<div class="hit">' + f.title + '</div>' +
          '<div class="him">Bought $' + f.bought + (f.sold ? ' · Sold $' + f.sold : '') + ' · ' + f.date + '</div>' +
          (f.notes ? '<div style="font-size:11px;color:var(--mu);margin-top:2px">' + f.notes + '</div>' : '') +
        '</div>' +
        profitStr +
      '</div>' +
      '<button data-mid="' + f.id + '" class="del-manual-btn" style="width:100%;padding:7px;background:rgba(255,79,79,.08);border:1px solid rgba(255,79,79,.2);border-radius:8px;color:#ff4f4f;font-size:11px;cursor:pointer">Remove</button>' +
    '</div>';
  }).join('');
}


// ── Flip Tracker ──────────────────────────────────────────
var flips = {};
try { flips = JSON.parse(localStorage.getItem('fr_flips') || '{}'); } catch(e) { flips = {}; }
function saveFlips() { try { localStorage.setItem('fr_flips', JSON.stringify(flips)); } catch(e) {} }

var savedListings = {};
try { savedListings = JSON.parse(localStorage.getItem('fr_saved') || '{}'); } catch(e) { savedListings = {}; }
function saveSavedListings() { try { localStorage.setItem('fr_saved', JSON.stringify(savedListings)); } catch(e) {} }
function toggleSaved(listing) {
  if (savedListings[listing.id]) {
    delete savedListings[listing.id];
    toast('Removed from saved');
  } else {
    savedListings[listing.id] = listing;
    toast('⭐ Saved!');
  }
  saveSavedListings();
  // Refresh feed to update heart icons
  var cached = getCachedListings();
  var ratings = getCachedRatings();
  if (cached.length) renderListingsFeed(cached, ratings);
}
function isSaved(id) { return !!savedListings[id]; }

var _trackingId = null;

function openTrackPanel(id) {
  _trackingId = id;
  var e = null;
  for (var i = 0; i < hist.length; i++) { if (hist[i].id === id) { e = hist[i]; break; } }
  if (!e) return;

  document.getElementById('trackTitle').textContent = e.title;
  document.getElementById('trackItemName').textContent = 'Asking $' + e.price + ' · ' + e.date;

  var flip = flips[id] || {};

  // Status bar
  var statusBar = document.getElementById('trackStatusBar');
  var paidColor = flip.paidPrice ? '#00ff88' : 'var(--mu)';
  var soldColor = flip.soldPrice ? '#00ff88' : 'var(--mu)';
  statusBar.innerHTML =
    '<div style="background:var(--s2);border:1px solid ' + paidColor + ';border-radius:10px;padding:10px;text-align:center">' +
      '<div style="font-size:10px;color:var(--mu);text-transform:uppercase;letter-spacing:1px">Bought</div>' +
      '<div style="font-family:Bebas Neue,sans-serif;font-size:20px;color:' + paidColor + '">' + (flip.paidPrice ? '$' + flip.paidPrice : '—') + '</div>' +
    '</div>' +
    '<div style="background:var(--s2);border:1px solid ' + soldColor + ';border-radius:10px;padding:10px;text-align:center">' +
      '<div style="font-size:10px;color:var(--mu);text-transform:uppercase;letter-spacing:1px">Sold</div>' +
      '<div style="font-family:Bebas Neue,sans-serif;font-size:20px;color:' + soldColor + '">' + (flip.soldPrice ? '$' + flip.soldPrice : '—') + '</div>' +
    '</div>';

  // Reset sections
  document.getElementById('trackBuySection').style.display = 'none';
  document.getElementById('trackSellSection').style.display = 'none';
  document.getElementById('trackSoldDisplay').style.display = 'none';

  if (flip.soldPrice) {
    document.getElementById('trackSoldDisplay').style.display = 'block';
    var profit = flip.soldPrice - flip.paidPrice;
    document.getElementById('trackProfitDisplay').textContent = (profit >= 0 ? '+' : '') + '$' + profit;
    document.getElementById('trackProfitDetail').textContent = 'Bought $' + flip.paidPrice + ' · Sold $' + flip.soldPrice;
  } else if (flip.paidPrice) {
    document.getElementById('trackSellSection').style.display = 'block';
    showSellSuggestions(e, flip.paidPrice);
  } else {
    document.getElementById('trackBuySection').style.display = 'block';
    document.getElementById('trackPaidInput').value = '';
  }

  document.getElementById('trackPanel').style.display = 'block';
}

function closeTrackPanel() {
  document.getElementById('trackPanel').style.display = 'none';
  _trackingId = null;
}

function savePaidPrice() {
  var paid = parseFloat(document.getElementById('trackPaidInput').value);
  if (!paid || paid <= 0) { toast('Enter the price you paid'); return; }
  if (!flips[_trackingId]) flips[_trackingId] = {};
  flips[_trackingId].paidPrice = paid;
  saveFlips();

  // Get the history item for suggestions
  var e = null;
  for (var i = 0; i < hist.length; i++) { if (hist[i].id === _trackingId) { e = hist[i]; break; } }

  document.getElementById('trackBuySection').style.display = 'none';
  document.getElementById('trackSellSection').style.display = 'block';
  // Update status bar
  var sb = document.getElementById('trackStatusBar');
  if (sb) {
    var first = sb.firstChild;
    if (first) { first.style.borderColor = '#00ff88'; first.lastChild.textContent = '$' + paid; first.lastChild.style.color = '#00ff88'; }
  }
  showSellSuggestions(e, paid);
  updateFlipStats();
  renderHist();
  toast('✅ Bought price saved!');
}

function showSellSuggestions(item, paidPrice) {
  var el = document.getElementById('trackSuggestions');
  el.innerHTML = '<div style="font-size:12px;color:var(--mu)">Getting suggestions...</div>';

  var prompt = 'You are an Australian secondhand market expert. Someone bought a "' + item.title + '" for $' + paidPrice + ' AUD. Suggest 3 sell prices with realistic timeframes for the Australian market. Return ONLY valid JSON array: [{"label":"Quick Sale","price":number,"timeframe":"1-3 days","reason":"string"},{"label":"Good Profit","price":number,"timeframe":"1-2 weeks","reason":"string"},{"label":"Maximum","price":number,"timeframe":"3-4 weeks","reason":"string"}]';

  var aiCall = getBackendUrl()
    ? callBackendAI('/ai/text', { prompt: prompt, max_tokens: 400 }).then(function(d) { return d._raw || JSON.stringify(d); })
    : fetchWithRetry('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type':'application/json','x-api-key':API_KEY,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true' },
        body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:400, messages:[{role:'user',content:prompt}] })
      }).then(function(r){return r.json();}).then(function(d){ return d.content && d.content[0] ? d.content[0].text : ''; });

  aiCall.then(function(text) {
    try {
      var match = text.match(/\[[\s\S]*\]/);
      if (!match) throw new Error('no json');
      var suggestions = JSON.parse(match[0]);
      var profit;
      el.innerHTML = suggestions.map(function(s) {
        profit = s.price - paidPrice;
        return '<div onclick="document.getElementById(\'trackSoldInput\').value=' + s.price + '" style="background:var(--s2);border:1px solid var(--bd);border-radius:10px;padding:10px 12px;margin-bottom:8px;cursor:pointer;display:flex;justify-content:space-between;align-items:center">' +
          '<div><div style="font-weight:600;color:#fff;font-size:13px">' + s.label + '</div>' +
          '<div style="font-size:11px;color:var(--mu);margin-top:2px">' + s.timeframe + ' · ' + s.reason + '</div></div>' +
          '<div style="text-align:right">' +
          '<div style="font-family:Bebas Neue,sans-serif;font-size:18px;color:var(--g)">$' + s.price + '</div>' +
          '<div style="font-size:11px;color:var(--g)">+$' + profit + '</div>' +
          '</div></div>';
      }).join('');
    } catch(e) {
      el.innerHTML = '<div style="font-size:12px;color:var(--mu)">Could not get suggestions</div>';
    }
  }).catch(function() {
    el.innerHTML = '<div style="font-size:12px;color:var(--mu)">Could not get suggestions</div>';
  });
}

function markSold() {
  var sold = parseFloat(document.getElementById('trackSoldInput').value);
  if (!sold || sold <= 0) { toast('Enter the price you sold for'); return; }
  if (!flips[_trackingId]) flips[_trackingId] = {};
  flips[_trackingId].soldPrice = sold;
  flips[_trackingId].soldAt = new Date().toISOString();
  saveFlips();

  var profit = sold - (flips[_trackingId].paidPrice || 0);
  document.getElementById('trackSellSection').style.display = 'none';
  document.getElementById('trackSoldDisplay').style.display = 'block';
  document.getElementById('trackProfitDisplay').textContent = (profit >= 0 ? '+' : '') + '$' + profit;
  updateFlipStats();
  renderHist();
  toast('🎉 Flip complete! +$' + profit);
}

function resetFlip() {
  if (!_trackingId) return;
  delete flips[_trackingId];
  saveFlips();
  updateFlipStats();
  renderHist();
  closeTrackPanel();
  toast('Flip reset');
}

function updateFlipStats() {
  var bought = 0, sold = 0, profit = 0;
  // From history flip tracker
  for (var id in flips) {
    if (flips[id].paidPrice) bought++;
    if (flips[id].soldPrice) {
      sold++;
      profit += (flips[id].soldPrice - flips[id].paidPrice);
    }
  }
  // From manual flips
  for (var mid in manualFlips) {
    bought++;
    if (manualFlips[mid].sold) {
      sold++;
      profit += (manualFlips[mid].sold - manualFlips[mid].bought);
    }
  }
  var bEl = document.getElementById('ftBought');
  var sEl = document.getElementById('ftSold');
  var pEl = document.getElementById('ftProfit');
  var pEl2 = document.getElementById('ftProfitDisplay');
  if (bEl) bEl.textContent = bought;
  if (sEl) sEl.textContent = sold;
  if (pEl) pEl.textContent = (profit >= 0 ? '+' : '') + '$' + profit;
  if (pEl2) pEl2.textContent = Math.abs(profit).toLocaleString();
  updatePill();
  renderManualFlips();
}



// ── DEALS SCREEN ────────────────────────────────────────────────────────────
var _dealsPage = 1;
var _dealsTotal = 0;
var _dealsCat = 'all';
var _dealsData = [];

function initDealsScreen() {
  var isPrem = (userPlan === 'premium' || userPlan === 'pro');
  document.getElementById('dealsPremGate').style.display = isPrem ? 'none' : 'block';
  document.getElementById('dealsContent').style.display = isPrem ? 'block' : 'none';
  if (isPrem && _dealsData.length === 0) loadDeals();
}

async function loadDeals(refresh) {
  if (refresh) { _dealsPage = 1; _dealsData = []; _dealsCat = 'all'; }
  var loading = document.getElementById('dealsLoading');
  var empty   = document.getElementById('dealsEmpty');
  var grid    = document.getElementById('dealsGrid');
  var more    = document.getElementById('dealsLoadMore');
  loading.style.display = 'block';
  grid.innerHTML = '';
  empty.style.display = 'none';
  more.style.display = 'none';
  try {
    var res = await fetch('/api/deals?page=' + _dealsPage + '&limit=24', {
      headers: { 'Authorization': 'Bearer ' + authToken }
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    _dealsData = data.deals || [];
    _dealsTotal = data.total || 0;
    loading.style.display = 'none';
    if (_dealsData.length === 0) { empty.style.display = 'block'; return; }
    buildDealsCatChips();
    renderDealsGrid(_dealsCat);
    if (_dealsTotal > _dealsData.length) more.style.display = 'block';
  } catch(e) {
    loading.style.display = 'none';
    empty.style.display = 'block';
    console.error('[Deals]', e.message);
  }
}

async function loadMoreDeals() {
  _dealsPage++;
  var res = await fetch('/api/deals?page=' + _dealsPage + '&limit=24', {
    headers: { 'Authorization': 'Bearer ' + authToken }
  }).then(r => r.json());
  var newDeals = res.deals || [];
  _dealsData = _dealsData.concat(newDeals);
  renderDealsGrid(_dealsCat);
  if (_dealsData.length >= (res.total || 0)) {
    document.getElementById('dealsLoadMore').style.display = 'none';
  }
}

function buildDealsCatChips() {
  var cats = ['all'];
  _dealsData.forEach(function(d) {
    var c = d.category === 'vehicle' ? 'vehicles' : (d.norm_cat || d.category || 'general');
    if (!cats.includes(c)) cats.push(c);
  });
  var labels = { all:'All', vehicle:'Vehicles', vehicles:'Vehicles', power_tool:'Tools',
    phone:'Phones', gaming:'Gaming', computer:'Computers', audio:'Audio',
    vacuum:'Appliances', outdoor:'Outdoor', general:'General' };
  var html = '';
  cats.forEach(function(c) {
    var active = c === _dealsCat;
    html += '<button onclick="filterDeals(&apos;'+c+'&apos;)" style="flex-shrink:0;padding:8px 16px;border-radius:20px;font-size:13px;font-weight:600;cursor:pointer;border:none;transition:all .15s;white-space:nowrap;background:'+(active?'var(--g)':'var(--s1)')+';color:'+(active?'#000':'var(--mu)')+'">'+
      (labels[c] || c.charAt(0).toUpperCase() + c.slice(1)) + '</button>';
  });
  document.getElementById('dealsCatChips').innerHTML = html;
}

function filterDeals(cat) {
  _dealsCat = cat;
  buildDealsCatChips();
  renderDealsGrid(cat);
}

function renderDealsGrid(cat) {
  var grid = document.getElementById('dealsGrid');
  var filtered = cat === 'all' ? _dealsData : _dealsData.filter(function(d) {
    var c = d.category === 'vehicle' ? 'vehicles' : (d.norm_cat || d.category || 'general');
    return c === cat;
  });
  if (filtered.length === 0) {
    grid.innerHTML = '<div style="text-align:center;padding:40px 0;color:var(--mu);font-size:14px">No '+cat+' deals right now</div>';
    return;
  }

  var html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">';
  filtered.forEach(function(d) {
    var disc = parseFloat(d.discount_pct) || 0;
    var isRb = disc >= 35;
    var cardBg = isRb ? '' : disc >= 22 ? 'rgba(0,221,85,0.11)' : disc >= 12 ? 'rgba(255,200,0,0.10)' : 'var(--s1)';
    var tc = disc >= 22 ? '#00dd55' : disc >= 12 ? '#ffc800' : 'var(--mu)';
    var badge = disc >= 35 ? 'GREAT DEAL' : disc >= 22 ? 'GOOD DEAL' : disc >= 12 ? 'FAIR' : '';
    var watched = d.match_type === 'watched';
    var imgHtml = d.image_url
      ? '<img src="'+d.image_url+'" style="width:100%;height:100%;object-fit:cover;display:block">'
      : '<div style="width:100%;height:100%;background:var(--s2);display:flex;align-items:center;justify-content:center;font-size:28px">🏷️</div>';

    html += '<div class="'+(isRb?'rainbow-card':'')+'" data-lid="'+d.listing_id+'" onclick="openDealListing(this)" style="background:'+(isRb?'':cardBg)+';border:none;border-radius:14px;overflow:hidden;display:flex;flex-direction:column;cursor:pointer">';
    html += '<div style="width:100%;height:155px;overflow:hidden;flex-shrink:0;position:relative">'+imgHtml;
    if (watched) html += '<div style="position:absolute;top:8px;left:8px;background:rgba(0,255,136,.25);border:1px solid var(--g);border-radius:6px;padding:2px 7px;font-size:10px;font-weight:700;color:var(--g);letter-spacing:.5px">WATCHED</div>';
    html += '<div style="position:absolute;top:8px;right:8px;background:rgba(0,0,0,.6);border-radius:6px;padding:2px 7px;font-size:10px;font-weight:700;color:#fff">'+Math.round(disc)+'% OFF</div>';
    html += '</div>';

    html += '<div class="'+(isRb?'rainbow-card':'')+'" style="padding:10px;flex:1;display:flex;flex-direction:column;background:'+(isRb?'':cardBg)+';">';
    if (badge) html += '<div style="font-size:9px;font-weight:700;color:'+tc+';letter-spacing:.5px;margin-bottom:4px">'+badge+'</div>';
    html += '<div style="font-size:12px;font-weight:700;color:#fff;line-height:1.3;margin-bottom:4px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;">'+escHtml(d.title||'—')+'</div>';
    html += '<div style="font-family:&apos;Bebas Neue&apos;,sans-serif;font-size:20px;color:var(--g);letter-spacing:1px;margin-top:auto">'+(d.price ? '$'+Number(d.price).toLocaleString() : '—')+'</div>';
    if (d.market_value) html += '<div style="font-size:11px;color:var(--mu);text-decoration:line-through">mkt $'+Number(d.market_value).toLocaleString()+'</div>';
    if (d.location) html += '<div style="font-size:10px;color:var(--mu);margin-top:4px;text-transform:uppercase;letter-spacing:.5px">'+escHtml(d.location)+'</div>';
    html += '</div></div>';
  });
  html += '</div>';
  grid.innerHTML = html;
}

function openDealListing(el) {
  var lid = el.getAttribute('data-lid');
  var deal = _dealsData.find(function(d) { return d.listing_id == lid; });
  if (deal && deal.url) window.open(deal.url, '_blank');
}

function escHtml(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Feed state ───────────────────────────────────────────
var _feedItems = [];

// ── History ──────────────────────────────────────────────
var hist = [];
try { hist = JSON.parse(localStorage.getItem('fr5') || '[]'); } catch(e) { hist = []; }
// Update pill on load with real profit
setTimeout(function() { if (typeof updateFlipStats === 'function') updateFlipStats(); }, 100);
function sv() { try { localStorage.setItem('fr5', JSON.stringify(hist.slice(0,100))); } catch(e) {} }

// ── Image state ──────────────────────────────────────────
var imgFiles = [];
var scanMode = 'text'; // 'text' | 'image'

function setMode(m) {
  scanMode = m;
  document.getElementById('mode-text').style.display  = m === 'text'  ? 'block' : 'none';
  document.getElementById('mode-image').style.display = m === 'image' ? 'block' : 'none';
  document.getElementById('mtab-text').classList.toggle('on',  m === 'text');
  document.getElementById('mtab-image').classList.toggle('on', m === 'image');
  // Show img-panel via its own class too
  var ip = document.getElementById('mode-image');
  if (m === 'image') ip.classList.add('on'); else ip.classList.remove('on');
}
setMode('text');

// ── File handling ────────────────────────────────────────
function addFiles(files) {
  var slots = 5 - imgFiles.length;
  var arr = Array.from(files).slice(0, slots);
  imgFiles = imgFiles.concat(arr);
  renderThumbs();
}

function removeImg(i) {
  imgFiles.splice(i, 1);
  renderThumbs();
}

function renderThumbs() {
  var grid = document.getElementById('thumbGrid');
  var zone = document.getElementById('dropZone');
  var tip  = document.getElementById('imgTip');
  var lbl  = document.getElementById('dzLabel');
  var sub  = document.getElementById('dzSub');
  grid.innerHTML = '';

  imgFiles.forEach(function(f, i) {
    var url = URL.createObjectURL(f);
    var wrap = document.createElement('div');
    wrap.className = 'tw';
    var img = document.createElement('img');
    img.src = url;
    var del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.onclick = function(e) { e.stopPropagation(); removeImg(i); };
    wrap.appendChild(img);
    wrap.appendChild(del);
    grid.appendChild(wrap);
  });

  if (imgFiles.length > 0 && imgFiles.length < 5) {
    var addBtn = document.createElement('button');
    addBtn.className = 'add-more';
    addBtn.textContent = '+';
    addBtn.onclick = function(e) { e.stopPropagation(); document.getElementById('imgInput').click(); };
    grid.appendChild(addBtn);
  }

  var hasImgs = imgFiles.length > 0;
  zone.classList.toggle('has-imgs', hasImgs);
  tip.classList.toggle('on', hasImgs);

  if (hasImgs) {
    lbl.textContent = imgFiles.length + ' screenshot' + (imgFiles.length > 1 ? 's' : '') + ' ready';
    sub.textContent = imgFiles.length + '/5 · tap to add more';
  } else {
    lbl.textContent = 'Upload listing screenshots';
    sub.textContent = 'Tap to choose · drag & drop · JPG PNG HEIC · up to 5';
  }
}

// ── Convert file to base64 ───────────────────────────────
function fileToBase64(file) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onload  = function() { resolve(reader.result.split(',')[1]); };
    reader.onerror = function() { reject(new Error('Could not read image')); };
    reader.readAsDataURL(file);
  });
}

function fileToDataUrl(file) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onload = function() { resolve(reader.result); };
    reader.onerror = function() { reject(new Error('Could not read image')); };
    reader.readAsDataURL(file);
  });
}

function compressHistoryImage(file) {
  return fileToDataUrl(file).then(function(dataUrl) {
    return new Promise(function(resolve) {
      var img = new Image();
      img.onload = function() {
        try {
          var max = 700;
          var scale = Math.min(1, max / Math.max(img.width, img.height));
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.72));
        } catch(e) {
          resolve(dataUrl);
        }
      };
      img.onerror = function() { resolve(dataUrl); };
      img.src = dataUrl;
    });
  });
}

function captureHistoryImages(files) {
  return Promise.all(files.map(compressHistoryImage)).catch(function() { return []; });
}

function compressImageForAI(file) {
  return fileToDataUrl(file).then(function(dataUrl) {
    return new Promise(function(resolve) {
      var fallbackType = file.type && file.type.startsWith('image/') ? file.type : 'image/jpeg';
      if (fallbackType === 'image/heic' || fallbackType === 'image/heif') fallbackType = 'image/jpeg';
      function fallback() {
        fileToBase64(file).then(function(b64) {
          resolve({ type: 'image', source: { type: 'base64', media_type: fallbackType, data: b64 } });
        });
      }
      var img = new Image();
      img.onload = function() {
        try {
          var max = 1400;
          var scale = Math.min(1, max / Math.max(img.width, img.height));
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          var ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          var out = canvas.toDataURL('image/jpeg', 0.82);
          resolve({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: out.split(',')[1] } });
        } catch(e) {
          fallback();
        }
      };
      img.onerror = fallback;
      img.src = dataUrl;
    });
  });
}

// ── Navigation ───────────────────────────────────────────
function tab(t) {
  var tabs = ['scan','watch','feed','history','sell','deals','settings'];
  for (var i = 0; i < tabs.length; i++) {
    var x = tabs[i];
    var nav = document.getElementById('n' + x.charAt(0).toUpperCase() + x.slice(1));
    var scr = document.getElementById('scr' + x.charAt(0).toUpperCase() + x.slice(1));
    if (nav) nav.classList.remove('on');
    if (scr) scr.classList.remove('on');
  }
  var selNav = document.getElementById('n' + t.charAt(0).toUpperCase() + t.slice(1));
  var selScr = document.getElementById('scr' + t.charAt(0).toUpperCase() + t.slice(1));
  if (selNav) selNav.classList.add('on');
  if (selScr) selScr.classList.add('on');
  document.getElementById('lw').classList.remove('on');
  document.getElementById('rw').classList.remove('on');
  document.getElementById('main').scrollTop = 0;
  if (t === 'history') { renderHist(); updateFlipStats(); }
  if (t === 'deals') { initDealsScreen(); }
  if (t === 'feed') { renderWatchlistTabs(); refreshListings(); }
  if (t === 'watch') { hideNewWatch(); loadWatchlist(); }
  if (t === 'settings') { loadSettingsInfo(); }
}

function toast(m, d) {
  d = d || 2500;
  var t = document.getElementById('ts');
  t.textContent = m;
  t.classList.add('on');
  setTimeout(function() { t.classList.remove('on'); }, d);
}

function showErr(m) {
  var e = document.getElementById('er');
  e.textContent = m;
  e.classList.add('on');
}
function hideErr() { document.getElementById('er').classList.remove('on'); }

// ── Scan trigger ─────────────────────────────────────────
function go() {
  window._appraisalContext = null; // clear any context left from a prior feed appraisal
  hideErr();

  // Validate
  if (scanMode === 'text') {
    var txt = document.getElementById('box').value.trim();
    if (txt.length < 15) { showErr('⚠️ Paste the full listing — title, price and description.'); return; }
  } else {
    if (imgFiles.length === 0) { showErr('⚠️ Upload at least one listing screenshot.'); return; }
  }

  // Show loading
  document.getElementById('scrScan').classList.remove('on');
  document.getElementById('rw').classList.remove('on');
  document.getElementById('lw').classList.add('on');
  document.getElementById('main').scrollTop = 0;

  var ps = ['p1','p2','p3','p4'];
  for (var i = 0; i < ps.length; i++) document.getElementById(ps[i]).className = 'stp';
  document.getElementById('p1').classList.add('ac');
  var si = 0;
  var stepTimer = setInterval(function() {
    if (si < ps.length - 1) {
      document.getElementById(ps[si]).className = 'stp dn';
      si++;
      document.getElementById(ps[si]).classList.add('ac');
    }
  }, 900);

  var historyImagesPromise = scanMode === 'image' ? captureHistoryImages(imgFiles.slice(0, 5)) : Promise.resolve([]);
  var apiPromise = scanMode === 'image' ? callAI_image() : callAI_text(document.getElementById('box').value.trim());

  apiPromise.then(function(r) {
    return historyImagesPromise.then(function(historyImages) {
      clearInterval(stepTimer);
      for (var i = 0; i < ps.length; i++) document.getElementById(ps[i]).className = 'stp dn';
      var entry = { id: Date.now(), title: r.extractedTitle || 'Unknown', price: r.extractedPrice || 0, image: historyImages[0] || null, images: historyImages, result: r, date: new Date().toLocaleDateString('en-AU') };
      hist.unshift(entry);
      sv();
      updatePill();
      setTimeout(function() {
        render(r);
        document.getElementById('lw').classList.remove('on');
        document.getElementById('rw').classList.add('on');
        document.getElementById('main').scrollTop = 0;
        var _bb = document.getElementById('rwBackBar');
        if (_bb) _bb.style.display = window._appraiseFromFeed ? 'block' : 'none';
        // Add listing image + FB link to result screen
        var existingHeader = document.getElementById('listingHeader');
        if (existingHeader) existingHeader.remove();
        var rw = document.getElementById('rw');
        if (rw && (window._currentListingImage || window._currentListingUrl)) {
          var header = document.createElement('div');
          header.id = 'listingHeader';
          header.style = 'margin-bottom:16px;border-radius:14px;overflow:hidden;border:1px solid var(--bd)';
          var inner = '';
          if (window._currentListingImage) {
            inner += '<div style="width:100%;height:260px;position:relative;overflow:hidden"><img src="' + window._currentListingImage + '" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:blur(16px) brightness(0.45);transform:scale(1.1)"><img src="' + window._currentListingImage + '" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain"></div>';
          }
          if (window._currentListingUrl) {
            inner += '<a href="' + window._currentListingUrl + '" target="_blank" style="display:block;padding:12px;background:rgba(0,255,136,.12);border-top:1px solid rgba(0,255,136,.2);color:var(--g);text-align:center;font-weight:700;font-size:14px;text-decoration:none">&#x1F517; View on Facebook Marketplace</a>';
          }
          header.innerHTML = inner;
          rw.insertBefore(header, rw.firstChild);
        }
      }, 400);
    });
  }).catch(function(e) {
    clearInterval(stepTimer);
    document.getElementById('lw').classList.remove('on');
    document.getElementById('scrScan').classList.add('on');
    showErr('❌ Error: ' + e.message);
  });
}

// ── AI call — text mode (proxied through backend) ───────
function callAI_text(txt, keyword) {
  var url = getBackendUrl();
  var prompt = 'You are an expert Australian Facebook Marketplace flipper. Give a sharp appraisal based on Australian resale market pricing. For vehicles, mileage/odometer is critical. If the item is broken, "for parts", "not working", "as-is", or needs significant repair, set isBrokenOrProject true and estimate repairEstimate in AUD — subtract it from estimatedProfit and cap the verdict at FAIR unless margins after full repairs are exceptional.\n\nLISTING:\n"""\n' + txt + '\n"""\n\nReturn ONLY valid JSON:\n{"extractedTitle":string,"extractedPrice":number,"extractedMileage":number or null,"verdict":"STEAL" or "GOOD DEAL" or "FAIR" or "PASS","dealScore":number 0-100,"roiPercent":number,"estimatedMarketValue":number,"estimatedResellLow":number,"estimatedResellHigh":number,"recommendedOffer":number,"walkAwayPrice":number,"estimatedProfit":number,"timeToSell":string,"demandLevel":string,"oneLiner":string,"whyItsWorth":string,"greenFlags":["string"],"redFlags":["string"],"whatToCheckInPerson":["string"],"negotiationScript":string,"isBrokenOrProject":false,"repairEstimate":0}';

  if (url) {
    var ctx = window._appraisalContext || null;
    var imagePayload = ctx
      ? (ctx.imageB64 ? { imageB64: ctx.imageB64, mediaType: ctx.mediaType } : {})
      : { imageUrl: window._currentListingImage || null };
    return callBackendAI('/ai/text-image', Object.assign({ prompt: prompt }, imagePayload))
      .then(function(r) {
        if (!r || typeof r !== 'object' || !r.verdict) {
          console.error('[Appraise] Bad response from AI:', JSON.stringify(r).slice(0, 200));
          throw new Error('Could not read the scan result. Try again.');
        }
        return r;
      });
  }

  var imgUrl = window._currentListingImage || null;

  function doAppraise(base64data, mediaType) {
    var msgContent;
    if (base64data) {
      msgContent = [
        { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: base64data } },
        { type: 'text', text: prompt }
      ];
    } else {
      msgContent = prompt;
    }
    return fetchWithRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        messages: [{ role: 'user', content: msgContent }]
      })
    }).then(parseAPIResponse);
  }

  if (imgUrl) {
    var backendUrl = getBackendUrl();
    if (backendUrl) {
      return fetch(backendUrl + '/proxy-image?url=' + encodeURIComponent(imgUrl))
        .then(function(r) { return r.json(); })
        .then(function(d) { return doAppraise(d.base64, d.mediaType); })
        .catch(function() { return doAppraise(null, null); });
    }
  }
  return doAppraise(null, null);
}

// ── AI call — image mode (proxied through backend) ───────
function callAI_image() {
  var extraText = (document.getElementById('imgExtra').value || '').trim();

  return Promise.all(imgFiles.map(compressImageForAI)).then(function(imageBlocks) {
    var textPrompt = 'You are an expert Australian Facebook Marketplace flipper.\n\nAnalyse the listing screenshot(s) provided. Read ALL visible text carefully — title, asking price, condition, location, description, seller notes. For vehicles, look carefully for odometer/mileage/km readings — they are critical to the valuation. If the item is broken, "for parts", "not working", "as-is", or needs significant repair, set isBrokenOrProject true and estimate repairEstimate in AUD — subtract it from estimatedProfit and cap the verdict at FAIR unless margins after full repairs are exceptional.\n' +
      (extraText ? '\nExtra context:\n"""\n' + extraText + '\n"""\n' : '') +
      '\nRespond with ONLY a raw JSON object. No explanation. No markdown. No code fences. Start your response with { and end with }.\n\n' +
      '{"extractedTitle":string,"extractedPrice":number,"extractedMileage":number or null,"verdict":"STEAL" or "GOOD DEAL" or "FAIR" or "PASS","dealScore":number 0-100,"roiPercent":number,"estimatedMarketValue":number,"estimatedResellLow":number,"estimatedResellHigh":number,"recommendedOffer":number,"walkAwayPrice":number,"estimatedProfit":number,"timeToSell":string,"demandLevel":string,"oneLiner":string,"whyItsWorth":string,"greenFlags":["string"],"redFlags":["string"],"whatToCheckInPerson":["string"],"negotiationScript":string,"isBrokenOrProject":false,"repairEstimate":0}';

    // ── Backend proxy path (preferred — keys on server) ───
    if (getBackendUrl()) {
      var geminiParts = imageBlocks.map(toGeminiImage).concat([{ text: textPrompt }]);
      return callBackendAI('/ai/image', { parts: geminiParts });
    }

    // ── Legacy: Gemini direct ─────────────────────────────
    if (GEMINI_KEY) {
      var parts = imageBlocks.map(toGeminiImage).concat([{ text: textPrompt }]);
      return callGemini(parts);
    }

    // ── Legacy: Anthropic direct ──────────────────────────
    var content = imageBlocks.concat([{ type: 'text', text: textPrompt }]);
    return fetchWithRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json','x-api-key':API_KEY,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true' },
      body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:1400, messages:[{ role:'user', content:content }] })
    }).then(parseAPIResponse);
  });
}

// ── Retry helper — handles 529 overload + 500/503 with backoff ──
function fetchWithRetry(url, options, maxRetries) {
  maxRetries = maxRetries || 3;
  var attempt = 0;

  function tryFetch() {
    attempt++;
    return fetch(url, options).then(function(res) {
      if ((res.status === 529 || res.status === 503 || res.status === 500) && attempt < maxRetries) {
        var delay = attempt * 5000;
        return new Promise(function(resolve) {
          setTimeout(function() { resolve(tryFetch()); }, delay);
        });
      }
      return res;
    }).catch(function(err) {
      if (attempt < maxRetries) {
        var delay = attempt * 3000;
        return new Promise(function(resolve) {
          setTimeout(function() { resolve(tryFetch()); }, delay);
        });
      }
      throw err;
    });
  }

  return tryFetch();
}

function parseAPIResponse(res) {
  if (!res.ok) {
    return res.json().then(function(d) {
      var msg = d.error ? d.error.message : 'API error ' + res.status;
      if (res.status === 529) msg = 'The AI service is busy right now. FlipRadar retried a few times, so wait about 30 seconds and scan again.';
      if (res.status === 500 || res.status === 503) msg = 'The AI service is temporarily unavailable. Wait a moment and scan again.';
      throw new Error(msg);
    }).catch(function(e) { throw e; });
  }
  return res.json().then(function(d) {
    var raw = '';
    for (var i = 0; i < d.content.length; i++) {
      if (d.content[i].type === 'text') { raw = d.content[i].text; break; }
    }
    // Robustly extract JSON — find first { and last }
    var start = raw.indexOf('{');
    var end   = raw.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON found in response. Try adding text in the extra field.');
    raw = raw.slice(start, end + 1);
    try {
      return JSON.parse(raw);
    } catch(e) {
      throw new Error('Could not read the scan result. Try adding listing text in the extra field.');
    }
  });
}


// ── Render results ───────────────────────────────────────
function render(r) {
  var v = VD[r.verdict] || VD['FAIR'];
  if (r.isOfferPriceListing) v = {e:'🤝',c:'var(--mu)',bg:'rgba(150,150,150,0.12)',bo:'rgba(150,150,150,0.28)',g:'rgba(150,150,150,0.08)'}; // offer price always grey
  if (r.isBrokenOrProject) v = VD['FAIR'];   // broken/project items never get rainbow/green
  // Confidence-based border cap: don't show rainbow/green when data quality is too weak
  var hasMarketAnchor = r.confidence != null && r.confidence > 0;
  if (r.aiGenerated && !hasMarketAnchor) {
    // Pure AI guess with no market data anchor — cap positive verdicts to neutral yellow
    if (r.verdict === 'STEAL' || r.verdict === 'GOOD DEAL') v = VD['FAIR'];
  } else if (r.confidence != null && r.confidence < 0.45 && r.verdict === 'STEAL') {
    // Explicit low confidence — downgrade STEAL one level
    v = VD['GOOD DEAL'];
  }
  var el = document.getElementById('vc');
  el.style.cssText = '--vc:' + v.c + ';--vg:' + v.g + ';background:' + v.bg + ';border:1px solid ' + v.bo;
  document.getElementById('rE').textContent = v.e;
  document.getElementById('rL').textContent = r.isOfferPriceListing ? 'MAKE OFFER' : (r.verdict || '—');
  var priceEl = document.getElementById('rPrice');
  if (priceEl) priceEl.textContent = r.extractedPrice ? '$' + r.extractedPrice.toLocaleString() : '';
  document.getElementById('rT').textContent = r.extractedTitle || '';
  document.getElementById('rO').textContent = r.oneLiner || '';
  setTimeout(function() {
    document.getElementById('sf').style.width = (r.dealScore || 0) + '%';
    document.getElementById('sn').textContent = (r.dealScore || 0) + '/100';
  }, 200);
  document.getElementById('rOf').textContent = '$' + (r.recommendedOffer || 0);
  document.getElementById('rWa').textContent = '$' + (r.walkAwayPrice || 0);
  document.getElementById('rRs').textContent = '$' + (r.estimatedResellLow || 0) + '–$' + (r.estimatedResellHigh || 0);
  var p = r.estimatedProfit || 0;
  document.getElementById('rPr').textContent = (p >= 0 ? '+' : '') + '$' + p;
  document.getElementById('rPr').style.color = p >= 0 ? 'var(--g)' : 'var(--red)';
  document.getElementById('rRoi').textContent = (r.roiPercent || 0) + '% ROI';
  document.getElementById('rTm').textContent = r.timeToSell || '—';
  document.getElementById('rDm').textContent = r.demandLevel || '—';
  var miCard = document.getElementById('rMiCard');
  var miEl = document.getElementById('rMi');
  if (r.extractedMileage) {
    miEl.textContent = r.extractedMileage.toLocaleString() + ' km';
    miEl.style.color = r.extractedMileage < 80000 ? 'var(--g)' : r.extractedMileage < 150000 ? 'var(--gold)' : 'var(--red)';
    miCard.style.display = 'block';
  } else {
    miCard.style.display = 'none';
  }
  // ── Market Intelligence block ─────────────────────────
  var ebayEl = document.getElementById('rEbayStats');
  if (ebayEl) {
    var mLow = r.low || r.marketLow, mMed = r.median || r.marketMedian, mHi = r.high || r.marketHigh;
    if (mLow && mMed && mHi) {
      document.getElementById('rEbayLow').textContent    = '$' + mLow.toLocaleString();
      document.getElementById('rEbayMedian').textContent = '$' + mMed.toLocaleString();
      document.getElementById('rEbayHigh').textContent   = '$' + mHi.toLocaleString();
      var dpLabel = '';
      if (r.dataPoints) {
        var unitWord = (r.source === 'vpx' || r.source === 'csales') ? ' comparable' + (r.dataPoints !== 1 ? 's' : '') : ' sold';
        dpLabel = '· ' + r.dataPoints + unitWord;
      }
      document.getElementById('rEbayCount').textContent = dpLabel;
      var srcEl = document.getElementById('rEbaySource');
      if (r.sourceLabel) {
        srcEl.textContent = r.sourceLabel;
      } else if (r.source === 'own_history') {
        srcEl.textContent = '📈 FlipRadar price history';
      } else if (r.source === 'autograb') {
        srcEl.textContent = '🚗 RedBook valuation (AutoGrab)';
      } else if (r.source === 'vpx') {
        srcEl.textContent = '📊 FlipRadar AU vehicle index';
      } else if (r.source === 'csales') {
        srcEl.textContent = '🏷️ Carsales AU market data';
      } else {
        srcEl.textContent = '📦 Sold listings';
      }
      var confWrap = document.getElementById('rConfWrap');
      if (confWrap && r.confidence) {
        var confPct = Math.round(r.confidence * 100);
        var confBar = document.getElementById('rConfBar');
        confBar.style.width = confPct + '%';
        confBar.style.background = confPct >= 75 ? '#00ff88' : confPct >= 50 ? 'var(--gold)' : '#ff6b6b';
        document.getElementById('rConfPct').textContent = confPct + '%';
        confWrap.style.display = 'flex';
      } else if (confWrap) {
        confWrap.style.display = 'none';
      }
      ebayEl.style.display = 'block';
    } else {
      ebayEl.style.display = 'none';
    }
  }
  var gr = r.greenFlags || [];
  document.getElementById('rGr').innerHTML = gr.length ? gr.map(function(f) { return '<div class="fi"><span style="color:var(--g);flex-shrink:0">▸</span>' + f + '</div>'; }).join('') : '<div class="fi" style="color:var(--mu)"><span>▸</span>None found</div>';
  var rd = r.redFlags || [];
  if (r.isBrokenOrProject && r.repairEstimate > 0) {
    rd = ['⚠️ Broken/project item — est. repair cost $' + r.repairEstimate.toLocaleString() + (r.repairNotes ? ' · ' + r.repairNotes : '')].concat(rd);
  }
  document.getElementById('rRd').innerHTML = rd.length ? rd.map(function(f) { return '<div class="fi"><span style="color:var(--red);flex-shrink:0">▸</span>' + f + '</div>'; }).join('') : '<div class="fi" style="color:var(--mu)"><span>▸</span>None found</div>';
  var ch = r.whatToCheckInPerson || [];
  document.getElementById('rCh').innerHTML = ch.map(function(c, i) { return '<div class="ci"><div class="cn">' + (i+1) + '</div><div class="ct">' + c + '</div></div>'; }).join('');
  document.getElementById('rWy').textContent = r.whyItsWorth || '';
  document.getElementById('ngs').dataset.s = r.negotiationScript || '';
  document.getElementById('ngsTxt').textContent = '"' + (r.negotiationScript || '') + '"';
}

function cpNeg() {
  var s = document.getElementById('ngs').dataset.s;
  if (!s) return;
  navigator.clipboard.writeText(s).catch(function(){});
  document.getElementById('cfl').classList.add('on');
  setTimeout(function() { document.getElementById('cfl').classList.remove('on'); }, 1800);
}

function goNew() {
  document.getElementById('rw').classList.remove('on');
  document.getElementById('box').value = '';
  document.getElementById('chc').textContent = '0';
  document.getElementById('imgExtra').value = '';
  imgFiles = [];
  renderThumbs();
  hideErr();
  tab('scan');
}

var _histFilter = 'all';
function filterHistory(f) {
  _histFilter = f;
  renderHist();
  // Highlight active filter
  var cards = document.querySelectorAll('.ps .psi, #scrHistory [onclick^="filterHistory"]');
  cards.forEach(function(c) { c.style.borderColor = 'var(--bd)'; });
}

function renderHist() {
  document.getElementById('psT').textContent = hist.length;
  var seenSteals = {};
  var stealCount = 0;
  hist.forEach(function(h) {
    if (h.result && h.result.verdict === 'STEAL') {
      var k = (h.title || '').toLowerCase().trim();
      if (!seenSteals[k]) { seenSteals[k] = true; stealCount++; }
    }
  });
  document.getElementById('psS').textContent = stealCount;
  // Real profit from tracked flips
  var realProfit = 0;
  for (var fid in flips) { if (flips[fid].soldPrice && flips[fid].paidPrice) realProfit += flips[fid].soldPrice - flips[fid].paidPrice; }
  var psP = document.getElementById('psP'); if (psP) psP.textContent = '$' + Math.max(0, realProfit);
  // Filter history
  var filtered = hist;
  // Update saved count
  var savedCount = Object.keys(savedListings).length;
  var psSaved = document.getElementById('psSaved');
  if (psSaved) psSaved.textContent = savedCount;

  if (_histFilter === 'steals') {
    var seen = {};
    filtered = hist.filter(function(h) {
      if (!(h.result && h.result.verdict === 'STEAL')) return false;
      var key = (h.title || '').toLowerCase().trim();
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }
  if (_histFilter === 'saved') {
    // Show saved listings from feed as cards
    var l = document.getElementById('hl');
    var savedItems = Object.values(savedListings);
    if (!savedItems.length) {
      l.innerHTML = '<div class="he"><span class="big">⭐</span>No saved listings yet.<br>Hit the ⭐ on any Feed card to save it.</div>';
    } else {
      l.innerHTML = savedItems.map(function(sl) {
        var priceStr = sl.isOfferPrice ? 'Make Offer' : (sl.price ? '$' + sl.price.toLocaleString() : 'Price unknown');
        var imgHtml = sl.image ? '<img src="' + sl.image + '" style="width:44px;height:44px;object-fit:cover;border-radius:8px;flex-shrink:0;border:1px solid var(--bd)">' : '<div style="width:44px;height:44px;border-radius:8px;background:var(--s2);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0">🏷️</div>';
        return '<div class="hi" style="gap:10px;align-items:center">' +
          imgHtml +
          '<div style="flex:1;min-width:0">' +
            '<div class="hit" style="white-space:normal;line-height:1.3">' + sl.title + '</div>' +
            '<div class="him">' + priceStr + (sl.location ? ' · ' + sl.location : '') + '</div>' +
          '</div>' +
          '<div style="display:flex;flex-direction:column;gap:5px;flex-shrink:0">' +
            '<a href="' + (sl.url||'#') + '" target="_blank" style="padding:5px 10px;background:rgba(255,255,255,.07);border:1px solid var(--bd);border-radius:8px;color:#fff;font-size:11px;text-decoration:none;text-align:center">🔗 View</a>' +
            '<button data-sid="' + sl.id + '" class="unsave-btn" style="padding:5px 10px;background:rgba(255,200,0,.1);border:1px solid rgba(255,200,0,.3);border-radius:8px;color:#ffc800;font-size:11px;cursor:pointer">✕ Remove</button>' +
          '</div>' +
        '</div>';
      }).join('');
      l.onclick = function(ev) {
        var btn = ev.target.closest('.unsave-btn');
        if (btn) {
          var sid = btn.getAttribute('data-sid');
          delete savedListings[sid];
          saveSavedListings();
          renderHist();
        }
      };
    }
    return;
  }
  else if (_histFilter === 'flips') filtered = hist.filter(function(h) { return flips[h.id] && flips[h.id].soldPrice; });
  else if (_histFilter === 'bought') filtered = hist.filter(function(h) { return flips[h.id] && flips[h.id].paidPrice; });
  else if (_histFilter === 'sold') filtered = hist.filter(function(h) { return flips[h.id] && flips[h.id].soldPrice; });
  var l = document.getElementById('hl');
  // Build manual flip cards for relevant filters BEFORE checking if filtered is empty
  var mHtml = '';
  if (_histFilter !== 'steals' && _histFilter !== 'all') {
    var mItems = Object.values(manualFlips).sort(function(a,b) { return b.id.localeCompare(a.id); });
    if (_histFilter === 'sold' || _histFilter === 'flips') mItems = mItems.filter(function(f){ return f.sold; });
    if (_histFilter === 'bought') mItems = mItems.filter(function(f){ return f.bought; });
    mHtml = mItems.map(function(f) {
      var profit = f.sold ? f.sold - f.bought : null;
      var badge = f.sold ? '<span style="font-size:10px;background:rgba(0,255,136,.15);border:1px solid rgba(0,255,136,.3);border-radius:6px;padding:2px 6px;color:var(--g);margin-left:6px">SOLD</span>' : '<span style="font-size:10px;background:rgba(255,200,0,.15);border:1px solid rgba(255,200,0,.3);border-radius:6px;padding:2px 6px;color:#ffc800;margin-left:6px">BOUGHT</span>';
      return '<div class="hi" style="flex-direction:column;gap:6px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center">' +
          '<div><div class="hit">' + f.title + badge + '</div><div class="him">Bought $' + f.bought + (f.sold ? ' · Sold $' + f.sold : '') + ' · ' + f.date + '</div>' + (f.notes ? '<div style="font-size:11px;color:var(--mu)">' + f.notes + '</div>' : '') + '</div>' +
          (profit !== null ? '<span style="color:var(--g);font-size:13px;font-weight:700">+$' + profit + '</span>' : '<span style="color:var(--mu);font-size:12px">not sold</span>') +
        '</div>' +
        '<button data-mid="' + f.id + '" class="del-manual-btn2" style="width:100%;padding:7px;background:rgba(255,79,79,.08);border:1px solid rgba(255,79,79,.2);border-radius:8px;color:#ff4f4f;font-size:11px;cursor:pointer">Remove</button>' +
      '</div>';
    }).join('');
  }

  if (!filtered.length && !mHtml) { l.innerHTML = '<div class="he"><span class="big">📭</span>' + (_histFilter === 'all' ? 'No deals scanned yet.' : 'No items in this filter.') + '</div>'; return; }
  l.innerHTML = filtered.map(function(e) {
    var v = VD[e.result && e.result.verdict] || VD['FAIR'];
    var p = 0; // real profit shown in flip tracker only
    var flip = flips[e.id] || {};
    var flipBadge = '';
    if (flip.soldPrice) {
      var fp = flip.soldPrice - flip.paidPrice;
      flipBadge = '<span style="font-size:10px;background:rgba(0,255,136,.15);border:1px solid rgba(0,255,136,.3);border-radius:6px;padding:2px 6px;color:var(--g);margin-left:6px">SOLD +$' + fp + '</span>';
    } else if (flip.paidPrice) {
      flipBadge = '<span style="font-size:10px;background:rgba(255,200,0,.15);border:1px solid rgba(255,200,0,.3);border-radius:6px;padding:2px 6px;color:#ffc800;margin-left:6px">BOUGHT</span>';
    }
    var imgHtml = e.image
      ? '<img src="' + e.image + '" style="width:44px;height:44px;object-fit:cover;border-radius:8px;flex-shrink:0;border:1px solid var(--bd)">'
      : '<div class="hie">' + v.e + '</div>';
    return '<div class="hi" style="flex-direction:column;gap:8px"><div style="display:flex;align-items:center;gap:8px;width:100%" onclick="openMod(' + e.id + ')">' + imgHtml + '<div class="hib"><div class="hit">' + e.title + flipBadge + '</div><div class="him">$' + e.price + ' asking · ' + e.date + '</div></div><div class="hir"><div class="hiv" style="color:' + v.c + '">' + (e.result && e.result.verdict || '—') + '</div></div><span style="color:var(--mu);font-size:18px;margin-left:4px">›</span></div>' +
      '<button onclick="event.stopPropagation();openTrackPanel(' + e.id + ')" style="width:100%;padding:8px;background:rgba(0,255,136,.1);border:1px solid rgba(0,255,136,.25);border-radius:8px;color:var(--g);font-size:12px;font-weight:600;cursor:pointer">' + (flip.soldPrice ? '✅ View Flip' : flip.paidPrice ? '📈 Track Sale' : '💰 Track Flip') + '</button></div>';
  }).join('') + mHtml;
  if (mHtml) {
    l.onclick = function(ev) { var btn = ev.target.closest('.del-manual-btn2'); if (btn) { deleteManualFlip(btn.getAttribute('data-mid')); } };
  }
}

function updatePill() {
  // Match exactly what ftProfit shows (flips + manual flips)
  var profit = 0;
  for (var id in flips) {
    if (flips[id].soldPrice && flips[id].paidPrice) profit += flips[id].soldPrice - flips[id].paidPrice;
  }
  for (var mid in manualFlips) {
    if (manualFlips[mid].sold) profit += manualFlips[mid].sold - manualFlips[mid].bought;
  }
  var el = document.getElementById('pill');
  if (el) el.textContent = '$' + Math.max(0, profit) + ' profit';
}

function renderHistoryImages(e) {
  var imgs = (e.images && e.images.length) ? e.images : (e.image ? [e.image] : []);
  if (!imgs.length) return '';
  return '<div style="display:grid;grid-template-columns:repeat(' + Math.min(imgs.length, 3) + ',1fr);gap:6px;margin-bottom:14px">' +
    imgs.map(function(src) {
      return '<img src="' + src + '" style="width:100%;height:120px;object-fit:cover;border-radius:10px;border:1px solid var(--bd);background:var(--s2)">';
    }).join('') +
  '</div>';
}
function openMod(id) {
  var e = null;
  for (var i = 0; i < hist.length; i++) { if (hist[i].id === id) { e = hist[i]; break; } }
  if (!e) return;
  var r = e.result;
  var v = VD[r && r.verdict] || VD['FAIR'];
  document.getElementById('mb').innerHTML = '<div style="font-family:\'Bebas Neue\',sans-serif;font-size:20px;letter-spacing:1px;color:#fff;margin-bottom:14px">' + e.title + '</div>' + renderHistoryImages(e) + '<div style="display:flex;align-items:center;gap:12px;background:' + v.bg + ';border:1px solid ' + v.bo + ';border-radius:14px;padding:16px;margin-bottom:14px"><span style="font-size:38px">' + v.e + '</span><div><div style="font-family:\'Bebas Neue\',sans-serif;font-size:34px;color:' + v.c + ';line-height:1">' + (r && r.verdict) + '</div><div style="font-size:12px;color:var(--mu);font-style:italic;margin-top:4px">' + (r && r.oneLiner || '') + '</div></div></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px"><div style="background:var(--s2);border-radius:12px;padding:12px 14px"><div style="font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:var(--mu);margin-bottom:4px">Open With</div><div style="font-family:\'Bebas Neue\',sans-serif;font-size:24px;color:var(--g)">$' + (r && r.recommendedOffer || 0) + '</div></div><div style="background:var(--s2);border-radius:12px;padding:12px 14px"><div style="font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:var(--mu);margin-bottom:4px">Walk Away</div><div style="font-family:\'Bebas Neue\',sans-serif;font-size:24px;color:var(--gold)">$' + (r && r.walkAwayPrice || 0) + '</div></div><div style="background:var(--s2);border-radius:12px;padding:12px 14px"><div style="font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:var(--mu);margin-bottom:4px">Flip For</div><div style="font-family:\'Bebas Neue\',sans-serif;font-size:20px;color:var(--tx)">$' + (r && r.estimatedResellLow || 0) + '–$' + (r && r.estimatedResellHigh || 0) + '</div></div><div style="background:var(--s2);border-radius:12px;padding:12px 14px"><div style="font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:var(--mu);margin-bottom:4px">Est. Profit</div><div style="font-family:\'Bebas Neue\',sans-serif;font-size:24px;color:var(--g)">+$' + (r && r.estimatedProfit || 0) + '</div></div></div><div style="background:rgba(0,255,136,.05);border-left:3px solid var(--g);border-radius:0 10px 10px 0;padding:12px 14px;font-size:13px;color:#a0ffcc;line-height:1.6;cursor:pointer" onclick="navigator.clipboard.writeText(\'' + ((r && r.negotiationScript || '').replace(/'/g,"\\'")) + '\');toast(\'✅ Copied!\')">"' + (r && r.negotiationScript || '') + '"</div><div style="font-size:11px;color:var(--mu);text-align:center;margin-top:10px">Scanned ' + e.date + ' · Tap script to copy</div>';
  document.getElementById('mo').classList.add('on');
}

function clrAll() {
  if (!confirm('Clear all history?')) return;
  hist = []; sv(); renderHist(); updatePill(); toast('🗑️ Cleared');
}

updatePill();

function saveApiKey() {} // legacy — keys now on server
function saveGeminiKey() {} // legacy — keys now on server
function refreshApiKeySettings() {} // legacy
function loadSettingsInfo() {
  // Update plan badge and user info when settings tab opens
  var user = getAuthUser();
  if (!user) return;
  var sname = document.getElementById('settingsUserName');
  var semail = document.getElementById('settingsUserEmail');
  if (sname) sname.textContent = user.name || '—';
  if (semail) semail.textContent = user.email || '—';
}


// ── Watchlist ────────────────────────────────────────────

// ── Auth ─────────────────────────────────────────────────
var _authTab = 'login';
var _authToken = null;
var _authUser  = null;

function getAuthToken() {
  if (_authToken) return _authToken;
  try { _authToken = localStorage.getItem('fr_token'); } catch(e) {}
  return _authToken;
}
function getAuthUser() {
  if (_authUser) return _authUser;
  try { var u = localStorage.getItem('fr_user'); _authUser = u ? JSON.parse(u) : null; } catch(e) {}
  return _authUser;
}
function setAuth(token, user) {
  _authToken = token; _authUser = user;
  try { localStorage.setItem('fr_token', token); localStorage.setItem('fr_user', JSON.stringify(user)); } catch(e) {}
}
function clearAuth() {
  _authToken = null; _authUser = null;
  try { localStorage.removeItem('fr_token'); localStorage.removeItem('fr_user'); } catch(e) {}
}

function authHeaders() {
  var token = getAuthToken();
  return token ? { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token } : { 'Content-Type': 'application/json' };
}

function switchAuthTab(tab) {
  _authTab = tab;
  var isLogin = tab === 'login';
  document.getElementById('authTabLogin').style.background  = isLogin ? '#00ff88' : 'transparent';
  document.getElementById('authTabLogin').style.color       = isLogin ? '#000' : 'var(--mu)';
  document.getElementById('authTabSignup').style.background = isLogin ? 'transparent' : '#00ff88';
  document.getElementById('authTabSignup').style.color      = isLogin ? 'var(--mu)' : '#000';
  document.getElementById('authNameWrap').style.display     = isLogin ? 'none' : 'block';
  document.getElementById('authSubmitBtn').textContent      = isLogin ? 'Log In' : 'Create Account';
  document.getElementById('authError').style.display = 'none';
}

function showAuthError(msg) {
  var el = document.getElementById('authError');
  el.textContent = msg; el.style.display = 'block';
}

function submitAuth() {
  var url = getBackendUrl();
  var email    = (document.getElementById('authEmail').value || '').trim();
  var password = (document.getElementById('authPassword').value || '').trim();
  var name     = (document.getElementById('authName') ? document.getElementById('authName').value.trim() : '');
  if (!email || !password) { showAuthError('Please enter your email and password.'); return; }
  var loadingEl = document.getElementById('authLoading');
  var btnEl     = document.getElementById('authSubmitBtn');
  loadingEl.textContent = 'Connecting… (may take ~15s if server is waking up)';
  loadingEl.style.display = 'block';
  btnEl.style.opacity = '0.5';
  btnEl.disabled = true;
  document.getElementById('authError').style.display = 'none';
  var endpoint = _authTab === 'login' ? '/auth/login' : '/auth/signup';
  var body = { email: email, password: password };
  if (_authTab === 'signup' && name) body.name = name;

  // First wake the server, then auth — handles Render cold-start
  function doAuth() {
    return fetch(url + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function(r) {
        return r.text().then(function(txt) {
          var d;
          try { d = JSON.parse(txt); } catch(e) { throw new Error('Server returned unexpected response. Make sure the latest server.js is deployed.'); }
          return { ok: r.ok, data: d };
        });
      });
  }

  doAuth()
    .then(function(res) {
      loadingEl.style.display = 'none';
      btnEl.style.opacity = '1';
      btnEl.disabled = false;
      if (!res.ok) { showAuthError(res.data.error || 'Something went wrong.'); return; }
      setAuth(res.data.token, res.data.user);
      onAuthReady();
      // Show verify screen for new signups
      if (_authTab === 'signup' && res.data.user && !res.data.user.emailVerified) {
        setTimeout(function() { showVerifyScreen(); }, 300);
      } else {
        document.getElementById('authModal').style.display = 'none';
      }
    })
    .catch(function(e) {
      loadingEl.style.display = 'none';
      btnEl.style.opacity = '1';
      btnEl.disabled = false;
      var msg = e && e.message ? e.message : 'Unknown error';
      showAuthError(msg.indexOf('unexpected response') !== -1
        ? msg
        : 'Could not reach server. Make sure the updated server.js is deployed on Render. (' + msg + ')');
    });
}

function logOut() {
  clearAuth();
  updateUserUI(null);
  document.getElementById('authEmail').value = '';
  document.getElementById('authPassword').value = '';
  document.getElementById('authModal').style.display = 'flex';
}

function updateUserUI(user) {
  var initial = user ? (user.name || user.email || '?')[0].toUpperCase() : '?';
  var av = document.getElementById('userAvatar');
  var sav = document.getElementById('settingsAvatar');
  var sname = document.getElementById('settingsUserName');
  var semail = document.getElementById('settingsUserEmail');
  if (av) av.textContent = initial;
  if (sav) sav.textContent = initial;
  if (sname) sname.textContent = user ? (user.name || 'Account') : '—';
  if (semail) semail.textContent = user ? user.email : '—';
  // Update plan badge in settings
  var plan = user ? (user.plan || 'free') : 'free';
  var planLabels = { free: 'Free', basic: 'Basic', premium: 'Premium ⭐' };
  var planEl = document.getElementById('settingsPlanName');
  if (planEl) planEl.textContent = planLabels[plan] || 'Free';
  // Show manage subscription button only for paying users
  var manageBtn = document.getElementById('manageSubBtn');
  if (manageBtn) manageBtn.style.display = (plan !== 'free') ? 'block' : 'none';
  // Change upgrade button text if already on a plan
  var upgradeBtn = document.querySelector('#settingsPlanBadge button');
  if (upgradeBtn) upgradeBtn.textContent = plan === 'free' ? 'Upgrade ↑' : 'Change Plan';
}

function pingServer() {
  var url = getBackendUrl();
  var token = getAuthToken();
  if (!url || !token) return;
  fetch(url + '/auth/ping', { method: 'POST', headers: authHeaders() })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.resumed && d.resumed > 0) {
        toast('▶️ ' + d.resumed + ' watch(es) resumed');
        loadWatchlist();
      }
    })
    .catch(function() {});
}


// ── Email verification ────────────────────────────────────
function showVerifyScreen() {
  document.getElementById('authModal').style.display = 'flex';
  document.getElementById('authVerifyScreen').style.display = 'block';
  // Hide the login/signup form div (first child of modal)
  var formDiv = document.querySelector('#authModal > div:not(#authVerifyScreen)');
  if (formDiv) formDiv.style.display = 'none';
  document.getElementById('verifyCodeInput').focus();
}

function hideVerifyScreen() {
  document.getElementById('authVerifyScreen').style.display = 'none';
  document.getElementById('authModal').style.display = 'none';
  var formDiv = document.querySelector('#authModal > div:not(#authVerifyScreen)');
  if (formDiv) formDiv.style.display = 'block';
}

function skipVerify() {
  hideVerifyScreen();
  toast('You can verify your email anytime in Settings');
}

function submitVerify() {
  var code = (document.getElementById('verifyCodeInput').value || '').trim();
  if (!code || code.length < 6) {
    document.getElementById('verifyError').textContent = 'Enter the 6-digit code from your email.';
    document.getElementById('verifyError').style.display = 'block';
    return;
  }
  var url = getBackendUrl();
  var btn = document.getElementById('verifyBtn');
  btn.textContent = 'Verifying...'; btn.style.opacity = '0.6'; btn.disabled = true;
  document.getElementById('verifyError').style.display = 'none';
  fetch(url + '/auth/verify-email', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ code: code })
  })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    btn.textContent = 'Verify Email'; btn.style.opacity = '1'; btn.disabled = false;
    if (d.error) {
      document.getElementById('verifyError').textContent = d.error;
      document.getElementById('verifyError').style.display = 'block';
      return;
    }
    // Update local user cache
    var user = getAuthUser();
    if (user) { user.emailVerified = true; setAuth(getAuthToken(), user); }
    hideVerifyScreen();
    updateVerifyBanner(true);
    toast('✅ Email verified!');
  })
  .catch(function() {
    btn.textContent = 'Verify Email'; btn.style.opacity = '1'; btn.disabled = false;
    document.getElementById('verifyError').textContent = 'Connection error. Try again.';
    document.getElementById('verifyError').style.display = 'block';
  });
}

function resendVerifyCode() {
  var url = getBackendUrl();
  toast('Sending new code...');
  fetch(url + '/auth/resend-verify', { method: 'POST', headers: authHeaders() })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.ok) toast('✅ New code sent — check your email');
      else toast('Could not resend. Try again.');
    })
    .catch(function() { toast('Connection error. Try again.'); });
}

function updateVerifyBanner(verified) {
  var banner = document.getElementById('settingsVerifyBanner');
  if (banner) banner.style.display = verified ? 'none' : 'block';
}

function onAuthReady() {
  var user = getAuthUser();
  updateUserUI(user);
  updateVerifyBanner(user && user.emailVerified);
  pingServer();
  loadWatchlist();
  refreshListings();
}

// On page load — check for existing token
(function initAuth() {
  var token = getAuthToken();
  var user  = getAuthUser();
  if (token && user) {
    // Validate token with server before proceeding — clears bad/expired tokens
    fetch('https://api.flip-radar.app/auth/me', { headers: { 'Authorization': 'Bearer ' + token } })
      .then(function(r) {
        if (r.ok) {
          return r.json().then(function(freshUser) {
            setAuth(token, freshUser);
            document.getElementById('authModal').style.display = 'none';
            onAuthReady();
            if (!freshUser.emailVerified) {
              setTimeout(function() { updateVerifyBanner(false); }, 500);
            }
          });
        } else {
          // Token invalid — clear and show login
          clearAuth();
          document.getElementById('authModal').style.display = 'flex';
        }
      })
      .catch(function() {
        // Offline — trust local token and proceed
        document.getElementById('authModal').style.display = 'none';
        onAuthReady();
      });
  } else {
    document.getElementById('authModal').style.display = 'flex';
  }
})();

function getBackendUrl() {
  return 'https://api.flip-radar.app';
}
function showWErr(m) {
  var e = document.getElementById('wer');
  if (e) { e.textContent = m; e.style.display = 'block'; } else { toast(m); }
}
function hideWErr() {
  var e = document.getElementById('wer');
  if (e) e.style.display = 'none';
}
function testBackend() {
  var url = getBackendUrl();
  if (!url) { showWErr('Enter your Railway URL first.'); return; }
  toast('Connecting...');
  fetch(url + '/').then(function(r){return r.json();}).then(function(d){
    toast('Connected! ' + d.watchlist + ' keywords active');
    hideWErr(); loadWatchlist();
  }).catch(function(){ showWErr('Could not connect. Check URL and make sure backend is running.'); });
}

var LOCAL_WATCH_KEY = 'fr_watchlist_cache';
function getLocalWatches() {
  try { return JSON.parse(localStorage.getItem(LOCAL_WATCH_KEY) || '[]'); } catch(e) { return []; }
}
function saveLocalWatches(items) {
  try { localStorage.setItem(LOCAL_WATCH_KEY, JSON.stringify((items || []).slice(0, 20))); } catch(e) {}
}
function normaliseWatchlistResponse(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.watchlist)) return data.watchlist;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && data.error) throw new Error(data.error);
  return [];
}
function upsertLocalWatch(item, replaceId) {
  var items = getLocalWatches();
  var id = replaceId || item.id;
  var replaced = false;
  items = items.map(function(w) {
    if (w.id === id || w.keyword === item.keyword) { replaced = true; return item; }
    return w;
  });
  if (!replaced) items.unshift(item);
  saveLocalWatches(items);
}
function removeLocalWatch(id) {
  saveLocalWatches(getLocalWatches().filter(function(w) { return w.id !== id; }));
}
function loadWatchlist() {
  var url = getBackendUrl();
  var cached = getLocalWatches();
  if (cached.length) renderWatchlist(cached);
  if (!url) { if (!cached.length) renderWatchlist([]); return; }
  fetch(url + '/watchlist', { headers: authHeaders() })
    .then(function(r){
      return r.json().then(function(d) {
        if (!r.ok) throw new Error(d && d.error ? d.error : 'Could not load watchlists');
        return d;
      });
    })
    .then(function(data) {
      var items = normaliseWatchlistResponse(data);
      saveLocalWatches(items);
      renderWatchlist(items);
      hideWErr();
    })
    .catch(function(e) {
      if (!cached.length) renderWatchlist([]);
      showWErr('Watchlists saved on this device. Cloud load failed: ' + (e.message || 'connection error'));
    });
}
function renderWatchlist(items) {
  var el = document.getElementById('wList');
  if (!el) return;
  items = Array.isArray(items) ? items : [];
  updatePlanUI(items ? items.length : 0);
  if (!items || !items.length) {
    el.innerHTML = '<div class="he" style="padding:30px 0"><span style="font-size:36px;display:block;margin-bottom:8px">👁️</span>No watchlists yet. Tap + New Watchlist.</div>';
    return;
  }
  el.innerHTML = items.map(function(w) {
    return '<div class="hi" style="justify-content:space-between;align-items:center">' +
      '<div style="display:flex;align-items:center;gap:12px">' +
        '<div style="width:40px;height:40px;background:rgba(0,255,136,.1);border:1px solid rgba(0,255,136,.2);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">🔍</div>' +
        '<div>' +
          '<div class="hit" style="font-size:15px;font-weight:700">' + w.keyword + '</div>' +
          '<div class="him">' + (w.maxPrice ? 'Max $' + w.maxPrice.toLocaleString() : 'Any price') + ' · ' + (w.plan === 'premium' ? 'every 60s' : w.plan === 'basic' ? 'every 15 min' : 'no auto scan') + (w.lastScanned ? ' · last scan ' + formatAgo(w.lastScanned) : '') + '</div>' +
        '</div>' +
      '</div>' +
      '<button onclick="removeWatch(\'' + w.id + '\')" style="background:rgba(255,79,79,.1);border:1px solid rgba(255,79,79,.25);border-radius:8px;color:var(--red);font-size:12px;padding:6px 12px;cursor:pointer;white-space:nowrap">Remove</button>' +
    '</div>';
  }).join('');
}
// ── Watch tab UI ──────────────────────────────────────────
var _selectedSpeed = 'basic';

function showNewWatch(bypassLimit) {
  // Check plan limit before showing form (skip if dev bypass)
  var url = getBackendUrl();
  var openForm = function() {
    document.getElementById('watchMain').style.display = 'none';
    document.getElementById('watchForm').style.display = 'block';
    document.getElementById('main').scrollTop = 0;
  };
  if (bypassLimit) { openForm(); return; }
  var localCount = getLocalWatches().length;
  var limit = Math.max(getPlanLimit(), 1);
  if (url) {
    fetch(url + '/watchlist', { headers: authHeaders() }).then(function(r){return r.json();}).then(function(data){
      var watches = normaliseWatchlistResponse(data);
      var count = watches.length || localCount;
      if (count >= limit) { openPlanModal(); return; }
      openForm();
    }).catch(function(){
      if (localCount >= limit) { openPlanModal(); return; }
      openForm();
    });
  } else {
    if (localCount >= limit) { openPlanModal(); return; }
    openForm();
  }
}

function hideNewWatch() {
  document.getElementById('watchForm').style.display = 'none';
  // Reset vehicle filters
  ['wMinYear','wMaxYear','wMinKms','wMaxKms'].forEach(function(id) {
    var el = document.getElementById(id); if (el) el.value = '';
  });
  _selectedTransmission = 'any';
  selectTransmission('any');
  var body = document.getElementById('vehicleFiltersBody');
  var btn  = document.getElementById('vehicleFiltersToggle');
  if (body) body.style.display = 'none';
  if (btn)  btn.textContent = 'Show ▼';
  document.getElementById('watchMain').style.display = 'block';
  document.getElementById('main').scrollTop = 0;
  // Reset exclude token input
  _excludeTokens = [];
  _currentSuggestions = [];
  _lastSuggestedKeyword = '';
  var sugWrap = document.getElementById('wExcludeSuggestions');
  if (sugWrap) sugWrap.style.display = 'none';
  renderExcludeTokens();
  document.getElementById('wExcludeInput').value = '';
}

// ── Exclude keywords — token input ────────────────────────
var _excludeTokens = [];

function handleExcludeKey(e) {
  if (e.key === 'Enter' || e.key === ',' ) {
    e.preventDefault();
    commitExcludeToken();
  }
}

function handleExcludeInput(e) {
  // Commit on space (but keep cursor in field so user can keep typing)
  var val = e.target.value;
  if (val.endsWith(' ') || val.endsWith(',')) {
    commitExcludeToken();
  }
}

function commitExcludeToken() {
  var inp = document.getElementById('wExcludeInput');
  var word = inp.value.replace(/[,\s]+$/, '').trim().toLowerCase();
  if (word.length < 2) { inp.value = ''; return; }
  if (_excludeTokens.indexOf(word) === -1) {
    _excludeTokens.push(word);
    renderExcludeTokens();
  }
  inp.value = '';
}

function renderExcludeTokens() {
  var el = document.getElementById('wExcludeTokens');
  if (!el) return;
  if (!_excludeTokens.length) { el.innerHTML = ''; el.style.marginBottom = '0'; return; }
  el.style.marginBottom = '8px';
  el.innerHTML = _excludeTokens.map(function(w, i) {
    return '<span style="display:inline-flex;align-items:center;gap:5px;background:rgba(255,79,79,.15);border:1px solid rgba(255,79,79,.4);border-radius:20px;padding:4px 10px 4px 12px;font-size:12px;font-weight:600;color:#ff6b6b">' +
      w +
      '<button onclick="removeExcludeToken(' + i + ')" style="background:none;border:none;color:#ff6b6b;cursor:pointer;font-size:14px;padding:0;line-height:1;opacity:.7">×</button>' +
    '</span>';
  }).join('');
}

function removeExcludeToken(i) {
  _excludeTokens.splice(i, 1);
  renderExcludeTokens();
  renderExcludeSuggestions(); // refresh suggestions to re-show removed ones
}

// ── AI exclude suggestions ────────────────────────────────
var _suggestTimer = null;
var _lastSuggestedKeyword = '';
var _currentSuggestions = [];

// ── Vehicle keyword detection ─────────────────────────────
// Mirrors server-side VEHICLE_KEYWORDS exactly for 100% consistency
var VEHICLE_KEYWORDS_FE = [
  'car','ute','van','truck','motorcycle','suv','4wd','wagon',
  'sedan','hatch','coupe','convertible','tractor','forklift','boat','caravan',
  'camper','excavator','loader','hilux','landcruiser','patrol',
  'ranger','triton','navara','colorado','dmax','bt50','pajero','prado','defender','discovery',
  'transit','sprinter','vito','ducato','daily','commodore','falcon','camry','corolla',
  'civic','accord','mazda','subaru','toyota','ford','holden','honda','nissan','mitsubishi',
  'hyundai','kia','bmw','mercedes','audi','volkswagen','vw','jeep','ram','dodge',
  // model codes and common search terms people type
  'e30','e36','e46','e90','e92','e60','e39','e38',
  'wrx','sti','brz','86','rav4','crv','cx5','cx-5','cx9','cx-9',
  'triton','navara','colorado','dmax','bt-50','bt50',
  'hilux','landcruiser','prado','fortuner','kluger',
  'patrol','pathfinder','xtrail','x-trail','qashqai',
  'lancer','outlander','asx','eclipse',
  'tucson','santa fe','i30','i20','accent',
  'cerato','sportage','sorento','stinger',
  'golf','polo','tiguan','passat','amarok',
  'wrangler','cherokee','compass',
  'mustang','f150','f-150','explorer','escape',
  'camaro','silverado','tahoe',
  'swift','vitara','jimny','baleno',
  'forester','outback','impreza','legacy',
  'yaris','echo','tarago','alphard','estima',
  'pajero','triton','outlander',
  'transit','tourneo','connect',
  'ducato','daily','boxer','relay',
  'sprinter','vito','viano','citan',
  'defender','discovery','freelander','evoque','sport',
  'commodore','colorado','cruze','barina','astra',
  'falcon','territory','ranger','transit',
  '4x4','4wd','awd','diesel','petrol','turbo','tdi','tdci','ute','utes',
  'wagon','hatchback','sedan','coupe','convertible','suv','crossover','people mover'
];

function isVehicleKw(kw) {
  var lower = kw.toLowerCase().trim();
  if (!lower) return false;
  // Direct word/phrase match anywhere in the keyword
  return VEHICLE_KEYWORDS_FE.some(function(v) { return lower.indexOf(v) !== -1; });
}

function detectVehicleKeyword(val) {
  var section = document.getElementById('vehicleFiltersSection');
  if (!section) return;
  var isVehicle = isVehicleKw(val);
  if (isVehicle) {
    section.style.display = 'block';
    // Auto-expand if it was hidden
    var body = document.getElementById('vehicleFiltersBody');
    var btn  = document.getElementById('vehicleFiltersToggle');
    if (body && body.style.display === 'none') {
      body.style.display = 'block';
      if (btn) btn.textContent = 'Hide ▲';
    }
  } else {
    section.style.display = 'none';
    // Collapse and clear vehicle filter values when hidden
    var body = document.getElementById('vehicleFiltersBody');
    var btn  = document.getElementById('vehicleFiltersToggle');
    if (body) body.style.display = 'none';
    if (btn)  btn.textContent = 'Show ▼';
    ['wMinYear','wMaxYear','wMinKms','wMaxKms'].forEach(function(id) {
      var el = document.getElementById(id); if (el) el.value = '';
    });
    _selectedTransmission = 'any';
    if (typeof selectTransmission === 'function') selectTransmission('any');
  }
}

function scheduleExcludeSuggestions() {
  clearTimeout(_suggestTimer);
  var kw = (document.getElementById('wKeyword').value || '').trim();
  if (kw.length < 2) {
    document.getElementById('wExcludeSuggestions').style.display = 'none';
    return;
  }
  if (kw === _lastSuggestedKeyword) return;
  _suggestTimer = setTimeout(function() { fetchExcludeSuggestions(kw); }, 800);
}

function fetchExcludeSuggestions(keyword) {
  var url = getBackendUrl();
  if (!url) return;
  _lastSuggestedKeyword = keyword;
  var chipsEl = document.getElementById('wExcludeSuggestionChips');
  var wrapEl  = document.getElementById('wExcludeSuggestions');
  chipsEl.innerHTML = '<span style="font-size:11px;color:var(--mu)">Thinking…</span>';
  wrapEl.style.display = 'block';

  var prompt = 'You are helping a Facebook Marketplace buyer filter out irrelevant listings for the search keyword: "' + keyword + '".\n' +
    'Return a JSON array of 6-10 short lowercase words or phrases that should be EXCLUDED from results because they indicate:\n' +
    '- Parts listings (not complete items)\n' +
    '- Wrecked/damaged/non-running items\n' +
    '- Wanted/looking-to-buy posts\n' +
    '- Accessories only\n' +
    '- Other clearly irrelevant listings for someone wanting to buy this item to flip\n\n' +
    'Be specific to the keyword. For a car keyword include things like "wrecking", "parts", "engine only", "not running".\n' +
    'For electronics include things like "broken screen", "for parts", "cracked".\n' +
    'Return ONLY a JSON array of strings, nothing else. Example: ["wrecking","parts","damaged","wanted","project"]';

  fetch(url + '/ai/text', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
    body: JSON.stringify({ prompt: prompt, max_tokens: 200 })
  })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    var text = (d.text || '').trim();
    try {
      // Strip any markdown fences just in case
      text = text.replace(/```json|```/g, '').trim();
      var suggestions = JSON.parse(text);
      if (!Array.isArray(suggestions)) throw new Error('not array');
      _currentSuggestions = suggestions.map(function(s) { return String(s).toLowerCase().trim(); }).filter(Boolean);
      renderExcludeSuggestions();
    } catch(e) {
      chipsEl.innerHTML = '';
      wrapEl.style.display = 'none';
    }
  })
  .catch(function() {
    chipsEl.innerHTML = '';
    wrapEl.style.display = 'none';
  });
}

function renderExcludeSuggestions() {
  var chipsEl = document.getElementById('wExcludeSuggestionChips');
  var wrapEl  = document.getElementById('wExcludeSuggestions');
  if (!chipsEl || !_currentSuggestions.length) return;
  // Only show suggestions not already added
  var available = _currentSuggestions.filter(function(s) {
    return _excludeTokens.indexOf(s) === -1;
  });
  if (!available.length) { wrapEl.style.display = 'none'; return; }
  wrapEl.style.display = 'block';
  chipsEl.innerHTML = available.map(function(s) {
    return '<button onclick="addExcludeSuggestion(\'' + s.replace(/'/g, "\\'") + '\')" ' +
      'style="padding:5px 12px;background:rgba(255,200,80,.1);border:1px solid rgba(255,200,80,.3);border-radius:20px;' +
      'color:#ffc850;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap">+ ' + s + '</button>';
  }).join('');
}

function addExcludeSuggestion(word) {
  if (_excludeTokens.indexOf(word) === -1) {
    _excludeTokens.push(word);
    renderExcludeTokens();
  }
  renderExcludeSuggestions(); // removes clicked chip from suggestions
}

// ── Exclude keywords — localStorage ──────────────────────
function saveExcludeWords(watchId, words) {
  try {
    var all = JSON.parse(localStorage.getItem('fr_exclude') || '{}');
    all[watchId] = words;
    localStorage.setItem('fr_exclude', JSON.stringify(all));
  } catch(e) {}
}

function getExcludeWords(watchId) {
  try {
    var all = JSON.parse(localStorage.getItem('fr_exclude') || '{}');
    return all[watchId] || [];
  } catch(e) { return []; }
}

function getAllExcludeWords() {
  try { return JSON.parse(localStorage.getItem('fr_exclude') || '{}'); }
  catch(e) { return {}; }
}

function listingMatchesExclude(listing, excludeWords) {
  if (!excludeWords || !excludeWords.length) return false;
  var haystack = ((listing.title || '') + ' ' + (listing.description || '') + ' ' + (listing.keyword || '')).toLowerCase();
  return excludeWords.some(function(w) { return w && haystack.indexOf(w.toLowerCase()) !== -1; });
}

// Get all exclude words across all watches as a flat merged list (for safety net filtering)
function getAllExcludeWordsList() {
  try {
    var all = JSON.parse(localStorage.getItem('fr_exclude') || '{}');
    var merged = [];
    Object.values(all).forEach(function(words) {
      if (Array.isArray(words)) words.forEach(function(w) { if (merged.indexOf(w) === -1) merged.push(w); });
    });
    return merged;
  } catch(e) { return []; }
}



function selectSpeed(speed) {
  _selectedSpeed = speed;
  var boxes = { basic: document.getElementById('wSpeedBasic'), pro: document.getElementById('wSpeedPro'), premium: document.getElementById('wSpeedPremium') };
  var checks = { basic: document.getElementById('wSpeedBasicCheck'), pro: document.getElementById('wSpeedProCheck'), premium: document.getElementById('wSpeedPremiumCheck') };
  Object.keys(boxes).forEach(function(k) {
    if (!boxes[k]) return;
    var active = k === speed;
    boxes[k].style.border = active ? '2px solid #00ff88' : '1px solid var(--bd)';
    boxes[k].style.background = active ? 'rgba(0,255,136,.08)' : 'transparent';
    checks[k].textContent = active ? '✓' : '○';
    checks[k].style.color = active ? '#00ff88' : 'var(--mu)';
  });
}

var _selectedTransmission = 'any';
function selectTransmission(val) {
  _selectedTransmission = val;
  ['any','auto','manual'].forEach(function(k) {
    var btn = document.getElementById('wTrans' + k.charAt(0).toUpperCase() + k.slice(1));
    if (!btn) return;
    var active = k === val;
    btn.style.border = active ? '2px solid #00ff88' : '1px solid var(--bd)';
    btn.style.background = active ? 'rgba(0,255,136,.08)' : 'var(--s2)';
    btn.style.color = active ? '#fff' : 'var(--mu)';
  });
}

function toggleVehicleFilters() {
  var body = document.getElementById('vehicleFiltersBody');
  var btn  = document.getElementById('vehicleFiltersToggle');
  var open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  btn.textContent = open ? 'Show ▼' : 'Hide ▲';
}

// ── Location presets ──────────────────────────────────────
var _locMode = 'auto50'; // auto50 | auto25 | custom
var _userLat = null;
var _userLng = null;

function setLocationPreset(mode) {
  _locMode = mode;
  var btns = {
    auto50: document.getElementById('locPresetAuto'),
    auto25: document.getElementById('locPreset25'),
    custom: document.getElementById('locPresetCustom')
  };
  var activeStyle = 'padding:7px 12px;border-radius:20px;font-size:12px;font-weight:600;cursor:pointer;border:none;background:#00ff88;color:#000';
  var inactiveStyle = 'padding:7px 12px;border-radius:20px;font-size:12px;font-weight:600;cursor:pointer;border:1px solid var(--bd);background:var(--s2);color:var(--mu)';
  Object.keys(btns).forEach(function(k) { if (btns[k]) btns[k].style.cssText = (k === mode ? activeStyle : inactiveStyle); });

  var customFields = document.getElementById('customLocationFields');
  var statusEl = document.getElementById('locationStatus');

  if (mode === 'custom') {
    if (customFields) customFields.style.display = 'block';
    if (statusEl) statusEl.textContent = 'Enter your location and radius below';
  } else {
    if (customFields) customFields.style.display = 'none';
    var radius = mode === 'auto25' ? 25 : 50;
    if (statusEl) statusEl.textContent = 'Locating you...';
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(function(pos) {
        _userLat = pos.coords.latitude;
        _userLng = pos.coords.longitude;
        if (statusEl) statusEl.textContent = 'Will search within ' + radius + 'km of your location ✓';
      }, function() {
        if (statusEl) statusEl.textContent = 'Could not get location — will use Melbourne as default';
      });
    }
  }
}

function getWatchLocation() {
  if (_locMode === 'custom') {
    return {
      city: document.getElementById('wLocation') ? document.getElementById('wLocation').value.trim() || 'melbourne' : 'melbourne',
      radius: document.getElementById('wRadius') ? parseInt(document.getElementById('wRadius').value) : 50,
      lat: null, lng: null
    };
  }
  var radius = _locMode === 'auto25' ? 25 : 50;
  return { city: null, lat: _userLat, lng: _userLng, radius };
}


function useMyLocation() {
  if (!navigator.geolocation) { toast('Location not supported'); return; }
  toast('Getting location...');
  navigator.geolocation.getCurrentPosition(function(pos) {
    var lat = pos.coords.latitude.toFixed(4);
    var lng = pos.coords.longitude.toFixed(4);
    document.getElementById('wLocation').value = lat + ',' + lng;
    toast('Location set!');
  }, function() { toast('Could not get location'); });
}

 function fillWithAI() {
  var desc = document.getElementById('wAiDesc').value.trim();
  if (!desc) { toast('Describe what you want first'); return; }
  toast('Filling with AI...');
  var prompt = 'Extract watchlist details from this description and return ONLY valid JSON, no markdown: {"name":string,"keyword":string,"minPrice":number or null,"maxPrice":number or null,"aiFilter":string or null}. Description: ' + desc;
  var aiCall = getBackendUrl()
    ? callBackendAI('/ai/text', { prompt: prompt, max_tokens: 300 }).then(function(d) { return d._raw || JSON.stringify(d); })
    : fetchWithRetry('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type':'application/json','x-api-key':API_KEY,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true' },
        body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:300, messages:[{role:'user',content:prompt}] })
      }).then(function(r){return r.json();}).then(function(d){ return d.content && d.content[0] ? d.content[0].text : ''; });
  aiCall.then(function(text) {
    try {
      var match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('No JSON');
      var result = JSON.parse(match[0]);
      if (result.name)     document.getElementById('wName').value = result.name;
      if (result.keyword)  document.getElementById('wKeyword').value = result.keyword;
      if (result.minPrice) document.getElementById('wMinPrice').value = result.minPrice;
      if (result.maxPrice) document.getElementById('wMaxPrice').value = result.maxPrice;
      if (result.aiFilter) document.getElementById('wAiFilter').value = result.aiFilter;
      toast('✅ Filled with AI!');
    } catch(e) { toast('Could not parse AI response'); }
  }).catch(function(){ toast('AI fill failed'); });
}


function devBypassLimit() {
  showNewWatch(true);
}

function addWatch() {
  var url = getBackendUrl();
  var keyword = document.getElementById('wKeyword').value.trim();
  var maxPrice = document.getElementById('wMaxPrice').value.trim();
  if (!keyword) { showWErr('Enter a keyword first.'); return; }
  hideWErr();
  var loc = getWatchLocation();
  var minPrice = document.getElementById('wMinPrice').value.trim();
  var excludeWords = _excludeTokens.slice();
  var localItem = {
    id: 'local_' + Date.now(),
    keyword: keyword,
    maxPrice: maxPrice ? parseInt(maxPrice) : null,
    minPrice: minPrice ? parseInt(minPrice) : null,
    plan: _selectedSpeed,
    location: loc.city || null,
    lat: loc.lat || null,
    lng: loc.lng || null,
    radius: loc.radius || 50,
    localOnly: true,
    createdAt: new Date().toISOString()
  };
  upsertLocalWatch(localItem);
  if (excludeWords.length) saveExcludeWords(localItem.id, excludeWords);
  document.getElementById('wKeyword').value = '';
  document.getElementById('wMinPrice').value = '';
  document.getElementById('wMaxPrice').value = '';
  hideNewWatch();
  renderWatchlist(getLocalWatches());
  toast('✅ Watching: ' + keyword);
  if (!url) {
    showWErr('Saved on this device. Backend URL is unavailable, so cloud scanning is not active.');
    return;
  }
  var minYear = document.getElementById('wMinYear') ? document.getElementById('wMinYear').value.trim() : '';
  var maxYear = document.getElementById('wMaxYear') ? document.getElementById('wMaxYear').value.trim() : '';
  var minKms  = document.getElementById('wMinKms')  ? document.getElementById('wMinKms').value.trim()  : '';
  var maxKms  = document.getElementById('wMaxKms')  ? document.getElementById('wMaxKms').value.trim()  : '';
  fetch(url + '/watchlist', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      keyword:      keyword,
      maxPrice:     maxPrice ? parseInt(maxPrice) : null,
      minPrice:     minPrice ? parseInt(minPrice) : null,
      plan:         _selectedSpeed,
      location:     loc.city || null,
      lat:          loc.lat  || null,
      lng:          loc.lng  || null,
      radius:       loc.radius || 50,
      excludeWords: excludeWords,
      minYear:      minYear ? parseInt(minYear) : null,
      maxYear:      maxYear ? parseInt(maxYear) : null,
      minKms:       minKms  ? parseInt(minKms)  : null,
      maxKms:       maxKms  ? parseInt(maxKms)  : null,
      transmission: (_selectedTransmission && _selectedTransmission !== 'any') ? _selectedTransmission : null,
    })
  })
  .then(function(r) {
    return r.json().then(function(d) {
      if (!r.ok) throw new Error(d && d.error ? d.error : 'Could not save to cloud');
      return d;
    });
  })
  .then(function(newItem) {
    if (newItem && newItem.id) {
      newItem.localOnly = false;
      upsertLocalWatch(newItem, localItem.id);
      if (excludeWords.length) saveExcludeWords(newItem.id, excludeWords);
    }
    loadWatchlist();
    // Poll for listings after adding a watch — initial scan can take 30-60s
    var pollCount = 0;
    var pollInterval = setInterval(function() {
      pollCount++;
      refreshListings();
      if (pollCount >= 6) clearInterval(pollInterval); // stop after 3 mins
    }, 30000); // check every 30s
    // Also do a quick check at 10s in case it was fast
    setTimeout(function() { refreshListings(); }, 10000);
  })
  .catch(function(e) {
    console.error('addWatch sync error:', e);
    if (e.message && e.message.toLowerCase().includes('limit')) {
      showWErr('Plan limit hit on server. Use 🛠 Dev button to bypass.');
      var msg = document.getElementById('planLimitMsg');
      if (msg) msg.style.display = 'block';
    } else {
      showWErr('Saved on this device. Cloud sync failed: ' + (e.message || 'connection error'));
    }
  });
}


// ── Plan limits ───────────────────────────────────────────
// ── Plan modal ────────────────────────────────────────────
var _pendingPlan = null;


// ── Stripe / Plan ─────────────────────────────────────────
var _billing = 'weekly';
var _selectedPlanName = 'premium';
var STRIPE_PK = 'pk_test_51Ta7AzPDjYUYNInH9L5vNseVrlXkIMnpn9n52nVPxvZzkApJ7JWjku4bT4vZXSa3YwZmXn07ZHqSoUYtYLPpucpi00fiVZWY5Q';

var PRICES = {
  basic:   { weekly: { id: 'price_1Ta7LcPDjYUYNInHPy2AMqba', label: '$5.49', per: '/week' },
             monthly: { id: 'price_1Ta7MLPDjYUYNInHYru4vO5M', label: '$13.99', per: '/month' },
             yearly:  { id: 'price_1Ta7MdPDjYUYNInHu5k5kiOU', label: '$89.00', per: '/year' } },
  premium: { weekly: { id: 'price_1Ta7PsPDjYUYNInHMvbMiWvV', label: '$8.99', per: '/week' },
             monthly: { id: 'price_1Ta7QDPDjYUYNInHDQTp70Mt', label: '$27.99', per: '/month' },
             yearly:  { id: 'price_1Ta7QSPDjYUYNInHLG2F4aT3', label: '$199.00', per: '/year' } },
};

function setBilling(period) {
  _billing = period;
  ['Weekly','Monthly','Yearly'].forEach(function(p) {
    var btn = document.getElementById('bill' + p);
    if (!btn) return;
    var active = p.toLowerCase() === period;
    btn.style.background = active ? '#00ff88' : 'transparent';
    btn.style.color = active ? '#000' : 'var(--mu)';
  });
  updatePlanPrices();
}

function updatePlanPrices() {
  var bp = PRICES.basic[_billing];
  var pp = PRICES.premium[_billing];
  var bpEl   = document.getElementById('basicPrice');
  var bperEl = document.getElementById('basicPer');
  var ppEl   = document.getElementById('premiumPrice');
  var pperEl = document.getElementById('premiumPer');
  var bSave  = document.getElementById('basicSaving');
  var pSave  = document.getElementById('premiumSaving');
  if (bpEl)   bpEl.textContent   = bp.label;
  if (bperEl) bperEl.textContent = bp.per;
  if (ppEl)   ppEl.textContent   = pp.label;
  if (pperEl) pperEl.textContent = pp.per;
  var savings = {
    basic:   { weekly: null, monthly: 7.97,  yearly: 78.88 },
    premium: { weekly: null, monthly: 7.97,  yearly: 136.88 },
  };
  var bSavingVal = savings.basic[_billing];
  var pSavingVal = savings.premium[_billing];
  if (bSave) {
    if (bSavingVal) { bSave.textContent = 'Save $' + bSavingVal.toFixed(2) + ' vs weekly'; bSave.style.display = 'block'; }
    else { bSave.style.display = 'none'; }
  }
  if (pSave) {
    if (pSavingVal) { pSave.textContent = 'Save $' + pSavingVal.toFixed(2) + ' vs weekly'; pSave.style.display = 'block'; }
    else { pSave.style.display = 'none'; }
  }
  updateCheckoutBtn();
}

function selectStripePlan(plan) {
  _selectedPlanName = plan;
  var basicCard   = document.getElementById('basicPlanCard');
  var premiumCard = document.getElementById('premiumPlanCard');
  if (basicCard) {
    basicCard.style.borderColor   = plan === 'basic' ? '#00ff88' : 'var(--bd)';
    basicCard.style.background    = plan === 'basic' ? 'rgba(0,255,136,.04)' : 'transparent';
  }
  if (premiumCard) {
    premiumCard.style.borderColor = plan === 'premium' ? '#00ff88' : 'var(--bd)';
    premiumCard.style.background  = plan === 'premium' ? 'rgba(0,255,136,.04)' : 'transparent';
  }
  updateCheckoutBtn();
}

function updateCheckoutBtn() {
  var btn = document.getElementById('planCheckoutBtn');
  if (!btn) return;
  var p = PRICES[_selectedPlanName][_billing];
  btn.textContent = 'Subscribe — ' + p.label + ' ' + p.per + ' →';
}

var _stripeInstance = null;
var _stripeCardElement = null;
var _stripeClientSecret = null;

function showPlanScreen() {
  document.getElementById('cardScreen').style.display = 'none';
  document.getElementById('planScreen') && (document.getElementById('planScreen').style.display = 'block');
  // Show the first child div (plan selection)
  var modal = document.querySelector('#planModal > div > div:first-child');
  if (modal) modal.style.display = 'block';
  var card = document.getElementById('cardScreen');
  if (card) card.style.display = 'none';
}

function goToCheckout() {
  var url = getBackendUrl();
  var priceId = PRICES[_selectedPlanName][_billing].id;
  var p = PRICES[_selectedPlanName][_billing];
  var btn = document.getElementById('planCheckoutBtn');
  if (btn) { btn.textContent = 'Loading...'; btn.disabled = true; }

  // Create payment intent on server
  fetch(url + '/stripe/create-intent', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ priceId: priceId })
  })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    if (btn) { btn.textContent = 'Subscribe — ' + p.label + ' ' + p.per + ' →'; btn.disabled = false; }
    if (!d.clientSecret) { toast('Could not start checkout. Try again.'); return; }
    _stripeClientSecret = d.clientSecret;

    // Show card screen
    var planDiv = document.querySelector('#planModal .plan-screen');
    var cardDiv = document.getElementById('cardScreen');
    // Hide first child, show card screen
    var firstChild = document.querySelector('#planModal > div > div:not(#cardScreen)');
    if (firstChild) firstChild.style.display = 'none';
    if (cardDiv) cardDiv.style.display = 'block';

    // Update summary
    var summaryPlan = document.getElementById('cardSummaryPlan');
    var summaryPrice = document.getElementById('cardSummaryPrice');
    if (summaryPlan) summaryPlan.textContent = _selectedPlanName === 'premium' ? 'Premium ⭐' : 'Basic';
    if (summaryPrice) summaryPrice.textContent = p.label + p.per;

    // Mount Stripe Elements
    if (!_stripeInstance) {
      _stripeInstance = Stripe('pk_test_51Ta7AzPDjYUYNInH9L5vNseVrlXkIMnpn9n52nVPxvZzkApJ7JWjku4bT4vZXSa3YwZmXn07ZHqSoUYtYLPpucpi00fiVZWY5Q');
    }
    var elements = _stripeInstance.elements({ clientSecret: _stripeClientSecret, appearance: {
      theme: 'night',
      variables: { colorPrimary: '#00ff88', colorBackground: '#0d0d18', colorText: '#e4e4f4', colorDanger: '#ff6b6b', fontFamily: 'DM Sans, sans-serif', borderRadius: '10px' }
    }});
    _stripeCardElement = elements.create('payment');
    _stripeCardElement.mount('#card-element');
    _stripeCardElement.on('change', function(e) {
      var errEl = document.getElementById('card-errors');
      if (e.error) { errEl.textContent = e.error.message; errEl.style.display = 'block'; }
      else { errEl.style.display = 'none'; }
    });

    // Apple Pay / Google Pay is disabled in this static build.
    var paymentRequestBtn = document.getElementById('payment-request-btn');
    var paymentRequestDivider = document.getElementById('payment-request-divider');
    if (paymentRequestBtn) paymentRequestBtn.style.display = 'none';
    if (paymentRequestDivider) paymentRequestDivider.style.display = 'none';
  })
  .catch(function(e) {
    if (btn) { btn.disabled = false; updateCheckoutBtn(); }
    toast('Connection error. Try again.');
  });
}

function handlePaymentSuccess() {
  closePlanModal();
  toast('🎉 Payment successful! Upgrading your account...');
  setTimeout(function() {
    fetch(getBackendUrl() + '/auth/me', { headers: authHeaders() })
      .then(function(r) { return r.json(); })
      .then(function(u) { if (u && u.plan) { setAuth(getAuthToken(), u); updateUserUI(u); toast('✅ Welcome to ' + u.plan + '!'); } })
      .catch(function() {});
  }, 3000);
}

function submitPayment() {
  if (!_stripeInstance || !_stripeClientSecret || !_stripeCardElement) { toast('Payment not ready. Try again.'); return; }
  var btn = document.getElementById('payBtn');
  if (btn) { btn.textContent = 'Processing...'; btn.disabled = true; }
  document.getElementById('card-errors').style.display = 'none';

  _stripeInstance.confirmPayment({
    elements: _stripeCardElement._elements || (function() {
      // fallback for payment element
      return undefined;
    })(),
    clientSecret: _stripeClientSecret,
    confirmParams: { return_url: window.location.href },
    redirect: 'if_required'
  }).then(function(result) {
    if (btn) { btn.textContent = 'Pay Now'; btn.disabled = false; }
    if (result.error) {
      var errEl = document.getElementById('card-errors');
      errEl.textContent = result.error.message;
      errEl.style.display = 'block';
    } else if (result.paymentIntent && result.paymentIntent.status === 'succeeded') {
      closePlanModal();
      toast('🎉 Payment successful! Upgrading your account...');
      // Poll for plan upgrade
      setTimeout(function() {
        fetch(getBackendUrl() + '/auth/me', { headers: authHeaders() })
          .then(function(r) { return r.json(); })
          .then(function(u) { if (u && u.plan) { setAuth(getAuthToken(), u); updateUserUI(u); toast('✅ Welcome to ' + u.plan + '!'); } })
          .catch(function() {});
      }, 3000);
    }
  }).catch(function(e) {
    if (btn) { btn.textContent = 'Pay Now'; btn.disabled = false; }
    toast('Payment error. Try again.');
  });
}

function openManageSubscription() {
  var url = getBackendUrl();
  fetch(url + '/stripe/portal', { method: 'POST', headers: authHeaders() })
    .then(function(r) { return r.json(); })
    .then(function(d) { if (d.url) window.location.href = d.url; })
    .catch(function() { toast('Could not open billing portal.'); });
}

// Check if user upgraded after returning from Stripe
(function checkUpgradeReturn() {
  if (window.location.search.includes('upgraded=1')) {
    toast('🎉 Welcome to ' + (_authUser && _authUser.plan ? _authUser.plan : 'Premium') + '!');
    history.replaceState(null, '', window.location.pathname);
    // Refresh user plan from server
    var url = getBackendUrl();
    fetch(url + '/auth/me', { headers: authHeaders() })
      .then(function(r) { return r.json(); })
      .then(function(u) {
        if (u && u.plan) {
          var token = getAuthToken();
          setAuth(token, u);
          updateUserUI(u);
        }
      }).catch(function(){});
  }
})();

// Appraisal rate limiting — check with server before firing
function checkAppraisalLimit() {
  var url = getBackendUrl();
  return fetch(url + '/auth/appraisal', { method: 'POST', headers: authHeaders() })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.error) {
        var user = getAuthUser();
        var plan = user ? user.plan : 'free';
        if (plan === 'free') {
          toast('⚠️ 5 appraisals/day limit reached. Upgrade for more!');
          openPlanModal();
        } else if (plan === 'basic') {
          toast('⚠️ 25 appraisals/day limit reached. Upgrade to Premium for unlimited!');
          openPlanModal();
        }
        return false;
      }
      return true;
    })
    .catch(function() { return true; }); // fail open so appraisal still works offline
}

function closePlanModal() { document.getElementById('planModal').style.display = 'none'; }
function openPlanModal() {
  document.getElementById('planModal').style.display = 'block';
  setBilling('weekly');
  selectStripePlan('premium');
}

var PLAN_LIMITS = { free: 0, basic: 1, premium: 2 };
function getPlanLimit() {
  var user = getAuthUser();
  var plan = user ? (user.plan || 'free') : 'free';
  return PLAN_LIMITS[plan] !== undefined ? PLAN_LIMITS[plan] : 0;
}

function updatePlanUI(watchCount) {
  var user = getAuthUser();
  var plan = user ? (user.plan || 'free') : 'free';
  var limit = Math.max(getPlanLimit(), 1);
  var el;
  el = document.getElementById('planName');   if (el) el.textContent = plan === 'premium' ? 'Premium' : plan === 'basic' ? 'Basic' : 'Free';
  el = document.getElementById('planSlots');  if (el) el.textContent = watchCount + ' / ' + limit + ' watchlist' + (limit > 1 ? 's' : '');
  el = document.getElementById('planIcon');   if (el) el.textContent = plan === 'premium' ? '⭐' : '🔍';
  var atLimit = watchCount >= limit;
  el = document.getElementById('addWatchBtnWrap'); if (el) el.style.display = atLimit ? 'none' : 'block';
  el = document.getElementById('planLimitMsg');    if (el) el.style.display = atLimit ? 'block' : 'none';
}

function removeWatch(id) {
  var url = getBackendUrl();
  removeLocalWatch(id);
  renderWatchlist(getLocalWatches());
  try {
    var all = JSON.parse(localStorage.getItem('fr_exclude') || '{}');
    delete all[id];
    localStorage.setItem('fr_exclude', JSON.stringify(all));
  } catch(e) {}
  toast('Removed');
  if (!url || String(id).indexOf('local_') === 0) return;
  fetch(url + '/watchlist/' + id, { method: 'DELETE', headers: authHeaders() })
    .then(function(r) {
      if (!r.ok) { showWErr('Removed on this device. Cloud remove failed.'); return; }
      loadWatchlist();
    })
    .catch(function() { showWErr('Removed on this device. Cloud remove failed.'); });
}
function manualScan() {
  var url = getBackendUrl();
  if (!url) { showWErr('Backend error. Please try again.'); return; }
  fetch(url + '/scan/now', {method:'POST'}).then(function(){
    toast('Scan triggered! Check Pushover.', 3500);
  }).catch(function(){ showWErr('Could not trigger scan.'); });
}
(function(){
  var saved = localStorage.getItem('fr_backend');
  if (saved) { var inp = document.getElementById('wBackendUrl'); if(inp) inp.value = saved; }
})();


// ── Listings feed ─────────────────────────────────────────
// ── Watchlist feed tabs ───────────────────────────────────
var _activeWatchFilter = 'all';
var _watchlistData = [];

function applyWatchFilter() {
  var cached = getCachedListings();
  var allExclude = getAllExcludeWords();
  // Flat list of ALL exclude words across all watches — safety net so nothing slips through
  var allExcludeFlat = getAllExcludeWordsList();
  var filtered;
  if (_activeWatchFilter === 'all') {
    filtered = cached.filter(function(l) {
      var watch = _watchlistData.find(function(w) { return w.keyword === l.keyword; });
      if (watch && watch.maxPrice && l.price > watch.maxPrice) return false;
      if (watch && watch.minPrice && l.price < watch.minPrice) return false;
      // Use watch-specific exclude words if available, otherwise fall back to all exclude words
      var excludeWords = watch ? (allExclude[watch.id] || []) : allExcludeFlat;
      if (listingMatchesExclude(l, excludeWords)) return false;
      return true;
    });
  } else {
    var watch = _watchlistData.find(function(w) { return w.keyword === _activeWatchFilter; });
    var excludeWords = watch ? (allExclude[watch.id] || []) : allExcludeFlat;
    filtered = cached.filter(function(l) {
      if (l.keyword !== _activeWatchFilter) return false;
      if (watch && watch.maxPrice && l.price > watch.maxPrice) return false;
      if (watch && watch.minPrice && l.price < watch.minPrice) return false;
      if (listingMatchesExclude(l, excludeWords)) return false;
      return true;
    });
  }
  var ratings = getCachedRatings() || {};
  renderListingsFeed(filtered, ratings);
  // Only re-rate items that don't have a rating yet
  var unrated = filtered.filter(function(l) { return !ratings[l.id]; });
  if (unrated.length > 0) autoAppraise(unrated);
}

function renderWatchlistTabs() {
  var el = document.getElementById('watchlistTabs');
  if (!el) return;
  var url = getBackendUrl();
  if (!url) { el.innerHTML = ''; return; }
  fetch(url + '/watchlist', { headers: authHeaders() })
    .then(function(r) { return r.json(); })
    .then(function(watches) {
      if (!watches || !watches.length) { el.innerHTML = ''; return; }
      var tabStyle = function(active) {
        return 'padding:6px 14px;border-radius:20px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;border:none;' +
          (active ? 'background:#00ff88;color:#000;' : 'background:var(--s2);color:var(--mu);border:1px solid var(--bd);');
      };
      var html = '<button class="wtab" data-kw="all" style="' + tabStyle(_activeWatchFilter === 'all') + '">All</button>';
      var seen = {};
      watches.forEach(function(w) {
        var kw = w.keyword;
        if (seen[kw]) return;
        seen[kw] = true;
        var label = w.name || kw;
        html += '<button class="wtab" data-kw="' + kw + '" style="' + tabStyle(_activeWatchFilter === kw) + '">' + label + '</button>';
      });
      el.innerHTML = html;
      // Store watches for price filtering
      _watchlistData = watches;
      el.onclick = function(ev) {
        var btn = ev.target.closest('.wtab');
        if (!btn) return;
        _activeWatchFilter = btn.getAttribute('data-kw');
        renderWatchlistTabs();
        applyWatchFilter();
      };
    })
    .catch(function() { el.innerHTML = ''; });
}


function triggerRefresh() {
  var icon = document.getElementById('refreshIcon');
  var btn = document.getElementById('refreshBtn');
  if (icon) icon.className = 'spinning';
  if (btn) btn.style.opacity = '0.6';
  refreshListings();
}

// ── Active feed keyword filter ────────────────────────────
var _feedFilter = 'all'; // 'all' | keyword string

function renderFilterTabs(items) {
  var el = document.getElementById('feedFilterTabs');
  if (!el) return;
  // Collect unique keywords
  var kws = [];
  items.forEach(function(l) { if (l.keyword && kws.indexOf(l.keyword) === -1) kws.push(l.keyword); });
  if (kws.length <= 1) { el.innerHTML = ''; return; } // Only show tabs if >1 keyword
  var tabStyle = function(active) {
    return 'padding:6px 14px;border-radius:100px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;border:1px solid ' +
      (active ? '#00ff88;background:rgba(0,255,136,.15);color:#00ff88' : 'var(--bd);background:var(--s1);color:var(--mu)');
  };
  var html = '<button onclick="setFeedFilter(\'all\')" style="' + tabStyle(_feedFilter === 'all') + '">All</button>';
  kws.forEach(function(kw) {
    html += '<button data-kw="' + kw + '" class="feed-filter-btn" style="' + tabStyle(_feedFilter === kw) + '">' + kw + '</button>';
  });
  el.innerHTML = html;
}

function setFeedFilter(kw) {
  _feedFilter = kw;
  var cached = getCachedListings();
  var ratings = getCachedRatings();
  renderFilterTabs(cached);
  renderListingsFeed(cached, ratings);
}

function refreshListings() {
  var url = getBackendUrl();
  if (!url) {
    document.getElementById('listingsFeed').innerHTML = '<div style="text-align:center;padding:60px 20px;color:var(--mu)"><div style="font-size:48px;margin-bottom:12px">🔌</div><div>No listings yet. Add a keyword in the Watch tab.</div></div>';
    return;
  }

  var cached = getCachedListings();
  var cachedRatings = getCachedRatings();
  if (cached.length) { renderListingsFeed(cached, cachedRatings || {}); }
  else document.getElementById('listingsFeed').innerHTML = '<div style="text-align:center;padding:60px 20px;color:var(--mu)"><div style="font-size:36px;margin-bottom:12px">⏳</div><div>Loading...</div></div>';

  // Always fetch all listings — don't use ?since= as it can miss listings
  // if the lastFetch time is wrong. Merge on client side instead.
  var fetchUrl = url + '/listings';

  fetch(fetchUrl, { headers: authHeaders() })
    .then(function(r) { return r.json(); })
    .then(function(newItems) {
      var icon = document.getElementById('refreshIcon');
      var btn = document.getElementById('refreshBtn');
      if (icon) icon.className = '';
      if (btn) btn.style.opacity = '1';
      saveLastFetchTime(new Date().toISOString());
      _lastFeedFetch = Date.now();
      updateFeedLastUpdated();

      // Merge: new items at top, existing cached below, deduplicate by id
      var existingCached = getCachedListings();
      var existingIds = {};
      existingCached.forEach(function(l) { existingIds[l.id] = true; });
      var trulyNew = (newItems || []).filter(function(l) { return !existingIds[l.id]; });
      var merged = trulyNew.concat(existingCached);
      if (merged.length > 200) merged = merged.slice(0, 200);

      if (!merged.length) {
        document.getElementById('feedFilterTabs').innerHTML = '';
        document.getElementById('listingsFeed').innerHTML = '<div style="text-align:center;padding:60px 20px;color:var(--mu)"><div style="font-size:48px;margin-bottom:12px">📭</div><div>No listings yet</div><div style="font-size:13px;margin-top:8px">Add a keyword in the Watch tab — it scans every 30 minutes</div></div>';
        return;
      }

      // Mark truly new items so the feed can highlight them
      trulyNew.forEach(function(l) { l._isNew = true; });

      // Prune ratings for IDs no longer in feed
      var mergedIdSet = {};
      merged.forEach(function(l) { mergedIdSet[l.id] = true; });
      var existingRatings = getCachedRatings() || {};
      var prunedRatings = {};
      Object.keys(existingRatings).forEach(function(id) {
        if (mergedIdSet[id]) prunedRatings[id] = existingRatings[id];
      });
      saveCachedRatings(prunedRatings);
      saveCachedListings(merged);
      renderWatchlistTabs();

      var ratings2 = getCachedRatings() || {};
      renderListingsFeed(merged, ratings2);

      // Only appraise items we have not rated yet
      var unrated = trulyNew.filter(function(l) { return !ratings2[l.id]; });
      if (unrated.length > 0) autoAppraise(unrated);

      if (trulyNew.length > 0) toast('✨ ' + trulyNew.length + ' new listing' + (trulyNew.length > 1 ? 's' : '') + ' found');
    })
    .catch(function(err) {
      var icon = document.getElementById('refreshIcon');
      var btn = document.getElementById('refreshBtn');
      if (icon) icon.className = '';
      if (btn) btn.style.opacity = '1';
      if (!cached.length) document.getElementById('listingsFeed').innerHTML = '<div style="text-align:center;padding:60px 20px;color:var(--mu)"><div style="font-size:48px;margin-bottom:12px">❌</div><div>Could not load listings</div></div>';
    });
}

function saveLastFetchTime(iso) { try { localStorage.setItem('fr_last_fetch', iso); } catch(e) {} }
function getLastFetchTime() { try { return localStorage.getItem('fr_last_fetch') || ''; } catch(e) { return ''; } }

// Cache listings in localStorage
function saveCachedListings(items) {
  // Deduplicate by ID before saving
  var seen = {};
  var deduped = items.filter(function(l) {
    if (seen[l.id]) return false;
    seen[l.id] = true;
    return true;
  });
  try { localStorage.setItem('fr_feed', JSON.stringify(deduped)); } catch(e) {}
}
function getCachedListings() {
  try { return JSON.parse(localStorage.getItem('fr_feed') || '[]'); } catch(e) { return []; }
}

// Cache AI ratings in localStorage
function saveCachedRatings(ratingMap) {
  try { localStorage.setItem('fr_ratings', JSON.stringify(ratingMap)); } catch(e) {}
}
function getCachedRatings() {
  try { return JSON.parse(localStorage.getItem('fr_ratings') || 'null'); } catch(e) { return null; }
}

// Auto refresh every 30 mins
var _feedRefreshTimer = null;
var _lastFeedFetch = 0;
var FEED_REFRESH_INTERVAL = 60 * 1000; // check every 60 seconds for new listings

function refreshListingsIfStale() {
  // Always show cached immediately
  var cached = getCachedListings();
  var ratings = getCachedRatings();
  if (cached.length) { renderFilterTabs(cached); renderListingsFeed(cached, ratings); }
  // Always fetch fresh from backend
  refreshListings();
}

function startFeedAutoRefresh() {
  if (_feedRefreshTimer) clearInterval(_feedRefreshTimer);
  _feedRefreshTimer = setInterval(function() {
    refreshListings();
  }, FEED_REFRESH_INTERVAL);
}

function updateFeedLastUpdated() {
  var el = document.getElementById('feedLastUpdated');
  if (!el || !_lastFeedFetch) return;
  var mins = Math.floor((Date.now() - _lastFeedFetch) / 60000);
  el.textContent = mins === 0 ? 'Updated just now' : 'Updated ' + mins + 'm ago';
}
// Tick the "last updated" label every minute
setInterval(updateFeedLastUpdated, 60000);
startFeedAutoRefresh();

// ── Service Worker + Web Push ─────────────────────────────
// Registers SW and subscribes user to push notifications automatically
// No setup needed by the user — just tap Allow when prompted
function initWebPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  var backendUrl = getBackendUrl();
  if (!backendUrl) return;

  // Register service worker
  navigator.serviceWorker.register('/sw.js').then(function(reg) {
    console.log('[SW] Registered');

    // Get VAPID public key from backend
    fetch(backendUrl + '/push/vapid-key').then(function(r) { return r.json(); }).then(function(d) {
      if (!d.publicKey) return;
      var publicKey = d.publicKey;

      // Check current permission
      if (Notification.permission === 'denied') return;

      // Subscribe to push
      var appServerKey = urlBase64ToUint8Array(publicKey);
      return reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: appServerKey
      });
    }).then(function(subscription) {
      if (!subscription) return;
      // Send subscription to backend
      fetch(backendUrl + '/push/subscribe', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ subscription: subscription.toJSON() })
      });
      console.log('[SW] Push subscribed');
    }).catch(function(e) {
      console.log('[SW] Push subscribe error:', e.message);
    });
  }).catch(function(e) {
    console.log('[SW] Registration failed:', e.message);
  });
}

function urlBase64ToUint8Array(base64String) {
  var padding = '='.repeat((4 - base64String.length % 4) % 4);
  var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  var rawData = window.atob(base64);
  var outputArray = new Uint8Array(rawData.length);
  for (var i = 0; i < rawData.length; ++i) { outputArray[i] = rawData.charCodeAt(i); }
  return outputArray;
}

// Init push after login
setTimeout(function() {
  if (getAuthToken()) initWebPush();
}, 2000);


function autoAppraise(items) {
  var BATCH_SIZE = 10;
  var batches = [];
  for (var i = 0; i < items.length; i += BATCH_SIZE) {
    batches.push(items.slice(i, i + BATCH_SIZE));
  }

  function runBatch(batchIndex) {
    if (batchIndex >= batches.length) return;
    var batch = batches[batchIndex];
    var lines = batch.map(function(l, i) {
      var priceStr = l.price ? 'AUD $' + l.price : 'price not listed';
      return i + '. "' + l.title + '" listed for ' + priceStr;
    }).join(' | ');

    var watchKeyword = batch[0] ? (batch[0].keyword || '') : '';

    var prompt = 'You are an Australian secondhand market expert filtering and rating listings for someone searching: "' + watchKeyword + '". Decide if each listing is relevant then rate it. VEHICLES: if searching for a car/ute/van/bike model (e.g. "bmw e36", "hilux", "patrol") then the actual vehicle = relevant:true. Parts, wrecking, manuals, merchandise, toys, models, books about that car = relevant:false. NON-VEHICLES: if searching "electric scooter" then electric/motorised scooters, any brand (Ninebot, Segway etc) = relevant:true. Trick/stunt/push/kids scooters = relevant:false. If searching "golf clubs" then actual clubs, irons, drivers, putters, wedges = relevant:true. Golf balls, shoes, bags alone, books, accessories = relevant:false. For ALL other keywords use common sense — only mark relevant:false if it clearly has nothing to do with what they want. When in doubt: relevant:true. Rate relevant items: Green=30%+ below market, Yellow=fair, Red=overpriced, Rainbow=50%+ below market steal. Reply ONLY as JSON array: [{"idx":0,"rating":"yellow","reason":"Fair price","relevant":true}]. Max 6 words reason. Listings: ' + lines;

    var ratingCall = getBackendUrl()
      ? callBackendAI('/ai/text', { prompt: prompt, max_tokens: 1000 }).then(function(d) { return d._raw || JSON.stringify(d); })
      : fetchWithRetry('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type':'application/json','x-api-key':API_KEY,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true' },
          body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:1000, messages:[{ role:'user', content:prompt }] })
        }).then(function(r){return r.json();}).then(function(data){ return data.content && data.content[0] ? data.content[0].text : ''; });

    ratingCall
    .then(function(text) {
      var match = text.match(/\[[\s\S]*\]/);
      if (!match) return;
      var match = text.match(/\[[\s\S]*\]/);
      if (!match) return;
      try {
        var ratings = JSON.parse(match[0]);
        var ratingMap = getCachedRatings() || {};
        var irrelevantIds = [];

        ratings.forEach(function(r) {
          var listing = batch[r.idx];
          if (!listing || !listing.id) return;
          var reason = (r.reason || '').toLowerCase();
          var REASON_BLOCKS = ['trick scooter','stunt scooter','push scooter','kick scooter',
            'kids scooter','micro scooter','mini scooter','park scooter','pro scooter',
            'toddler scooter','razor scooter','phone case only','charger only',
            'golf balls only','golf ball pack','golf shoes only','golf accessories only'];
          var blockedByReason = REASON_BLOCKS.some(function(w) { return reason.includes(w); });
          var blockedReasonWord = REASON_BLOCKS.find(function(w) { return reason.includes(w); });

          if (r.relevant === false || blockedByReason) {
            irrelevantIds.push(listing.id);
            if (r.relevant === false) {
              console.log('[AutoAppraise] REMOVED (AI relevant:false) —', listing.title, '| reason:', r.reason);
            } else {
              console.log('[AutoAppraise] REMOVED (reason match: "' + blockedReasonWord + '") —', listing.title, '| reason:', r.reason);
            }
          } else {
            console.log('[AutoAppraise] KEPT —', listing.title, '| rating:', r.rating, '| reason:', r.reason);
            ratingMap[listing.id] = r;
          }
        });

        if (irrelevantIds.length > 0) {
          _feedItems = _feedItems.filter(function(l) { return irrelevantIds.indexOf(l.id) === -1; });
          var cached = getCachedListings().filter(function(l) { return irrelevantIds.indexOf(l.id) === -1; });
          saveCachedListings(cached);
          var backendUrl = getBackendUrl();
          if (backendUrl) {
            fetch(backendUrl + '/listings/remove', {
              method: 'POST',
              headers: authHeaders(),
              body: JSON.stringify({ ids: irrelevantIds })
            }).catch(function(){});
          }
        }

        saveCachedRatings(ratingMap);
        renderListingsFeed(_feedItems.length ? _feedItems : batch, ratingMap);
        setTimeout(function() { runBatch(batchIndex + 1); }, 1500);
      } catch(e) { console.log('Rating parse error', e); }
    })
    .catch(function(e) { console.log('Auto-appraise error:', e); });
  }

  runBatch(0);
}

function formatAgo(iso) {
  var diff = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff/60) + 'm ago';
  if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
  return Math.floor(diff/86400) + 'd ago';
}

function renderListingsFeed(items, ratingMap) {
  _feedItems = items;
  var el = document.getElementById('listingsFeed');
  if (!items || !items.length) {
    el.innerHTML = '<div style="text-align:center;padding:60px 20px;color:var(--mu)"><div style="font-size:48px;margin-bottom:12px">&#x1F4EB;</div><div>No listings yet</div><div style="font-size:13px;margin-top:8px">Add keywords in the Watch tab</div></div>';
    return;
  }
  // Apply keyword filter
  var filtered = (_feedFilter && _feedFilter !== 'all')
    ? items.filter(function(l) { return l.keyword === _feedFilter; })
    : items;
  if (!filtered.length) {
    el.innerHTML = '<div style="text-align:center;padding:40px 20px;color:var(--mu)"><div style="font-size:36px;margin-bottom:10px">🔍</div><div>No listings for "' + _feedFilter + '" yet</div></div>';
    return;
  }
  // Final safety net — strip any excluded keywords before rendering
  var _safeExclude = getAllExcludeWordsList();
  if (_safeExclude.length) {
    filtered = filtered.filter(function(l) { return !listingMatchesExclude(l, _safeExclude); });
  }
  // Sort by Facebook listing date, newest first
  filtered = filtered.slice().sort(function(a, b) {
    return new Date(b.listedAt || b.foundAt) - new Date(a.listedAt || a.foundAt);
  });
  // Both vehicle and general listings use 2-col grid
  var isVehicleFeed = filtered.some(function(l) { return l.mileage || l.year || l.make; });
  var html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">';

  for (var i = 0; i < filtered.length; i++) {
    var l = filtered[i];
    var priceStr = l.isOfferPrice ? '<span style="color:var(--mu);font-size:14px;font-style:italic">Make Offer</span>' : (l.price ? '$' + l.price.toLocaleString() : '—');
    var timeAgo = (l.listedAt || l.foundAt) ? formatAgo(l.listedAt || l.foundAt) : '';
    var rating = ratingMap ? (ratingMap[l.id] || null) : null;
    var borderColor = 'var(--bd)';
    var cardBg = 'var(--s1)';
    var badgeHtml = '';
    var isRainbow = false;
    if (rating) {
      if (rating.rating === 'rainbow') {
        isRainbow = true;
        borderColor = 'rgba(255,0,0,0.4)'; cardBg = '';
        badgeHtml = '<div style="font-size:10px;font-weight:700;letter-spacing:.5px;margin-bottom:4px;background:linear-gradient(90deg,#ff0000,#ff8800,#ffff00,#00ff88,#0088ff,#8800ff);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text">&#x1F308; GREAT DEAL · ' + rating.reason + '</div>';
      } else if (rating.rating === 'green') {
        borderColor = 'rgba(0,221,85,0.55)'; cardBg = 'rgba(0,221,85,0.20)';
        badgeHtml = '<div style="font-size:10px;color:#00dd55;font-weight:700;letter-spacing:.5px;margin-bottom:4px">&#x1F7E2; GOOD DEAL · ' + rating.reason + '</div>';
      } else if (rating.rating === 'yellow') {
        borderColor = 'rgba(255,200,0,0.55)'; cardBg = 'rgba(255,200,0,0.18)';
        badgeHtml = '<div style="font-size:10px;color:#ffc800;font-weight:700;letter-spacing:.5px;margin-bottom:4px">&#x1F7E1; FAIR · ' + rating.reason + '</div>';
      } else if (rating.rating === 'red') {
        borderColor = 'rgba(255,60,60,0.55)'; cardBg = 'rgba(255,60,60,0.20)';
        badgeHtml = '<div style="font-size:10px;color:#ff4f4f;font-weight:700;letter-spacing:.5px;margin-bottom:4px">&#x1F534; BAD DEAL · ' + rating.reason + '</div>';
      }
    }

    // Offer price listings: always grey, always "unknown price" — never coloured
    if (l.isOfferPrice) {
      cardBg      = 'rgba(150,150,150,0.09)';
      borderColor = 'rgba(150,150,150,0.22)';
      isRainbow   = false;
      badgeHtml   = '<div style="font-size:10px;color:var(--mu);font-weight:600;letter-spacing:.5px;margin-bottom:4px">⬜ UNKNOWN PRICE · MAKE OFFER</div>';
    }

    var newBadge = l._isNew ? '<div id="new-badge-' + l.id + '" style="position:absolute;top:8px;left:8px;z-index:10;background:#00ff88;color:#000;font-size:9px;font-weight:800;letter-spacing:1px;padding:3px 7px;border-radius:20px">NEW</div>' : '';

    if (isVehicleFeed) {
      // ── Vehicle card: horizontal layout ──
      var imgHtml = l.image
        ? '<div style="width:100%;height:210px;overflow:hidden;flex-shrink:0">' +
            '<img src="' + l.image + '" style="width:100%;height:100%;object-fit:cover;display:block">' +
          '</div>'
        : '<div style="width:100%;height:210px;background:var(--s2);display:flex;align-items:center;justify-content:center;font-size:32px;flex-shrink:0">🚗</div>';

      html += '<div data-id="' + l.id + '" style="position:relative;background:var(--s1);border:none;border-radius:14px;overflow:hidden;display:flex;flex-direction:column">';
      html += newBadge;
      html += '<div class="lnk-img" data-idx="' + i + '" style="cursor:pointer;flex-shrink:0">' + imgHtml + '</div>';
      html += '<div class="' + (isRainbow ? 'rainbow-card' : '') + '" style="padding:8px;flex:1;display:flex;flex-direction:column;min-width:0;background:' + (isRainbow ? '' : cardBg) + ';transition:background 0.4s">';
      html += badgeHtml;
      // Title
      html += '<div style="font-size:12px;font-weight:700;color:#fff;line-height:1.3;margin-bottom:3px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">' + l.title + '</div>';
      // Price
      html += '<div style="font-family:Bebas Neue,sans-serif;font-size:20px;color:var(--g);line-height:1;margin-bottom:3px">' + priceStr + '</div>';
      // Vehicle specs row
      var specs = [];
      if (l.year) specs.push('<span style="color:#fff;font-weight:700">' + l.year + '</span>');
      if (l.make) specs.push('<span style="color:var(--mu)">' + l.make + (l.model ? ' ' + l.model : '') + '</span>');
      if (specs.length) html += '<div style="font-size:11px;margin-bottom:4px">' + specs.join(' · ') + '</div>';
      // Key stats chips
      var chips = '';
      if (l.mileage) chips += '<span style="background:rgba(0,255,136,.12);border:1px solid rgba(0,255,136,.25);border-radius:20px;padding:2px 7px;font-size:10px;color:#00ff88;font-weight:700">🔢 ' + l.mileage.toLocaleString() + 'km</span>';
      if (l.transmission) chips += '<span style="background:rgba(255,255,255,.07);border:1px solid var(--bd);border-radius:20px;padding:2px 7px;font-size:10px;color:var(--mu)">⚙️ ' + l.transmission + '</span>';
      if (l.fuelType) chips += '<span style="background:rgba(255,255,255,.07);border:1px solid var(--bd);border-radius:20px;padding:2px 7px;font-size:10px;color:var(--mu)">⛽ ' + l.fuelType + '</span>';
      if (chips) html += '<div style="display:flex;flex-wrap:wrap;gap:3px;margin-bottom:5px">' + chips + '</div>';
      // Location + time
      html += '<div style="font-size:10px;color:var(--mu);margin-bottom:6px">' + timeAgo + (l.location && typeof l.location === 'string' ? ' · ' + l.location : '') + '</div>';
      // Action buttons
      html += '<div style="display:flex;gap:5px;margin-top:auto">';
      var isSavedItem = isSaved(l.id);
      html += '<button class="save-btn" data-idx="' + i + '" style="flex:1;padding:6px 4px;background:' + (isSavedItem ? 'rgba(255,200,0,.2)' : 'rgba(255,255,255,.07)') + ';border:1px solid ' + (isSavedItem ? 'rgba(255,200,0,.5)' : 'var(--bd)') + ';border-radius:8px;color:' + (isSavedItem ? '#ffc800' : '#fff') + ';font-size:13px;cursor:pointer">' + (isSavedItem ? '⭐' : '☆') + '</button>';
      html += '<button class="lnk-btn" data-url="' + (l.url||'') + '" style="flex:1;padding:6px 4px;background:rgba(255,255,255,.07);border:1px solid var(--bd);border-radius:8px;color:#fff;font-size:11px;cursor:pointer">&#x1F517;</button>';
      html += '<button data-idx="' + i + '" onclick="appraiseIdx(this)" style="flex:2;padding:6px 4px;background:rgba(0,255,136,.12);border:1px solid rgba(0,255,136,.25);border-radius:8px;color:var(--g);font-size:11px;font-weight:700;cursor:pointer">&#x1F916; Appraise</button>';
      html += '</div>';
      html += '</div></div>';

    } else {
      // ── Standard 2-col card ──
      var imgHtml2 = l.image
        ? '<div style="width:100%;height:210px;overflow:hidden;flex-shrink:0">' +
            '<img src="' + l.image + '" style="width:100%;height:100%;object-fit:cover;display:block">' +
          '</div>'
        : '<div style="width:100%;height:210px;background:var(--s2);display:flex;align-items:center;justify-content:center;font-size:32px;flex-shrink:0">🏷️</div>';
      html += '<div data-id="' + l.id + '" style="position:relative;background:var(--s1);border:none;border-radius:12px;overflow:hidden;display:flex;flex-direction:column">';
      html += newBadge;
      html += '<div class="lnk-img" data-idx="' + i + '" style="cursor:pointer;flex-shrink:0">' + imgHtml2 + '</div>';
      html += '<div class="' + (isRainbow ? 'rainbow-card' : '') + '" style="padding:8px;flex:1;display:flex;flex-direction:column;background:' + (isRainbow ? '' : cardBg) + ';transition:background 0.4s">';
      html += badgeHtml;
      html += '<div style="font-size:12px;font-weight:600;color:#fff;line-height:1.3;margin-bottom:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">' + l.title + '</div>';
      html += '<div style="font-family:Bebas Neue,sans-serif;font-size:20px;color:var(--g);line-height:1;margin-bottom:3px">' + priceStr + '</div>';
      html += '<div style="font-size:10px;color:var(--mu);margin-bottom:6px">' + timeAgo + (l.location && typeof l.location === 'string' ? ' · ' + l.location : '') + '</div>';
      html += '<div style="display:flex;gap:5px;margin-top:auto">';
      var isSavedItem2 = isSaved(l.id);
      html += '<button class="save-btn" data-idx="' + i + '" style="flex:1;padding:6px 4px;background:' + (isSavedItem2 ? 'rgba(255,200,0,.2)' : 'rgba(255,255,255,.07)') + ';border:1px solid ' + (isSavedItem2 ? 'rgba(255,200,0,.5)' : 'var(--bd)') + ';border-radius:8px;color:' + (isSavedItem2 ? '#ffc800' : '#fff') + ';font-size:13px;cursor:pointer">' + (isSavedItem2 ? '⭐' : '☆') + '</button>';
      html += '<button class="lnk-btn" data-url="' + (l.url||'') + '" style="flex:1;padding:6px 4px;background:rgba(255,255,255,.07);border:1px solid var(--bd);border-radius:8px;color:#fff;font-size:11px;cursor:pointer">&#x1F517;</button>';
      html += '<button data-idx="' + i + '" onclick="appraiseIdx(this)" style="flex:2;padding:6px 4px;background:rgba(0,255,136,.12);border:1px solid rgba(0,255,136,.25);border-radius:8px;color:var(--g);font-size:11px;font-weight:600;cursor:pointer">&#x1F916; Appraise</button>';
      html += '</div></div></div>';
    }
  }
  html += '</div>';
  el.innerHTML = html;
  el.querySelectorAll('.lnk-img').forEach(function(el) {
    el.addEventListener('click', function() { appraiseIdx(this); });
  });
  el.querySelectorAll('.lnk-btn').forEach(function(btn) {
    btn.addEventListener('click', function() { window.open(this.getAttribute('data-url'), '_blank'); });
  });
  el.querySelectorAll('.save-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var idx = parseInt(this.getAttribute('data-idx'));
      var listing = _feedItems[idx];
      if (listing) toggleSaved(listing);
    });
  });

  // Remove NEW badge 60s after card scrolls into view
  var newTimers = {};
  var observer = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      var id = entry.target.getAttribute('data-id');
      if (!id) return;
      var badge = document.getElementById('new-badge-' + id);
      if (!badge) return;
      if (entry.isIntersecting) {
        if (!newTimers[id]) {
          newTimers[id] = setTimeout(function() {
            if (badge && badge.parentNode) {
              badge.style.transition = 'opacity 0.4s';
              badge.style.opacity = '0';
              setTimeout(function() { if (badge.parentNode) badge.parentNode.removeChild(badge); }, 400);
            }
            delete newTimers[id];
          }, 60000);
        }
      } else {
        // Card scrolled out — cancel timer so clock only runs while visible
        if (newTimers[id]) { clearTimeout(newTimers[id]); delete newTimers[id]; }
      }
    });
  }, { threshold: 0.3 });

  el.querySelectorAll('[data-id]').forEach(function(card) {
    if (document.getElementById('new-badge-' + card.getAttribute('data-id'))) {
      observer.observe(card);
    }
  });
}

function goBackFromAppraise() {
  window._appraiseFromFeed = false;
  document.getElementById('rw').classList.remove('on');
  var backBar = document.getElementById('rwBackBar');
  if (backBar) backBar.style.display = 'none';
  tab('feed');
}

function appraiseListing(listing) {
  window._appraiseFromFeed = true;
  var keyword = listing.keyword || listing.watchKeyword || '';

  var txt = listing.title + '\n';
  if (listing.year)         txt += 'Year: ' + listing.year + '\n';
  if (listing.make)         txt += 'Make: ' + listing.make + '\n';
  if (listing.transmission) txt += 'Transmission: ' + listing.transmission + '\n';
  if (listing.fuelType)     txt += 'Fuel type: ' + listing.fuelType + '\n';
  if (listing.exteriorColor)txt += 'Exterior colour: ' + listing.exteriorColor + '\n';
  if (listing.interiorColor)txt += 'Interior colour: ' + listing.interiorColor + '\n';
  if (listing.bodyStyle)    txt += 'Body style: ' + listing.bodyStyle + '\n';
  if (listing.model)        txt += 'Model: ' + listing.model + '\n';
  if (listing.price && !listing.isOfferPrice) txt += 'Price: $' + listing.price + '\n';
  if (listing.isOfferPrice) txt += 'Price: Not stated — seller is using a placeholder price ($' + listing.price + ') meaning they want offers. Treat the actual price as unknown and focus on what a fair offer would be.\n';
  if (listing.mileage)      txt += 'Odometer: ' + listing.mileage.toLocaleString() + ' km\n';
  if (listing.location)     txt += 'Location: ' + listing.location + '\n';
  if (listing.description)  txt += 'Description: ' + listing.description + '\n';
  txt += 'Facebook Marketplace listing\nURL: ' + listing.url;

  window._appraisalContext    = { imageB64: null, mediaType: null, proxyFailed: false };
  window._currentListingUrl   = listing.url;
  window._currentListingTitle = listing.title;
  window._currentListingImage = listing.image || null;

  tab('scan');
  document.getElementById('scrScan').classList.remove('on');
  document.getElementById('rw').classList.remove('on');
  document.getElementById('lw').classList.add('on');
  document.getElementById('main').scrollTop = 0;

  var ps = ['p1','p2','p3','p4'];
  for (var i = 0; i < ps.length; i++) document.getElementById(ps[i]).className = 'stp';
  document.getElementById('p1').classList.add('ac');
  var si = 0;
  var stepTimer = setInterval(function() {
    if (si < ps.length - 1) {
      document.getElementById(ps[si]).className = 'stp dn';
      si++;
      document.getElementById(ps[si]).classList.add('ac');
    }
  }, 900);

  var backendUrl = getBackendUrl();

  // Proxy listing image immediately — FB CDN URLs expire within hours, so we fetch
  // and cache as base64 now rather than letting the backend try a stale URL later.
  var imageProxyPromise = (listing.image && backendUrl)
    ? fetch(backendUrl + '/proxy-image?url=' + encodeURIComponent(listing.image), { headers: authHeaders() })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (d && d.base64) {
            window._appraisalContext.imageB64  = d.base64;
            window._appraisalContext.mediaType = d.mediaType || 'image/jpeg';
          } else {
            window._appraisalContext.proxyFailed = true;
          }
        })
        .catch(function() { window._appraisalContext.proxyFailed = true; })
    : Promise.resolve();

  // Always go straight to AI — no market data pre-check
  var appraisePromise = Promise.resolve(null);

  // Inline helper — shared by cache-hit and AI paths
  function showResult(r) {
    render(r);
    document.getElementById('lw').classList.remove('on');
    document.getElementById('rw').classList.add('on');
    document.getElementById('main').scrollTop = 0;
    var _bb = document.getElementById('rwBackBar');
    if (_bb) _bb.style.display = 'block';
    var existingHeader = document.getElementById('listingHeader');
    if (existingHeader) existingHeader.remove();
    var rwEl = document.getElementById('rw');
    if (rwEl && (window._currentListingImage || window._currentListingUrl)) {
      var header = document.createElement('div');
      header.id = 'listingHeader';
      header.style = 'margin-bottom:16px;border-radius:14px;overflow:hidden;border:1px solid var(--bd)';
      var inner = '';
      if (window._currentListingImage) {
        inner += '<div style="width:100%;height:260px;position:relative;overflow:hidden"><img src="' + window._currentListingImage + '" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:blur(16px) brightness(0.45);transform:scale(1.1)"><img src="' + window._currentListingImage + '" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain"></div>';
      }
      if (window._currentListingUrl) {
        inner += '<a href="' + window._currentListingUrl + '" target="_blank" style="display:block;padding:12px;background:rgba(0,255,136,.12);border-top:1px solid rgba(0,255,136,.2);color:var(--g);text-align:center;font-weight:700;font-size:14px;text-decoration:none">&#x1F517; View on Facebook Marketplace</a>';
      }
      header.innerHTML = inner;
      rwEl.insertBefore(header, rwEl.firstChild);
    }
  }

  function _showErr(msg) {
    clearInterval(stepTimer);
    document.getElementById('lw').classList.remove('on');
    document.getElementById('scrScan').classList.add('on');
    showErr(msg);
  }

  function _finishAI(r) {
    clearInterval(stepTimer);
    for (var i = 0; i < ps.length; i++) document.getElementById(ps[i]).className = 'stp dn';
    r = Object.assign({
      extractedTitle:      listing.title,
      extractedPrice:      listing.price || 0,
      extractedMileage:    listing.mileage || null,
      timeToSell:          '—',
      demandLevel:         '—',
      greenFlags:          [],
      redFlags:            [],
      whatToCheckInPerson: [],
      whyItsWorth:         ''
    }, r);
    if (listing.isOfferPrice) normalizeOfferPriceResult(r);
    var entry = { id: Date.now(), title: r.extractedTitle, price: r.extractedPrice || listing.price, image: listing.image || null, url: listing.url || null, result: r, date: new Date().toLocaleDateString('en-AU') };
    hist.unshift(entry); sv(); updatePill();
    setTimeout(function() { showResult(r); }, 400);
  }

  // /appraise resolves first — check for cache hit or limit hit immediately (no image needed)
  appraisePromise.then(function(appraiseData) {

    // ── Limit hit ──
    if (appraiseData && appraiseData.error) {
      _showErr('❌ ' + appraiseData.error);
      return;
    }

    // ── Race image proxy vs 1.5s timeout — don't block AI for a slow/expired image ──
    Promise.race([
      imageProxyPromise,
      new Promise(function(resolve) { setTimeout(resolve, 1500); })
    ]).then(function() {

      // Vehicle path — /ai/vehicle with mileage/year/make context + image if available
      if (listing.make && backendUrl) {
        var vehiclePayload = {
          make: listing.make,
          model: listing.model || '',
          year: listing.year,
          mileage: listing.mileage || null,
          transmission: listing.transmission || null,
          listingPrice: listing.price,
          title: listing.title,
          description: listing.description || '',
          listingId: listing.id || null,
          listingUrl: listing.url || null
        };
        var imgCtx = window._appraisalContext;
        if (imgCtx && imgCtx.imageB64 && !imgCtx.proxyFailed) {
          vehiclePayload.imageBase64 = imgCtx.imageB64;
          vehiclePayload.imageMime   = imgCtx.mediaType || 'image/jpeg';
        }
        fetch(backendUrl + '/ai/vehicle', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify(vehiclePayload)
        }).then(function(resp) { return resp.json(); })
          .then(_finishAI)
          .catch(function(e) { _showErr('Error: ' + e.message); });
        return;
      }

      // Non-vehicle — call AI text path
      callAI_text(txt, keyword).then(function(r) {
        clearInterval(stepTimer);
        for (var i = 0; i < ps.length; i++) document.getElementById(ps[i]).className = 'stp dn';
        if (listing.isOfferPrice) normalizeOfferPriceResult(r);
        var entry = { id: Date.now(), title: r.extractedTitle || listing.title, price: r.extractedPrice || listing.price, image: listing.image || null, url: listing.url || null, result: r, date: new Date().toLocaleDateString('en-AU') };
        hist.unshift(entry); sv(); updatePill();
        setTimeout(function() { showResult(r); }, 400);
      }).catch(function(e) { _showErr('Error: ' + e.message); });

    }).catch(function(e) { _showErr('Error: ' + e.message); });

  }).catch(function(e) { _showErr('Error: ' + e.message); });
}

function appraiseIdx(el) {
  var elCopy = el;
  checkAppraisalLimit().then(function(allowed) { if (allowed) _doAppraiseIdx(elCopy); });
}
function _doAppraiseIdx(el) {
  var idx = parseInt(el.getAttribute('data-idx'));
  var listing = _feedItems[idx];
  if (!listing) return;
  appraiseListing(listing);
}

function closeBlockedModal() {
  var m = document.getElementById('blockedModal');
  if (m) m.remove();
}

function showBlockedListings() {
  var url = getBackendUrl();
  if (!url) { toast('No backend connected'); return; }
  fetch(url + '/listings/blocked', { headers: authHeaders() })
    .then(function(r) { return r.json(); })
    .then(function(blocked) {
      if (!blocked.length) { toast('No blocked listings'); return; }
      // Show modal with blocked listings
      var modal = document.createElement('div');
      modal.id = 'blockedModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;overflow-y:auto;padding:20px';
      modal.innerHTML = '<div style="max-width:500px;margin:0 auto">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">' +
        '<div style="font-size:18px;font-weight:800;color:#fff">🚫 Blocked Listings (' + blocked.length + ')</div>' +
        '<button onclick="closeBlockedModal()" style="background:none;border:none;color:#888;font-size:20px;cursor:pointer">✕</button>' +
        '</div>' +
        '<div style="font-size:12px;color:#666;margin-bottom:12px">These were filtered out. Tap Restore to add back to your feed.</div>' +
        blocked.map(function(l) {
          return '<div class="blocked-item" style="background:#0d0d1a;border:1px solid #1a1a2e;border-radius:12px;padding:12px;margin-bottom:8px;display:flex;gap:10px;align-items:center">' +
            (l.image ? '<img src="' + l.image + '" style="width:50px;height:50px;object-fit:cover;border-radius:8px;flex-shrink:0">' : '<div style="width:50px;height:50px;background:#1a1a2e;border-radius:8px;flex-shrink:0"></div>') +
            '<div style="flex:1;min-width:0">' +
            '<div style="color:#fff;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + (l.title || '—') + '</div>' +
            '<div style="color:#00ff88;font-size:12px">' + (l.price ? '$' + l.price : 'No price') + '</div>' +
            '<div style="color:#555;font-size:11px">' + (l.keyword || '') + '</div>' +
            '</div>' +
            '<button data-id="' + l.id + '" onclick="unblockListing(this.dataset.id,this)" style="padding:6px 10px;background:rgba(0,255,136,.15);border:1px solid rgba(0,255,136,.3);border-radius:8px;color:#00ff88;font-size:12px;cursor:pointer;flex-shrink:0">Restore</button>' +
            '</div>';
        }).join('') +
        '</div>';
      document.body.appendChild(modal);
    })
    .catch(function() { toast('Could not load blocked listings'); });
}

function unblockListing(id, btn) {
  var url = getBackendUrl();
  if (!url) return;
  btn.textContent = '...';
  btn.disabled = true;
  fetch(url + '/listings/unblock', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ id: id })
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d.ok) {
      btn.closest('.blocked-item').remove();
      refreshListings();
      toast('✅ Restored to feed');
    }
  }).catch(function() { btn.textContent = 'Restore'; btn.disabled = false; });
}

function clearListings() {
  var url = getBackendUrl();
  if (!url) return;
  if (!confirm('Clear all listings?')) return;
  fetch(url + '/listings', { method: 'DELETE', headers: authHeaders() })
    .then(function() { localStorage.removeItem('fr_last_fetch'); saveCachedListings([]); toast('🗑️ Listings cleared'); refreshListings(); })
    .catch(function() { toast('Failed to clear'); });
}
