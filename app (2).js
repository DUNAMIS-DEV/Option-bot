/**
 * app.js — SINGLE-SERVICE EDITION
 * ===============================
 * Frontend calls API on the SAME origin (no CORS, no external URL needed).
 * Works when backend serves these static files via express.static().
 */

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

// EMPTY STRING = same origin. Backend serves frontend + API from same domain.
const API_BASE = '';

const PAIRS = ['XAU/USD', 'USD/JPY', 'GBP/JPY', 'EUR/USD', 'BTC/USD'];

const state = {
  pairs: {},
  timeframe: '1h',
  botActive: false,
  lastSetup: null,
  lastSetupSymbol: null,
  signals: []
};

PAIRS.forEach(sym => {
  state.pairs[sym] = {
    price: null,
    change: 0,
    changePercent: 0,
    lastSetup: null,
    lastCheck: null
  };
});

// ═══════════════════════════════════════════════════════════════
// DOM REFERENCES
// ═══════════════════════════════════════════════════════════════

const els = {
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText'),
  botToggle: document.getElementById('botToggle'),
  botStatus: document.getElementById('botStatus'),
  timeframeSelect: document.getElementById('timeframeSelect'),
  pairsGrid: document.getElementById('pairsGrid'),
  scanAllBtn: document.getElementById('scanAllBtn'),
  setupPairSelect: document.getElementById('setupPairSelect'),
  setupSymbolLabel: document.getElementById('setupSymbolLabel'),
  generateBtn: document.getElementById('generateBtn'),
  setupResult: document.getElementById('setupResult'),
  signalBadge: document.getElementById('signalBadge'),
  scoreProgress: document.getElementById('scoreProgress'),
  scoreNumber: document.getElementById('scoreNumber'),
  setupDetails: document.getElementById('setupDetails'),
  executeBtn: document.getElementById('executeBtn'),
  tradesBody: document.getElementById('tradesBody'),
  historyBody: document.getElementById('historyBody'),
  refreshTrades: document.getElementById('refreshTrades'),
  signalList: document.getElementById('signalList'),
  unrealizedPnL: document.getElementById('unrealizedPnL'),
  realizedPnL: document.getElementById('realizedPnL'),
  winRate: document.getElementById('winRate'),
  totalTrades: document.getElementById('totalTrades'),
  toastContainer: document.getElementById('toastContainer'),
  paramEmaFast: document.getElementById('paramEmaFast'),
  paramEmaSlow: document.getElementById('paramEmaSlow'),
  paramRsi: document.getElementById('paramRsi'),
  paramRisk: document.getElementById('paramRisk'),
  paramMaxPos: document.getElementById('paramMaxPos')
};

// ═══════════════════════════════════════════════════════════════
// API HELPERS
// ═══════════════════════════════════════════════════════════════

async function apiGet(endpoint) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    headers: { 'Content-Type': 'application/json' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function apiPost(endpoint, body) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ═══════════════════════════════════════════════════════════════
// CONNECTIVITY
// ═══════════════════════════════════════════════════════════════

async function checkHealth() {
  try {
    await apiGet('/health');
    els.statusDot.className = 'status-dot online';
    els.statusText.textContent = 'Online';
    return true;
  } catch (err) {
    els.statusDot.className = 'status-dot offline';
    els.statusText.textContent = 'Offline';
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// PAIRS GRID
// ═══════════════════════════════════════════════════════════════

function renderPairsGrid() {
  els.pairsGrid.innerHTML = PAIRS.map(sym => `
    <div class="pair-card" data-symbol="${sym}" id="pair-${sym.replace('/', '')}">
      <div class="pair-symbol">${sym}</div>
      <div class="pair-price" id="price-${sym.replace('/', '')}">--.-----</div>
      <div class="pair-change" id="change-${sym.replace('/', '')}">--</div>
      <div class="pair-score" id="score-${sym.replace('/', '')}" style="display:none;">--%</div>
      <div class="pair-last-signal" id="lastsig-${sym.replace('/', '')}">No signal yet</div>
      <button class="btn-pair-setup" data-symbol="${sym}">Generate Setup</button>
    </div>
  `).join('');

  document.querySelectorAll('.btn-pair-setup').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const sym = e.target.dataset.symbol;
      els.setupPairSelect.value = sym;
      generateSetup(sym);
    });
  });

  document.querySelectorAll('.pair-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('btn-pair-setup')) return;
      const sym = card.dataset.symbol;
      els.setupPairSelect.value = sym;
      els.setupSymbolLabel.textContent = sym;
      document.querySelectorAll('.pair-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
    });
  });
}

