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
const PUMPFUN = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const DAYS_TO_SCAN = config.daysToScan || 7;
const DELAY_MS = config.delayMs || 40;

// Filters
const FILTERS = {
  minTxs: config.minTxs || 10,
  minWinrate: config.minWinrate || 0.4,
  minRoi: config.minRoi || 0.5,
  minProfit: config.minProfit || 10,
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

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

async function getSigs(before = null) {
  const params = [PUMPFUN, { limit: 1000, ...(before ? { before: before } : {}) }];
  return await rpc('getSignaturesForAddress', params);
}

function extractTrade(tx) {
  if (!tx.blockTime || tx.meta.err) return null;
  
  const signers = tx.transaction.message.accountKeys.filter(k => k.signer).map(k => k.pubkey);
  if (!signers.length) return null;
  
  const trader = signers[0];
  const solChange = (tx.meta.postBalances[0] - tx.meta.preBalances[0]) / 1e9;
  
  return { trader, solChange, blockTime: tx.blockTime };
}

function saveProgress(state) {
  const now = Date.now();
  const currentBlockTime = state.currentBlockTime || now;
  const timeProgress = Math.max(0, Math.min(1, (scanEndTime - currentBlockTime * 1000) / (scanEndTime - targetStartTime)));
  const timeProgressPercent = Math.round(timeProgress * 100);
  
  // Calculate ETA
  const elapsedMs = now - state.scanStartRealTime;
  const estimatedTotalMs = timeProgress > 0 ? elapsedMs / timeProgress : 0;
  const remainingMs = estimatedTotalMs - elapsedMs;
  const eta = remainingMs > 0 ? new Date(now + remainingMs).toISOString() : null;
  
  const progressData = {
    // Existing fields
    processed: state.processed,
    traders: Object.keys(state.traders).length,
    profitable: Object.values(state.traders).filter(t => t.received > t.spent).length,
    startTime: state.startTime,
    lastUpdate: new Date().toISOString(),
    status: state.status || 'running',
    
    // Enhanced time tracking
    currentBlockTime: currentBlockTime,
    currentBlockTimeFormatted: new Date(currentBlockTime * 1000).toLocaleString(),
    targetStartTime: Math.floor(targetStartTime / 1000),
    targetStartTimeFormatted: new Date(targetStartTime).toLocaleString(),
    scanEndTime: Math.floor(scanEndTime / 1000),
    scanEndTimeFormatted: new Date(scanEndTime).toLocaleString(),
    
    // Progress metrics
    timeProgress: timeProgress,
    timeProgressPercent: timeProgressPercent,
    estimatedTotalMs: estimatedTotalMs,
    elapsedMs: elapsedMs,
    remainingMs: Math.max(0, remainingMs),
    eta: eta,
    etaFormatted: eta ? new Date(eta).toLocaleString() : null,
    
    // Additional stats
    avgTxsPerSecond: state.processed / (elapsedMs / 1000),
    daysScanned: (scanEndTime - currentBlockTime * 1000) / (1000 * 60 * 60 * 24)
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
  
  // Load checkpoint if exists
  if (fs.existsSync(CHECKPOINT_FILE)) {
    try {
      const checkpoint = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
      console.log(`📌 Resuming: ${checkpoint.processed} txs, ${Object.keys(checkpoint.traders).length} traders`);
      state = { ...state, ...checkpoint, scanStartRealTime: Date.now() - (checkpoint.timestamp || 0) };
    } catch (e) {
      console.log('❌ Failed to load checkpoint, starting fresh');
    }
  }
  
  try {
    while (true) {
      const sigs = await getSigs(state.lastSig);
      if (!sigs.length) break;
      
      console.log(`📡 Processing batch: ${sigs.length} signatures`);
      
      // Process in chunks to avoid memory issues
      const CHUNK_SIZE = 100;
      for (let i = 0; i < sigs.length; i += CHUNK_SIZE) {
        const chunk = sigs.slice(i, i + CHUNK_SIZE);
        
        try {
const txPromises = chunk.map(sig => rpc("getTransaction", [sig.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]));          const txs = await Promise.all(txPromises);
          
          for (const tx of txs) {
            if (!tx) continue;
            
            // Update current block time for progress tracking
            if (tx.blockTime) {
              state.currentBlockTime = tx.blockTime;
            }
            
            // Check if we've reached our time limit
            if (tx.blockTime && tx.blockTime < targetStartTime / 1000) {
              console.log(`⏰ Reached time limit: ${new Date(tx.blockTime * 1000).toLocaleString()}`);
              state.status = 'completed';
              saveProgress(state);
              return await finalize(state);
            }
            
            const trade = extractTrade(tx);
            if (!trade) continue;
            
            const trader = trade.trader;
            if (!state.traders[trader]) {
              state.traders[trader] = { spent: 0, received: 0, txs: 0 };
            }
            
            if (trade.solChange < 0) {
              state.traders[trader].spent += Math.abs(trade.solChange);
            } else {
              state.traders[trader].received += trade.solChange;
            }
            state.traders[trader].txs++;
            
            state.processed++;
            
            // Save progress every 100 transactions
            if (state.processed % 100 === 0) {
              saveProgress(state);
              saveCheckpoint(state);
            }
          }
          
        } catch (e) {
          console.error(`❌ Batch processing error:`, e.message);
          await delay(DELAY_MS * 2); // Double delay on error
        }
        
        await delay(DELAY_MS);
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
    return await finalize(state);
    
  } catch (error) {
    console.error('❌ Scanner error:', error);
    state.status = 'error';
    state.error = error.message;
    saveProgress(state);
    throw error;
  }
}

async function finalize(state) {
  console.log('\n🔍 Analysis phase starting...');
  state.status = 'analyzing';
  saveProgress(state);
  
  const validTraders = Object.entries(state.traders).filter(([_, data]) => {
    const profit = data.received - data.spent;
    const roi = data.spent > 0 ? profit / data.spent : 0;
    const winrate = data.txs > 0 ? (data.received > 0 ? 1 : 0) : 0; // Simplified
    
    return (
      data.txs >= FILTERS.minTxs &&
      roi >= FILTERS.minRoi &&
      winrate >= FILTERS.minWinrate &&
      profit >= FILTERS.minProfit
    );
  });
  
  const results = validTraders.map(([address, data]) => ({
    address,
    totalTxs: data.txs,
    totalSpent: data.spent,
    totalReceived: data.received,
    totalProfit: data.received - data.spent,
    roi: data.spent > 0 ? (data.received - data.spent) / data.spent : 0,
    winrate: data.txs > 0 ? (data.received > 0 ? 1 : 0) : 0, // Simplified
    avgHoldDays: 1, // Placeholder
    balance: 0 // Placeholder
  }));
  
  console.log(`✅ Analysis complete: ${results.length} profitable wallets found`);
  
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(results, null, 2));
  
  // Final progress update
  state.status = 'complete';
  saveProgress(state);
  
  return results;
}

// Start scanner
main().catch(console.error);