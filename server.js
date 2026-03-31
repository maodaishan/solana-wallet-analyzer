const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// Paths
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const TRADERS_FILE = path.join(DATA_DIR, 'traders.json');
const GAP_TRADERS_FILE = path.join(DATA_DIR, 'gap-traders.json');
const PROGRESS_FILE = path.join(DATA_DIR, 'progress.json');
const WEBHOOK_STATE_FILE = path.join(DATA_DIR, 'webhook-state.json');
const SCAN_METADATA_FILE = path.join(DATA_DIR, 'scan-metadata.json');

const PUMPFUN = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Middleware
app.use(express.json({ limit: '10mb' })); // webhook payloads can be large
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// In-memory state
// ============================================================
let tradersData = {};       // Raw trader stats: {address: {spent, received, txs, firstSeen, lastSeen}}
let tradersDataDirty = false;
let scannerProcess = null;
let lastScanMode = 'normal'; // 'normal' or 'continue' — tracks current/last scan mode
let webhookScanAccumulator = {};  // Webhook data during active scan (kept separate to avoid double-counting)

let webhookState = {
  webhookId: null,
  webhookURL: null,
  status: 'inactive',     // 'inactive' | 'active' | 'error'
  createdAt: null,
  eventsReceived: 0,
  lastEventAt: null,
  tradersUpdated: 0,
};

let scanMetadata = {
  isRunning: false,
  scanStartBlockTime: null,
};

// ============================================================
// State loading / persistence
// ============================================================
function loadTradersData() {
  if (fs.existsSync(TRADERS_FILE)) {
    try {
      tradersData = JSON.parse(fs.readFileSync(TRADERS_FILE, 'utf8'));
      console.log(`Loaded ${Object.keys(tradersData).length} traders from traders.json`);
    } catch (e) {
      console.error('Failed to load traders.json:', e.message);
      tradersData = {};
    }
  }
}

function saveTradersData() {
  if (!tradersDataDirty) return;
  try {
    const tmpFile = TRADERS_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(tradersData));
    fs.renameSync(tmpFile, TRADERS_FILE);
    tradersDataDirty = false;
    console.log(`Persisted ${Object.keys(tradersData).length} traders to traders.json`);
  } catch (e) {
    console.error('Failed to save traders.json:', e.message);
  }
}

function loadWebhookState() {
  if (fs.existsSync(WEBHOOK_STATE_FILE)) {
    try {
      webhookState = JSON.parse(fs.readFileSync(WEBHOOK_STATE_FILE, 'utf8'));
    } catch (e) {
      console.error('Failed to load webhook-state.json:', e.message);
    }
  }
}

function saveWebhookState() {
  fs.writeFileSync(WEBHOOK_STATE_FILE, JSON.stringify(webhookState, null, 2));
}

function loadScanMetadata() {
  if (fs.existsSync(SCAN_METADATA_FILE)) {
    try {
      scanMetadata = JSON.parse(fs.readFileSync(SCAN_METADATA_FILE, 'utf8'));
    } catch (e) {
      scanMetadata = { isRunning: false, scanStartBlockTime: null };
    }
  }
}

function saveScanMetadata() {
  try {
    fs.writeFileSync(SCAN_METADATA_FILE, JSON.stringify(scanMetadata));
  } catch (e) {
    console.error('Failed to save scan-metadata:', e.message);
  }
}

// Compute dataNewestTime from available state (migration for old data without this field)
function getDataNewestTime() {
  if (scanMetadata.dataNewestTime) return scanMetadata.dataNewestTime;
  // Fallback: derive from webhook lastEventAt or scanStartBlockTime
  if (webhookState.lastEventAt) {
    return Math.floor(new Date(webhookState.lastEventAt).getTime() / 1000);
  }
  if (scanMetadata.scanStartBlockTime) {
    return scanMetadata.scanStartBlockTime;
  }
  return null;
}

// Load all state on startup
loadTradersData();
loadWebhookState();
loadScanMetadata();

