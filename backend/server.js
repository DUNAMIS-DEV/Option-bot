/**
 * server.js — SINGLE-SERVICE EDITION
 * ===================================
 * Serves both the Express API AND the static frontend from one Render web service.
 * No Netlify needed. No CORS needed.
 */

require('dotenv').config();
const express = require('express');
const path = require('path');

const TwelveDataService = require('./twelveDataService');
const StrategyEngine = require('./strategyEngine');

const app = express();
app.use(express.json());

// ── SERVE STATIC FRONTEND FILES ──
// This serves index.html, style.css, app.js from the /frontend folder
app.use(express.static(path.join(__dirname, '../frontend')));

// ── SERVICES ──
const tdService = new TwelveDataService(process.env.TWELVE_DATA_API_KEY);

// ── MULTI-PAIR CONFIGURATION ──
const DEFAULT_PAIRS = ['XAU/USD', 'USD/JPY', 'GBP/JPY', 'EUR/USD', 'BTC/USD'];
const pairs = process.env.WATCHLIST ? process.env.WATCHLIST.split(',') : DEFAULT_PAIRS;

const pairState = {};
pairs.forEach(sym => {
  pairState[sym] = {
    strategy: new StrategyEngine(process.env),
    ohlcvCache: [],
    lastPrice: null,
    lastSetup: null,
    lastCheck: null
  };
});

let botState = {
  status: 'PAUSED',
  timeframe: process.env.DEFAULT_TIMEFRAME || '1h',
  pollIntervalMs: (parseInt(process.env.POLL_INTERVAL_SECONDS) || 60) * 1000,
  autoTrade: false,
  uptime: Date.now()
};

let pollTimer = null;

// ── HEALTH CHECK ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── API: GET /api/status ──
app.get('/api/status', (req, res) => {
  const portfolio = getGlobalPortfolio();
  res.json({
    bot: {
      status: botState.status,
      pairs: pairs,
      timeframe: botState.timeframe,
      autoTrade: botState.autoTrade,
      uptime: Date.now() - botState.uptime
    },
    strategy: {
      name: 'YouTube Course Multi-Confluence Strategy',
      source: 'ULTIMATE Options Trading Course for Beginners',
      indicators: {
        emaFast: parseInt(process.env.EMA_FAST_PERIOD || 9),
        emaSlow: parseInt(process.env.EMA_SLOW_PERIOD || 21),
        rsiPeriod: parseInt(process.env.RSI_PERIOD || 14),
        rsiOverbought: parseInt(process.env.RSI_OVERBOUGHT || 70),
        rsiOversold: parseInt(process.env.RSI_OVERSOLD || 30)
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
      lastPrice: pairState[sym].lastPrice,
      lastCheck: pairState[sym].lastCheck,
      activePositions: pairState[sym].strategy.getActivePositions().length
    })),
    portfolio,
    serverTime: new Date().toISOString()
  });
});

