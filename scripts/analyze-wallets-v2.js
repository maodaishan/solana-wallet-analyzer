/**
 * analyze-wallets-v2.js
 * Per-wallet analyzer: queries each wallet's PumpFun transactions directly
 * instead of scanning ALL PumpFun transactions. Much cheaper on credits.
 *
 * Credit cost: ~(N wallets × avg sigs per wallet / 1000) for getSigs
 *            + ~(N wallets × avg successful txs) for getTransaction
 * vs old approach: ALL PumpFun transactions regardless of wallet count
 */

const fs = require('fs');
const path = require('path');

// Paths
const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const USER_WALLETS_FILE = path.join(DATA_DIR, 'user-wallets.json');
const PROGRESS_FILE = path.join(DATA_DIR, 'progress.json');
const WALLETS_FILE = path.join(DATA_DIR, 'wallets.json');

// Load config
const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

const HELIUS_KEY = config.heliusApiKey;
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const PUMPFUN = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const TARGET_RPS = config.targetRps || 10;
const CHUNK_SIZE = config.chunkSize || 10;

const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function rpc(method, params, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const data = await res.json();
      if (data.error) {
        if (data.error.message && data.error.message.includes('rate')) {
          await delay(2000);
          continue;
        }
        throw new Error(data.error.message);
      }
      return data.result;
    } catch (e) {
      if (attempt === retries) throw e;
      const waitMs = attempt * 2000;
      console.log(`🔄 RPC error (attempt ${attempt}/${retries}), retrying in ${waitMs}ms: ${e.message}`);
      await delay(waitMs);
    }
  }
}

async function batchRpc(requests, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const body = requests.map((req, i) => ({
        jsonrpc: '2.0', id: i, method: req.method, params: req.params,
      }));
      const res = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!Array.isArray(data)) {
        if (data.error?.message?.includes('rate')) {
          await delay(2000);
          continue;
        }
        throw new Error(data.error?.message || 'Batch RPC returned non-array');
      }
      data.sort((a, b) => a.id - b.id);
      return data.map(d => d.result || null);
    } catch (e) {
      if (attempt === retries) throw e;
      const waitMs = attempt * 2000;
      console.log(`🔄 Batch error (attempt ${attempt}/${retries}), retrying in ${waitMs}ms: ${e.message}`);
      await delay(waitMs);
    }
  }
}

function extractTrade(tx, walletAddress) {
  if (!tx || !tx.blockTime || tx.meta?.err) return null;
  const keys = tx.transaction.message.accountKeys;
  const accounts = Array.isArray(keys)
    ? keys.map(k => k.pubkey || k)
    : [];

  const walletIndex = accounts.indexOf(walletAddress);
  if (walletIndex === -1) return null;

  const solChange = (tx.meta.postBalances[walletIndex] - tx.meta.preBalances[walletIndex]) / 1e9;
  return { solChange, blockTime: tx.blockTime };
}

function saveProgress(state) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(state, null, 2));
}

async function analyzeWallet(walletAddress) {
  const stats = { spent: 0, received: 0, txs: 0, firstSeen: null, lastSeen: null };
  let lastSig = null;
  let totalSigs = 0;

  // Fetch all PumpFun-related signatures for this wallet
  while (true) {
    const params = [walletAddress, { limit: 1000, ...(lastSig ? { before: lastSig } : {}) }];
    const sigs = await rpc('getSignaturesForAddress', params);
    if (!sigs || !sigs.length) break;

    totalSigs += sigs.length;

    // Filter: only successful transactions
    const successSigs = sigs.filter(s => s.err === null);

    // Batch fetch transactions
    for (let i = 0; i < successSigs.length; i += CHUNK_SIZE) {
      const chunk = successSigs.slice(i, i + CHUNK_SIZE);
      const chunkStart = Date.now();

      const requests = chunk.map(s => ({
        method: 'getTransaction',
        params: [s.signature, { maxSupportedTransactionVersion: 0 }],
      }));
      const txs = await batchRpc(requests);

      for (const tx of txs) {
        if (!tx) continue;

        // Check if this transaction involves PumpFun
        const keys = tx.transaction?.message?.accountKeys || [];
        const accounts = Array.isArray(keys) ? keys.map(k => k.pubkey || k) : [];
        if (!accounts.includes(PUMPFUN)) continue;

        const trade = extractTrade(tx, walletAddress);
        if (!trade) continue;

        if (trade.solChange < 0) {
          stats.spent += Math.abs(trade.solChange);
        } else {
          stats.received += trade.solChange;
        }
        stats.txs++;

        if (!stats.firstSeen || trade.blockTime < stats.firstSeen) {
          stats.firstSeen = trade.blockTime;
        }
        if (!stats.lastSeen || trade.blockTime > stats.lastSeen) {
          stats.lastSeen = trade.blockTime;
        }
      }

      // Rate limiting
      const elapsed = Date.now() - chunkStart;
      const targetMs = Math.floor(chunk.length / TARGET_RPS * 1000);
      const waitMs = Math.max(0, targetMs - elapsed);
      if (waitMs > 0) await delay(waitMs);
    }

    lastSig = sigs[sigs.length - 1].signature;

    // If we got less than 1000, we've reached the end
    if (sigs.length < 1000) break;
  }

  return { stats, totalSigs };
}

