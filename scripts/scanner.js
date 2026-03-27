/**
 * PumpFun On-Chain Scanner - Enhanced with Real-time Block Time Progress
 * Scans Solana blockchain for profitable traders
 */

const fs = require('fs');
const path = require('path');

// Paths
const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PROGRESS_FILE = path.join(DATA_DIR, 'progress.json');
const WALLETS_FILE = path.join(DATA_DIR, 'wallets.json');
const CHECKPOINT_FILE = path.join(DATA_DIR, 'checkpoint.json');

// Load config
const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

const HELIUS_KEY = config.heliusApiKey;
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const BATCH_URL = `https://api.helius.xyz/v0/transactions?api-key=${HELIUS_KEY}`;
const PUMPFUN = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const DAYS_TO_SCAN = config.daysToScan || 7;
const DELAY_MS = config.delayMs || 40;
const TARGET_RPS = config.targetRps || 45; // batch API calls per second
const CHUNK_SIZE = config.chunkSize || 10; // concurrent batch calls
const BATCH_SIZE = 100; // signatures per batch API call

// Filters
const FILTERS = {
  minTxs: config.minTxs || 10,
  minWinrate: config.minWinrate || 0.4,
  minRoi: config.minRoi || 0.5,
  minProfit: config.minProfit || 10,
  minWalletAge: config.minWalletAge || 0,
};

// Time calculations
const scanStartTime = Date.now();
const targetStartTime = Date.now() - (DAYS_TO_SCAN * 24 * 60 * 60 * 1000); // X days ago
const scanEndTime = Date.now();

console.log(`🔍 PumpFun Scanner Started`);
console.log(`📅 Scanning last ${DAYS_TO_SCAN} days`);
console.log(`🕐 Target range: ${new Date(targetStartTime).toLocaleString()} → ${new Date(scanEndTime).toLocaleString()}`);

// Helper
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
          console.log(`⏳ Rate limited, waiting 2s... (attempt ${attempt})`);
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

async function getSigs(before = null) {
  const params = [PUMPFUN, { limit: 1000, ...(before ? { before: before } : {}) }];
  return await rpc('getSignaturesForAddress', params);
}

async function getTransactionsBatch(signatures, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(BATCH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactions: signatures }),
      });
      const data = await res.json();
      if (!Array.isArray(data)) {
        const msg = data.error || JSON.stringify(data);
        if (msg.includes('rate')) {
          await delay(2000);
          continue;
        }
        throw new Error(msg);
      }
      return data;
    } catch (e) {
      if (attempt === retries) throw e;
      const waitMs = attempt * 2000;
      console.log(`🔄 Batch error (attempt ${attempt}/${retries}), retrying in ${waitMs}ms: ${e.message}`);
      await delay(waitMs);
    }
  }
}

function extractTrade(tx) {
  // Helius enhanced transaction format
  if (!tx.timestamp || tx.transactionError) return null;
  const trader = tx.feePayer;
  if (!trader) return null;
  const accountData = tx.accountData || [];
  const feePayerData = accountData.find(a => a.account === trader);
  const solChange = feePayerData ? feePayerData.nativeBalanceChange / 1e9 : 0;
  return { trader, solChange, blockTime: tx.timestamp };
}