// Periodic persistence of webhook-accumulated trader data (every 60s)
setInterval(() => {
  // During scanning, scanner owns traders.json — server should only read, not write
  if (!scannerProcess) {
    saveTradersData();
    // Persist dataNewestTime if webhook has been updating it
    if (scanMetadata.dataNewestTime) {
      saveScanMetadata();
    }
  }
  // Also reload scan-metadata in case scanner updated it
  loadScanMetadata();
}, 60000);

// Daily cleanup: remove traders inactive for longer than dataRetentionDays
function pruneExpiredTraders() {
  const config = loadConfig();
  const retentionDays = config.dataRetentionDays || 30;
  const cutoff = Date.now() / 1000 - retentionDays * 86400;
  const before = Object.keys(tradersData).length;
  for (const addr of Object.keys(tradersData)) {
    if ((tradersData[addr].lastSeen || 0) < cutoff) {
      delete tradersData[addr];
    }
  }
  const removed = before - Object.keys(tradersData).length;
  if (removed > 0) {
    tradersDataDirty = true;
    saveTradersData();
    console.log(`🧹 Pruned ${removed} inactive traders (>${retentionDays}d), ${Object.keys(tradersData).length} remaining`);
  }
}

// Run daily at 3:00 AM
function scheduleDailyPrune() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(3, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const msUntil = next - now;
  setTimeout(() => {
    if (!scannerProcess) pruneExpiredTraders();
    setInterval(() => {
      if (!scannerProcess) pruneExpiredTraders();
    }, 24 * 60 * 60 * 1000);
  }, msUntil);
  console.log(`🧹 Data pruning scheduled at 03:00 daily (next in ${(msUntil / 3600000).toFixed(1)}h)`);
}
scheduleDailyPrune();

// ============================================================
// On-demand filtering: traders → wallet results
// ============================================================
function filterTraders(config) {
  const filters = {
    minTxs: config.minTxs || 10,
    minWinrate: config.minWinrate || 0.4,
    minRoi: config.minRoi || 0.5,
    minProfit: config.minProfit || 10,
    minWalletAge: config.minWalletAge || 0,
  };

  const nowSec = Date.now() / 1000;

  return Object.entries(tradersData)
    .filter(([_, d]) => {
      const profit = d.received - d.spent;
      const roi = d.spent > 0 ? profit / d.spent : 0;
      const winrate = d.txs > 0 ? (d.received > 0 ? 1 : 0) : 0;
      const ageDays = d.firstSeen ? (nowSec - d.firstSeen) / 86400 : 0;
      return d.txs >= filters.minTxs
        && roi >= filters.minRoi
        && winrate >= filters.minWinrate
        && profit >= filters.minProfit
        && ageDays >= filters.minWalletAge;
    })
    .map(([address, d]) => ({
      address,
      totalTxs: d.txs,
      totalSpent: d.spent,
      totalReceived: d.received,
      totalProfit: d.received - d.spent,
      roi: d.spent > 0 ? (d.received - d.spent) / d.spent : 0,
      winrate: d.txs > 0 ? (d.received > 0 ? 1 : 0) : 0,
      walletAgeDays: d.firstSeen ? parseFloat(((nowSec - d.firstSeen) / 86400).toFixed(1)) : 0,
      balance: 0,
    }))
    .sort((a, b) => b.totalProfit - a.totalProfit);
}

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  }
  return {};
}

