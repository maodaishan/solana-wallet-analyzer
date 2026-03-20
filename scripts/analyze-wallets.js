/**
 * analyze-wallets.js
 * Analyze a list of user-provided wallets using Helius API
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USER_WALLETS_FILE = path.join(DATA_DIR, 'user-wallets.json');
const WALLETS_FILE = path.join(DATA_DIR, 'wallets.json');
const PROGRESS_FILE = path.join(DATA_DIR, 'progress.json');

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!HELIUS_API_KEY) {
  console.error('HELIUS_API_KEY not set');
  process.exit(1);
}

function updateProgress(data) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(data, null, 2));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function getWalletBalance(wallet) {
  try {
    const url = `https://api.helius.xyz/v0/addresses/${wallet}/balances?api-key=${HELIUS_API_KEY}`;
    const data = await fetchJson(url);
    const solBalance = (data.nativeBalance || 0) / 1e9;
    return solBalance;
  } catch (e) {
    console.error(`Failed to get balance for ${wallet}:`, e.message);
    return 0;
  }
}

async function getWalletTransactions(wallet) {
  try {
    const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${HELIUS_API_KEY}&limit=100`;
    const txs = await fetchJson(url);
    // Helius returns array on success, object with error on failure
    if (!Array.isArray(txs)) {
      console.error(`API error for ${wallet}:`, txs.error || 'unknown');
      return [];
    }
    return txs;
  } catch (e) {
    console.error(`Failed to get txs for ${wallet}:`, e.message);
    return [];
  }
}

function analyzeTransactions(txs, wallet) {
  if (!Array.isArray(txs) || txs.length === 0) {
    return { txs: 0, pnl_sol: 0, roi_pct: 0, winrate: 0, avg_hold_time_min: 0, wallet_age_days: 0 };
  }

  let totalPnl = 0;
  let wins = 0;
  let totalTrades = 0;

  // Simple PnL calculation from swap transactions
  for (const tx of txs) {
    if (tx.type === 'SWAP') {
      totalTrades++;
      // Basic heuristic: if we got more SOL out than in, it's a win
      const solIn = (tx.nativeTransfers || [])
        .filter(t => t.fromUserAccount === wallet)
        .reduce((sum, t) => sum + (t.amount || 0), 0) / 1e9;
      const solOut = (tx.nativeTransfers || [])
        .filter(t => t.toUserAccount === wallet)
        .reduce((sum, t) => sum + (t.amount || 0), 0) / 1e9;
      
      const pnl = solOut - solIn;
      totalPnl += pnl;
      if (pnl > 0) wins++;
    }
  }

  const winrate = totalTrades > 0 ? Math.round((wins / totalTrades) * 100) : 0;
  const roi = totalTrades > 0 ? (totalPnl / Math.max(totalTrades * 0.1, 1)) * 100 : 0;

  // Calculate wallet age from oldest tx
  let walletAge = 0;
  if (txs.length > 0) {
    const oldestTx = txs[txs.length - 1];
    if (oldestTx.timestamp) {
      walletAge = Math.floor((Date.now() / 1000 - oldestTx.timestamp) / 86400);
    }
  }

  return {
    txs: txs.length,
    pnl_sol: parseFloat(totalPnl.toFixed(4)),
    roi_pct: parseFloat(roi.toFixed(2)),
    winrate,
    avg_hold_time_min: 0, // Would need more complex analysis
    wallet_age_days: walletAge
  };
}

async function main() {
  console.log('Starting wallet analysis...');
  
  if (!fs.existsSync(USER_WALLETS_FILE)) {
    console.error('No user wallets file found');
    process.exit(1);
  }

  const userWallets = JSON.parse(fs.readFileSync(USER_WALLETS_FILE, 'utf8'));
  console.log(`Analyzing ${userWallets.length} wallets`);

  const results = [];
  let processed = 0;

  updateProgress({
    status: 'running',
    processed: 0,
    total: userWallets.length,
    traders: userWallets.length,
    profitable: 0
  });

  for (const wallet of userWallets) {
    console.log(`[${processed + 1}/${userWallets.length}] Analyzing ${wallet.slice(0, 8)}...`);
    
    try {
      const balance = await getWalletBalance(wallet);
      await sleep(200);
      
      const txs = await getWalletTransactions(wallet);
      await sleep(300);
      
      const analysis = analyzeTransactions(txs, wallet);
      
      results.push({
        wallet_address: wallet,
        sol_balance: parseFloat(balance.toFixed(4)),
        ...analysis
      });

      processed++;
      
      updateProgress({
        status: 'running',
        processed,
        total: userWallets.length,
        traders: userWallets.length,
        profitable: results.filter(r => r.pnl_sol > 0).length
      });
      
    } catch (e) {
      console.error(`Error analyzing ${wallet}:`, e.message);
      // Still add wallet with empty data
      results.push({
        wallet_address: wallet,
        sol_balance: 0,
        txs: 0,
        pnl_sol: 0,
        roi_pct: 0,
        winrate: 0,
        avg_hold_time_min: 0,
        wallet_age_days: 0
      });
      processed++;
    }
  }

  // Sort by PnL
  results.sort((a, b) => b.pnl_sol - a.pnl_sol);

  // Save results
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(results, null, 2));
  
  updateProgress({
    status: 'complete',
    processed,
    total: userWallets.length,
    traders: userWallets.length,
    profitable: results.filter(r => r.pnl_sol > 0).length
  });

  console.log(`\nAnalysis complete! ${results.length} wallets analyzed.`);
  console.log(`Profitable: ${results.filter(r => r.pnl_sol > 0).length}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
