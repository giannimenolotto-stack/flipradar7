# FlipRadar Backend

Scans Facebook Marketplace via Apify and sends Pushover alerts for new listings.

## Setup

### 1. Get an Apify token
1. Sign up at https://apify.com (free — $10 credit/month)
2. Go to Settings → Integrations → API token
3. Copy your token

### 2. Set Railway environment variables
In your Railway project → Variables:

| Variable | Value |
|---|---|
| `APIFY_TOKEN` | Your Apify API token |
| `PUSHOVER_TOKEN` | Your Pushover app token |
| `PUSHOVER_USER` | Your Pushover user key |

### 3. Deploy
```bash
railway up
```

## API endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/` | Status — shows if Apify is connected |
| GET | `/watchlist` | List all keywords |
| POST | `/watchlist` | Add keyword `{ keyword, maxPrice? }` |
| DELETE | `/watchlist/:id` | Remove keyword |
| POST | `/scan/now` | Trigger a scan immediately |
| POST | `/scan/test` | Test a keyword, returns raw results `{ keyword, maxPrice? }` |

## Apify actor
Uses `curious_coder~facebook-marketplace-scraper`
https://apify.com/curious_coder/facebook-marketplace-scraper

## Cost estimate (Apify free tier)
- Free tier: $10 USD credit/month
- Each actor run: ~$0.02–0.05 per keyword scan
- At 15-min intervals, 5 keywords: ~$5–10/month
- Stays within free tier for light use

## Notes
- Watchlist resets on redeploy (in-memory). Add Upstash Redis for persistence.
- Scan interval is 15 min by default. Change to `*/5 * * * *` for 5-min on a paid Apify plan.