// ============================================================
// Webhook transaction processing
// ============================================================
function processWebhookTransaction(tx) {
  if (!tx || !tx.feePayer || !tx.timestamp) return;

  // Skip if scanner is running and this tx falls within scanner's range
  if (scanMetadata.isRunning && scanMetadata.scanStartBlockTime
      && tx.timestamp <= scanMetadata.scanStartBlockTime) {
    return;
  }

  const trader = tx.feePayer;
  const blockTime = tx.timestamp;

  // Calculate net SOL change for the fee payer from nativeTransfers
  let solChange = 0;
  if (Array.isArray(tx.nativeTransfers)) {
    for (const transfer of tx.nativeTransfers) {
      if (transfer.toUserAccount === trader) {
        solChange += (transfer.amount || 0) / 1e9;
      }
      if (transfer.fromUserAccount === trader) {
        solChange -= (transfer.amount || 0) / 1e9;
      }
    }
  }

  // During active scan: write to separate accumulator to avoid double-counting
  // After scan: write directly to tradersData
  const store = scannerProcess ? webhookScanAccumulator : tradersData;

  if (!store[trader]) {
    store[trader] = { spent: 0, received: 0, txs: 0, firstSeen: blockTime, lastSeen: blockTime };
  }

  if (solChange < 0) {
    store[trader].spent += Math.abs(solChange);
  } else {
    store[trader].received += solChange;
  }
  store[trader].txs++;

  if (blockTime < (store[trader].firstSeen || Infinity)) {
    store[trader].firstSeen = blockTime;
  }
  if (blockTime > (store[trader].lastSeen || 0)) {
    store[trader].lastSeen = blockTime;
  }

  webhookState.tradersUpdated++;
  if (!scannerProcess) {
    tradersDataDirty = true;
    // Track newest data time for continue scan feature
    if (blockTime > (scanMetadata.dataNewestTime || 0)) {
      scanMetadata.dataNewestTime = blockTime;
    }
  }
}

// ============================================================
// Helius webhook registration helpers
// ============================================================
async function registerWebhook(config) {
  const webhookURL = config.webhookURL;
  if (!webhookURL) return { error: 'webhookURL not configured' };

  // Delete existing webhook if any
  if (webhookState.webhookId) {
    try {
      await fetch(
        `https://api.helius.xyz/v0/webhooks/${webhookState.webhookId}?api-key=${config.heliusApiKey}`,
        { method: 'DELETE' }
      );
    } catch (e) { /* ignore cleanup errors */ }
  }

  const response = await fetch(
    `https://api.helius.xyz/v0/webhooks?api-key=${config.heliusApiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        webhookURL,
        transactionTypes: ['ANY'],
        accountAddresses: [PUMPFUN],
        webhookType: 'enhanced',
      }),
    }
  );

  if (!response.ok) {
    const errBody = await response.text();
    return { error: `Helius webhook API error: ${errBody}` };
  }

  const data = await response.json();

  webhookState = {
    webhookId: data.webhookID,
    webhookURL,
    status: 'active',
    createdAt: new Date().toISOString(),
    eventsReceived: 0,
    lastEventAt: null,
    tradersUpdated: 0,
  };
  saveWebhookState();
  console.log(`Webhook registered: ${data.webhookID}`);
  return { success: true, webhookId: data.webhookID };
}

async function deleteWebhook(config) {
  if (!webhookState.webhookId) return;
  try {
    await fetch(
      `https://api.helius.xyz/v0/webhooks/${webhookState.webhookId}?api-key=${config.heliusApiKey}`,
      { method: 'DELETE' }
    );
  } catch (e) {
    console.error('Failed to delete webhook:', e.message);
  }
  webhookState.status = 'inactive';
  webhookState.webhookId = null;
  saveWebhookState();
}

async function verifyWebhookRegistration() {
  if (webhookState.status !== 'active' || !webhookState.webhookId) return;
  try {
    const config = loadConfig();
    if (!config.heliusApiKey) return;
    const response = await fetch(
      `https://api.helius.xyz/v0/webhooks?api-key=${config.heliusApiKey}`
    );
    const webhooks = await response.json();
    const found = Array.isArray(webhooks) && webhooks.find(w => w.webhookID === webhookState.webhookId);
    if (found) {
      console.log('Webhook verified: still active');
    } else {
      console.log('Webhook no longer exists at Helius, marking inactive');
      webhookState.status = 'inactive';
      webhookState.webhookId = null;
      saveWebhookState();
    }
  } catch (e) {
    console.error('Failed to verify webhook:', e.message);
  }
}

