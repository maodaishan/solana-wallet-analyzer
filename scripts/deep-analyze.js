/**
 * deep-analyze.js
 * Token-level P&L analyzer: tracks all token trades across all DEXes,
 * calculates realized + unrealized P&L using average cost basis method.
 *
 * Replaces analyze-wallets-v2.js which only tracked SOL balance changes
 * on PumpFun transactions (missed ~50% of trades).
 *
 * Usage: spawned by server.js for both Mode 1 and Mode 2 deep analysis.
 * Env: DEEP_MODE=mode1|mode2 (for logging/progress context)
 */

const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const fs = require('fs');
const path = require('path');

// Paths
const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const USER_WALLETS_FILE = path.join(DATA_DIR, 'user-wallets.json');
const WALLETS_FILE = path.join(DATA_DIR, 'wallets.json');
const DEEP_STATE_FILE = path.join(DATA_DIR, 'deep-state.json');
const DEEP_PROGRESS_FILE = path.join(DATA_DIR, 'deep-progress.json');

// Load config
const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

const HELIUS_KEY = config.heliusApiKey;
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const TARGET_RPS = config.targetRps || 10;
const CHUNK_SIZE = config.chunkSize || 10;
const DAYS_TO_SCAN = config.daysToScan || 30;
const CUTOFF_TIME = Math.floor(Date.now() / 1000) - DAYS_TO_SCAN * 86400;
const DEEP_MODE = process.env.DEEP_MODE || 'mode1';

const WSOL_MINT = 'So11111111111111111111111111111111';
const SOL_MINT = WSOL_MINT;
const JUPITER_PRICE_URL = 'https://api.jup.ag/price/v2';

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// Track whether batch RPC is supported (paid plans only)
let batchSupported = null; // null = unknown, true/false after first attempt

// ============================================================
// RPC Helpers
// ============================================================

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
        const msg = data.error.message || '';
        if (msg.includes('rate') || msg.includes('Too many') || msg.includes('429')) {
          await delay(attempt * 2000);
          continue;
        }
        if (msg.includes('max usage')) {
          throw new Error('CREDITS_EXHAUSTED');
        }
        throw new Error(msg);
      }
      return data.result;
    } catch (e) {
      if (e.message === 'CREDITS_EXHAUSTED') throw e;
      if (attempt === retries) throw e;
      await delay(attempt * 2000);
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
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { throw new Error('Invalid JSON'); }
      if (!Array.isArray(data)) {
        const msg = data.error?.message || '';
        if (msg.includes('Batch requests are only available for paid plans')) {
          batchSupported = false;
          throw new Error('BATCH_NOT_SUPPORTED');
        }
        if (msg.includes('rate') || msg.includes('Too many') || msg.includes('429')) {
          await delay(attempt * 3000);
          continue;
        }
        if (msg.includes('max usage')) {
          throw new Error('CREDITS_EXHAUSTED');
        }
        throw new Error(msg || 'non-array');
      }
      batchSupported = true;
      data.sort((a, b) => a.id - b.id);
      return data.map(d => d.result || null);
    } catch (e) {
      if (e.message === 'BATCH_NOT_SUPPORTED' || e.message === 'CREDITS_EXHAUSTED') throw e;
      if (attempt === retries) throw e;
      await delay(attempt * 2000);
    }
  }
  throw new Error('batchRpc: all retries exhausted');
}

