# Solana Wallet Analyzer — Project Guide

## What This App Does

A web tool that finds profitable PumpFun traders on Solana blockchain. PumpFun is a token launchpad DEX (program ID: `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`). The app discovers wallets that consistently profit from trading on PumpFun, useful for "copy trading" — following profitable traders' moves.

## Two Analysis Modes

**Mode 1 — Analyze Specified Wallets**: User uploads a CSV or pastes wallet addresses. The app queries each wallet's transaction history on-chain, filters for PumpFun interactions, and calculates profit/loss. Script: `scripts/analyze-wallets-v2.js`. Cost: proportional to number of wallets provided.

**Mode 2 — Blockchain Discovery**: Scans ALL PumpFun transactions for the past N days to discover every wallet that traded, then filters by profitability. Script: `scripts/scanner.js`. Cost: proportional to total PumpFun volume (~2M tx/day). After the historical scan, a Helius webhook monitors new transactions in real-time at zero credit cost.

## Architecture

```
Browser (index.html SPA)
    |
    v
Express server (server.js, port 3000)
    |
    +-- In-memory tradersData {} -- loaded from traders.json on startup
    |
    +-- Spawns child processes:
    |     scanner.js (Mode 2)
    |     analyze-wallets-v2.js (Mode 1)
    |
    +-- Receives Helius webhook POST at /api/webhook/helius
    |
    v
JSON files in data/ (no database)
```

### Key Design Principles

- **No database**: All state in JSON files with atomic writes (write to .tmp, then rename)
- **Minimal dependencies**: Only `express` — no framework, no build tools
- **Single HTML file**: Full SPA with CSS and JS inline (~1300 lines)
- **On-demand filtering**: Raw trader data stored unfiltered; filter params applied at query time via `filterTraders()`. Changing filter settings takes effect immediately without re-scanning
- **Hybrid scan model**: Expensive historical scan + free real-time webhook creates continuous coverage

## File Structure

```
server.js              - Express server, all API routes, webhook handler, state management (~980 lines)
public/index.html      - Full SPA UI: Results/Scanner/Config tabs (~1335 lines)
scripts/
  scanner.js           - Mode 2: scans all PumpFun txs backward in time (~415 lines)
  analyze-wallets-v2.js - Mode 1: per-wallet PumpFun tx analysis (~378 lines)
  analyze-wallets.js   - Legacy Mode 1 using Helius parsed API (not used in production)
  enhance-option-b-full.cjs - One-off script to enrich wallet data (not part of main app)
data/
  config.json          - User settings (API key, webhook URL, scan params, filter params)
  traders.json         - Main data: {walletAddr: {spent, received, txs, firstSeen, lastSeen}}
  gap-traders.json     - Temp file during "continue" scan (gap-fill data before merge)
  progress.json        - Scan progress for frontend polling
  checkpoint.json      - Scanner resume point (deleted after successful scan)
  mode1-state.json     - Mode 1 checkpoint for resume
  user-wallets.json    - User-uploaded wallet list for Mode 1
  wallets.json         - Mode 1 results (analyzed wallet data)
  webhook-state.json   - Webhook registration (ID, URL, event counts)
  scan-metadata.json   - Time boundaries: dataNewestTime for continue scans
```

## Data Flow

### Mode 2 (Blockchain Discovery)

1. Frontend calls `POST /api/scan/start`
2. Server spawns `scanner.js` as child process
3. Scanner calls `getSignaturesForAddress(PUMPFUN)` to get tx signatures, newest-first
4. Fetches full tx data via batch `getTransaction` RPC calls
5. For each tx: extracts trader wallet (first signer), SOL balance change (postBalance - preBalance)
6. Accumulates stats per trader: {spent, received, txs, firstSeen, lastSeen}
7. Saves checkpoint every 10K txs; saves progress every 1K txs
8. Stops when tx blockTime < targetStartTime (N days ago)
9. On completion: server merges scanner data + any webhook data accumulated during scan

**Continue scan**: If previous scan exists, fills the gap from `dataNewestTime` to now instead of full rescan. Scanner writes to `gap-traders.json`; server merges into existing data.

### Mode 1 (Specified Wallets)

1. Frontend calls `POST /api/analyze/wallets` with wallet list
2. Server saves wallets to `user-wallets.json`, spawns `analyze-wallets-v2.js`
3. For each wallet: fetches all its signatures, filters for PumpFun interactions, calculates P&L
4. Results saved to `wallets.json` progressively (partial results visible during scan)
5. Supports checkpoint/resume via `mode1-state.json`

### Webhook (Real-time)

1. Server registers webhook at Helius API: monitors PumpFun program, receives raw tx data
2. Helius POSTs batches of txs to `/api/webhook/helius`
3. Server processes each tx same as scanner: extract trader + SOL change
4. During active scan: webhook data stored in separate `webhookScanAccumulator` to avoid double-counting
5. After scan: webhook writes directly to `tradersData` in memory

## API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/config` | GET/POST | Read/save configuration |
| `/api/wallets` | GET | Filtered wallet results (on-demand from traders data) |
| `/api/progress` | GET | Scan progress + webhook status + mode1 resume info |
| `/api/status` | GET | Quick status check |
| `/api/scan/start` | POST | Start Mode 2 scan (`{continue: true}` for gap-fill) |
| `/api/scan/stop` | POST | Stop scanner (optionally stop webhook) |
| `/api/analyze/wallets` | POST | Start Mode 1 with wallet list |
| `/api/analyze/resume` | POST | Resume interrupted Mode 1 |
| `/api/analyze/discard` | POST | Discard Mode 1 checkpoint |
| `/api/webhook/helius` | POST | Helius webhook receiver |
| `/api/webhook/status` | GET | Webhook state |
| `/api/webhook/start` | POST | Start webhook only (no scan) |
| `/api/webhook/stop` | POST | Stop webhook only |
| `/api/download/wallets` | GET | Download filtered addresses |
| `/api/download/filtered` | GET | Download filtered CSV (addresses or detailed) |
| `/api/reset` | POST | Clear all data (double confirmation in frontend) |

## Important Implementation Details

- **RPC rate limiting**: Adaptive delay between batch calls to stay at `targetRps` (configurable, default 45 for paid Helius plan)
- **Batch JSON-RPC**: Multiple `getTransaction` calls in a single HTTP request (reduces overhead)
- **Failed tx filtering**: Signatures with `err !== null` are skipped before fetching full tx data (~30-50% credit savings)
- **blockTime pre-filtering**: Out-of-range txs filtered using signature metadata before RPC call
- **Trader profit calc**: Simple `received - spent` from SOL balance changes (postBalances[0] - preBalances[0])
- **Winrate**: Currently simplified — `received > 0 ? 1 : 0` (not per-trade win/loss)
- **Data retention**: Daily prune at 03:00 removes traders whose `lastSeen` is older than `dataRetentionDays`
- **Graceful shutdown**: SIGTERM/SIGINT save tradersData and webhookState before exit
- **Frontend polling**: Progress polled every 1s during scan; wallets refreshed every 10s; webhook status every 10s

## Development

```bash
npm install       # Only dependency: express
npm start         # or: node server.js
# Open http://localhost:3000
# Configure Helius API key in Config tab
```

## Coding Conventions

- Keep single-file simplicity: no frameworks, no build tools, no TypeScript
- All state in JSON files with atomic writes (tmp + rename pattern)
- Frontend is a single inline HTML/CSS/JS file — no separate .js/.css
- Only `express` as npm dependency — use Node.js built-ins otherwise
- Scripts communicate via shared JSON files in `data/`, not IPC