// Merge scanner traders with webhook data accumulated DURING this scan
function mergeScannedTraders() {
  try {
    let merged;
    const webhookCount = Object.keys(webhookScanAccumulator).length;
    let scannerCount = 0;

    if (lastScanMode === 'continue') {
      // Continue mode: scanner wrote gap-only data to gap-traders.json
      merged = { ...tradersData }; // start from existing in-memory data (full)
      if (fs.existsSync(GAP_TRADERS_FILE)) {
        const gapTraders = JSON.parse(fs.readFileSync(GAP_TRADERS_FILE, 'utf8'));
        scannerCount = Object.keys(gapTraders).length;
        for (const [addr, sData] of Object.entries(gapTraders)) {
          if (!merged[addr]) {
            merged[addr] = { ...sData };
          } else {
            merged[addr].spent += sData.spent;
            merged[addr].received += sData.received;
            merged[addr].txs += sData.txs;
            merged[addr].firstSeen = Math.min(merged[addr].firstSeen || Infinity, sData.firstSeen || Infinity);
            merged[addr].lastSeen = Math.max(merged[addr].lastSeen || 0, sData.lastSeen || 0);
          }
        }
        // Clean up gap file
        fs.unlinkSync(GAP_TRADERS_FILE);
      }
    } else {
      // Normal mode: scanner wrote complete data to traders.json — replace
      if (!fs.existsSync(TRADERS_FILE)) return;
      const scannerTraders = JSON.parse(fs.readFileSync(TRADERS_FILE, 'utf8'));
      scannerCount = Object.keys(scannerTraders).length;
      merged = { ...scannerTraders };
    }

    // Add webhook data from during this scan (non-overlapping time range)
    for (const [addr, wData] of Object.entries(webhookScanAccumulator)) {
      if (!merged[addr]) {
        merged[addr] = { ...wData };
      } else {
        merged[addr].spent += wData.spent;
        merged[addr].received += wData.received;
        merged[addr].txs += wData.txs;
        merged[addr].firstSeen = Math.min(merged[addr].firstSeen || Infinity, wData.firstSeen || Infinity);
        merged[addr].lastSeen = Math.max(merged[addr].lastSeen || 0, wData.lastSeen || 0);
      }
    }

    tradersData = merged;
    webhookScanAccumulator = {}; // Clear accumulator
    tradersDataDirty = true;
    saveTradersData();
    console.log(`Merged (${lastScanMode}): ${Object.keys(merged).length} traders total (scanner: ${scannerCount} + webhook: ${webhookCount})`);
  } catch (e) {
    console.error('Failed to merge traders:', e.message);
    loadTradersData();
  }
}

// ============================================================
// API Routes
// ============================================================