function saveProgress(state) {
  const now = Date.now();
  const elapsedMs = now - state.scanStartRealTime;
  const elapsedSec = elapsedMs / 1000;

  const currentBlockTime = state.currentBlockTime || Math.floor(now / 1000);
  const totalRangeSec = (scanEndTime - targetStartTime) / 1000;
  const scannedSec = Math.max(0, Math.floor(now / 1000) - currentBlockTime); // seconds of blockchain scanned
  const daysScanned = scannedSec / 86400;

  // Use scan rate (blockchain days per real second) to estimate remaining
  const scanRateDaysPerSec = elapsedSec > 5 ? daysScanned / elapsedSec : 0;
  const daysRemaining = Math.max(0, DAYS_TO_SCAN - daysScanned);
  const remainingMs = scanRateDaysPerSec > 0 ? (daysRemaining / scanRateDaysPerSec) * 1000 : 0;

  const timeProgressPercent = Math.min(100, Math.round(daysScanned / DAYS_TO_SCAN * 100));
  const eta = (remainingMs > 0 && daysScanned > 0.01) ? new Date(now + remainingMs).toISOString() : null;

  const progressData = {
    processed: state.processed,
    traders: Object.keys(state.traders).length,
    profitable: Object.values(state.traders).filter(t => t.received > t.spent).length,
    startTime: state.startTime,
    lastUpdate: new Date().toISOString(),
    status: state.status || 'scanning',

    currentBlockTimeFormatted: new Date(currentBlockTime * 1000).toLocaleString(),
    targetStartTimeFormatted: new Date(targetStartTime).toLocaleString(),
    scanEndTimeFormatted: new Date(scanEndTime).toLocaleString(),

    timeProgressPercent,
    daysScanned: parseFloat(daysScanned.toFixed(2)),
    daysTotal: DAYS_TO_SCAN,
    elapsedMs,
    remainingMs: Math.min(remainingMs, 8640000000000000 - now - 1),
    eta,
    etaFormatted: eta ? new Date(eta).toLocaleString() : null,
    avgTxsPerSecond: elapsedSec > 0 ? Math.round(state.processed / elapsedSec) : 0,
  };

  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progressData, null, 2));
}

function saveCheckpoint(state) {
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify({
    lastSig: state.lastSig,
    processed: state.processed,
    traders: state.traders,
    lastBlockTime: state.currentBlockTime,
    timestamp: Date.now()
  }));
}

async function main() {
  let state = {
    processed: 0,
    traders: {},
    lastSig: null,
    startTime: new Date().toISOString(),
    scanStartRealTime: Date.now(),
    status: 'scanning',
    currentBlockTime: Math.floor(Date.now() / 1000) // Initialize with current time
  };
  
  // Write initial progress immediately so frontend knows scanner started
  saveProgress(state);

  // Write interim results every 10 seconds during scanning
  const interimInterval = setInterval(() => {
    if (state.status === 'scanning') writeInterimResults(state);
  }, 10000);

  // Load checkpoint if exists
  if (fs.existsSync(CHECKPOINT_FILE)) {
    try {
      const checkpoint = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
      console.log(`📌 Resuming: ${checkpoint.processed} txs, ${Object.keys(checkpoint.traders).length} traders`);
      state = { ...state, ...checkpoint, scanStartRealTime: Date.now() };
    } catch (e) {
      console.log('❌ Failed to load checkpoint, starting fresh');
    }
  }
  
  try {
    while (true) {
      const sigs = await getSigs(state.lastSig);
      if (!sigs.length) break;
      
      // Split 1000 sigs into batches of BATCH_SIZE (100), then process CHUNK_SIZE batches concurrently
      const sigGroups = [];
      for (let i = 0; i < sigs.length; i += BATCH_SIZE) {
        sigGroups.push(sigs.slice(i, i + BATCH_SIZE).map(s => s.signature));
      }

      console.log(`📡 Processing ${sigs.length} signatures in ${sigGroups.length} batches`);

      for (let i = 0; i < sigGroups.length; i += CHUNK_SIZE) {
        const concurrentGroups = sigGroups.slice(i, i + CHUNK_SIZE);
        const chunkStart = Date.now();

        try {
          const allTxs = (await Promise.all(concurrentGroups.map(g => getTransactionsBatch(g)))).flat();

          for (const tx of allTxs) {
            if (!tx) continue;

            if (tx.timestamp) state.currentBlockTime = tx.timestamp;

            if (tx.timestamp && tx.timestamp < targetStartTime / 1000) {
              console.log(`⏰ Reached time limit: ${new Date(tx.timestamp * 1000).toLocaleString()}`);
              state.status = 'completed';
              saveProgress(state);
              return await finalize(state);
            }

            const trade = extractTrade(tx);
            if (!trade) continue;

            const trader = trade.trader;
            if (!state.traders[trader]) {
              state.traders[trader] = { spent: 0, received: 0, txs: 0, firstSeen: trade.blockTime };
            }
            if (trade.solChange < 0) {
              state.traders[trader].spent += Math.abs(trade.solChange);
            } else {
              state.traders[trader].received += trade.solChange;
            }
            // Track earliest known transaction (scanning backwards, so update if older)
            if (trade.blockTime && trade.blockTime < state.traders[trader].firstSeen) {
              state.traders[trader].firstSeen = trade.blockTime;
            }
            state.traders[trader].txs++;
            state.processed++;

            if (state.processed % 1000 === 0) {
              saveProgress(state);
              saveCheckpoint(state);
            }
          }
        } catch (e) {
          console.error(`❌ Batch processing error:`, e.message);
          await delay(1000);
        }

        // Adaptive delay to stay at TARGET_RPS (batch API calls per second)
        const elapsed = Date.now() - chunkStart;
        const targetMs = Math.floor(concurrentGroups.length / TARGET_RPS * 1000);
        const waitMs = Math.max(0, targetMs - elapsed);
        if (waitMs > 0) await delay(waitMs);
      }
      
      state.lastSig = sigs[sigs.length - 1].signature;
      
      // Update progress more frequently during scanning
      saveProgress(state);
      
      // Break if last transaction is older than our target
      const lastBlockTime = sigs[sigs.length - 1].blockTime;
      if (lastBlockTime && lastBlockTime < targetStartTime / 1000) {
        console.log(`⏰ Reached time limit: ${new Date(lastBlockTime * 1000).toLocaleString()}`);
        break;
      }
    }
    
    clearInterval(interimInterval);
    state.status = 'completed';
    saveProgress(state);
    return await finalize(state);

  } catch (error) {
    clearInterval(interimInterval);
    console.error('❌ Scanner error:', error);
    state.status = 'error';
    state.error = error.message;
    saveProgress(state);
    throw error;
  }
}

