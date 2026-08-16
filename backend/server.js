/**
 * server.js — XAU/USD SCALPER + API USAGE (DEBUG EDITION)
 * ========================================================
 * Fixes:
 * 1. /api/usage now returns tracked credit stats (no external call)
 * 2. Better market-closed detection and messaging
 * 3. Debug logging on every endpoint
 * 4. Graceful fallback when OHLCV is empty but quote works
 */

require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());

// ── SERVE STATIC FRONTEND ──
// Try multiple possible frontend paths
const possiblePaths = [
  path.join(__dirname, 'frontend'),
  path.join(__dirname, '../frontend'),
  path.join(__dirname, 'public'),
  path.join(__dirname, 'dist'),
  __dirname
];

let frontendPath = __dirname;
for (const p of possiblePaths) {
  try {
    require('fs').accessSync(p);
    frontendPath = p;
    break;
  } catch (e) {}
}

console.log('[SERVER] Serving frontend from:', frontendPath);
app.use(express.static(frontendPath));

// ── CONFIG ──
const API_KEY = process.env.TWELVE_DATA_API_KEY || '';
const DEFAULT_PAIRS = ['XAU/USD'];
const pairs = process.env.WATCHLIST ? process.env.WATCHLIST.split(',') : DEFAULT_PAIRS;

console.log('[SERVER] ===========================================');
console.log('[SERVER] Pairs:', pairs.join(', '));
console.log('[SERVER] API Key:', API_KEY ? 'SET (' + API_KEY.substring(0, 6) + '...)' : 'MISSING');
console.log('[SERVER] NODE_ENV:', process.env.NODE_ENV || 'not set');
console.log('[SERVER] ===========================================');

// ── LAZY LOAD SERVICES ──
let TwelveDataService, StrategyEngine, tdService;
let pairState = {};
let servicesLoaded = false;
let servicesError = null;

try {
  TwelveDataService = require('./twelveDataService');
  StrategyEngine = require('./strategyEngine');
  tdService = new TwelveDataService(API_KEY);

  pairs.forEach(sym => {
    pairState[sym] = {
      strategy: new StrategyEngine(process.env),
      ohlcvCache: [],
      lastPrice: null,
      lastSetup: null,
      lastCheck: null
    };
  });

  servicesLoaded = true;
  console.log('[SERVER] Services loaded successfully');
} catch (err) {
  servicesError = err.message;
  console.error('[SERVER] FAILED to load services:', err.message);
  console.error(err.stack);
}

let botState = {
  status: 'PAUSED',
  timeframe: process.env.DEFAULT_TIMEFRAME || '5min',
  pollIntervalMs: (parseInt(process.env.POLL_INTERVAL_SECONDS) || 30) * 1000,
  autoTrade: false,
  uptime: Date.now()
};

let pollTimer = null;

// ═══════════════════════════════════════════════════════════════
// TEST / HEALTH ENDPOINTS
// ═══════════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    apiKeyPresent: !!API_KEY,
    servicesLoaded,
    servicesError,
    pairs,
    serverTime: new Date().toISOString(),
    nodeVersion: process.version
  });
});

app.get('/api/test', (req, res) => {
  res.json({ 
    ok: true, 
    message: 'API is reachable', 
    servicesLoaded, 
    pairs,
    endpoints: ['/health', '/api/test', '/api/status', '/api/market-data', '/api/setup', '/api/trades', '/api/usage', '/api/control']
  });
});

// ═══════════════════════════════════════════════════════════════
// API USAGE ENDPOINT (returns locally tracked stats — no external call)
// ═══════════════════════════════════════════════════════════════