// API: Get config
app.get('/api/config', (req, res) => {
  try {
    const config = loadConfig();
    if (config.heliusApiKey) {
      config.heliusApiKeyMasked = config.heliusApiKey.slice(0, 8) + '...';
    }
    res.json(config);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Save config
app.post('/api/config', (req, res) => {
  try {
    const config = req.body;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Get wallets (on-demand filtering from in-memory traders data)
let lastTradersReload = 0;
app.get('/api/wallets', (req, res) => {
  try {
    // Reload traders from file during normal scanning, at most once per 30 seconds
    // In continue mode, server already has full data in memory — don't reload partial gap data
    const now = Date.now();
    if (scannerProcess && lastScanMode !== 'continue' && now - lastTradersReload > 30000) {
      loadTradersData();
      lastTradersReload = now;
    }
    const config = loadConfig();
    const results = filterTraders(config);
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Get scan progress
app.get('/api/progress', (req, res) => {
  try {
    const progress = {
      isRunning: scannerProcess !== null,
      webhookActive: webhookState.status === 'active',
      data: {}
    };

    if (fs.existsSync(PROGRESS_FILE)) {
      progress.data = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    }

    // Add webhook stats to progress
    if (webhookState.status === 'active') {
      progress.data.webhookEventsReceived = webhookState.eventsReceived;
      progress.data.webhookTradersUpdated = webhookState.tradersUpdated;
      progress.data.webhookLastEventAt = webhookState.lastEventAt;
    }

    // Add data coverage info for continue scan feature
    progress.dataNewestTime = getDataNewestTime();
    progress.totalTraders = Object.keys(tradersData).length;

    res.json(progress);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Start scan (auto-registers webhook first, then starts historical scanner)
// Body: { continue: true } to fill gap from last data point to now (instead of full rescan)
app.post('/api/scan/start', async (req, res) => {
  try {
    if (scannerProcess) {
      return res.status(400).json({ error: 'Scan already running' });
    }

    if (!fs.existsSync(CONFIG_FILE)) {
      return res.status(400).json({ error: 'Please configure Helius API key first' });
    }

    const config = loadConfig();
    if (!config.heliusApiKey) {
      return res.status(400).json({ error: 'Helius API key not configured' });
    }

    const isContinue = req.body && req.body.continue === true;
    console.log(`[DEBUG] /api/scan/start called. body=${JSON.stringify(req.body)}, isContinue=${isContinue}`);

    // For continue mode: determine where the last data ends
    let continueUntil = null;
    if (isContinue) {
      continueUntil = getDataNewestTime();
      console.log(`[DEBUG] continueUntil=${continueUntil}, dataNewestTime=${scanMetadata.dataNewestTime}, webhookLastEvent=${webhookState.lastEventAt}, scanStartBlockTime=${scanMetadata.scanStartBlockTime}`);
      if (!continueUntil) {
        return res.status(400).json({ error: 'No previous scan data found. Use a normal scan first.' });
      }
      console.log(`Continue scan: filling gap from ${new Date(continueUntil * 1000).toISOString()} to now`);
    }

    // Step 1: Auto-register webhook (if webhookURL is configured)
    let webhookResult = null;
    if (config.webhookURL) {
      try {
        webhookResult = await registerWebhook(config);
        if (webhookResult.error) {
          console.error('Webhook registration failed:', webhookResult.error);
          // Continue without webhook — historical scan still works
        } else {
          console.log('Webhook registered successfully, starting scanner...');
        }
      } catch (e) {
        console.error('Webhook registration error:', e.message);
      }
    } else {
      console.log('No webhookURL configured, running historical scan only');
    }

    // Step 2: Reset webhook accumulator for this scan
    // During scan, webhook data goes to separate accumulator to avoid double-counting
    webhookScanAccumulator = {};
    lastScanMode = isContinue ? 'continue' : 'normal';

    // Step 3: Start scanner with appropriate mode
    const scannerEnv = { ...process.env };
    if (isContinue) {
      scannerEnv.SCAN_MODE = 'continue';
      scannerEnv.CONTINUE_UNTIL = String(continueUntil);
    }
    console.log(`[DEBUG] Spawning scanner: lastScanMode=${lastScanMode}, env.SCAN_MODE=${scannerEnv.SCAN_MODE || 'not set'}, env.CONTINUE_UNTIL=${scannerEnv.CONTINUE_UNTIL || 'not set'}`);

    scannerProcess = spawn('node', ['scripts/scanner.js'], {
      cwd: __dirname,
      env: scannerEnv,
    });

    scannerProcess.stdout.on('data', (data) => {
      console.log(`Scanner: ${data}`);
    });

    scannerProcess.stderr.on('data', (data) => {
      console.error(`Scanner error: ${data}`);
    });

    scannerProcess.on('close', (code) => {
      console.log(`Scanner exited with code ${code}`);
      scannerProcess = null;

      // Reload scan metadata
      loadScanMetadata();

      if (code === 0) {
        // Merge scanner results with webhook data
        mergeScannedTraders();
        console.log('Scan complete. Webhook continues running.');
      } else {
        // Write error status
        try {
          const existing = fs.existsSync(PROGRESS_FILE)
            ? JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'))
            : {};
          if (existing.status !== 'complete' && existing.status !== 'completed') {
            fs.writeFileSync(PROGRESS_FILE, JSON.stringify({
              ...existing,
              status: 'error',
              error: `Scanner exited with code ${code}. Check your Helius API key.`,
              lastUpdate: new Date().toISOString()
            }, null, 2));
          }
        } catch (e) {}
      }
    });

    res.json({
      success: true,
      message: isContinue ? 'Continue scan started' : 'Scan started',
      scanMode: isContinue ? 'continue' : 'normal',
      webhookRegistered: webhookResult?.success || false,
    });
  } catch (e) {
    console.error('Scan start error:', e);
    res.status(500).json({ error: e.message });
  }
});

// API: Stop scan (stops scanner process, optionally stops webhook)
app.post('/api/scan/stop', async (req, res) => {
  try {
    const { stopWebhook: shouldStopWebhook } = req.body || {};

    if (scannerProcess) {
      scannerProcess.kill('SIGTERM');
      scannerProcess = null;
    }

    if (shouldStopWebhook && webhookState.webhookId) {
      const config = loadConfig();
      await deleteWebhook(config);
    }

    // Save any accumulated webhook data
    saveTradersData();

    res.json({ success: true, message: 'Scan stopped', webhookStopped: shouldStopWebhook || false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Webhook status
app.get('/api/webhook/status', (req, res) => {
  res.json({
    ...webhookState,
    totalTraders: Object.keys(tradersData).length,
  });
});

// API: Stop webhook only (without stopping scanner)
app.post('/api/webhook/stop', async (req, res) => {
  try {
    if (!webhookState.webhookId) {
      return res.status(400).json({ error: 'No active webhook' });
    }
    const config = loadConfig();
    await deleteWebhook(config);
    saveTradersData();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Start webhook only (without starting a scan)
app.post('/api/webhook/start', async (req, res) => {
  try {
    const config = loadConfig();
    if (!config.heliusApiKey) {
      return res.status(400).json({ error: 'Helius API key not configured' });
    }
    if (!config.webhookURL) {
      return res.status(400).json({ error: 'Webhook URL not configured' });
    }

    const result = await registerWebhook(config);
    if (result.error) {
      return res.status(500).json({ error: result.error });
    }

    res.json({ success: true, webhookId: result.webhookId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Reset all data (requires confirmation from frontend)
app.post('/api/reset', async (req, res) => {
  try {
    // Stop scanner if running
    if (scannerProcess) {
      scannerProcess.kill('SIGTERM');
      scannerProcess = null;
    }

    // Stop webhook if active
    if (webhookState.webhookId) {
      const config = loadConfig();
      await deleteWebhook(config);
    }

    // Clear in-memory data
    tradersData = {};
    tradersDataDirty = false;
    webhookScanAccumulator = {};

    // Delete data files
    const filesToDelete = [
      TRADERS_FILE,
      path.join(DATA_DIR, 'checkpoint.json'),
      PROGRESS_FILE,
      SCAN_METADATA_FILE,
    ];
    for (const f of filesToDelete) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }

    console.log('All data reset');
    res.json({ success: true, message: 'All data cleared' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Helius webhook receiver endpoint
app.post('/api/webhook/helius', (req, res) => {
  // Respond 200 immediately
  res.status(200).json({ received: true });

  try {
    const transactions = req.body;
    if (!Array.isArray(transactions)) return;

    for (const tx of transactions) {
      processWebhookTransaction(tx);
    }

    webhookState.eventsReceived += transactions.length;
    webhookState.lastEventAt = new Date().toISOString();

    // Save webhook state periodically (every 100 events)
    if (webhookState.eventsReceived % 100 === 0) {
      saveWebhookState();
    }
  } catch (e) {
    console.error('Webhook processing error:', e.message);
  }
});

// API: Get status
app.get('/api/status', (req, res) => {
  try {
    const config = loadConfig();
    const results = filterTraders(config);
    res.json({
      lastUpdate: new Date().toISOString(),
      walletCount: results.length,
      totalTraders: Object.keys(tradersData).length,
      isScanning: scannerProcess !== null,
      webhookActive: webhookState.status === 'active',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Download wallets (on-demand filtered)
app.get('/api/download/wallets', (req, res) => {
  try {
    const config = loadConfig();
    const results = filterTraders(config);
    if (results.length === 0) {
      return res.status(404).json({ error: 'No wallets found' });
    }
    const addresses = results.map(w => w.address).join(', ');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=wallets.csv');
    res.send(addresses);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Download filtered wallets
app.get('/api/download/filtered', (req, res) => {
  try {
    const config = loadConfig();
    let results = filterTraders(config);

    // Apply additional frontend filters from query params
    const minProfit = parseFloat(req.query.minProfit) || 0;
    const minWinrate = parseFloat(req.query.minWinrate) || 0;
    const minBalance = parseFloat(req.query.minBalance) || 0;
    const minAge = parseFloat(req.query.minAge) || 0;

    results = results.filter(w =>
      (w.totalProfit || 0) >= minProfit &&
      (w.winrate || 0) >= minWinrate &&
      (w.balance || 0) >= minBalance &&
      (w.walletAgeDays || 0) >= minAge
    );

    if (results.length === 0) {
      return res.status(404).json({ error: 'No wallets found matching filters' });
    }

    res.setHeader('Content-Type', 'text/csv');

    if (req.query.mode === 'detailed') {
      const header = 'Address,Total Trades,Winrate,ROI,Total Profit (SOL),Total Spent (SOL),Total Received (SOL),Wallet Age (days)';
      const rows = results.map(w =>
        `${w.address},${w.totalTxs},${(w.winrate * 100).toFixed(1)}%,${(w.roi * 100).toFixed(1)}%,${w.totalProfit.toFixed(4)},${w.totalSpent.toFixed(4)},${w.totalReceived.toFixed(4)},${w.walletAgeDays}`
      );
      res.setHeader('Content-Disposition', 'attachment; filename=wallets-detailed.csv');
      res.send(header + '\n' + rows.join('\n'));
    } else {
      const addresses = results.map(w => w.address).join(', ');
      res.setHeader('Content-Disposition', 'attachment; filename=wallets-filtered.csv');
      res.send(addresses);
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Analyze user's own wallet list
app.post('/api/analyze/wallets', async (req, res) => {
  try {
    const { wallets: walletList } = req.body;

    if (!walletList || !Array.isArray(walletList) || walletList.length === 0) {
      return res.status(400).json({ error: 'Please provide a list of wallet addresses' });
    }

    if (!fs.existsSync(CONFIG_FILE)) {
      return res.status(400).json({ error: 'Please configure Helius API key first' });
    }

    const config = loadConfig();
    if (!config.heliusApiKey) {
      return res.status(400).json({ error: 'Helius API key not configured' });
    }

    // Save wallet list for the analyzer script
    const userWalletsFile = path.join(DATA_DIR, 'user-wallets.json');
    fs.writeFileSync(userWalletsFile, JSON.stringify(walletList, null, 2));

    // Start the enhanced analyzer with user wallets
    scannerProcess = spawn('node', ['scripts/analyze-wallets-v2.js'], {
      cwd: __dirname,
      env: { ...process.env, HELIUS_API_KEY: config.heliusApiKey }
    });

    scannerProcess.stdout.on('data', (data) => {
      console.log(`Analyzer: ${data}`);
    });

    scannerProcess.stderr.on('data', (data) => {
      console.error(`Analyzer error: ${data}`);
    });

    scannerProcess.on('close', (code) => {
      console.log(`Analyzer exited with code ${code}`);
      scannerProcess = null;
    });

    res.json({
      success: true,
      message: `Analyzing ${walletList.length} wallets. Check progress in Scanner tab.`
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API error handler — return JSON instead of Express's default HTML
app.use('/api', (err, req, res, next) => {
  console.error('API error:', err.message);
  res.status(err.status || 500).json({ error: err.message });
});

// ============================================================
// Graceful shutdown
// ============================================================
function gracefulShutdown(signal) {
  console.log(`\n${signal} received. Saving state...`);
  saveTradersData();
  saveWebhookState();
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ============================================================
// Startup
// ============================================================
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n🚀 Solana Wallet Analyzer running at http://0.0.0.0:${PORT}`);
  console.log(`📊 Loaded ${Object.keys(tradersData).length} traders`);
  console.log(`📡 Webhook status: ${webhookState.status}`);

  // Verify webhook registration on startup
  await verifyWebhookRegistration();
});
