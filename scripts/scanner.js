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
const TRADERS_FILE = path.join(DATA_DIR, 'traders.json');
const CHECKPOINT_FILE = path.join(DATA_DIR, 'checkpoint.json');
const SCAN_METADATA_FILE = path.join(DATA_DIR, 'scan-metadata.json');

// Load config
const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

const HELIUS_KEY = config.heliusApiKey;
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const PUMPFUN = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const DAYS_TO_SCAN = config.daysToScan || 7;
const DELAY_MS = config.delayMs || 40;
const TARGET_RPS = config.targetRps || 45; // RPC calls per second
const CHUNK_SIZE = config.chunkSize || 10; // concurrent RPC calls

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

// Batch JSON-RPC: send multiple getTransaction calls in a single HTTP request
async function batchRpc(requests, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const body = requests.map((req, i) => ({
        jsonrpc: '2.0',
        id: i,
        method: req.method,
        params: req.params,
      }));
      const res = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!Array.isArray(data)) {
        if (data.error?.message?.includes('rate')) {
          console.log(`⏳ Batch rate limited, waiting 2s... (attempt ${attempt})`);
          await delay(2000);
          continue;
        }
        throw new Error(data.error?.message || 'Batch RPC returned non-array');
      }
      // Sort by id to maintain order, extract results
      data.sort((a, b) => a.id - b.id);
      return data.map(d => d.result || null);
    } catch (e) {
      if (attempt === retries) throw e;
      const waitMs = attempt * 2000;
      console.log(`🔄 Batch RPC error (attempt ${attempt}/${retries}), retrying in ${waitMs}ms: ${e.message}`);
      await delay(waitMs);
    }
  }
}

async function getSigs(before = null) {
  const params = [PUMPFUN, { limit: 1000, ...(before ? { before: before } : {}) }];
  return await rpc('getSignaturesForAddress', params);
}

async function getTxBatch(sigs) {
  const requests = sigs.map(sig => ({
    method: 'getTransaction',
    params: [sig, { maxSupportedTransactionVersion: 0 }],
  }));
  return await batchRpc(requests);
}