// Fetch transactions for a chunk of signatures, with batch fallback
async function fetchTransactions(sigs) {
  // If batch not supported (or unknown on free plan), use individual requests
  if (batchSupported !== true) {
    if (batchSupported === null) {
      // First call: probe batch support with a quick test
      try {
        const body = [{ jsonrpc: '2.0', id: 0, method: 'getHealth', params: [] }];
        const res = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (Array.isArray(data)) {
          batchSupported = true;
          console.log('  Batch RPC: supported (paid plan)');
        } else {
          batchSupported = false;
          console.log('  Batch RPC: not supported (free plan), using individual requests');
        }
      } catch (e) {
        batchSupported = false;
        console.log('  Batch RPC: probe failed, using individual requests');
      }
    }

    if (batchSupported !== true) {
      const results = [];
      for (const sig of sigs) {
        try {
          const tx = await rpc('getTransaction', [sig, { maxSupportedTransactionVersion: 0 }]);
          results.push(tx);
        } catch (e) {
          if (e.message === 'CREDITS_EXHAUSTED') throw e;
          results.push(null);
        }
      }
      return results;
    }
  }

  // Batch mode
  const requests = sigs.map(sig => ({
    method: 'getTransaction',
    params: [sig, { maxSupportedTransactionVersion: 0 }],
  }));
  return await batchRpc(requests);
}

// ============================================================
// Token Extraction
// ============================================================

function getAllAccounts(tx) {
  const keys = tx.transaction?.message?.accountKeys || [];
  const staticKeys = Array.isArray(keys) ? keys.map(k => k.pubkey || k) : [];
  const loadedW = tx.meta?.loadedAddresses?.writable || [];
  const loadedR = tx.meta?.loadedAddresses?.readonly || [];
  return [...staticKeys, ...loadedW, ...loadedR];
}

function extractTokenChanges(tx, walletAddress) {
  if (!tx || !tx.blockTime || tx.meta?.err) return null;

  const allAccounts = getAllAccounts(tx);
  const walletIndex = allAccounts.indexOf(walletAddress);
  if (walletIndex === -1) return null;

  // SOL change (subtract fee to get pure trade amount)
  const rawSolChange = (tx.meta.postBalances[walletIndex] - tx.meta.preBalances[walletIndex]) / 1e9;
  // Fee is paid by first signer (index 0). If our wallet is the fee payer, add fee back.
  const fee = (tx.meta.fee || 0) / 1e9;
  const isFeePayer = walletIndex === 0;
  const solChange = isFeePayer ? rawSolChange + fee : rawSolChange;

  // Token changes
  const pre = tx.meta.preTokenBalances || [];
  const post = tx.meta.postTokenBalances || [];

  const tokenMap = {};

  for (const entry of pre) {
    if (entry.owner === walletAddress && entry.mint !== WSOL_MINT) {
      if (!tokenMap[entry.mint]) tokenMap[entry.mint] = { pre: 0, post: 0 };
      tokenMap[entry.mint].pre += parseFloat(entry.uiTokenAmount.uiAmountString || '0');
    }
  }

  for (const entry of post) {
    if (entry.owner === walletAddress && entry.mint !== WSOL_MINT) {
      if (!tokenMap[entry.mint]) tokenMap[entry.mint] = { pre: 0, post: 0 };
      tokenMap[entry.mint].post += parseFloat(entry.uiTokenAmount.uiAmountString || '0');
    }
  }

  const tokenChanges = [];
  for (const [mint, bal] of Object.entries(tokenMap)) {
    const delta = bal.post - bal.pre;
    if (Math.abs(delta) < 1e-12) continue;
    tokenChanges.push({ mint, delta });
  }

  return {
    blockTime: tx.blockTime,
    solChange,
    tokenChanges,
  };
}

// ============================================================
// P&L Engine (Average Cost Basis)
// ============================================================

