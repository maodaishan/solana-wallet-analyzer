/**
 * PumpFun On-Chain Scanner
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
  const params = [PUMPFUN, { limit: 1000, ...(before && { before }) }];
  return await rpc('getSignaturesForAddress', params);
}

async function getTx(sig) {
  return await rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
}

function parseTx(tx) {
  if (!tx || !tx.meta || tx.meta.err) return null;
  
  const signers = tx.transaction.message.accountKeys.filter(k => k.signer).map(k => k.pubkey);
  if (!signers.length) return null;
  
  const trader = signers[0];
  const solChange = (tx.meta.postBalances[0] - tx.meta.preBalances[0]) / 1e9;
  
  return { trader, solChange, blockTime: tx.blockTime };
}

function saveProgress(state) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({
    processed: state.processed,
    traders: Object.keys(state.traders).length,
    profitable: Object.values(state.traders).filter(t => t.received > t.spent).length,
    startTime: state.startTime,
    lastUpdate: new Date().toISOString(),
    status: state.status || 'running'
  }, null, 2));
}

function saveCheckpoint(state) {
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify({
    lastSig: state.lastSig,
    processed: state.processed,
    traders: state.traders,
    startTime: state.startTime
  }));
}

function loadCheckpoint() {
  if (fs.existsSync(CHECKPOINT_FILE)) {
    return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
  }
  return null;
}

function filterAndSave(traders) {
  const results = Object.entries(traders)
    .map(([wallet, d]) => ({
      wallet_address: wallet,
      profit_7d: d.received - d.spent,
      txs_7d: d.txs,
      sol_spent: d.spent,
      sol_received: d.received,
      roi: d.spent > 0 ? (d.received - d.spent) / d.spent : 0,
      winrate_7d: d.received > d.spent ? 0.6 : 0.3, // Estimated
    }))
    .filter(t => 
      t.profit_7d > 0 && 
      t.txs_7d >= FILTERS.minTxs &&
      t.roi >= FILTERS.minRoi &&
      t.profit_7d >= FILTERS.minProfit
    )
    .sort((a, b) => b.profit_7d - a.profit_7d);
  
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(results, null, 2));
  return results.length;
}

async function main() {
  console.log('🔍 PumpFun Scanner Started');
  console.log(`📅 Scanning last ${DAYS_TO_SCAN} days\n`);
  
  // Load or init state
  let state = loadCheckpoint() || {
    lastSig: null,
    processed: 0,
    traders: {},
    startTime: new Date().toISOString()
  };
  
  if (state.processed > 0) {
    console.log(`📌 Resuming: ${state.processed} txs, ${Object.keys(state.traders).length} traders\n`);
  }
  
  state.status = 'running';
  saveProgress(state);
  
  const cutoff = Math.floor(Date.now() / 1000) - (DAYS_TO_SCAN * 86400);
  let batch = 0;
  
  while (true) {
    try {
      const sigs = await getSigs(state.lastSig);
      if (!sigs.length) { 
        console.log('No more signatures'); 
        break; 
      }
      
      batch++;
      let batchTraders = 0;
      
      for (const s of sigs) {
        if (s.blockTime && s.blockTime < cutoff) {
          console.log(`\n✅ Reached cutoff.`);
          state.status = 'complete';
          saveProgress(state);
          const count = filterAndSave(state.traders);
          console.log(`💾 Saved ${count} filtered wallets`);
          return;
        }
        
        await delay(DELAY_MS);
        
        try {
          const tx = await getTx(s.signature);
          const parsed = parseTx(tx);
          
          if (parsed) {
            if (!state.traders[parsed.trader]) {
              state.traders[parsed.trader] = { spent: 0, received: 0, txs: 0 };
              batchTraders++;
            }
            
            state.traders[parsed.trader].txs++;
            if (parsed.solChange < 0) {
              state.traders[parsed.trader].spent += Math.abs(parsed.solChange);
            } else {
              state.traders[parsed.trader].received += parsed.solChange;
            }
          }
          
          state.processed++;
        } catch (e) {
          // Skip failed tx
        }
        
        state.lastSig = s.signature;
      }
      
      // Save checkpoint & progress
      saveCheckpoint(state);
      saveProgress(state);
      
      // Periodically save filtered results
      if (batch % 10 === 0) {
        filterAndSave(state.traders);
      }
      
      const traderCount = Object.keys(state.traders).length;
      const profitable = Object.values(state.traders).filter(t => t.received > t.spent).length;
      console.log(`Batch ${batch}: ${state.processed} txs | ${traderCount} traders | ${profitable} profitable`);
      
    } catch (e) {
      console.error('Batch error:', e.message);
      await delay(5000);
    }
  }
  
  state.status = 'complete';
  saveProgress(state);
  const count = filterAndSave(state.traders);
  console.log(`\n✅ Done! Saved ${count} filtered wallets`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