function extractTrade(tx) {
  if (!tx || !tx.blockTime || tx.meta?.err) return null;
  const keys = tx.transaction.message.accountKeys;
  const signers = Array.isArray(keys)
    ? keys.filter(k => (typeof k === 'object' ? k.signer : false)).map(k => k.pubkey || k)
    : [];
  const trader = signers[0] || (Array.isArray(keys) ? (keys[0]?.pubkey || keys[0]) : null);
  if (!trader) return null;
  const solChange = (tx.meta.postBalances[0] - tx.meta.preBalances[0]) / 1e9;
  return { trader, solChange, blockTime: tx.blockTime };
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
  
  let scanStartBlockTime = null;

  try {
    while (true) {
      const sigs = await getSigs(state.lastSig);
      if (!sigs.length) break;

      // Record the most recent blockTime on first batch (for webhook dedup)
      if (!scanStartBlockTime && sigs[0]?.blockTime) {
        scanStartBlockTime = sigs[0].blockTime;
        fs.writeFileSync(SCAN_METADATA_FILE, JSON.stringify({
          isRunning: true,
          scanStartBlockTime,
          startedAt: new Date().toISOString(),
        }));
        console.log(`📌 Scan boundary: webhook will skip txs before ${new Date(scanStartBlockTime * 1000).toLocaleString()}`);
      }
      
      // Filter out failed transactions BEFORE fetching full data (saves ~30-50% credits)
      // Also filter out transactions already outside time range using blockTime from signatures
      const successSigs = sigs.filter(s => {
        if (s.err !== null) return false; // skip failed txs
        if (s.blockTime && s.blockTime < targetStartTime / 1000) return false; // skip out-of-range txs
        return true;
      });
      const skippedCount = sigs.length - successSigs.length;
      console.log(`📡 Processing ${successSigs.length} successful signatures (skipped ${skippedCount} failed/out-of-range txs)`);

      // Update currentBlockTime from sigs metadata (no extra RPC needed)
      const lastSigBlockTime = sigs[sigs.length - 1]?.blockTime;
      if (lastSigBlockTime) state.currentBlockTime = lastSigBlockTime;

      for (let i = 0; i < successSigs.length; i += CHUNK_SIZE) {
        const chunk = successSigs.slice(i, i + CHUNK_SIZE);
        const chunkStart = Date.now();

        try {
          // Use batch RPC: single HTTP request for the whole chunk
          const txs = await getTxBatch(chunk.map(s => s.signature));

          for (const tx of txs) {
            if (!tx) continue;

            if (tx.blockTime) state.currentBlockTime = tx.blockTime;

            if (tx.blockTime && tx.blockTime < targetStartTime / 1000) {
              console.log(`⏰ Reached time limit: ${new Date(tx.blockTime * 1000).toLocaleString()}`);
              state.status = 'completed';
              saveProgress(state);
              return await finalize(state, scanStartBlockTime);
            }

            const trade = extractTrade(tx);
            if (!trade) continue;

            const trader = trade.trader;
            if (!state.traders[trader]) {
              state.traders[trader] = { spent: 0, received: 0, txs: 0, firstSeen: trade.blockTime, lastSeen: trade.blockTime };
            }
            if (trade.solChange < 0) {
              state.traders[trader].spent += Math.abs(trade.solChange);
            } else {
              state.traders[trader].received += trade.solChange;
            }
            if (trade.blockTime && trade.blockTime < state.traders[trader].firstSeen) {
              state.traders[trader].firstSeen = trade.blockTime;
            }
            if (trade.blockTime && (!state.traders[trader].lastSeen || trade.blockTime > state.traders[trader].lastSeen)) {
              state.traders[trader].lastSeen = trade.blockTime;
            }
            state.traders[trader].txs++;
            state.processed++;

            if (state.processed % 1000 === 0) {
              saveProgress(state);
              saveCheckpoint(state);
            }
          }
        } catch (e) {
          console.error(`❌ Chunk processing error:`, e.message);
          await delay(1000);
        }

        // Adaptive delay to stay at TARGET_RPS (RPC calls per second)
        const elapsed = Date.now() - chunkStart;
        const targetMs = Math.floor(chunk.length / TARGET_RPS * 1000);
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
    
    state.status = 'completed';
    saveProgress(state);
    return await finalize(state, scanStartBlockTime);

  } catch (error) {
    console.error('❌ Scanner error:', error);
    state.status = 'error';
    state.error = error.message;
    saveProgress(state);
    throw error;
  }
}

async function finalize(state, scanStartBlockTime) {
  console.log('\n💾 Saving raw traders data...');
  state.status = 'saving';
  saveProgress(state);

  const traderCount = Object.keys(state.traders).length;
  const profitable = Object.values(state.traders).filter(t => t.received > t.spent).length;

  // Write raw traders data (atomic: write to .tmp then rename)
  const tmpFile = TRADERS_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(state.traders));
  fs.renameSync(tmpFile, TRADERS_FILE);
  console.log(`✅ Saved ${traderCount} traders (${profitable} profitable) to traders.json`);

  // Update scan-metadata to mark completion
  fs.writeFileSync(SCAN_METADATA_FILE, JSON.stringify({
    isRunning: false,
    scanStartBlockTime: scanStartBlockTime || null,
    completedAt: new Date().toISOString(),
  }));

  // Clean up checkpoint after successful save
  if (fs.existsSync(CHECKPOINT_FILE)) {
    fs.unlinkSync(CHECKPOINT_FILE);
    console.log('🗑️ Checkpoint cleared');
  }

  // Final progress update
  state.status = 'complete';
  saveProgress(state);

  console.log(`✅ Scanner complete. Server will apply filters on-demand.`);
}

// Start scanner
main().catch(console.error);