app.get('/api/usage', (req, res) => {
  console.log('[API] GET /api/usage');

  if (!servicesLoaded) {
    return res.status(503).json({ 
      error: 'Services not loaded',
      detail: servicesError || 'Check server logs'
    });
  }

  const stats = tdService.getCreditStats();

  // If we've never made a request, stats will be all zeros
  // Return a friendly message in that case
  const hasData = stats.lastUpdated !== null;

  res.json({
    plan: stats.plan || 'Unknown',
    apiCreditsUsed: stats.used,
    apiCreditsRemaining: stats.remaining,
    apiCreditsLimit: stats.total || (stats.used + stats.remaining) || 100,
    requestsThisMinute: stats.requestsThisMinute,
    minuteResetAt: stats.minuteResetAt,
    lastUpdated: stats.lastUpdated,
    hasData,
    message: hasData ? null : 'No API requests made yet. Credits will appear after first market data call.',
    timestamp: new Date().toISOString()
  });
});

// ═══════════════════════════════════════════════════════════════
// MAIN API ROUTES
// ═══════════════════════════════════════════════════════════════

app.get('/api/status', (req, res) => {
  console.log('[API] GET /api/status');

  if (!servicesLoaded) {
    return res.status(503).json({ error: 'Services not loaded', detail: servicesError });
  }

  const portfolio = getGlobalPortfolio();
  res.json({
    bot: {
      status: botState.status,
      pairs,
      timeframe: botState.timeframe,
      autoTrade: botState.autoTrade,
      uptime: Date.now() - botState.uptime
    },
    strategy: {
      name: 'XAU/USD Scalping Strategy',
      indicators: {
        emaFast: parseInt(process.env.EMA_FAST_PERIOD || 9),
        emaSlow: parseInt(process.env.EMA_SLOW_PERIOD || 21),
        rsiPeriod: parseInt(process.env.RSI_PERIOD || 14)
      },
      riskRules: {
        maxRiskPerTrade: parseFloat(process.env.MAX_RISK_PER_TRADE_PCT || 2) + '%',
        defaultStopLoss: parseFloat(process.env.DEFAULT_STOP_LOSS_PCT || 1.5) + '%',
        defaultTakeProfit: parseFloat(process.env.DEFAULT_TAKE_PROFIT_PCT || 3) + '%',
        maxPositions: parseInt(process.env.MAX_POSITIONS || 3)
      }
    },
    pairSummaries: pairs.map(sym => ({
      symbol: sym,
      lastPrice: pairState[sym]?.lastPrice,
      lastCheck: pairState[sym]?.lastCheck,
      activePositions: pairState[sym]?.strategy?.getActivePositions()?.length || 0
    })),
    portfolio,
    serverTime: new Date().toISOString()
  });
});

app.get('/api/market-data', async (req, res) => {
  const symbol = req.query.symbol || 'XAU/USD';
  console.log(`[API] GET /api/market-data?symbol=${symbol}`);

  if (!servicesLoaded) {
    return res.status(503).json({ error: 'Services not loaded', detail: servicesError });
  }
  if (!API_KEY) {
    return res.status(503).json({ error: 'TWELVE_DATA_API_KEY not set' });
  }

  try {
    if (symbol === 'ALL') {
      const results = {};
      let anySuccess = false;
      let lastError = null;

      for (const sym of pairs) {
        try {
          const quote = await tdService.getQuote(sym);
          results[sym] = {
            quote: quote?.error ? { error: true, message: quote.message, code: quote.code } : quote,
            timestamp: new Date().toISOString()
          };

          if (quote && !quote.error && quote.price) {
            anySuccess = true;
            if (pairState[sym]) {
              pairState[sym].lastPrice = quote.price;
              pairState[sym].strategy.updatePositions(quote.price);
            }
          } else if (quote?.error) {
            lastError = quote.message;
          }
        } catch (err) {
          console.error(`[API] Quote error for ${sym}:`, err.message);
          results[sym] = {
            quote: { error: true, message: err.message },
            timestamp: new Date().toISOString()
          };
        }
      }

      return res.json({ 
        allPairs: results, 
        anySuccess,
        lastError,
        timestamp: new Date().toISOString() 
      });
    }

    const quote = await tdService.getQuote(symbol);

    if (quote?.error) {
      console.log(`[API] Quote returned error for ${symbol}:`, quote.message);
      return res.status(200).json({ 
        symbol, 
        quote,
        marketClosed: quote.message?.toLowerCase().includes('market') || quote.code === 404,
        timestamp: new Date().toISOString()
      });
    }

    const ohlcv = await tdService.getTimeSeries(symbol, botState.timeframe, 100);

    if (pairState[symbol]) {
      pairState[symbol].ohlcvCache = ohlcv;
      if (quote?.price) {
        pairState[symbol].lastPrice = quote.price;
        pairState[symbol].strategy.updatePositions(quote.price);
      }
    }

    res.json({ symbol, quote, ohlcv: ohlcv.slice(0, 50), timestamp: new Date().toISOString() });

  } catch (err) {
    console.error('[API /api/market-data] ERROR:', err.message);
    res.status(500).json({ error: err.message, symbol, stack: err.stack });
  }
});

