/**
 * server.js — XAU/USD FOCUS + API USAGE TRACKING
 */

require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());

const frontendPath = path.join(__dirname, '../frontend');
console.log('[SERVER] Serving frontend from:', frontendPath);
app.use(express.static(frontendPath));

// ── CONFIG ──
const API_KEY = process.env.TWELVE_DATA_API_KEY || '';
const DEFAULT_PAIRS = ['XAU/USD'];
const pairs = process.env.WATCHLIST ? process.env.WATCHLIST.split(',') : DEFAULT_PAIRS;

console.log('[SERVER] Pairs:', pairs.join(', '));
console.log('[SERVER] API Key:', API_KEY ? 'SET (' + API_KEY.substring(0, 6) + '...)' : 'MISSING');

// ── LAZY LOAD SERVICES ──
let TwelveDataService, StrategyEngine, tdService;
let pairState = {};
let servicesLoaded = false;

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
  console.error('[SERVER] FAILED to load services:', err.message);
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
// TEST ENDPOINTS
// ═══════════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    apiKeyPresent: !!API_KEY,
    servicesLoaded,
    pairs,
    timestamp: new Date().toISOString() 
  });
});

app.get('/api/test', (req, res) => {
  res.json({ ok: true, message: 'API is reachable', servicesLoaded, pairs });
});

// ═══════════════════════════════════════════════════════════════
// API USAGE ENDPOINT
// ═══════════════════════════════════════════════════════════════

app.get('/api/usage', async (req, res) => {
  if (!servicesLoaded) {
    return res.status(503).json({ error: 'Services not loaded' });
  }
  if (!API_KEY) {
    return res.status(503).json({ error: 'TWELVE_DATA_API_KEY not set' });
  }

  try {
    const usage = await tdService.getApiUsage();
    const creditStats = tdService.getCreditStats();
    res.json({
      ...usage,
      creditStats,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('[API /api/usage] ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// MAIN API ROUTES
// ═══════════════════════════════════════════════════════════════

app.get('/api/status', (req, res) => {
  if (!servicesLoaded) {
    return res.status(503).json({ error: 'Services not loaded. Check server logs.' });
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
  if (!servicesLoaded) {
    return res.status(503).json({ error: 'Services not loaded' });
  }
  if (!API_KEY) {
    return res.status(503).json({ error: 'TWELVE_DATA_API_KEY not set' });
  }

  const symbol = req.query.symbol || 'XAU/USD';

  try {
    if (symbol === 'ALL') {
      const results = {};
      for (const sym of pairs) {
        const quote = await tdService.getQuote(sym);
        results[sym] = {
          quote: quote?.error ? { error: quote.message, price: null } : quote,
          timestamp: new Date().toISOString()
        };
        if (quote && !quote.error && quote.price) {
          if (pairState[sym]) {
            pairState[sym].lastPrice = quote.price;
            pairState[sym].strategy.updatePositions(quote.price);
          }
        }
      }
      return res.json({ allPairs: results, timestamp: new Date().toISOString() });
    }

    const quote = await tdService.getQuote(symbol);

    if (quote?.error) {
      return res.status(503).json({ 
        error: 'Twelve Data API error',
        detail: quote.message,
        symbol
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
    res.status(500).json({ error: err.message, symbol });
  }
});

app.get('/api/setup', async (req, res) => {
  console.log('[API] /api/setup called with query:', req.query);

  if (!servicesLoaded) {
    return res.status(503).json({ error: 'Services not loaded. Check server logs.' });
  }
  if (!API_KEY) {
    return res.status(503).json({
      error: 'TWELVE_DATA_API_KEY not configured',
      message: 'Add your Twelve Data API key to environment variables',
      setup: null, signal: 'HOLD', score: 0
    });
  }

  const symbol = req.query.symbol || 'XAU/USD';
  const scanAll = req.query.scan === 'true';

  if (!pairState[symbol]) {
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
        if (quote?.error) continue;
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

  try {
    let ohlcv = pairState[symbol].ohlcvCache || [];
    if (ohlcv.length < 30) {
      ohlcv = await tdService.getTimeSeries(symbol, botState.timeframe, 100);
      pairState[symbol].ohlcvCache = ohlcv;
    }

    const quote = await tdService.getQuote(symbol);

    if (quote?.error) {
      return res.status(503).json({
        error: 'Failed to fetch market data',
        detail: quote.message,
        symbol,
        setup: null, signal: 'HOLD', score: 0
      });
    }

    if (!quote?.price) {
      return res.status(503).json({ 
        error: 'Unable to fetch current price',
        symbol,
        setup: null, signal: 'HOLD', score: 0
      });
    }

    const setup = pairState[symbol].strategy.generateSetup(ohlcv, quote.price, symbol);
    pairState[symbol].lastSetup = setup;
    res.json(setup);

  } catch (err) {
    console.error('[API /api/setup] UNCAUGHT ERROR:', err.message);
    res.status(500).json({ 
      error: err.message,
      symbol,
      setup: null, signal: 'HOLD', score: 0
    });
  }
});

app.post('/api/setup/execute', async (req, res) => {
  if (!servicesLoaded) return res.status(503).json({ error: 'Services not loaded' });

  const { symbol } = req.body;
  const targetSymbol = symbol || 'XAU/USD';

  if (!pairState[targetSymbol]?.lastSetup) {
    return res.status(400).json({ error: 'No setup generated yet for this pair.' });
  }

  try {
    const quote = await tdService.getQuote(targetSymbol);
    if (!quote?.price) {
      return res.status(503).json({ error: 'Unable to fetch current price' });
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
      return res.status(503).json({ error: 'Unable to fetch current price' });
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
// CATCH-ALL
// ═══════════════════════════════════════════════════════════════
app.get('*', (req, res) => {
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
  console.log('║  XAU/USD SCALPER BOT — Twelve Data Integration           ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  URL: http://localhost:${PORT}                           ║`);
  console.log(`║  Test: http://localhost:${PORT}/api/test                 ║`);
  console.log(`║  Pairs: ${pairs.join(', ')}                              ║`);
  console.log(`║  API Key: ${API_KEY ? 'SET' : 'MISSING'}                                    ║`);
  console.log('╚════════════════════════════════════════════════════════════╝');
});