// ═══════════════════════════════════════════════════════════════
// MARKET DATA (ALL PAIRS)
// ═══════════════════════════════════════════════════════════════

async function loadAllMarketData() {
  try {
    const data = await apiGet('/api/market-data?symbol=ALL');

    if (data.allPairs) {
      PAIRS.forEach(sym => {
        const pairData = data.allPairs[sym];
        if (pairData && pairData.quote && pairData.quote.price) {
          const q = pairData.quote;
          state.pairs[sym].price = q.price;
          state.pairs[sym].change = q.change;
          state.pairs[sym].changePercent = q.changePercent;
          state.pairs[sym].lastCheck = pairData.timestamp;
          updatePairCard(sym, q);
        }
      });
    }
  } catch (err) {
    console.error('All pairs market data error:', err);
    for (const sym of PAIRS) {
      try {
        const data = await apiGet(`/api/market-data?symbol=${encodeURIComponent(sym)}`);
        if (data.quote && data.quote.price) {
          state.pairs[sym].price = data.quote.price;
          updatePairCard(sym, data.quote);
        }
      } catch (e) {
        console.error(`Fallback fetch error for ${sym}:`, e);
      }
    }
  }
}

function updatePairCard(sym, quote) {
  const id = sym.replace('/', '');
  const priceEl = document.getElementById(`price-${id}`);
  const changeEl = document.getElementById(`change-${id}`);
  const card = document.getElementById(`pair-${id}`);

  if (priceEl) {
    const decimals = sym === 'XAU/USD' ? 2 : (sym === 'BTC/USD' ? 1 : 3);
    priceEl.textContent = quote.price.toFixed(decimals);
  }

  if (changeEl) {
    const isUp = quote.change >= 0;
    changeEl.className = 'pair-change ' + (isUp ? 'up' : 'down');
    changeEl.textContent = `${isUp ? '+' : ''}${quote.changePercent.toFixed(2)}%`;
  }

  if (card) {
    card.classList.remove('bullish', 'bearish', 'neutral');
    card.classList.add(quote.change >= 0 ? 'bullish' : 'bearish');
  }
}

// ═══════════════════════════════════════════════════════════════
// SETUP GENERATOR
// ═══════════════════════════════════════════════════════════════

async function generateSetup(symbol) {
  const targetSymbol = symbol || els.setupPairSelect.value;
  els.setupSymbolLabel.textContent = targetSymbol;

  els.generateBtn.disabled = true;
  els.generateBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/></svg> Analyzing ${targetSymbol}...`;

  try {
    const setup = await apiGet(`/api/setup?symbol=${encodeURIComponent(targetSymbol)}`);
    state.lastSetup = setup;
    state.lastSetupSymbol = targetSymbol;
    state.pairs[targetSymbol].lastSetup = setup;

    renderSetup(setup);
    addSignalToLog(setup);
    updatePairScore(targetSymbol, setup);

    if (setup.signal !== 'HOLD') {
      els.executeBtn.style.display = 'block';
    } else {
      els.executeBtn.style.display = 'none';
    }

    showToast(`${targetSymbol}: ${setup.signal} (${setup.score}%)`, setup.score >= 60 ? 'success' : 'warning');
  } catch (err) {
    showToast('Failed to generate setup: ' + err.message, 'error');
  } finally {
    els.generateBtn.disabled = false;
    els.generateBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg> Generate Setup`;
  }
}

// ═══════════════════════════════════════════════════════════════
// SCAN ALL PAIRS
// ═══════════════════════════════════════════════════════════════

