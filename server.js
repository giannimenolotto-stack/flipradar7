// ── Bright Data keyword scan (replaces Apify for vehicle keywords) ────────────
// Uses POST /datasets/v3/scrape with { input: [{ keyword }] }
// Returns listings already normalized — no separate enrichment step needed.
async function brightDataKeywordScan(keyword, opts = {}) {
  if (!BRIGHTDATA_API_KEY) {
    console.log(`[BrightData] No API key — skipping keyword scan for "${keyword}"`);
    return [];
  }

  console.log(`[BrightData] Keyword scan: "${keyword}"`);
  try {
    const res = await axios.post(
      `${BRIGHTDATA_BASE_URL}/scrape?dataset_id=${BRIGHTDATA_DATASET_ID}&include_errors=true`,
      { input: [{ keyword }] },
      {
        headers: {
          'Authorization': `Bearer ${BRIGHTDATA_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 120000,
      }
    );

    const raw = Array.isArray(res.data) ? res.data.filter(r => !r.error) : [];
    console.log(`[BrightData] "${keyword}" -> ${raw.length} result(s)`);

    const maxItems = opts.initialScan ? 25 : 15;
    const items = raw.slice(0, maxItems);

    return items.map(item => {
      const id = item.product_id ||
        (item.url || '').match(/\/item\/(\d+)/)?.[1] || '';
      if (!id) return null;

      const rawTitle    = item.title || keyword;
      const description = item.description || item.seller_description || null;
      const rawPrice    = parsePrice(item.final_price || item.initial_price);

      // Extract vehicle fields from title since BrightData doesn't return structured fields
      const year = extractYear(rawTitle, description);
      const make = extractMake(keyword, rawTitle);
      const model = extractModel(make, rawTitle);
      const title = normalizeVehicleTitle(rawTitle, year, make);

      // Mileage — BrightData doesn't return car_miles on keyword scan (only collect-by-URL)
      // Fall back to regex extraction from title/description
      const mileage = extractMileage(rawTitle, description);

      // listedAt — BrightData returns listing_date as ISO string
      let listedAt = null;
      let listedAtUnknown = false;
      if (item.listing_date) {
        const d = new Date(item.listing_date);
        if (!isNaN(d.getTime()) && d.getFullYear() >= 2020) {
          listedAt = d.toISOString();
        }
      }
      if (!listedAt) {
        listedAt = new Date().toISOString();
        listedAtUnknown = true;
      }

      return {
        id,
        title,
        price:         rawPrice,
        isOfferPrice:  isOfferPrice(rawPrice),
        url:           item.url || `https://www.facebook.com/marketplace/item/${id}/`,
        image:         Array.isArray(item.images) && item.images.length > 0 ? item.images[0] : null,
        location:      item.location || null,
        description,
        keyword,
        listedAt,
        listedAtUnknown,
        foundAt:       new Date().toISOString(),
        mileage,
        year,
        make,
        model,
        transmission:  extractTransmission(rawTitle, description),
        fuelType:      null,   // not returned by keyword scan
        exteriorColor: item.color || null,
        interiorColor: null,
        bodyStyle:     null,
        trim:          null,
        drivetrain:    null,
        sellerType:    null,
        condition:     item.condition || null,
      };
    }).filter(l => l && l.id);

  } catch (e) {
    console.error(`[BrightData] Keyword scan error for "${keyword}":`,
      e.response ? JSON.stringify(e.response.data).slice(0, 200) : e.message);
    return [];
  }
}


async function scrapeKeyword(keyword, opts = {}) {
  // ── Vehicle keywords: use Bright Data directly, skip Apify ──
  if (isVehicleKeyword(keyword)) {
    return brightDataKeywordScan(keyword, opts);
  }

  // ── Non-vehicle keywords: Apify as before ────────────────
  if (!APIFY_TOKEN) return [];
  const days      = opts.backfillDays || (opts.backfill ? 7 : (opts.initialScan ? 7 : 1));
  const maxItems  = opts.initialScan ? 25 : 15;
  const includeDetails = false;
  console.log(`[Apify] "${keyword}" — vehicle:false includeDetails:${includeDetails}`);

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
    const allItems = Array.isArray(res.data) ? res.data.filter(i => !i.error) : [];
    let items      = allItems.slice(0, maxItems);
    console.log(`[Apify] "${keyword}" -> ${items.length} item(s) (of ${allItems.length} returned)`);

    return items.map(item => {
      const id = item.id || item.listingId || String(item.marketplace_listing_id || '');

      let listedAt = null;
      const tsRaw = item.creation_time || item.listed_at || item.listingCreationTime
        || item.listing_creation_time || item.created_time || null;
      if (tsRaw && typeof tsRaw === 'number') {
        const ms = tsRaw < 1e10 ? tsRaw * 1000 : tsRaw;
        const d = new Date(ms);
        if (d.getFullYear() >= 2020 && d <= new Date()) listedAt = d.toISOString();
      }
      if (!listedAt) {
        const strRaw = item.date || item.listed_at_text || null;
        if (strRaw && typeof strRaw === 'string') {
          const d = new Date(strRaw);
          if (!isNaN(d.getTime()) && d.getFullYear() >= 2020) listedAt = d.toISOString();
        }
      }
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
      const listedAtUnknown = !listedAt;
      if (!listedAt) listedAt = new Date().toISOString();

      const rawTitle    = item.marketplace_listing_title || item.custom_title || item.title || keyword;
      const description = item.redacted_description?.text || item.description || null;
      const isVehicle   = isVehicleListing(keyword, rawTitle, description);
      const rawPrice    = parsePrice(
        item.listing_price?.amount || item.listing_price?.formatted_amount ||
        item.formatted_price || item.price
      );

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
        trim:          isVehicle ? (
                         item.vehicle_info?.trim || item.listing_vehicle_data?.trim ||
                         item.vehicleInfo?.trim || item.trim || item.trim_level ||
                         item.vehicle_info?.trim_level || null
                       ) : null,
        drivetrain:    isVehicle ? (
                         item.vehicle_info?.drivetrain || item.listing_vehicle_data?.drivetrain ||
                         item.vehicleInfo?.drivetrain || item.drivetrain ||
                         item.vehicle_info?.drive_type || item.drive_type || null
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
