# Mizan Gold History

Independent public-data pipeline for Mizan's daily gold and foreign-exchange history. It contains
no application code, Firebase configuration, user data, or API secrets.

## What it publishes

`public/gold-history.json` contains one real daily snapshot per available UTC date:

- XAU price in USD per troy ounce;
- local-currency-per-USD rates for KWD, SAR, AED, QAR, BHD, OMR, IQD, JOD, and EGP;
- coverage and honest gap metadata;
- a resumable backfill cursor and retry timestamps.

The source is `fawazahmed0/currency-api` (CC0-1.0), requested from jsDelivr with the source's
Cloudflare Pages endpoint as fallback. No API key is required.

## Local commands

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm update-history
```

The updater refuses to replace an invalid/corrupted file or publish a version that drops an
existing in-window day. It fetches at most 24 older dates per run with request spacing, retries
recent missing dates after a cooldown, and retains a rolling 400-day window.

## How progress survives GitHub Actions

GitHub runners are disposable. Progress lives in the committed `public/gold-history.json` file,
not in the runner cache. The file includes `days`, `backfillCursor.oldestCompletedDay`,
`backfillCursor.complete`, and `recentlyFailedDays`. Every run checks out the previous committed
file, continues from that cursor, validates the result, and commits only the updated JSON. A fresh
runner therefore resumes the prior run instead of restarting the year.

The workflow runs daily at 02:00 UTC and can also be started manually. Its only elevated GitHub
permission is `contents: write`, used to commit the public JSON state.

## Cloudflare Pages

Connect this repository through Cloudflare Pages Git integration with:

- Production branch: `main`
- Framework preset: `None`
- Build command: leave blank
- Build output directory: `public`
- Root directory: repository root (leave blank)
- Environment variables: none

The published feed will be available at `https://<project>.pages.dev/gold-history.json`.
