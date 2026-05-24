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
    const user = await getUser(req.userId);
    const planLimit = PLAN_WATCHLIST_LIMITS[user?.plan || 'free'];
    const existingWatches = await getUserWatches(req.userId);
    if (existingWatches.length >= planLimit)
      return res.status(403).json({ error: 'Watchlist limit reached for your plan', plan: user?.plan, limit: planLimit });
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
    console.log(`[Watch] Deleted "${keyword}" — cleared ${blocked.length - remaining.length} blocked listings`);

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
      listings.sort((a, b) => new Date(b.listedAt || b.foundAt) - new Date(a.listedAt || a.foundAt));
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

// ── Price cache route — lets frontend check before triggering AI ──
// GET /prices?keyword=ps5
app.get('/prices', authMiddleware, async (req, res) => {
  try {
    const { keyword } = req.query;
    if (!keyword) return res.status(400).json({ error: 'keyword required' });
    const priceData = await getPriceCacheForKeyword(keyword);
    if (!priceData) return res.json({ found: false, keyword });
    res.json({ found: true, keyword, ...priceData });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Appraisal route — cache-first, AI fallback ────────────
// POST /appraise  { keyword, price, title, description }
// Returns verdict without using AI if we have enough price data
app.post('/appraise', authMiddleware, async (req, res) => {
  try {
    const { keyword, price, title, description } = req.body;
    if (!keyword || !price) return res.status(400).json({ error: 'keyword and price required' });

    const listingPrice = parsePrice(price);

    // 1. Check appraisal limit
    const user = await getUser(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const today = new Date().toISOString().slice(0, 10);
    if (user.appraisalDate !== today) { user.appraisalsToday = 0; user.appraisalDate = today; }
    const limit = PLAN_APPRAISAL_LIMITS[user.plan || 'free'];
    if (limit !== Infinity && limit < 999 && user.appraisalsToday >= limit)
      return res.status(429).json({ error: 'Daily appraisal limit reached', limit, plan: user.plan });

    // 2. Try price cache first — free, no AI needed
    const priceData = await getPriceCacheForKeyword(keyword);
    if (priceData) {
      const verdict = buildCacheVerdict(listingPrice, priceData);
      // Still count as an appraisal but no AI cost incurred
      user.appraisalsToday = (user.appraisalsToday || 0) + 1;
      await saveUser(user);
      console.log(`[Appraise] "${keyword}" → served from ${verdict.source} cache (no AI used)`);
      return res.json({ ...verdict, usedCache: true });
    }