function buildPositions(txRecords) {
  const positions = {};

  function ensurePos(mint, blockTime) {
    if (!positions[mint]) {
      positions[mint] = {
        totalCostSol: 0, totalBought: 0,
        totalRevenueSol: 0, totalSold: 0,
        realized_pnl: 0, buys: 0, sells: 0,
        firstSeen: blockTime, lastSeen: blockTime,
      };
    }
    positions[mint].lastSeen = blockTime;
    return positions[mint];
  }

  for (const record of txRecords) {
    const { blockTime, solChange, tokenChanges } = record;
    if (tokenChanges.length === 0) continue;

    // CASE 1: Single token change + SOL change → simple buy or sell
    if (tokenChanges.length === 1) {
      const { mint, delta } = tokenChanges[0];
      const pos = ensurePos(mint, blockTime);

      if (delta > 0) {
        // BUY: received tokens, spent SOL
        const costSol = Math.max(0, Math.abs(solChange));
        pos.totalCostSol += costSol;
        pos.totalBought += delta;
        pos.buys++;
      } else {
        // SELL: sent tokens, received SOL
        const revenueSol = Math.max(0, solChange);
        const tokensSold = Math.abs(delta);

        // Realized P&L using average cost basis
        const avgCost = pos.totalBought > 0 ? pos.totalCostSol / pos.totalBought : 0;
        const costBasis = avgCost * tokensSold;
        pos.realized_pnl += revenueSol - costBasis;

        pos.totalRevenueSol += revenueSol;
        pos.totalSold += tokensSold;
        pos.sells++;
      }
    }

    // CASE 2: Multiple token changes → token-to-token swap
    else if (tokenChanges.length >= 2) {
      const sent = tokenChanges.filter(tc => tc.delta < 0);
      const received = tokenChanges.filter(tc => tc.delta > 0);

      // Calculate implied SOL value from sent tokens
      let impliedSolValue = 0;
      for (const { mint, delta } of sent) {
        const tokensSold = Math.abs(delta);
        const pos = ensurePos(mint, blockTime);
        const avgCost = pos.totalBought > 0 ? pos.totalCostSol / pos.totalBought : 0;
        impliedSolValue += avgCost * tokensSold;

        const costBasis = avgCost * tokensSold;
        pos.realized_pnl += 0 - costBasis;
        pos.totalSold += tokensSold;
        pos.sells++;
      }

      // Assign implied cost to received tokens
      const totalReceivedCount = received.length || 1;
      for (const { mint, delta } of received) {
        const pos = ensurePos(mint, blockTime);
        const share = impliedSolValue / totalReceivedCount;
        const extraSolCost = Math.abs(Math.min(0, solChange)) / totalReceivedCount;
        pos.totalCostSol += share + extraSolCost;
        pos.totalBought += delta;
        pos.buys++;
      }
    }
  }

  return positions;
}

// ============================================================
// On-chain Data: Holdings & Prices
// ============================================================

