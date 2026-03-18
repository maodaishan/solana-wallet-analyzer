/**
 * Full enhancement for Option B wallets
 * Adds: winrate, avg_hold_time, balances, wallet age
 */

const fs = require('fs');
const path = require('path');

const HELIUS_KEY = '5cf5a1d2-5a04-401c-9185-7f458a63bae7';
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function rpc(method, params) {
  const res = await fetch(HELIUS_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

async function getSolBalance(wallet) {
  try {
    const result = await rpc('getBalance', [wallet]);
    return (result.value || 0) / 1e9;
  } catch (e) {
    return 0;
  }
}

async function getTokenBalances(wallet) {
  try {
    const result = await rpc('getTokenAccountsByOwner', [
      wallet,
      { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
      { encoding: 'jsonParsed' }
    ]);
    
    const balances = { usdc: 0, usdt: 0 };
    for (const acc of result.value || []) {
      const info = acc.account.data.parsed.info;
      const mint = info.mint;
      const amount = parseFloat(info.tokenAmount.uiAmountString || 0);
      if (mint === USDC_MINT) balances.usdc = amount;
      if (mint === USDT_MINT) balances.usdt = amount;
    }
    return balances;
  } catch (e) {
    return { usdc: 0, usdt: 0 };
  }
}

async function getWalletAge(wallet) {
  try {
    const sigs = await rpc('getSignaturesForAddress', [wallet, { limit: 1000 }]);
    if (!sigs || sigs.length === 0) return null;
    
    const oldest = sigs[sigs.length - 1];
    if (oldest.blockTime) {
      const ageSeconds = Math.floor(Date.now() / 1000) - oldest.blockTime;
      const ageDays = Math.floor(ageSeconds / 86400);
      return {
        firstTx: new Date(oldest.blockTime * 1000).toISOString().split('T')[0],
        ageDays
      };
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Calculate winrate and avg hold time by analyzing transactions
async function analyzeTradeHistory(wallet) {
  try {
    // Get parsed transactions from Helius
    const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${HELIUS_KEY}&limit=100`;
    const res = await fetch(url);
    const txs = await res.json();
    
    if (!Array.isArray(txs) || txs.length === 0) {
      return { winrate: 0, avgHoldTimeMin: 0 };
    }
    
    // Track token positions: mint -> { buyTime, buyAmount }
    const positions = {};
    const trades = []; // { profit: number, holdTimeMin: number }
    
    for (const tx of txs.reverse()) { // oldest first
      if (!tx.tokenTransfers) continue;
      
      for (const transfer of tx.tokenTransfers) {
        const mint = transfer.mint;
        const amount = transfer.tokenAmount || 0;
        const timestamp = tx.timestamp * 1000;
        
        // Buy: wallet receives tokens
        if (transfer.toUserAccount === wallet && amount > 0) {
          if (!positions[mint]) {
            positions[mint] = { buyTime: timestamp, totalBought: 0 };
          }
          positions[mint].totalBought += amount;
        }
        
        // Sell: wallet sends tokens
        if (transfer.fromUserAccount === wallet && amount > 0) {
          if (positions[mint] && positions[mint].buyTime) {
            const holdTimeMin = Math.round((timestamp - positions[mint].buyTime) / 60000);
            
            // Check if profitable (simplified: any sell after price went up)
            // Using native transfer amounts as proxy
            const nativeChange = tx.nativeTransfers?.find(
              nt => nt.toUserAccount === wallet
            )?.amount || 0;
            
            trades.push({
              holdTimeMin: Math.max(0, holdTimeMin),
              profit: nativeChange > 0 ? 1 : 0
            });
            
            delete positions[mint];
          }
        }
      }
    }
    
    if (trades.length === 0) {
      return { winrate: 0, avgHoldTimeMin: 0 };
    }
    
    const wins = trades.filter(t => t.profit > 0).length;
    const winrate = Math.round((wins / trades.length) * 100);
    const avgHoldTimeMin = Math.round(
      trades.reduce((sum, t) => sum + t.holdTimeMin, 0) / trades.length
    );
    
    return { winrate, avgHoldTimeMin };
  } catch (e) {
    console.error(`  Error analyzing ${wallet.slice(0,8)}: ${e.message}`);
    return { winrate: 0, avgHoldTimeMin: 0 };
  }
}

async function main() {
  const inputPath = path.join(__dirname, 'output/option-b-enhanced.json');
  const wallets = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  
  console.log(`Enhancing ${wallets.length} wallets with winrate & hold time...\n`);
  
  const enhanced = [];
  
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    console.log(`[${i + 1}/${wallets.length}] ${w.wallet_address.slice(0, 8)}...`);
    
    // Get trade analysis
    await delay(200);
    const tradeStats = await analyzeTradeHistory(w.wallet_address);
    
    // Get fresh balances
    await delay(100);
    const solBalance = await getSolBalance(w.wallet_address);
    
    await delay(100);
    const tokenBalances = await getTokenBalances(w.wallet_address);
    
    // Get wallet age if missing
    let walletAge = { firstTx: w.wallet_first_tx, ageDays: w.wallet_age_days };
    if (!w.wallet_first_tx || w.wallet_first_tx === 'unknown') {
      await delay(100);
      walletAge = await getWalletAge(w.wallet_address) || { firstTx: 'unknown', ageDays: 0 };
    }
    
    enhanced.push({
      rank: w.rank,
      wallet_address: w.wallet_address,
      pnl_sol: w.pnl_sol,
      roi_pct: w.roi_pct,
      winrate: tradeStats.winrate,
      txs: w.txs,
      avg_hold_time_min: tradeStats.avgHoldTimeMin,
      sol_balance: parseFloat(solBalance.toFixed(4)),
      usdc_balance: parseFloat(tokenBalances.usdc.toFixed(2)),
      usdt_balance: parseFloat(tokenBalances.usdt.toFixed(2)),
      wallet_age_days: walletAge.ageDays,
      first_tx_date: walletAge.firstTx
    });
    
    if ((i + 1) % 10 === 0) {
      console.log(`  Progress: ${i + 1}/${wallets.length}`);
      // Save checkpoint
      fs.writeFileSync(
        path.join(__dirname, 'output/option-b-full-checkpoint.json'),
        JSON.stringify(enhanced, null, 2)
      );
    }
  }
  
  // Save final output
  fs.writeFileSync(
    path.join(__dirname, 'output/option-b-full.json'),
    JSON.stringify(enhanced, null, 2)
  );
  
  console.log(`\nDone! Enhanced ${enhanced.length} wallets`);
  console.log('Output: output/option-b-full.json');
}

main().catch(console.error);