app.get('/api/setup', async (req, res) => {
  const symbol = req.query.symbol || 'XAU/USD';
  const scanAll = req.query.scan === 'true';
  console.log(`[API] GET /api/setup?symbol=${symbol}&scan=${scanAll}`);

  if (!servicesLoaded) {
    console.error('[API /api/setup] Services not loaded');
    return res.status(503).json({ 
      error: 'Services not loaded', 
      detail: servicesError || 'Backend services failed to initialize. Check logs.'
    });
  }
  if (!API_KEY) {
    console.error('[API /api/setup] API key missing');
    return res.status(503).json({
      error: 'TWELVE_DATA_API_KEY not configured',
      message: 'Add your Twelve Data API key to environment variables',
      setup: null, signal: 'HOLD', score: 0
    });
  }

  if (!pairState[symbol]) {
    console.error(`[API /api/setup] Invalid symbol: ${symbol}`);
    return res.status(400).json({
      error: `Symbol ${symbol} not in watchlist`,
      validSymbols: pairs,
      setup: null, signal: 'HOLD', score: 0
    });
  }

  if (scanAll) {
    const setups = [];
    for (const sym of pairs) {
      try {
        let ohlcv = pairState[sym].ohlcvCache || [];
        if (ohlcv.length < 30) {
          ohlcv = await tdService.getTimeSeries(sym, botState.timeframe, 100);
          pairState[sym].ohlcvCache = ohlcv;
        }
        const quote = await tdService.getQuote(sym);

        if (quote?.error) {
          console.log(`[SCAN] Quote error for ${sym}:`, quote.message);
          continue;
        }

        if (quote?.price) {
          const setup = pairState[sym].strategy.generateSetup(ohlcv, quote.price, sym);
          pairState[sym].lastSetup = setup;
          setups.push(setup);
        }
      } catch (err) {
        console.error(`[SCAN] Error for ${sym}:`, err.message);
      }
    }
    setups.sort((a, b) => b.score - a.score);
    return res.json({ scan: true, setups, count: setups.length, timestamp: new Date().toISOString() });
  }

  // Single pair setup
  try {
    let ohlcv = pairState[symbol].ohlcvCache || [];

    // Try to fetch OHLCV if we don't have enough cached
    if (ohlcv.length < 30) {
      console.log(`[API /api/setup] Fetching OHLCV for ${symbol} (${botState.timeframe})`);
      ohlcv = await tdService.getTimeSeries(symbol, botState.timeframe, 100);
      pairState[symbol].ohlcvCache = ohlcv;
    }

    console.log(`[API /api/setup] Fetching quote for ${symbol}`);
    const quote = await tdService.getQuote(symbol);

    if (quote?.error) {
      console.error(`[API /api/setup] Quote error:`, quote.message);

      // Check if it's a market closed error
      const isMarketClosed = quote.message?.toLowerCase().includes('market') || 
                             quote.message?.toLowerCase().includes('closed') ||
                             quote.code === 404;

      return res.status(200).json({
        error: isMarketClosed ? 'MARKET_CLOSED' : 'QUOTE_ERROR',
        detail: quote.message,
        symbol,
        marketClosed: isMarketClosed,
        setup: null, 
        signal: 'HOLD', 
        score: 0
      });
    }

    if (!quote?.price) {
      return res.status(503).json({ 
        error: 'Unable to fetch current price',
        symbol,
        setup: null, signal: 'HOLD', score: 0
      });
    }

    console.log(`[API /api/setup] Generating setup for ${symbol} at ${quote.price}, OHLCV: ${ohlcv.length} candles`);

    if (ohlcv.length < 30) {
      return res.status(200).json({
        error: 'INSUFFICIENT_DATA',
        detail: `Only ${ohlcv.length} candles available. Need at least 30 for analysis.`,
        symbol,
        setup: null,
        signal: 'HOLD',
        score: 0
      });
    }

    const setup = pairState[symbol].strategy.generateSetup(ohlcv, quote.price, symbol);
    pairState[symbol].lastSetup = setup;

    console.log(`[API /api/setup] Result: ${setup.signal} (${setup.score}%)`);
    res.json(setup);

  } catch (err) {
    console.error('[API /api/setup] UNCAUGHT ERROR:', err.message);
    console.error(err.stack);
    res.status(500).json({ 
      error: 'INTERNAL_ERROR',
      detail: err.message,
      symbol,
      setup: null, signal: 'HOLD', score: 0
    });
  }
});

