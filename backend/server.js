/**
 * server.js — XAU/USD SCALPER (SINGLE SERVICE DEPLOYMENT)
 * ==========================================================
 * Repo structure:
 *   /frontend  → static files (index.html, style.css, app.js)
 *   /backend   → this file + node_modules
 *
 * Render start command:  node backend/server.js
 * Render root directory:  / (repo root)  OR  /backend
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('fs');
const nodePath = require('path');

const app = express();

// ── CORS ──
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// ── CONFIG ──
const API_KEY = process.env.TWELVE_DATA_API_KEY || '';
const PAIRS = ['XAU/USD']; // LOCKED: only XAU/USD
const DEMO_MODE = !API_KEY || API_KEY.length < 10;

let demoMode = DEMO_MODE; // Can be toggled at runtime

console.log('[SERVER] ===========================================');
console.log('[SERVER] Pairs:', PAIRS.join(', '));
console.log('[SERVER] API Key:', API_KEY ? 'SET (' + API_KEY.substring(0, 6) + '...)' : 'MISSING');
console.log('[SERVER] Initial Demo Mode:', demoMode);
console.log('[SERVER] NODE_ENV:', process.env.NODE_ENV || 'not set');
console.log('[SERVER] __dirname:', __dirname);
console.log('[SERVER] ===========================================');

// ── RESOLVE FRONTEND PATH (works whether root is repo or backend/) ──
function resolveFrontendPath() {
  const candidates = [
    nodePath.join(__dirname, '../frontend'),   // if running from backend/
    nodePath.join(__dirname, 'frontend'),        // if root is repo root
    nodePath.join(__dirname, '../public'),
    nodePath.join(__dirname, 'public'),
    nodePath.join(__dirname, 'dist'),
    __dirname
  ];

  for (const p of candidates) {
    const indexFile = nodePath.join(p, 'index.html');
    try {
      if (path.existsSync(indexFile)) {
        console.log('[SERVER] Frontend found at:', p);
        return p;
      }
    } catch (e) {}
  }

  console.warn('[SERVER] WARNING: index.html not found in any candidate path');
  return __dirname;
}

const FRONTEND_PATH = resolveFrontendPath();

// ── LAZY LOAD SERVICES ──
let TwelveDataService, StrategyEngine, tdService;
let pairState = {};
let servicesLoaded = false;
let servicesError = null;

try {
  TwelveDataService = require('./twelveDataService');
  StrategyEngine = require('./strategyEngine');
  tdService = new TwelveDataService(API_KEY);

  PAIRS.forEach(sym => {
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
// DEMO DATA GENERATORS
// ═══════════════════════════════════════════════════════════════

function generateDemoQuote(symbol) {
  // Realistic XAU/USD price ~ 2435.00 ± small noise
  const base = 2435.00;
  const noise = (Math.random() - 0.5) * 3.5;
  const price = base + noise;
  const change = noise;
  return {
    price: parseFloat(price.toFixed(2)),
    change: parseFloat(change.toFixed(2)),
    changePercent: parseFloat(((change / base) * 100).toFixed(3)),
    volume: Math.floor(Math.random() * 800000) + 200000,
    high: parseFloat((price + Math.abs(noise) + 1.2).toFixed(2)),
    low: parseFloat((price - Math.abs(noise) - 1.2).toFixed(2)),
    open: parseFloat((price - noise * 0.3).toFixed(2)),
    timestamp: new Date().toISOString()
  };
}

function generateDemoOHLCV(count = 100) {
  const data = [];
  let price = 2433.50;
  const now = new Date();
  for (let i = count; i >= 0; i--) {
    const t = new Date(now.getTime() - i * 5 * 60000);
    const change = (Math.random() - 0.5) * 1.8;
    price += change;
    data.push({
      datetime: t.toISOString().slice(0, 19).replace('T', ' '),
      open: parseFloat((price - 0.8).toFixed(2)),
      high: parseFloat((price + 1.0).toFixed(2)),
      low: parseFloat((price - 1.0).toFixed(2)),
      close: parseFloat(price.toFixed(2)),
      volume: Math.floor(Math.random() * 40000 + 10000).toString()
    });
  }
  return data;
}

// ═══════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    apiKeyPresent: !!API_KEY,
    demoMode,
    servicesLoaded,
    servicesError,
    pairs: PAIRS,
    serverTime: new Date().toISOString()
  });
});

app.get('/api/test', (req, res) => {
  res.json({
    ok: true,
    message: 'API is reachable',
    demoMode,
    servicesLoaded,
    pairs: PAIRS,
    endpoints: ['/health', '/api/test', '/api/status', '/api/market-data', '/api/setup', '/api/trades', '/api/usage', '/api/control', '/api/demo']
  });
});

// ── DEMO TOGGLE ──
app.get('/api/demo', (req, res) => {
  res.json({ demoMode, timestamp: new Date().toISOString() });
});

app.post('/api/demo', (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled === 'boolean') {
    demoMode = enabled;
    console.log('[SERVER] Demo mode set to:', demoMode);
  }
  res.json({ demoMode, message: `Demo mode ${demoMode ? 'enabled' : 'disabled'}` });
});

// ── USAGE ──
app.get('/api/usage', (req, res) => {
  if (!servicesLoaded) {
    return res.status(503).json({ error: 'Services not loaded', detail: servicesError });
  }
  const stats = tdService.getCreditStats();
  res.json({
    plan: stats.plan || (demoMode ? 'DEMO' : 'Unknown'),
    apiCreditsUsed: stats.used,
    apiCreditsRemaining: stats.remaining,
    apiCreditsLimit: stats.total || 100,
    demoMode,
    timestamp: new Date().toISOString()
  });
});

// ── STATUS ──
app.get('/api/status', (req, res) => {
  if (!servicesLoaded) return res.status(503).json({ error: 'Services not loaded', detail: servicesError });

  res.json({
    bot: {
      status: botState.status,
      pairs: PAIRS,
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
    demoMode,
    portfolio: getGlobalPortfolio(),
    serverTime: new Date().toISOString()
  });
});

// ── MARKET DATA ──
app.get('/api/market-data', async (req, res) => {
  const symbol = req.query.symbol || PAIRS[0];

  if (!servicesLoaded) {
    return res.status(503).json({ error: 'Services not loaded', detail: servicesError });
  }

  try {
    if (symbol === 'ALL') {
      const results = {};
      let anySuccess = false;

      for (const sym of PAIRS) {
        let quote;
        if (demoMode) {
          quote = generateDemoQuote(sym);
        } else {
          quote = await tdService.getQuote(sym);
        }

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
        }
      }

      return res.json({ allPairs: results, anySuccess, timestamp: new Date().toISOString() });
    }

    // Single symbol
    let quote, ohlcv;
    if (demoMode) {
      quote = generateDemoQuote(symbol);
      ohlcv = generateDemoOHLCV();
    } else {
      quote = await tdService.getQuote(symbol);
      ohlcv = await tdService.getTimeSeries(symbol, botState.timeframe, 100);
    }

    if (quote?.error) {
      return res.json({ symbol, quote, timestamp: new Date().toISOString() });
    }

    if (pairState[symbol]) {
      pairState[symbol].ohlcvCache = ohlcv;
      pairState[symbol].lastPrice = quote.price;
      pairState[symbol].strategy.updatePositions(quote.price);
    }

    res.json({ symbol, quote, ohlcv: ohlcv.slice(0, 50), timestamp: new Date().toISOString() });

  } catch (err) {
    console.error('[API /api/market-data] ERROR:', err.message);
    res.status(500).json({ error: err.message, symbol });
  }
});

// ── SETUP GENERATOR ──
app.get('/api/setup', async (req, res) => {
  const symbol = req.query.symbol || PAIRS[0];
  const scanAll = req.query.scan === 'true';

  if (!servicesLoaded) {
    return res.status(503).json({ error: 'Services not loaded', detail: servicesError });
  }

  if (!pairState[symbol]) {
    return res.status(400).json({ error: `Symbol ${symbol} not in watchlist`, validSymbols: PAIRS });
  }

  if (scanAll) {
    const setups = [];
    for (const sym of PAIRS) {
      let ohlcv = pairState[sym].ohlcvCache || [];
      if (ohlcv.length < 30) {
        ohlcv = demoMode ? generateDemoOHLCV() : await tdService.getTimeSeries(sym, botState.timeframe, 100);
        pairState[sym].ohlcvCache = ohlcv;
      }
      let quote = demoMode ? generateDemoQuote(sym) : await tdService.getQuote(sym);
      if (!quote?.error && quote?.price) {
        const setup = pairState[sym].strategy.generateSetup(ohlcv, quote.price, sym);
        pairState[sym].lastSetup = setup;
        setups.push(setup);
      }
    }
    setups.sort((a, b) => b.score - a.score);
    return res.json({ scan: true, setups, count: setups.length, timestamp: new Date().toISOString() });
  }

  // Single pair
  try {
    let ohlcv = pairState[symbol].ohlcvCache || [];
    if (ohlcv.length < 30) {
      ohlcv = demoMode ? generateDemoOHLCV() : await tdService.getTimeSeries(symbol, botState.timeframe, 100);
      pairState[symbol].ohlcvCache = ohlcv;
    }

    let quote = demoMode ? generateDemoQuote(symbol) : await tdService.getQuote(symbol);

    if (quote?.error) {
      return res.json({
        error: 'QUOTE_ERROR',
        detail: quote.message,
        symbol,
        setup: null, signal: 'HOLD', score: 0
      });
    }

    if (ohlcv.length < 30) {
      return res.json({
        error: 'INSUFFICIENT_DATA',
        detail: `Only ${ohlcv.length} candles available.`,
        symbol,
        setup: null, signal: 'HOLD', score: 0
      });
    }

    const setup = pairState[symbol].strategy.generateSetup(ohlcv, quote.price, symbol);
    pairState[symbol].lastSetup = setup;
    res.json(setup);

  } catch (err) {
    console.error('[API /api/setup] ERROR:', err.message);
    res.status(500).json({ error: 'INTERNAL_ERROR', detail: err.message, symbol, setup: null, signal: 'HOLD', score: 0 });
  }
});

// ── EXECUTE TRADE ──
app.post('/api/setup/execute', async (req, res) => {
  if (!servicesLoaded) return res.status(503).json({ error: 'Services not loaded' });

  const { symbol } = req.body;
  const targetSymbol = symbol || PAIRS[0];

  if (!pairState[targetSymbol]?.lastSetup) {
    return res.status(400).json({ error: 'No setup generated yet for this pair.' });
  }

  try {
    const quote = demoMode ? generateDemoQuote(targetSymbol) : await tdService.getQuote(targetSymbol);
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

// ── TRADES ──
app.get('/api/trades', (req, res) => {
  if (!servicesLoaded) return res.status(503).json({ error: 'Services not loaded' });

  const allActive = [];
  const allHistory = [];

  PAIRS.forEach(sym => {
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

// ── CLOSE POSITION ──
app.post('/api/positions/:id/close', async (req, res) => {
  if (!servicesLoaded) return res.status(503).json({ error: 'Services not loaded' });

  const { id } = req.params;
  const { symbol } = req.body;

  let targetSymbol = symbol;
  let targetEngine = null;

  if (targetSymbol && pairState[targetSymbol]?.strategy) {
    targetEngine = pairState[targetSymbol].strategy;
  } else {
    for (const sym of PAIRS) {
      const pos = pairState[sym]?.strategy?.getActivePositions()?.find(p => p.id === id);
      if (pos) { targetSymbol = sym; targetEngine = pairState[sym].strategy; break; }
    }
  }

  if (!targetEngine) return res.status(404).json({ error: 'Position not found' });

  try {
    const quote = demoMode ? generateDemoQuote(targetSymbol) : await tdService.getQuote(targetSymbol);
    const currentPrice = quote?.price || null;
    if (!currentPrice) return res.status(503).json({ error: 'Unable to fetch current price' });

    const result = targetEngine.closePosition(id, currentPrice, 'MANUAL');
    if (result.error) return res.status(404).json(result);

    res.json({ message: 'Position closed', position: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── BOT CONTROL ──
app.post('/api/control', (req, res) => {
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
      }
      break;
    default:
      return res.status(400).json({ error: 'Invalid action. Use START, PAUSE, or UPDATE' });
  }
  res.json({ message: `Bot ${action.toLowerCase()}ed`, state: botState });
});

// ═══════════════════════════════════════════════════════════════
// STATIC FRONTEND (MUST be after all API routes)
// ═══════════════════════════════════════════════════════════════

app.use(express.static(FRONTEND_PATH));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API endpoint not found', path: req.path });
  }
  res.sendFile(nodePath.join(FRONTEND_PATH, 'index.html'));
});

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function getGlobalPortfolio() {
  let totalUnrealized = 0, totalRealized = 0, totalTrades = 0, totalWins = 0, activeCount = 0;
  PAIRS.forEach(sym => {
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
  for (const sym of PAIRS) {
    try {
      const ohlcv = demoMode ? generateDemoOHLCV() : await tdService.getTimeSeries(sym, botState.timeframe, 100);
      if (pairState[sym]) pairState[sym].ohlcvCache = ohlcv;
      const quote = demoMode ? generateDemoQuote(sym) : await tdService.getQuote(sym);
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
  console.log(`[BOT] Polling started: ${PAIRS.length} pairs, ${botState.pollIntervalMs}ms`);
  pollMarket();
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; console.log('[BOT] Polling stopped'); }
}

process.on('SIGTERM', () => { stopPolling(); process.exit(0); });
process.on('SIGINT', () => { stopPolling(); process.exit(0); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  XAU/USD SCALPER BOT — RENDER READY                        ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  Port: ${PORT}                                           ║`);
  console.log(`║  Test:  curl http://localhost:${PORT}/api/test           ║`);
  console.log(`║  Pair:  XAU/USD                                          ║`);
  console.log(`║  Mode: ${demoMode ? 'DEMO' : 'LIVE'}                                    ║`);
  console.log('╚════════════════════════════════════════════════════════════╝');
});