// ── API: GET /api/market-data ──
app.get('/api/market-data', async (req, res) => {
  const symbol = req.query.symbol || 'EUR/USD';

  try {
    if (symbol === 'ALL') {
      const results = {};
      for (const sym of pairs) {
        const quote = await tdService.getQuote(sym);
        results[sym] = {
          quote: quote || { error: 'Unable to fetch' },
          timestamp: new Date().toISOString()
        };
        if (quote && quote.price) {
          pairState[sym].lastPrice = quote.price;
          pairState[sym].strategy.updatePositions(quote.price);
        }
      }
      return res.json({ allPairs: results, timestamp: new Date().toISOString() });
    }

    const quote = await tdService.getQuote(symbol);
    const ohlcv = await tdService.getTimeSeries(symbol, botState.timeframe, 100);
    pairState[symbol].ohlcvCache = ohlcv;

    if (quote && quote.price) {
      pairState[symbol].lastPrice = quote.price;
      pairState[symbol].strategy.updatePositions(quote.price);
    }

    res.json({
      symbol,
      quote: quote || { error: 'Unable to fetch quote' },
      ohlcv: ohlcv.slice(0, 50),
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('[API] Market data error:', err.message);
    res.status(500).json({ error: err.message, symbol });
  }
});

// ── API: GET /api/setup ──
app.get('/api/setup', async (req, res) => {
  const symbol = req.query.symbol || 'EUR/USD';
  const scanAll = req.query.scan === 'true';

  if (scanAll) {
    const setups = [];
    for (const sym of pairs) {
      try {
        let ohlcv = pairState[sym].ohlcvCache;
        if (ohlcv.length < 30) {
          ohlcv = await tdService.getTimeSeries(sym, botState.timeframe, 100);
          pairState[sym].ohlcvCache = ohlcv;
        }
        const quote = await tdService.getQuote(sym);
        const price = quote ? quote.price : null;

        if (price) {
          const setup = pairState[sym].strategy.generateSetup(ohlcv, price, sym);
          pairState[sym].lastSetup = setup;
          setups.push(setup);

          if (botState.autoTrade && setup.score >= 75 && setup.signal !== 'HOLD') {
            const pos = pairState[sym].strategy.openPosition(setup, price);
            if (!pos.error) {
              setup.autoPositionOpened = true;
              setup.positionId = pos.id;
            }
          }
        }
      } catch (err) {
        console.error(`[SCAN] Error for ${sym}:`, err.message);
      }
    }

    setups.sort((a, b) => b.score - a.score);
    return res.json({ scan: true, setups, count: setups.length, timestamp: new Date().toISOString() });
  }

  try {
    let ohlcv = pairState[symbol].ohlcvCache;
    if (ohlcv.length < 30) {
      ohlcv = await tdService.getTimeSeries(symbol, botState.timeframe, 100);
      pairState[symbol].ohlcvCache = ohlcv;
    }

    const quote = await tdService.getQuote(symbol);
    const price = quote ? quote.price : null;

    if (!price) {
      return res.status(503).json({ error: 'Unable to fetch current price' });
    }

    const setup = pairState[symbol].strategy.generateSetup(ohlcv, price, symbol);
    pairState[symbol].lastSetup = setup;

    if (botState.autoTrade && setup.score >= 75 && setup.signal !== 'HOLD') {
      const pos = pairState[symbol].strategy.openPosition(setup, price);
      if (!pos.error) {
        setup.autoPositionOpened = true;
        setup.positionId = pos.id;
      }
    }

    res.json(setup);
  } catch (err) {
    console.error('[API] Setup generation error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── API: POST /api/setup/execute ──
app.post('/api/setup/execute', async (req, res) => {
  const { symbol, setupId } = req.body;
  const targetSymbol = symbol || 'EUR/USD';

  if (!pairState[targetSymbol].lastSetup) {
    return res.status(400).json({ error: 'No setup generated yet for this pair.' });
  }

  const quote = await tdService.getQuote(targetSymbol);
  if (!quote || !quote.price) {
    return res.status(503).json({ error: 'Unable to fetch current price' });
  }

  const position = pairState[targetSymbol].strategy.openPosition(pairState[targetSymbol].lastSetup, quote.price);

  if (position.error) {
    return res.status(400).json({ error: position.error });
  }

  res.json({
    message: 'Position opened successfully',
    position,
    setup: pairState[targetSymbol].lastSetup
  });
});

// ── API: GET /api/trades ──
app.get('/api/trades', (req, res) => {
  const allActive = [];
  const allHistory = [];

  pairs.forEach(sym => {
    const engine = pairState[sym].strategy;
    allActive.push(...engine.getActivePositions());
    allHistory.push(...engine.getTradeHistory(50));
  });

  allHistory.sort((a, b) => new Date(b.closeTime || 0) - new Date(a.closeTime || 0));

  res.json({
    activePositions: allActive,
    tradeHistory: allHistory.slice(0, 50),
    portfolio: getGlobalPortfolio(),
    lastSetups: pairs.reduce((acc, sym) => {
      if (pairState[sym].lastSetup) acc[sym] = pairState[sym].lastSetup;
      return acc;
    }, {})
  });
});

// ── API: POST /api/positions/:id/close ──
app.post('/api/positions/:id/close', async (req, res) => {
  const { id } = req.params;
  const { symbol } = req.body;

  let targetSymbol = symbol;
  let targetEngine = null;

  if (targetSymbol && pairState[targetSymbol]) {
    targetEngine = pairState[targetSymbol].strategy;
  } else {
    for (const sym of pairs) {
      const pos = pairState[sym].strategy.getActivePositions().find(p => p.id === id);
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

  const quote = await tdService.getQuote(targetSymbol);
  const currentPrice = quote ? quote.price : null;

  if (!currentPrice) {
    return res.status(503).json({ error: 'Unable to fetch current price' });
  }

  const result = targetEngine.closePosition(id, currentPrice, 'MANUAL');

  if (result.error) {
    return res.status(404).json(result);
  }

  res.json({ message: 'Position closed successfully', position: result });
});

// ── API: POST /api/control ──
app.post('/api/control', (req, res) => {
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

  res.json({ message: `Bot ${action.toLowerCase()}ed successfully`, state: botState });
});

// ── CATCH-ALL: SERVE index.html FOR SPA ROUTES ──
// This ensures refreshing the page or visiting any route loads the dashboard
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend', 'index.html'));
});

// ── GLOBAL PORTFOLIO ──
function getGlobalPortfolio() {
  let totalUnrealized = 0, totalRealized = 0, totalTrades = 0, totalWins = 0, activeCount = 0;

  pairs.forEach(sym => {
    const port = pairState[sym].strategy.getPortfolio();
    totalUnrealized += port.unrealizedPnL;
    totalRealized += port.realizedPnL;
    totalTrades += port.totalTrades;
    totalWins += Math.round(port.totalTrades * (parseFloat(port.winRate) / 100));
    activeCount += port.activePositions;
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

// ── POLLING LOOP ──
async function pollMarket() {
  if (botState.status !== 'ACTIVE') return;

  console.log(`[POLL] Scanning ${pairs.length} pairs at ${new Date().toISOString()}`);

  for (const sym of pairs) {
    try {
      const ohlcv = await tdService.getTimeSeries(sym, botState.timeframe, 100);
      pairState[sym].ohlcvCache = ohlcv;

      const quote = await tdService.getQuote(sym);
      if (quote && quote.price) {
        pairState[sym].lastPrice = quote.price;
        pairState[sym].lastCheck = new Date().toISOString();

        const events = pairState[sym].strategy.updatePositions(quote.price);

        if (botState.autoTrade) {
          const lastSetupTime = pairState[sym].lastSetup 
            ? new Date(pairState[sym].lastSetup.timestamp).getTime() 
            : 0;

          if (Date.now() - lastSetupTime > 300000) {
            const setup = pairState[sym].strategy.generateSetup(ohlcv, quote.price, sym);
            pairState[sym].lastSetup = setup;

            if (setup.score >= 75 && setup.signal !== 'HOLD') {
              const pos = pairState[sym].strategy.openPosition(setup, quote.price);
              if (!pos.error) {
                console.log(`[AUTO-TRADE] ${sym}: ${setup.signal} @ ${quote.price} (Score: ${setup.score}%)`);
              }
            }
          }
        }
      }
    } catch (err) {
      console.error(`[POLL] Error for ${sym}:`, err.message);
    }
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollMarket, botState.pollIntervalMs);
  console.log(`[BOT] Multi-pair polling started: ${pairs.length} pairs, ${botState.pollIntervalMs}ms interval`);
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

// ── START ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  AUTOMATED TRADING DASHBOARD — SINGLE SERVICE              ║');
  console.log('║  Frontend + Backend on one Render Web Service              ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  Dashboard: http://localhost:${PORT} (or your Render URL)   ║`);
  console.log(`║  Pairs: ${pairs.join(', ')}          ║`);
  console.log(`║  Status: ${botState.status}                                       ║`);
  console.log('╚════════════════════════════════════════════════════════════╝');
});