async function main() {
  console.log('🔍 Per-Wallet Analyzer Started');

  if (!fs.existsSync(USER_WALLETS_FILE)) {
    console.error('No user wallets found');
    process.exit(1);
  }

  const userWallets = JSON.parse(fs.readFileSync(USER_WALLETS_FILE, 'utf8'));
  console.log(`📋 Analyzing ${userWallets.length} wallets (per-wallet mode)`);

  const results = [];
  let totalCredits = 0;
  const nowSec = Date.now() / 1000;

  for (let i = 0; i < userWallets.length; i++) {
    const wallet = userWallets[i];
    console.log(`\n[${i + 1}/${userWallets.length}] ${wallet.slice(0, 8)}...`);

    try {
      const { stats, totalSigs } = await analyzeWallet(wallet);
      const profit = stats.received - stats.spent;
      const roi = stats.spent > 0 ? profit / stats.spent : 0;
      const ageDays = stats.firstSeen ? (nowSec - stats.firstSeen) / 86400 : 0;

      // Estimate credits used for this wallet
      const sigCalls = Math.ceil(totalSigs / 1000);
      const estCredits = sigCalls + stats.txs;
      totalCredits += estCredits;

      results.push({
        wallet_address: wallet,
        pnl_sol: parseFloat(profit.toFixed(4)),
        txs: stats.txs,
        total_sigs: totalSigs,
        sol_balance: 0,
        roi_pct: parseFloat((roi * 100).toFixed(2)),
        winrate: stats.received > stats.spent ? 100 : 0,
        wallet_age_days: parseFloat(ageDays.toFixed(1)),
        spent: parseFloat(stats.spent.toFixed(4)),
        received: parseFloat(stats.received.toFixed(4)),
      });

      console.log(`  PumpFun txs: ${stats.txs}, Profit: ${profit.toFixed(2)} SOL, ROI: ${(roi * 100).toFixed(1)}%, ~${estCredits} credits`);
    } catch (e) {
      console.error(`  Error: ${e.message}`);
      results.push({
        wallet_address: wallet,
        pnl_sol: 0, txs: 0, total_sigs: 0, sol_balance: 0,
        roi_pct: 0, winrate: 0, wallet_age_days: 0, spent: 0, received: 0,
        error: e.message,
      });
    }

    // Save progress after each wallet
    saveProgress({
      status: 'analyzing',
      processed: i + 1,
      total: userWallets.length,
      traders: results.filter(r => r.txs > 0).length,
      profitable: results.filter(r => r.pnl_sol > 0).length,
      estimatedCredits: totalCredits,
    });
  }

  // Sort by profit
  results.sort((a, b) => b.pnl_sol - a.pnl_sol);
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(results, null, 2));

  saveProgress({
    status: 'complete',
    processed: userWallets.length,
    total: userWallets.length,
    traders: results.filter(r => r.txs > 0).length,
    profitable: results.filter(r => r.pnl_sol > 0).length,
    estimatedCredits: totalCredits,
  });

  console.log(`\n✅ Analysis complete!`);
  console.log(`  Wallets: ${userWallets.length}`);
  console.log(`  With PumpFun activity: ${results.filter(r => r.txs > 0).length}`);
  console.log(`  Profitable: ${results.filter(r => r.pnl_sol > 0).length}`);
  console.log(`  Estimated credits used: ~${totalCredits.toLocaleString()}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  saveProgress({ status: 'error', error: e.message });
  process.exit(1);
});