async function scanAllPairs() {
  els.scanAllBtn.disabled = true;
  els.scanAllBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/></svg> Scanning...`;

  try {
    const data = await apiGet('/api/setup?scan=true');

    if (data.setups && data.setups.length > 0) {
      data.setups.forEach(setup => {
        state.pairs[setup.symbol].lastSetup = setup;
        updatePairScore(setup.symbol, setup);
      });

      const best = data.setups[0];
      state.lastSetup = best;
      state.lastSetupSymbol = best.symbol;
      els.setupPairSelect.value = best.symbol;
      els.setupSymbolLabel.textContent = best.symbol;
      renderSetup(best);

      data.setups.forEach(setup => addSignalToLog(setup));

      const buySignals = data.setups.filter(s => s.signal === 'BUY');
      const sellSignals = data.setups.filter(s => s.signal === 'SELL');
      showToast(`Scan complete: ${buySignals.length} BUY, ${sellSignals.length} SELL`, 'info');
    }
  } catch (err) {
    showToast('Scan failed: ' + err.message, 'error');
  } finally {
    els.scanAllBtn.disabled = false;
    els.scanAllBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg> Scan All Pairs`;
  }
}

function updatePairScore(symbol, setup) {
  const id = symbol.replace('/', '');
  const scoreEl = document.getElementById(`score-${id}`);
  const lastSigEl = document.getElementById(`lastsig-${id}`);

  if (scoreEl) {
    scoreEl.style.display = 'inline-block';
    scoreEl.textContent = `${setup.score}%`;
    scoreEl.className = 'pair-score ' + (setup.score >= 70 ? 'high' : setup.score >= 45 ? 'medium' : 'low');
  }

  if (lastSigEl) {
    lastSigEl.textContent = `${setup.signal} @ ${setup.score}%`;
    lastSigEl.style.color = setup.signal === 'BUY' ? 'var(--green)' : (setup.signal === 'SELL' ? 'var(--red)' : 'var(--yellow)');
  }
}

// ═══════════════════════════════════════════════════════════════
// RENDER SETUP
// ═══════════════════════════════════════════════════════════════

function renderSetup(setup) {
  els.setupResult.style.display = 'block';

  els.signalBadge.textContent = setup.signal;
  els.signalBadge.className = 'signal-badge ' + setup.signal.toLowerCase();

  const circumference = 2 * Math.PI * 50;
  const offset = circumference - (setup.score / 100) * circumference;
  els.scoreProgress.style.strokeDashoffset = offset;
  els.scoreProgress.className = 'score-progress ' + (setup.score >= 70 ? 'high' : setup.score >= 45 ? 'medium' : 'low');

  animateNumber(els.scoreNumber, setup.score);

  const decimals = setup.symbol === 'XAU/USD' ? 2 : (setup.symbol === 'BTC/USD' ? 1 : 5);

  const detailsHTML = `
    <div class="detail-item"><span class="detail-label">Pair</span><span class="detail-value">${setup.symbol}</span></div>
    <div class="detail-item"><span class="detail-label">Suggested Entry</span><span class="detail-value">${setup.suggestedEntry?.toFixed(decimals) || '--'}</span></div>
    <div class="detail-item"><span class="detail-label">Stop Loss</span><span class="detail-value negative">${setup.stopLoss?.toFixed(decimals) || '--'}</span></div>
    <div class="detail-item"><span class="detail-label">Take Profit</span><span class="detail-value positive">${setup.takeProfit?.toFixed(decimals) || '--'}</span></div>
    <div class="detail-item"><span class="detail-label">R/R Ratio</span><span class="detail-value">${setup.riskRewardRatio || '--'}</span></div>
    <div class="detail-item"><span class="detail-label">Position Size</span><span class="detail-value">${setup.positionSize || '--'}</span></div>
  `;
  els.setupDetails.innerHTML = detailsHTML;

  if (setup.criteria) {
    const criteriaHTML = setup.criteria.map(c => `
      <div class="criteria-item ${c.passed ? 'passed' : 'failed'}">
        <div class="criteria-icon">${c.passed ? '✓' : '✕'}</div>
        <div class="criteria-info">
          <span class="criteria-name">${c.name}</span>
          <span class="criteria-desc">${c.detail}</span>
        </div>
      </div>
    `).join('');
    els.setupDetails.innerHTML += `<div class="criteria-list">${criteriaHTML}</div>`;
  }
}

function animateNumber(el, target) {
  let current = 0;
  const step = target / 30;
  const timer = setInterval(() => {
    current += step;
    if (current >= target) {
      current = target;
      clearInterval(timer);
    }
    el.textContent = Math.round(current);
  }, 20);
}

// ═══════════════════════════════════════════════════════════════
// EXECUTE TRADE
// ═══════════════════════════════════════════════════════════════