async function getTokenHoldings(walletAddress) {
  const result = await rpc('getTokenAccountsByOwner', [
    walletAddress,
    { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
    { encoding: 'jsonParsed' }
  ]);

  const holdings = {};
  for (const acc of (result.value || [])) {
    const info = acc.account.data.parsed.info;
    const mint = info.mint;
    const amount = parseFloat(info.tokenAmount.uiAmountString || '0');
    if (amount > 0 && mint !== WSOL_MINT) {
      holdings[mint] = amount;
    }
  }
  return holdings;
}

async function getTokenPrices(mints) {
  const prices = {};
  for (let i = 0; i < mints.length; i += 100) {
    const batch = mints.slice(i, i + 100);
    try {
      const url = `${JUPITER_PRICE_URL}?ids=${batch.join(',')}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.data) {
        for (const [mint, info] of Object.entries(data.data)) {
          if (info && info.price) {
            prices[mint] = parseFloat(info.price);
          }
        }
      }
    } catch (e) {
      console.log(`  Jupiter price error: ${e.message}`);
    }
    if (i + 100 < mints.length) await delay(200);
  }
  return prices;
}

// ============================================================
// Wallet Summary Calculation
// ============================================================

function calculateWalletSummary(positions, holdings, prices, solBalance, solUsdPrice) {
  let realized_pnl = 0;
  let unrealized_pnl = 0;
  let totalCost = 0;
  let totalRevenue = 0;
  let totalTrades = 0;
  let wins = 0;
  let losses = 0;
  let openPositions = 0;
  const tokenDetails = {};

  for (const [mint, pos] of Object.entries(positions)) {
    realized_pnl += pos.realized_pnl;
    totalCost += pos.totalCostSol;
    totalRevenue += pos.totalRevenueSol;
    totalTrades += pos.buys + pos.sells;

    const holdingAmount = holdings[mint] || 0;
    const computedHolding = Math.max(0, pos.totalBought - pos.totalSold);
    const effectiveHolding = holdingAmount > 0 ? holdingAmount : computedHolding;

    let currentValueSol = 0;
    let tokenUnrealizedPnl = 0;

    if (effectiveHolding > 0) {
      if (prices[mint] && solUsdPrice > 0) {
        const valueSol = (prices[mint] * effectiveHolding) / solUsdPrice;
        currentValueSol = valueSol;
        const avgCost = pos.totalBought > 0 ? pos.totalCostSol / pos.totalBought : 0;
        const costBasis = avgCost * effectiveHolding;
        tokenUnrealizedPnl = valueSol - costBasis;
        unrealized_pnl += tokenUnrealizedPnl;
      }
      openPositions++;
    }

    // Win/loss: only for closed positions (fully sold)
    if (pos.totalSold > 0 && effectiveHolding < 1e-6) {
      if (pos.realized_pnl > 0) wins++;
      else losses++;
    }

    tokenDetails[mint] = {
      cost_sol: parseFloat(pos.totalCostSol.toFixed(6)),
      revenue_sol: parseFloat(pos.totalRevenueSol.toFixed(6)),
      realized_pnl: parseFloat(pos.realized_pnl.toFixed(6)),
      bought: parseFloat(pos.totalBought.toPrecision(8)),
      sold: parseFloat(pos.totalSold.toPrecision(8)),
      holding: parseFloat(effectiveHolding.toPrecision(8)),
      current_value_sol: parseFloat(currentValueSol.toFixed(6)),
      unrealized_pnl: parseFloat(tokenUnrealizedPnl.toFixed(6)),
      buys: pos.buys,
      sells: pos.sells,
    };
  }

  const closedPositions = wins + losses;
  return {
    realized_pnl_sol: parseFloat(realized_pnl.toFixed(4)),
    unrealized_pnl_sol: parseFloat(unrealized_pnl.toFixed(4)),
    total_pnl_sol: parseFloat((realized_pnl + unrealized_pnl).toFixed(4)),
    total_cost_sol: parseFloat(totalCost.toFixed(4)),
    total_revenue_sol: parseFloat(totalRevenue.toFixed(4)),
    total_trades: totalTrades,
    tokens_traded: Object.keys(positions).length,
    winrate: closedPositions > 0 ? parseFloat((wins / closedPositions).toFixed(4)) : 0,
    wins,
    losses,
    open_positions: openPositions,
    sol_balance: parseFloat(solBalance.toFixed(4)),
    tokens: tokenDetails,
  };
}

// ============================================================
// Main Per-Wallet Analysis
// ============================================================

async function analyzeWallet(walletAddress) {
  const txRecords = [];
  let lastSig = null;
  let totalSigs = 0;
  let firstSeen = null;
  let lastSeen = null;

  // Phase A: Fetch all signatures and transactions
  let page = 0;
  while (true) {
    const params = [walletAddress, { limit: 1000, ...(lastSig ? { before: lastSig } : {}) }];
    const sigs = await rpc('getSignaturesForAddress', params);
    if (!sigs || !sigs.length) break;

    const recentSigs = sigs.filter(s => (s.blockTime || 0) >= CUTOFF_TIME);
    const hitCutoff = recentSigs.length < sigs.length;

    page++;
    totalSigs += recentSigs.length;
    console.log(`    Page ${page}: ${recentSigs.length}/${sigs.length} sigs within ${DAYS_TO_SCAN}d (total: ${totalSigs})`);

    if (recentSigs.length === 0) break;

    const successSigs = recentSigs.filter(s => s.err === null);

    // Fetch transactions in chunks
    for (let i = 0; i < successSigs.length; i += CHUNK_SIZE) {
      const chunk = successSigs.slice(i, i + CHUNK_SIZE);
      const chunkStart = Date.now();

      const txs = await fetchTransactions(chunk.map(s => s.signature));
      if (!Array.isArray(txs)) {
        console.log(`    Warning: fetchTransactions returned non-array:`, typeof txs);
        continue;
      }

      for (const tx of txs) {
        const record = extractTokenChanges(tx, walletAddress);
        if (!record) continue;
        // Only record transactions that have token activity
        if (record.tokenChanges.length === 0) continue;

        txRecords.push(record);

        if (!firstSeen || record.blockTime < firstSeen) firstSeen = record.blockTime;
        if (!lastSeen || record.blockTime > lastSeen) lastSeen = record.blockTime;
      }

      if ((i + CHUNK_SIZE) % 100 === 0 || i + CHUNK_SIZE >= successSigs.length) {
        console.log(`    Fetched ${Math.min(i + CHUNK_SIZE, successSigs.length)}/${successSigs.length} txs, token trades: ${txRecords.length}`);
      }

      // Rate limiting
      const elapsed = Date.now() - chunkStart;
      const rpsForChunk = batchSupported === false ? 1 : chunk.length;
      const targetMs = Math.floor(rpsForChunk / TARGET_RPS * 1000);
      const waitMs = Math.max(0, targetMs - elapsed);
      if (waitMs > 0) await delay(waitMs);
    }

    if (hitCutoff) break;
    lastSig = sigs[sigs.length - 1].signature;
    if (sigs.length < 1000) break;
  }

  // Phase B: Sort records oldest-first
  txRecords.sort((a, b) => a.blockTime - b.blockTime);

  // Phase C: Build positions
  const positions = buildPositions(txRecords);

  // Phase D: Get current holdings
  let holdings = {};
  try {
    holdings = await getTokenHoldings(walletAddress);
  } catch (e) {
    console.log(`    Holdings fetch error: ${e.message}`);
  }

  // Phase E: Get prices for held tokens
  const heldMints = Object.keys(holdings).filter(m => holdings[m] > 0);
  // Also price tokens in open positions (computed holding > 0)
  for (const [mint, pos] of Object.entries(positions)) {
    if (pos.totalBought - pos.totalSold > 1e-6 && !heldMints.includes(mint)) {
      heldMints.push(mint);
    }
  }

  let prices = {};
  let solUsdPrice = 150; // fallback
  if (heldMints.length > 0) {
    const allMints = [...new Set([...heldMints, SOL_MINT])];
    try {
      prices = await getTokenPrices(allMints);
      if (prices[SOL_MINT]) {
        solUsdPrice = prices[SOL_MINT];
        delete prices[SOL_MINT];
      }
    } catch (e) {
      console.log(`    Price fetch error: ${e.message}`);
    }
  }

  // Phase F: Get SOL balance
  let solBalance = 0;
  try {
    const balResult = await rpc('getBalance', [walletAddress]);
    solBalance = (balResult?.value || 0) / 1e9;
  } catch (e) {
    console.log(`    SOL balance error: ${e.message}`);
  }

  // Phase G: Calculate summary
  const summary = calculateWalletSummary(positions, holdings, prices, solBalance, solUsdPrice);
  summary.wallet_age_days = firstSeen
    ? parseFloat(((Date.now() / 1000 - firstSeen) / 86400).toFixed(1))
    : 0;
  summary.firstSeen = firstSeen;
  summary.lastSeen = lastSeen;

  return { summary, totalSigs, txCount: txRecords.length };
}

// ============================================================
// Checkpoint / Resume
// ============================================================

function saveProgress(state) {
  fs.writeFileSync(DEEP_PROGRESS_FILE, JSON.stringify(state, null, 2));
}

function saveState(state) {
  const tmp = DEEP_STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DEEP_STATE_FILE);
}

function loadState() {
  try {
    if (fs.existsSync(DEEP_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(DEEP_STATE_FILE, 'utf8'));
    }
  } catch (e) {
    console.log('Failed to load checkpoint:', e.message);
  }
  return null;
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log(`🔍 Deep Token Analyzer Started (${DEEP_MODE})`);

  // Check for resumable checkpoint
  const checkpoint = loadState();
  let userWallets, results, totalCredits, startIndex, prevElapsedMs;
  const resuming = checkpoint && checkpoint.status === 'running' && checkpoint.nextIndex > 0;

  if (resuming) {
    userWallets = checkpoint.wallets;
    results = checkpoint.results || [];
    totalCredits = checkpoint.totalCredits || 0;
    startIndex = checkpoint.nextIndex;
    prevElapsedMs = checkpoint.elapsedMs || 0;
    console.log(`🔄 Resuming from wallet ${startIndex + 1}/${userWallets.length} (${startIndex} done, ${results.length} results)`);
  } else {
    if (!fs.existsSync(USER_WALLETS_FILE)) {
      console.error('No user wallets found');
      process.exit(1);
    }
    userWallets = JSON.parse(fs.readFileSync(USER_WALLETS_FILE, 'utf8'));
    results = [];
    totalCredits = 0;
    startIndex = 0;
    prevElapsedMs = 0;
  }

  console.log(`📋 Deep analyzing ${userWallets.length} wallets (last ${DAYS_TO_SCAN} days)${resuming ? ' [RESUMED]' : ''}`);

  const startTime = Date.now();

  // Save initial state
  saveState({
    status: 'running',
    wallets: userWallets,
    nextIndex: startIndex,
    results,
    totalCredits,
    elapsedMs: prevElapsedMs,
    startedAt: resuming ? checkpoint.startedAt : Date.now(),
    mode: DEEP_MODE,
  });

  for (let i = startIndex; i < userWallets.length; i++) {
    const wallet = userWallets[i];
    console.log(`\n[${i + 1}/${userWallets.length}] ${wallet.slice(0, 8)}...`);

    // Progress before analysis
    const elapsedMs = (Date.now() - startTime) + prevElapsedMs;
    const walletsProcessedThisRun = i - startIndex;
    const avgMs = walletsProcessedThisRun > 0 ? (Date.now() - startTime) / walletsProcessedThisRun : 0;
    const remainingMs = walletsProcessedThisRun > 0 ? avgMs * (userWallets.length - i) : 0;
    saveProgress({
      status: 'deep-analyzing',
      phase: DEEP_MODE === 'mode2' ? 2 : 1,
      processed: i,
      total: userWallets.length,
      currentWallet: wallet,
      traders: results.filter(r => r.total_trades > 0).length,
      profitable: results.filter(r => r.total_pnl_sol > 0).length,
      estimatedCredits: totalCredits,
      elapsedMs,
      remainingMs,
    });

    try {
      const { summary, totalSigs, txCount } = await analyzeWallet(wallet);

      // Estimate credits
      const sigCalls = Math.ceil(totalSigs / 1000);
      const estCredits = sigCalls + txCount + 2; // +2 for holdings + balance
      totalCredits += estCredits;

      const result = {
        wallet_address: wallet,
        ...summary,
      };
      results.push(result);

      console.log(`  Trades: ${summary.total_trades}, Tokens: ${summary.tokens_traded}, Realized: ${summary.realized_pnl_sol} SOL, Unrealized: ${summary.unrealized_pnl_sol} SOL, ~${estCredits} credits`);
    } catch (e) {
      if (e.message === 'CREDITS_EXHAUSTED') {
        console.log(`\n⚠️ Credits exhausted! Saving checkpoint at wallet ${i + 1}/${userWallets.length}`);
        saveState({
          status: 'running',
          wallets: userWallets,
          nextIndex: i,
          results,
          totalCredits,
          elapsedMs: (Date.now() - startTime) + prevElapsedMs,
          startedAt: resuming ? checkpoint.startedAt : startTime,
          mode: DEEP_MODE,
        });
        saveProgress({
          status: 'paused',
          phase: DEEP_MODE === 'mode2' ? 2 : 1,
          processed: i,
          total: userWallets.length,
          traders: results.filter(r => r.total_trades > 0).length,
          profitable: results.filter(r => r.total_pnl_sol > 0).length,
          estimatedCredits: totalCredits,
          error: 'Credits exhausted. Resume when credits are available.',
        });
        // Save partial results
        const sortedPartial = [...results].sort((a, b) => b.total_pnl_sol - a.total_pnl_sol);
        fs.writeFileSync(WALLETS_FILE, JSON.stringify(sortedPartial, null, 2));
        process.exit(2); // special exit code for credits exhausted
      }

      console.error(`  Error: ${e.message}`);
      results.push({
        wallet_address: wallet,
        realized_pnl_sol: 0, unrealized_pnl_sol: 0, total_pnl_sol: 0,
        total_cost_sol: 0, total_revenue_sol: 0, total_trades: 0,
        tokens_traded: 0, winrate: 0, wins: 0, losses: 0,
        open_positions: 0, sol_balance: 0, wallet_age_days: 0,
        tokens: {},
        error: e.message,
      });
    }

    // Save checkpoint after each wallet
    const elapsedMsAfter = (Date.now() - startTime) + prevElapsedMs;
    saveState({
      status: 'running',
      wallets: userWallets,
      nextIndex: i + 1,
      results,
      totalCredits,
      elapsedMs: elapsedMsAfter,
      startedAt: resuming ? checkpoint.startedAt : startTime,
      mode: DEEP_MODE,
    });

    // Save partial results for frontend
    const sortedPartial = [...results].sort((a, b) => b.total_pnl_sol - a.total_pnl_sol);
    const tmp = WALLETS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(sortedPartial, null, 2));
    fs.renameSync(tmp, WALLETS_FILE);

    // Update progress after each wallet
    const walletsAfter = i - startIndex + 1;
    const avgMsAfter = (Date.now() - startTime) / walletsAfter;
    const remainingMsAfter = avgMsAfter * (userWallets.length - i - 1);
    saveProgress({
      status: 'deep-analyzing',
      phase: DEEP_MODE === 'mode2' ? 2 : 1,
      processed: i + 1,
      total: userWallets.length,
      currentWallet: i + 1 < userWallets.length ? userWallets[i + 1] : null,
      traders: results.filter(r => r.total_trades > 0).length,
      profitable: results.filter(r => r.total_pnl_sol > 0).length,
      estimatedCredits: totalCredits,
      elapsedMs: elapsedMsAfter,
      remainingMs: remainingMsAfter,
    });
  }

  // Sort final results
  results.sort((a, b) => b.total_pnl_sol - a.total_pnl_sol);
  fs.writeFileSync(WALLETS_FILE, JSON.stringify(results, null, 2));

  const finalElapsedMs = (Date.now() - startTime) + prevElapsedMs;

  saveState({
    status: 'complete',
    wallets: userWallets,
    nextIndex: userWallets.length,
    results,
    totalCredits,
    elapsedMs: finalElapsedMs,
    startedAt: resuming ? checkpoint.startedAt : startTime,
    mode: DEEP_MODE,
  });

  saveProgress({
    status: 'complete',
    phase: DEEP_MODE === 'mode2' ? 2 : 1,
    processed: userWallets.length,
    total: userWallets.length,
    traders: results.filter(r => r.total_trades > 0).length,
    profitable: results.filter(r => r.total_pnl_sol > 0).length,
    estimatedCredits: totalCredits,
  });

  console.log(`\n✅ Deep analysis complete!`);
  console.log(`  Wallets: ${userWallets.length}`);
  console.log(`  With trades: ${results.filter(r => r.total_trades > 0).length}`);
  console.log(`  Profitable: ${results.filter(r => r.total_pnl_sol > 0).length}`);
  console.log(`  Credits: ~${totalCredits.toLocaleString()}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  saveProgress({ status: 'error', error: e.message });
  process.exit(1);
});
