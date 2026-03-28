# Solana Wallet Analyzer

A web-based tool to scan Solana blockchain for profitable PumpFun traders. Uses a hybrid approach: historical scan via Helius RPC + real-time webhook monitoring (zero credits).

## How It Works

1. **Historical Scan** - Scans past N days of PumpFun transactions via Helius RPC (costs credits)
2. **Real-time Webhook** - Auto-registers a Helius webhook to stream new transactions (zero credits, 24/7)
3. **On-demand Filtering** - Change filter params anytime, results update instantly without re-scanning

```
Timeline:
[N days ago] <--- historical scan (credits) ---> [start moment] <--- webhook (free) ---> [ongoing...]
```

## VPS Deployment

### Prerequisites

- Node.js 18+
- 2GB+ RAM recommended (for large trader datasets)
- Public IP with port 3000 open

### Install & Run

```bash
# Clone the repo
git clone <your-repo-url>
cd solana-wallet-analyzer

# Install dependencies
npm install

# Install pm2 for permanent running with auto-restart
npm install -g pm2

# Start with pm2
pm2 start server.js --name wallet-analyzer

# Auto-start on VPS reboot
pm2 startup
pm2 save
```

### pm2 Commands

```bash
pm2 status                    # Check running status
pm2 logs wallet-analyzer      # View logs
pm2 restart wallet-analyzer   # Restart
pm2 stop wallet-analyzer      # Stop
```

## Configuration

Open `http://YOUR-VPS-IP:3000` in your browser, go to **Config** tab:

| Setting | Description | Recommended |
|---|---|---|
| Helius API Key | Required. Get from https://dev.helius.xyz/ | - |
| Webhook URL | Your VPS public URL for receiving real-time data | `http://YOUR-VPS-IP:3000/api/webhook/helius` |
| Days to Scan | Historical days to backfill | 3-5 (for $49 plan) |
| Target Requests/sec | Helius rate limit | 45 (for paid plan) |
| Concurrent Batches | Transactions per batch request | 30 |
| Filter Settings | Min transactions, winrate, ROI, profit, wallet age | Adjust as needed |

## Usage

1. Fill in Config and click **Save Configuration**
2. Go to **Scanner** tab, select **Mode 2: Blockchain Discovery**
3. Click **Start** - system will:
   - Auto-register webhook (if Webhook URL configured)
   - Start historical scan
4. When historical scan completes, webhook continues running 24/7
5. Check **Results** tab anytime - filter changes apply instantly
6. Use **Reset Data** (Config tab, bottom) to clear everything and start fresh

## Key Features

- **Hybrid Scan**: Historical backfill + real-time webhook (zero credit cost after initial scan)
- **Resume on Interrupt**: Scanner saves checkpoint, click Start to continue from where it stopped
- **Instant Filter Changes**: Modify filter params in Config, results update immediately without re-scan
- **Auto-restart**: pm2 restarts the server if it crashes, and on VPS reboot
- **Webhook Persistence**: Server verifies webhook registration on restart

## Credit Consumption

PumpFun processes ~2M transactions/day. Each `getTransaction` call = 1 credit.

| Helius Plan | Credits/month | Historical scan coverage | With webhook |
|---|---|---|---|
| $49 Developer | 10M | ~5 days | 5 days + unlimited real-time |
| $499 Business | 60M | ~30 days | 30 days + unlimited real-time |

Optimizations applied:
- Skip failed transactions before fetching (~30-50% credit savings)
- Batch JSON-RPC (multiple calls per HTTP request)
- Pre-filter by blockTime from signature metadata

## Project Structure

```
solana-wallet-analyzer/
├── server.js              # Express server, API, webhook handler
├── public/
│   └── index.html         # Web UI (single page)
├── scripts/
│   ├── scanner.js         # Historical on-chain scanner
│   └── analyze-wallets-v2.js  # Mode 1: user wallet analyzer
├── data/
│   ├── config.json        # User configuration
│   ├── traders.json       # Raw trader data (all accumulated stats)
│   ├── progress.json      # Scan progress for frontend
│   ├── checkpoint.json    # Scanner resume point (deleted after completion)
│   ├── webhook-state.json # Webhook registration state
│   └── scan-metadata.json # Time boundary for scanner/webhook dedup
└── package.json
```

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/config` | GET/POST | Read/save configuration |
| `/api/wallets` | GET | Get filtered wallet results (on-demand from traders data) |
| `/api/progress` | GET | Scan progress + webhook status |
| `/api/status` | GET | Quick status check |
| `/api/scan/start` | POST | Auto-register webhook + start historical scan |
| `/api/scan/stop` | POST | Stop scanner (optionally stop webhook) |
| `/api/webhook/helius` | POST | Helius webhook receiver endpoint |
| `/api/webhook/status` | GET | Webhook state |
| `/api/webhook/stop` | POST | Stop webhook only |
| `/api/reset` | POST | Clear all data (requires frontend confirmation) |
| `/api/download/filtered` | GET | Download filtered wallets as CSV |