app.post('/api/setup/execute', async (req, res) => {
  console.log('[API] POST /api/setup/execute', req.body);

  if (!servicesLoaded) return res.status(503).json({ error: 'Services not loaded' });

  const { symbol } = req.body;
  const targetSymbol = symbol || 'XAU/USD';

  if (!pairState[targetSymbol]?.lastSetup) {
    return res.status(400).json({ error: 'No setup generated yet for this pair.' });
  }

  try {
    const quote = await tdService.getQuote(targetSymbol);
    if (!quote?.price) {
      return res.status(503).json({ error: 'Unable to fetch current price', detail: quote?.message });
    }

    const position = pairState[targetSymbol].strategy.openPosition(pairState[targetSymbol].lastSetup, quote.price);

    if (position.error) {
      return res.status(400).json({ error: position.error });
    }

    res.json({ message: 'Position opened', position, setup: pairState[targetSymbol].lastSetup });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/trades', (req, res) => {
  console.log('[API] GET /api/trades');

  if (!servicesLoaded) return res.status(503).json({ error: 'Services not loaded' });

  const allActive = [];
  const allHistory = [];

  pairs.forEach(sym => {
    if (pairState[sym]?.strategy) {
      allActive.push(...pairState[sym].strategy.getActivePositions());
      allHistory.push(...pairState[sym].strategy.getTradeHistory(50));
    }
  });

  allHistory.sort((a, b) => new Date(b.closeTime || 0) - new Date(a.closeTime || 0));

  res.json({
    activePositions: allActive,
    tradeHistory: allHistory.slice(0, 50),
    portfolio: getGlobalPortfolio()
  });
});

app.post('/api/positions/:id/close', async (req, res) => {
  console.log(`[API] POST /api/positions/${req.params.id}/close`);

  if (!servicesLoaded) return res.status(503).json({ error: 'Services not loaded' });

  const { id } = req.params;
  const { symbol } = req.body;

  let targetSymbol = symbol;
  let targetEngine = null;

  if (targetSymbol && pairState[targetSymbol]?.strategy) {
    targetEngine = pairState[targetSymbol].strategy;
  } else {
    for (const sym of pairs) {
      const pos = pairState[sym]?.strategy?.getActivePositions()?.find(p => p.id === id);
      if (pos) {
        targetSymbol = sym;
        targetEngine = pairState[sym].strategy;
        break;
      }
    }
  }

  if (!targetEngine) {
    return res.status(404).json({ error: 'Position not found in any pair' });
  }

  try {
    const quote = await tdService.getQuote(targetSymbol);
    const currentPrice = quote?.price || null;

    if (!currentPrice) {
      return res.status(503).json({ error: 'Unable to fetch current price', detail: quote?.message });
    }

    const result = targetEngine.closePosition(id, currentPrice, 'MANUAL');

    if (result.error) {
      return res.status(404).json(result);
    }

    res.json({ message: 'Position closed', position: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/control', (req, res) => {
  console.log('[API] POST /api/control', req.body);

  if (!servicesLoaded) return res.status(503).json({ error: 'Services not loaded' });

  const { action, settings } = req.body;

  switch (action) {
    case 'START':
      botState.status = 'ACTIVE';
      startPolling();
      break;
    case 'PAUSE':
      botState.status = 'PAUSED';
      stopPolling();
      break;
    case 'UPDATE':
      if (settings) {
        if (settings.timeframe) botState.timeframe = settings.timeframe;
        if (settings.autoTrade !== undefined) botState.autoTrade = settings.autoTrade;
        if (settings.pollIntervalSeconds) {
          botState.pollIntervalMs = settings.pollIntervalSeconds * 1000;
          if (botState.status === 'ACTIVE') {
            stopPolling();
            startPolling();
          }
        }
      }
      break;
    default:
      return res.status(400).json({ error: 'Invalid action. Use START, PAUSE, or UPDATE' });
  }

  res.json({ message: `Bot ${action.toLowerCase()}ed`, state: botState });
});

// ═══════════════════════════════════════════════════════════════
// CATCH-ALL — MUST BE LAST
// ═══════════════════════════════════════════════════════════════
app.get('*', (req, res) => {
  // Don't serve index.html for API routes that 404
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ 
      error: 'API endpoint not found',
      path: req.path,
      available: ['/health', '/api/test', '/api/status', '/api/market-data', '/api/setup', '/api/trades', '/api/usage', '/api/control']
    });
  }
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function getGlobalPortfolio() {
  let totalUnrealized = 0, totalRealized = 0, totalTrades = 0, totalWins = 0, activeCount = 0;

  pairs.forEach(sym => {
    if (pairState[sym]?.strategy) {
      const port = pairState[sym].strategy.getPortfolio();
      totalUnrealized += port.unrealizedPnL;
      totalRealized += port.realizedPnL;
      totalTrades += port.totalTrades;
      totalWins += Math.round(port.totalTrades * (parseFloat(port.winRate) / 100));
      activeCount += port.activePositions;
    }
  });

  return {
    activePositions: activeCount,
    totalTrades,
    winRate: totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : 0,
    unrealizedPnL: parseFloat(totalUnrealized.toFixed(2)),
    realizedPnL: parseFloat(totalRealized.toFixed(2)),
    totalPnL: parseFloat((totalUnrealized + totalRealized).toFixed(2))
  };
}

async function pollMarket() {
  if (botState.status !== 'ACTIVE' || !servicesLoaded) return;

  console.log(`[POLL] Scanning ${pairs.length} pairs`);

  for (const sym of pairs) {
    try {
      const ohlcv = await tdService.getTimeSeries(sym, botState.timeframe, 100);
      if (pairState[sym]) pairState[sym].ohlcvCache = ohlcv;

      const quote = await tdService.getQuote(sym);
      if (quote?.price && pairState[sym]) {
        pairState[sym].lastPrice = quote.price;
        pairState[sym].lastCheck = new Date().toISOString();
        pairState[sym].strategy.updatePositions(quote.price);
      }
    } catch (err) {
      console.error(`[POLL] Error for ${sym}:`, err.message);
    }
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollMarket, botState.pollIntervalMs);
  console.log(`[BOT] Polling started: ${pairs.length} pairs, ${botState.pollIntervalMs}ms`);
  pollMarket();
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log('[BOT] Polling stopped');
  }
}

process.on('SIGTERM', () => { stopPolling(); process.exit(0); });
process.on('SIGINT', () => { stopPolling(); process.exit(0); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  XAU/USD SCALPER BOT — DEBUG EDITION                     ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  Port: ${PORT}                                           ║`);
  console.log(`║  Test:  curl http://localhost:${PORT}/api/test           ║`);
  console.log(`║  Usage: curl http://localhost:${PORT}/api/usage        ║`);
  console.log(`║  Pairs: ${pairs.join(', ')}                              ║`);
  console.log(`║  API Key: ${API_KEY ? 'SET' : 'MISSING'}                                    ║`);
  console.log('╚════════════════════════════════════════════════════════════╝');
});
