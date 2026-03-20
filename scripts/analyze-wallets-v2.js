/**
 * analyze-wallets-v2.js 
 * Enhanced wallet analyzer using Scanner logic for accuracy
 * Only analyzes user-uploaded wallets instead of discovering new ones
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

function saveProgress(state) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(state, null, 2));
}

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
  const params = [sig, { maxSupportedTransactionVersion: 0 }];
  return await rpc('getTransaction', params);
}

function parseTx(tx) {
  if (!tx?.meta || tx.meta.err) return null;
  
  const accs = tx.transaction.message.accountKeys.map(a => a.pubkey);
  const pre = tx.meta.preBalances;
  const post = tx.meta.postBalances;
  
  for (let i = 0; i < accs.length; i++) {
    const solChange = (post[i] - pre[i]) / 1e9;
    if (Math.abs(solChange) > 0.001) {
      return { trader: accs[i], solChange };
    }
  }
  
  return null;
}

function filterAndAnalyze(traders, userWalletSet) {
  const results = Object.entries(traders)
    .filter(([wallet, d]) => userWalletSet.has(wallet)) // 🔥 KEY CHANGE: Only analyze user wallets
    .map(([wallet, d]) => ({
      wallet_address: wallet,
      pnl_sol: parseFloat((d.received - d.spent).toFixed(4)),
      txs: d.txs,
      sol_balance: 0, // Would need separate query
      roi_pct: parseFloat((d.spent > 0 ? ((d.received - d.spent) / d.spent * 100) : 0).toFixed(2)),
      winrate: d.received > d.spent ? 60 : 30, // Estimated
      avg_hold_time_min: 0, // Would need complex analysis
      wallet_age_days: 0, // Would need separate query
    }))
    .sort((a, b) => b.pnl_sol - a.pnl_sol);
  
  // Add wallets that weren't found in scanning (with zero data)
  userWalletSet.forEach(wallet => {
    if (!results.find(r => r.wallet_address === wallet)) {
      results.push({
        wallet_address: wallet,
        pnl_sol: 0,
        txs: 0,
        sol_balance: 0,
        roi_pct: 0,
        winrate: 0,
        avg_hold_time_min: 0,
        wallet_age_days: 0,
      });
    }
  });
  
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(results, null, 2));
  return results.length;
}

async function main() {
  console.log('🔍 Enhanced Wallet Analyzer Started');
  
  // Load user wallets
  if (!fs.existsSync(USER_WALLETS_FILE)) {
    console.error('No user wallets found');
    process.exit(1);
  }
  
  const userWallets = JSON.parse(fs.readFileSync(USER_WALLETS_FILE, 'utf8'));
  const userWalletSet = new Set(userWallets);
  console.log(`📋 Analyzing ${userWallets.length} user wallets`);
  
  const cutoff = Math.floor(Date.now() / 1000) - (DAYS_TO_SCAN * 24 * 3600);
  console.log(`📅 Scanning last ${DAYS_TO_SCAN} days`);
  
  const state = {
    status: 'running',
    processed: 0,
    traders: {},
    lastSig: null,
  };
  
  let batch = 0;
  let userWalletsFound = 0;
  
  while (state.status === 'running') {
    batch++;
    console.log(`\n🔄 Batch ${batch}`);
    
    try {
      const sigs = await getSigs(state.lastSig);
      if (!sigs.length) break;
      
      for (const s of sigs) {
        if (s.blockTime && s.blockTime < cutoff) {
          console.log(`\n✅ Reached cutoff`);
          state.status = 'complete';
          saveProgress(state);
          const count = filterAndAnalyze(state.traders, userWalletSet);
          console.log(`💾 Analyzed ${count} wallets (${userWalletsFound} user wallets found in transactions)`);
          return;
        }
        
        await delay(DELAY_MS);
        
        try {
          const tx = await getTx(s.signature);
          const parsed = parseTx(tx);
          
          if (parsed && userWalletSet.has(parsed.trader)) {
            // Only track user wallets
            if (!state.traders[parsed.trader]) {
              state.traders[parsed.trader] = { spent: 0, received: 0, txs: 0 };
              userWalletsFound++;
              console.log(`✨ Found user wallet: ${parsed.trader.slice(0, 8)}... (${userWalletsFound}/${userWallets.length})`);
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
      
      saveProgress({
        status: state.status,
        processed: state.processed,
        total: userWallets.length,
        traders: userWalletsFound,
        profitable: Object.values(state.traders).filter(t => t.received > t.spent).length
      });
      
      console.log(`📊 Progress: ${state.processed} txs, ${userWalletsFound}/${userWallets.length} user wallets found`);
      
      // Early termination if we found all wallets
      if (userWalletsFound >= userWallets.length) {
        console.log(`\n🎯 Found all ${userWallets.length} user wallets, continuing to build complete dataset...`);
      }
      
    } catch (e) {
      console.error(`Batch error:`, e.message);
      await delay(1000);
    }
  }
  
  const count = filterAndAnalyze(state.traders, userWalletSet);
  console.log(`\n✅ Analysis complete! ${count} wallets analyzed (${userWalletsFound} found in transactions)`);
  
  saveProgress({
    status: 'complete',
    processed: state.processed,
    total: userWallets.length,
    traders: userWalletsFound,
    profitable: Object.values(state.traders).filter(t => t.received > t.spent).length
  });
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});