async function executeTrade() {
  if (!state.lastSetup) return;
  const symbol = state.lastSetupSymbol || els.setupPairSelect.value;

  try {
    const result = await apiPost('/api/setup/execute', { symbol, setupId: Date.now() });
    showToast(`Position opened: ${result.position.id} on ${symbol}`, 'success');
    els.executeBtn.style.display = 'none';
    loadTrades();
  } catch (err) {
    showToast('Execution failed: ' + err.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════════════
// TRADES & PORTFOLIO
// ═══════════════════════════════════════════════════════════════

async function loadTrades() {
  try {
    const data = await apiGet('/api/trades');

    if (data.activePositions && data.activePositions.length > 0) {
      els.tradesBody.innerHTML = data.activePositions.map(pos => {
        const decimals = pos.symbol === 'XAU/USD' ? 2 : (pos.symbol === 'BTC/USD' ? 1 : 5);
        return `
        <tr>
          <td>${pos.id}</td>
          <td>${pos.symbol}</td>
          <td><span class="direction-badge ${pos.direction.toLowerCase()}">${pos.direction}</span></td>
          <td>${pos.entryPrice.toFixed(decimals)}</td>
          <td>${pos.closePrice ? pos.closePrice.toFixed(decimals) : '--'}</td>
          <td>${pos.stopLoss.toFixed(decimals)}</td>
          <td>${pos.takeProfit.toFixed(decimals)}</td>
          <td class="pnl-value ${pos.unrealizedPnL >= 0 ? 'positive' : 'negative'}">$${pos.unrealizedPnL.toFixed(2)}</td>
          <td>${pos.setupScore}%</td>
          <td><span class="status-badge open">OPEN</span></td>
          <td><button class="btn-close" onclick="closePosition('${pos.id}', '${pos.symbol}')">Close</button></td>
        </tr>
      `}).join('');
    } else {
      els.tradesBody.innerHTML = `<tr class="empty-row"><td colspan="11">No active positions. Generate a setup to start trading.</td></tr>`;
    }

    if (data.tradeHistory && data.tradeHistory.length > 0) {
      els.historyBody.innerHTML = data.tradeHistory.map(t => {
        const decimals = t.symbol === 'XAU/USD' ? 2 : (t.symbol === 'BTC/USD' ? 1 : 5);
        return `
        <tr>
          <td>${t.id}</td>
          <td>${t.symbol}</td>
          <td><span class="direction-badge ${t.direction.toLowerCase()}">${t.direction}</span></td>
          <td>${t.entryPrice.toFixed(decimals)}</td>
          <td>${t.closePrice ? t.closePrice.toFixed(decimals) : '--'}</td>
          <td class="pnl-value ${t.realizedPnL >= 0 ? 'positive' : 'negative'}">$${t.realizedPnL.toFixed(2)}</td>
          <td>${t.closeReason || '--'}</td>
          <td>${t.closeTime ? new Date(t.closeTime).toLocaleString() : '--'}</td>
        </tr>
      `}).join('');
    } else {
      els.historyBody.innerHTML = `<tr class="empty-row"><td colspan="8">No closed trades yet.</td></tr>`;
    }

    if (data.portfolio) {
      const p = data.portfolio;
      els.unrealizedPnL.textContent = (p.unrealizedPnL >= 0 ? '+' : '') + '$' + p.unrealizedPnL.toFixed(2);
      els.unrealizedPnL.className = 'metric-value ' + (p.unrealizedPnL >= 0 ? 'positive' : 'negative');
      els.realizedPnL.textContent = (p.realizedPnL >= 0 ? '+' : '') + '$' + p.realizedPnL.toFixed(2);
      els.realizedPnL.className = 'metric-value ' + (p.realizedPnL >= 0 ? 'positive' : 'negative');
      els.winRate.textContent = p.winRate + '%';
      els.totalTrades.textContent = p.totalTrades;
    }
  } catch (err) {
    console.error('Trades load error:', err);
  }
}

async function closePosition(id, symbol) {
  try {
    await apiPost(`/api/positions/${id}/close`, { symbol });
    showToast('Position closed', 'info');
    loadTrades();
  } catch (err) {
    showToast('Close failed: ' + err.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════════════
// SIGNAL LOG
// ═══════════════════════════════════════════════════════════════

function addSignalToLog(setup) {
  const time = new Date().toLocaleTimeString();
  const div = document.createElement('div');
  div.className = `signal-item ${setup.signal.toLowerCase()}`;
  const decimals = setup.symbol === 'XAU/USD' ? 2 : (setup.symbol === 'BTC/USD' ? 1 : 5);
  div.innerHTML = `
    <span class="signal-time">${time}</span>
    <div class="signal-info">
      <div class="signal-symbol">${setup.symbol} — ${setup.signal}</div>
      <div class="signal-detail">Entry: ${setup.suggestedEntry?.toFixed(decimals)} | SL: ${setup.stopLoss?.toFixed(decimals)} | TP: ${setup.takeProfit?.toFixed(decimals)}</div>
    </div>
    <span class="signal-score ${setup.score >= 70 ? 'high' : setup.score >= 45 ? 'medium' : 'low'}">${setup.score}%</span>
  `;

  els.signalList.prepend(div);

  const empty = els.signalList.querySelector('.signal-empty');
  if (empty) empty.remove();

  while (els.signalList.children.length > 30) {
    els.signalList.lastElementChild.remove();
  }
}

// ═══════════════════════════════════════════════════════════════
// BOT CONTROLS
// ═══════════════════════════════════════════════════════════════

async function toggleBot() {
  const action = state.botActive ? 'PAUSE' : 'START';
  try {
    await apiPost('/api/control', { action });
    state.botActive = !state.botActive;
    els.botToggle.checked = state.botActive;
    els.botStatus.textContent = state.botActive ? 'ACTIVE' : 'PAUSED';
    els.botStatus.className = 'toggle-status ' + (state.botActive ? 'active' : '');
    showToast(`Bot ${state.botActive ? 'started' : 'paused'}`, 'info');
  } catch (err) {
    showToast('Control failed: ' + err.message, 'error');
    els.botToggle.checked = state.botActive;
  }
}

async function updateSettings() {
  try {
    await apiPost('/api/control', {
      action: 'UPDATE',
      settings: {
        timeframe: state.timeframe,
        autoTrade: false
      }
    });
  } catch (err) {
    console.error('Settings update failed:', err);
  }
}

// ═══════════════════════════════════════════════════════════════
// STATUS
// ═══════════════════════════════════════════════════════════════

async function loadStatus() {
  try {
    const status = await apiGet('/api/status');
    state.botActive = status.bot.status === 'ACTIVE';
    els.botToggle.checked = state.botActive;
    els.botStatus.textContent = status.bot.status;
    els.botStatus.className = 'toggle-status ' + (state.botActive ? 'active' : '');

    if (status.strategy) {
      els.paramEmaFast.textContent = status.strategy.indicators.emaFast;
      els.paramEmaSlow.textContent = status.strategy.indicators.emaSlow;
      els.paramRsi.textContent = status.strategy.indicators.rsiPeriod;
      els.paramRisk.textContent = status.strategy.riskRules.maxRiskPerTrade;
      els.paramMaxPos.textContent = status.strategy.riskRules.maxPositions;
    }
  } catch (err) {
    console.error('Status load error:', err);
  }
}

// ═══════════════════════════════════════════════════════════════
// TOASTS
// ═══════════════════════════════════════════════════════════════

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  els.toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ═══════════════════════════════════════════════════════════════
// EVENT LISTENERS
// ═══════════════════════════════════════════════════════════════

els.generateBtn.addEventListener('click', () => generateSetup());
els.executeBtn.addEventListener('click', executeTrade);
els.refreshTrades.addEventListener('click', loadTrades);
els.botToggle.addEventListener('change', toggleBot);
els.scanAllBtn.addEventListener('click', scanAllPairs);

els.setupPairSelect.addEventListener('change', (e) => {
  els.setupSymbolLabel.textContent = e.target.value;
});

els.timeframeSelect.addEventListener('change', (e) => {
  state.timeframe = e.target.value;
  updateSettings();
});

// ═══════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════

async function init() {
  renderPairsGrid();
  await checkHealth();
  await loadStatus();
  await loadAllMarketData();
  await loadTrades();

  setInterval(checkHealth, 15000);
  setInterval(loadAllMarketData, 10000);
  setInterval(loadTrades, 5000);
}

init();