function walletAgeDays(data) {
  if (!data.firstSeen) return 0;
  return (Math.floor(Date.now() / 1000) - data.firstSeen) / 86400;
}

function passesFilters(data) {
  const profit = data.received - data.spent;
  const roi = data.spent > 0 ? profit / data.spent : 0;
  const winrate = data.txs > 0 ? (data.received > 0 ? 1 : 0) : 0;
  const ageDays = walletAgeDays(data);
  return (
    data.txs >= FILTERS.minTxs &&
    roi >= FILTERS.minRoi &&
    winrate >= FILTERS.minWinrate &&
    profit >= FILTERS.minProfit &&
    ageDays >= FILTERS.minWalletAge
  );
}

function toWalletResult([address, data]) {
  return {
    address,
    totalTxs: data.txs,
    totalSpent: data.spent,
    totalReceived: data.received,
    totalProfit: data.received - data.spent,
    roi: data.spent > 0 ? (data.received - data.spent) / data.spent : 0,
    winrate: data.txs > 0 ? (data.received > 0 ? 1 : 0) : 0,
    walletAgeDays: parseFloat(walletAgeDays(data).toFixed(1)),
    balance: 0
  };
}

function writeInterimResults(state) {
  try {
    const results = Object.entries(state.traders)
      .filter(([_, data]) => passesFilters(data))
      .map(toWalletResult);
    fs.writeFileSync(WALLETS_FILE, JSON.stringify(results, null, 2));
  } catch (e) {
    console.error('Failed to write interim results:', e.message);
  }
}

async function finalize(state) {
  console.log('\n🔍 Analysis phase starting...');
  state.status = 'analyzing';
  saveProgress(state);
  
  const results = Object.entries(state.traders)
    .filter(([_, data]) => passesFilters(data))
    .map(toWalletResult);
  
  console.log(`✅ Analysis complete: ${results.length} profitable wallets found`);
  
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(results, null, 2));
  
  // Final progress update
  state.status = 'complete';
  saveProgress(state);
  
  return results;
}

// Start scanner
main().catch(console.error);