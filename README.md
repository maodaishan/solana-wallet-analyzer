# Solana Wallet Analyzer

A web-based tool to scan Solana blockchain for profitable PumpFun traders.

## Quick Start

```bash
# Install dependencies
npm install

# Start the server
npm start

# Open in browser
# http://YOUR-VPS-IP:3000
```

## Features

- **Web UI**: Configure and monitor scans from your browser
- **On-chain Scanner**: Scans PumpFun transactions to find profitable traders
- **Filtering**: Filter wallets by profit, winrate, hold time, etc.
- **Resume Support**: Scan can be stopped and resumed from checkpoint

## Configuration

Go to the **Config** tab in the web UI to set:

1. **Helius API Key** (required) - Get one at https://dev.helius.xyz/
2. **Days to Scan** - How many days of history to scan (default: 7)
3. **Request Delay** - Delay between API requests in ms (default: 40)
4. **Filter Settings** - Min transactions, winrate, ROI, profit

## Usage

1. Open the web UI at `http://YOUR-VPS-IP:3000`
2. Go to **Config** tab and enter your Helius API key
3. Adjust scan and filter settings as needed
4. Click **Save Configuration**
5. Go to **Scanner** tab and click **Start Scan**
6. Watch progress update in real-time
7. View filtered results in **Wallets** tab

## Files

```
vps-deploy/
├── server.js          # Express server
├── public/
│   └── index.html     # Web UI
├── scripts/
│   └── scanner.js     # On-chain scanner
├── data/
│   ├── config.json    # User configuration
│   ├── wallets.json   # Filtered results
│   ├── progress.json  # Scan progress
│   └── checkpoint.json # Resume checkpoint
└── package.json
```

## API Endpoints

- `GET /api/wallets` - Get filtered wallet list
- `GET /api/status` - Get last update time and wallet count
- `GET /api/config` - Get current configuration
- `POST /api/config` - Save configuration
- `GET /api/progress` - Get scan progress
- `POST /api/scan/start` - Start scanner
- `POST /api/scan/stop` - Stop scanner

## VPS Requirements

- Node.js 18+
- 1 CPU, 1GB RAM minimum
- Port 3000 open (or configure via PORT env var)

## Running as Background Service

```bash
# Using PM2
npm install -g pm2
pm2 start server.js --name wallet-analyzer
pm2 save
pm2 startup
```
