const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// Paths
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const WALLETS_FILE = path.join(DATA_DIR, 'wallets.json');
const PROGRESS_FILE = path.join(DATA_DIR, 'progress.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Scanner state
let scannerProcess = null;

// API: Get config
app.get('/api/config', (req, res) => {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      // Hide full API key
      if (config.heliusApiKey) {
        config.heliusApiKeyMasked = config.heliusApiKey.slice(0, 8) + '...';
      }
      res.json(config);
    } else {
      res.json({});
    }
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

// API: Get wallets
app.get('/api/wallets', (req, res) => {
  try {
    if (fs.existsSync(WALLETS_FILE)) {
      const data = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8'));
      res.json(data);
    } else {
      res.json([]);
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Get scan progress
app.get('/api/progress', (req, res) => {
  try {
    const progress = {
      isRunning: scannerProcess !== null,
      data: {}
    };
    
    if (fs.existsSync(PROGRESS_FILE)) {
      progress.data = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    }
    
    res.json(progress);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Start scan
app.post('/api/scan/start', (req, res) => {
  if (scannerProcess) {
    return res.status(400).json({ error: 'Scan already running' });
  }
  
  if (!fs.existsSync(CONFIG_FILE)) {
    return res.status(400).json({ error: 'Please configure Helius API key first' });
  }
  
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  if (!config.heliusApiKey) {
    return res.status(400).json({ error: 'Helius API key not configured' });
  }
  
  // Start scanner
  scannerProcess = spawn('node', ['scripts/scanner.js'], {
    cwd: __dirname,
    env: { ...process.env, ...config }
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
  });
  
  res.json({ success: true, message: 'Scan started' });
});

// API: Stop scan
app.post('/api/scan/stop', (req, res) => {
  if (!scannerProcess) {
    return res.status(400).json({ error: 'No scan running' });
  }
  
  scannerProcess.kill('SIGTERM');
  scannerProcess = null;
  
  res.json({ success: true, message: 'Scan stopped' });
});

// API: Get status
app.get('/api/status', (req, res) => {
  try {
    let lastUpdate = null;
    let walletCount = 0;
    
    if (fs.existsSync(WALLETS_FILE)) {
      const stats = fs.statSync(WALLETS_FILE);
      lastUpdate = stats.mtime.toISOString();
      walletCount = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8')).length;
    }
    
    res.json({
      lastUpdate,
      walletCount,
      isScanning: scannerProcess !== null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Download wallets as comma-separated single line (for copy bots)
app.get('/api/download/wallets', (req, res) => {
  try {
    if (!fs.existsSync(WALLETS_FILE)) {
      return res.status(404).json({ error: 'No wallets found' });
    }
    
    const wallets = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8'));
    const addresses = wallets.map(w => w.wallet_address).join(', ');
    
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
    if (!fs.existsSync(WALLETS_FILE)) {
      return res.status(404).json({ error: 'No wallets found' });
    }
    
    const wallets = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8'));
    
    // Apply filters from query params
    const minProfit = parseFloat(req.query.minProfit) || 0;
    const minWinrate = parseFloat(req.query.minWinrate) || 0;
    const minHoldtime = parseFloat(req.query.minHoldtime) || 0;
    const minBalance = parseFloat(req.query.minBalance) || 0;
    const minAge = parseFloat(req.query.minAge) || 0;
    
    const filtered = wallets.filter(w => 
      (w.pnl_sol || 0) >= minProfit &&
      ((w.winrate || 0)) >= minWinrate &&
      (w.avg_hold_time_min || 0) >= minHoldtime &&
      (w.sol_balance || 0) >= minBalance &&
      (w.wallet_age_days || 0) >= minAge
    );
    
    const addresses = filtered.map(w => w.wallet_address).join(', ');
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=wallets-filtered.csv');
    res.send(addresses);
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
    
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Solana Wallet Analyzer running at http://0.0.0.0:${PORT}\n`);
});
