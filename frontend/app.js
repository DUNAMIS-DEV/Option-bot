/**
 * app.js — XAU/USD SCALPER + AUTH + DEMO MODE
 * ============================================
 */

const API_BASE = '';
const PAIRS = ['XAU/USD'];

const state = {
  pairs: {},
  timeframe: '5min',
  botActive: false,
  demoMode: false,
  authToken: null,
  userRole: null,
  lastSetup: null,
  lastSetupSymbol: null,
  signals: [],
  isScanning: false,
  apiUsage: null,
  marketStatus: 'unknown'
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

const els = {
  // Auth
  loginOverlay: document.getElementById('loginOverlay'),
  loginPassword: document.getElementById('loginPassword'),
  loginBtn: document.getElementById('loginBtn'),
  loginForm: document.getElementById('loginForm'),
  loginError: document.getElementById('loginError'),
  logoutBtn: document.getElementById('logoutBtn'),
  userBadge: document.getElementById('userBadge'),
  userRole: document.getElementById('userRole'),
  // Admin modal
  changePasswordModal: document.getElementById('changePasswordModal'),
  adminSettingsBtn: document.getElementById('adminSettingsBtn'),
  closePasswordModal: document.getElementById('closePasswordModal'),
  cancelPasswordChange: document.getElementById('cancelPasswordChange'),
  savePasswordChange: document.getElementById('savePasswordChange'),
  masterPasswordConfirm: document.getElementById('masterPasswordConfirm'),
  newAccessPassword: document.getElementById('newAccessPassword'),
  confirmAccessPassword: document.getElementById('confirmAccessPassword'),
  passwordModalError: document.getElementById('passwordModalError'),
  passwordModalSuccess: document.getElementById('passwordModalSuccess'),
  // Dashboard
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText'),
  botToggle: document.getElementById('botToggle'),
  botStatus: document.getElementById('botStatus'),
  demoToggle: document.getElementById('demoToggle'),
  demoStatus: document.getElementById('demoStatus'),
  liveBadge: document.getElementById('liveBadge'),
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
  paramMaxPos: document.getElementById('paramMaxPos'),
  apiUsed: document.getElementById('apiUsed'),
  apiRemaining: document.getElementById('apiRemaining'),
  apiPlan: document.getElementById('apiPlan'),
  apiPlanBadge: document.getElementById('apiPlanBadge'),
  apiDailyUsed: document.getElementById('apiDailyUsed'),
  apiDailyLimit: document.getElementById('apiDailyLimit'),
  apiResetIn: document.getElementById('apiResetIn'),
  apiReqPerMin: document.getElementById('apiReqPerMin'),
  creditBarFill: document.getElementById('creditBarFill'),
  creditBarText: document.getElementById('creditBarText'),
  creditBarLimit: document.getElementById('creditBarLimit')
};

// ═══════════════════════════════════════════════════════════════
// AUTH HELPERS
// ═══════════════════════════════════════════════════════════════

function getToken() {
  return sessionStorage.getItem('authToken');
}

function setToken(token) {
  state.authToken = token;
  if (token) {
    sessionStorage.setItem('authToken', token);
  } else {
    sessionStorage.removeItem('authToken');
  }
}

function getAuthHeaders() {
  const token = getToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {})
  };
}

// ═══════════════════════════════════════════════════════════════
// API HELPERS (with auth headers)
// ═══════════════════════════════════════════════════════════════

async function apiGet(endpoint) {
  console.log(`[FRONTEND] GET ${endpoint}`);
  const res = await fetch(`${API_BASE}${endpoint}`, {
    headers: getAuthHeaders()
  });

  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    data = { error: 'Invalid JSON response from server' };
  }

  if (res.status === 401) {
    handleUnauthorized();
    const err = new Error('Session expired. Please log in again.');
    err.status = 401;
    throw err;
  }

  if (!res.ok) {
    const err = new Error(data.detail || data.error || data.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.response = data;
    throw err;
  }
  return data;
}

async function apiPost(endpoint, body) {
  console.log(`[FRONTEND] POST ${endpoint}`, body);
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(body)
  });

  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    data = { error: 'Invalid JSON response from server' };
  }

  if (res.status === 401) {
    handleUnauthorized();
    const err = new Error('Session expired. Please log in again.');
    err.status = 401;
    throw err;
  }

  if (!res.ok) {
    const err = new Error(data.detail || data.error || data.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.response = data;
    throw err;
  }
  return data;
}

function handleUnauthorized() {
  setToken(null);
  state.userRole = null;
  showLoginOverlay();
  showToast('Session expired. Please log in again.', 'warning');
}

// ═══════════════════════════════════════════════════════════════
// LOGIN / LOGOUT
// ═══════════════════════════════════════════════════════════════

function showLoginOverlay() {
  els.loginOverlay.classList.remove('hidden');
  els.loginPassword.value = '';
  els.loginError.textContent = '';
  els.loginPassword.focus();
}

function hideLoginOverlay() {
  els.loginOverlay.classList.add('hidden');
}

async function attemptLogin() {
  const password = els.loginPassword.value.trim();
  if (!password) {
    els.loginError.textContent = 'Please enter a password';
    return;
  }

  els.loginBtn.disabled = true;
  els.loginBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> Checking...`;

  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });

    const data = await res.json();

    if (!res.ok || !data.success) {
      els.loginError.textContent = data.error || 'Invalid password';
      els.loginPassword.value = '';
      els.loginPassword.focus();
      return;
    }

    setToken(data.token);
    state.userRole = data.role;
    els.loginError.textContent = '';
    hideLoginOverlay();
    updateUserUI();
    showToast(`Welcome! Logged in as ${data.role.toUpperCase()}`, 'success');

    // Start dashboard
    await initDashboard();

  } catch (err) {
    els.loginError.textContent = 'Connection error. Try again.';
    console.error('[FRONTEND] Login error:', err);
  } finally {
    els.loginBtn.disabled = false;
    els.loginBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg> Unlock`;
  }
}

function logout() {
  setToken(null);
  state.userRole = null;
  location.reload();
}

function updateUserUI() {
  if (state.userRole) {
    els.userBadge.style.display = 'flex';
    els.userRole.textContent = state.userRole;
    els.userRole.style.color = state.userRole === 'admin' ? 'var(--blue)' : 'var(--green)';

    // Show admin settings button only for admin
    if (state.userRole === 'admin') {
      els.adminSettingsBtn.style.display = 'flex';
    } else {
      els.adminSettingsBtn.style.display = 'none';
    }
  } else {
    els.userBadge.style.display = 'none';
    els.adminSettingsBtn.style.display = 'none';
  }
}

// ═══════════════════════════════════════════════════════════════
// CHANGE PASSWORD MODAL
// ═══════════════════════════════════════════════════════════════

function openPasswordModal() {
  els.changePasswordModal.style.display = 'flex';
  els.masterPasswordConfirm.value = '';
  els.newAccessPassword.value = '';
  els.confirmAccessPassword.value = '';
  els.passwordModalError.textContent = '';
  els.passwordModalSuccess.textContent = '';
  els.newAccessPassword.focus();
}

function closePasswordModalFn() {
  els.changePasswordModal.style.display = 'none';
}

async function saveNewPassword() {
  const masterPass = els.masterPasswordConfirm.value;
  const newPass = els.newAccessPassword.value;
  const confirmPass = els.confirmAccessPassword.value;

  els.passwordModalError.textContent = '';
  els.passwordModalSuccess.textContent = '';

  if (!masterPass) {
    els.passwordModalError.textContent = 'Master password is required';
    return;
  }
  if (!newPass || newPass.length < 4) {
    els.passwordModalError.textContent = 'Password must be at least 4 characters';
    return;
  }
  if (newPass !== confirmPass) {
    els.passwordModalError.textContent = 'Passwords do not match';
    return;
  }

  try {
    const data = await apiPost('/api/auth/change-password', { masterPassword: masterPass, newPassword: newPass });
    // Clear the master password field regardless of outcome — never leave it sitting in the DOM.
    els.masterPasswordConfirm.value = '';
    if (data.success) {
      els.passwordModalSuccess.textContent = data.message;
      setTimeout(closePasswordModalFn, 1500);
      showToast('Access password updated — previous sessions revoked', 'success');
    } else {
      els.passwordModalError.textContent = data.error || 'Failed to update password';
    }
  } catch (err) {
    els.masterPasswordConfirm.value = '';
    els.passwordModalError.textContent = err.message || 'Failed to update password';
  }
}

// ═══════════════════════════════════════════════════════════════
// HEALTH & DEMO STATUS
// ═══════════════════════════════════════════════════════════════

async function checkHealth() {
  try {
    const data = await apiGet('/health');
    els.statusDot.className = 'status-dot online';
    els.statusText.textContent = data.apiKeyPresent ? 'Online' : 'No API Key';

    if (typeof data.demoMode === 'boolean') {
      state.demoMode = data.demoMode;
      els.demoToggle.checked = state.demoMode;
      updateDemoUI();
    }

    if (!data.apiKeyPresent && !state.demoMode) {
      showToast('TWELVE_DATA_API_KEY not set! Toggle Demo Mode to test.', 'warning', 8000);
    }
    return true;
  } catch (err) {
    els.statusDot.className = 'status-dot offline';
    els.statusText.textContent = 'Offline';
    console.error('[FRONTEND] Health check failed:', err.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// DEMO TOGGLE
// ═══════════════════════════════════════════════════════════════

function updateDemoUI() {
  els.demoStatus.textContent = state.demoMode ? 'ON' : 'OFF';
  els.demoStatus.className = 'toggle-status demo-status ' + (state.demoMode ? 'on' : '');
  els.liveBadge.textContent = state.demoMode ? '&#9679; DEMO' : '&#9679; LIVE';
  els.liveBadge.className = state.demoMode ? 'live-badge demo' : 'live-badge';
  document.querySelector('.card-setup')?.classList.toggle('demo-active', state.demoMode);
}

async function toggleDemo() {
  const enabled = els.demoToggle.checked;
  try {
    await apiPost('/api/demo', { enabled });
    state.demoMode = enabled;
    updateDemoUI();
    showToast(`Demo mode ${enabled ? 'enabled' : 'disabled'}`, 'info');
    await loadAllMarketData();
    await loadApiUsage();
  } catch (err) {
    console.error('[FRONTEND] Demo toggle failed:', err);
    els.demoToggle.checked = state.demoMode;
    showToast('Failed to toggle demo mode', 'error');
  }
}

// ═══════════════════════════════════════════════════════════════
// PAIRS GRID
// ═══════════════════════════════════════════════════════════════

function renderPairsGrid() {
  els.pairsGrid.innerHTML = PAIRS.map(sym => `
    <div class="pair-card active" data-symbol="${sym}" id="pair-${sym.replace('/', '')}">
      <div class="pair-symbol">${sym}</div>
      <div class="pair-price" id="price-${sym.replace('/', '')}">Loading...</div>
      <div class="pair-change" id="change-${sym.replace('/', '')}">--</div>
      <div class="pair-score" id="score-${sym.replace('/', '')}" style="display:none;">--%</div>
      <div class="pair-last-signal" id="lastsig-${sym.replace('/', '')}">Waiting for data...</div>
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
}

// ═══════════════════════════════════════════════════════════════
// MARKET DATA
// ═══════════════════════════════════════════════════════════════

async function loadAllMarketData() {
  try {
    const data = await apiGet('/api/market-data?symbol=ALL');
    console.log('[FRONTEND] Market data response:', data);

    if (data.allPairs) {
      PAIRS.forEach(sym => {
        const pairData = data.allPairs[sym];
        if (pairData) {
          const q = pairData.quote;
          if (q && !q.error && q.price) {
            state.pairs[sym].price = q.price;
            state.pairs[sym].change = q.change;
            state.pairs[sym].changePercent = q.changePercent;
            state.pairs[sym].lastCheck = pairData.timestamp;
            state.marketStatus = 'open';
            updatePairCard(sym, q);
          } else if (q && q.error) {
            console.warn(`[FRONTEND] Quote error for ${sym}:`, q.message);
            state.marketStatus = q.marketClosed ? 'closed' : 'error';
            showMarketStatus(sym, q.marketClosed ? 'closed' : 'error', q.message);
          }
        }
      });
    }

    if (!data.anySuccess) {
      console.warn('[FRONTEND] No successful market data');
      if (data.lastError) {
        showMarketStatus('XAU/USD', 'error', data.lastError);
      }
    }
  } catch (err) {
    console.error('[FRONTEND] Market data error:', err.message);
    showMarketStatus('XAU/USD', 'error', err.message);
  }
}

function updatePairCard(sym, quote) {
  const id = sym.replace('/', '');
  const priceEl = document.getElementById(`price-${id}`);
  const changeEl = document.getElementById(`change-${id}`);
  const card = document.getElementById(`pair-${id}`);
  const lastSigEl = document.getElementById(`lastsig-${id}`);

  if (priceEl) {
    priceEl.textContent = quote.price.toFixed(2);
    priceEl.style.color = 'var(--text-primary)';
    priceEl.style.fontSize = '';
  }

  if (changeEl) {
    const isUp = quote.change >= 0;
    changeEl.className = 'pair-change ' + (isUp ? 'up' : 'down');
    changeEl.textContent = `${isUp ? '+' : ''}${quote.changePercent.toFixed(2)}%`;
    changeEl.style.color = '';
  }

  if (card) {
    card.classList.remove('bullish', 'bearish', 'neutral');
    card.classList.add(quote.change >= 0 ? 'bullish' : 'bearish');
  }

  if (lastSigEl) {
    lastSigEl.textContent = 'Live price updated';
    lastSigEl.style.color = 'var(--text-secondary)';
  }
}

function showMarketStatus(sym, status, message) {
  const id = sym.replace('/', '');
  const priceEl = document.getElementById(`price-${id}`);
  const changeEl = document.getElementById(`change-${id}`);
  const card = document.getElementById(`pair-${id}`);
  const lastSigEl = document.getElementById(`lastsig-${id}`);

  if (priceEl) {
    priceEl.textContent = status === 'closed' ? 'Market Closed' : 'Error';
    priceEl.style.color = status === 'closed' ? 'var(--yellow)' : 'var(--red)';
    priceEl.style.fontSize = '1rem';
  }

  if (changeEl) {
    changeEl.textContent = status === 'closed' ? 'Sunday — opens 6pm EST' : (message || 'Connection error');
    changeEl.className = 'pair-change';
    changeEl.style.color = status === 'closed' ? 'var(--yellow)' : 'var(--red)';
  }

  if (card) {
    card.classList.remove('bullish', 'bearish');
    card.classList.add('neutral');
  }

  if (lastSigEl) {
    lastSigEl.textContent = status === 'closed' ? 'Markets closed — setups unavailable' : (message || 'Error fetching data');
    lastSigEl.style.color = status === 'closed' ? 'var(--yellow)' : 'var(--red)';
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
    console.log('[FRONTEND] Setup response:', setup);

    if (setup.error) {
      if (setup.error === 'MARKET_CLOSED') {
        showToast(`Market Closed: ${setup.detail || 'XAU/USD is closed.'}`, 'warning', 8000);
        resetGenerateBtn();
        return;
      }
      if (setup.error === 'INSUFFICIENT_DATA') {
        showToast(`Not enough data: ${setup.detail}`, 'warning', 6000);
        resetGenerateBtn();
        return;
      }
      if (setup.error === 'QUOTE_ERROR') {
        showToast(`Data error: ${setup.detail}`, 'error', 6000);
        resetGenerateBtn();
        return;
      }
      throw new Error(setup.detail || setup.error || 'Backend returned an error');
    }

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
    handleApiError(err, 'generate setup');
  } finally {
    resetGenerateBtn();
  }
}

function resetGenerateBtn() {
  els.generateBtn.disabled = false;
  els.generateBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg> Generate Setup`;
}

function handleApiError(err, context) {
  const msg = err.message || 'Unknown error';
  const status = err.status || err.response?.status || 0;

  console.error(`[FRONTEND] ${context} error:`, { status, message: msg, response: err.response });

  if (status === 401) {
    showToast('Session expired. Please log in again.', 'warning', 6000);
  } else if (status === 404) {
    showToast('Server endpoint not found. Check deployment.', 'error', 8000);
  } else if (status === 429 || msg.includes('429') || msg.includes('rate')) {
    showToast('Rate limited. Wait 30s and try again.', 'warning', 6000);
  } else if (status === 503) {
    showToast(`Service unavailable: ${msg}`, 'error', 6000);
  } else if (msg.includes('market') || msg.includes('closed')) {
    showToast('Market is closed. XAU/USD opens Sunday ~6pm EST.', 'warning', 8000);
  } else if (msg.includes('json') || msg.includes('JSON')) {
    showToast('Server returned invalid data. Check deployment.', 'error', 8000);
  } else {
    showToast(`Error: ${msg}`, 'error', 6000);
  }
}

// ═══════════════════════════════════════════════════════════════
// SCAN ALL
// ═══════════════════════════════════════════════════════════════

async function scanAllPairs() {
  if (state.isScanning) return;
  state.isScanning = true;

  els.scanAllBtn.disabled = true;
  els.scanAllBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/></svg> Scanning...`;

  try {
    const data = await apiGet('/api/setup?scan=true');

    if (data.error) {
      throw new Error(data.detail || data.error || 'Scan failed');
    }

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
    } else {
      showToast('No setups found. Market may be closed or API key invalid.', 'warning');
    }
  } catch (err) {
    handleApiError(err, 'scan');
  } finally {
    state.isScanning = false;
    els.scanAllBtn.disabled = false;
    els.scanAllBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg> Scan Setup`;
  }
}

// ═══════════════════════════════════════════════════════════════
// SETUP RENDERING
// ═══════════════════════════════════════════════════════════════

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

function renderSetup(setup) {
  els.setupResult.style.display = 'block';

  els.signalBadge.textContent = setup.signal;
  els.signalBadge.className = 'signal-badge ' + setup.signal.toLowerCase();

  const circumference = 2 * Math.PI * 50;
  const offset = circumference - (setup.score / 100) * circumference;
  els.scoreProgress.style.strokeDashoffset = offset;
  els.scoreProgress.className = 'score-progress ' + (setup.score >= 70 ? 'high' : setup.score >= 45 ? 'medium' : 'low');

  animateNumber(els.scoreNumber, setup.score);

  const decimals = 2;

  const detailsHTML = `
    <div class="detail-item"><span class="detail-label">Pair</span><span class="detail-value">${setup.symbol}</span></div>
    <div class="detail-item"><span class="detail-label">Current Price</span><span class="detail-value">${setup.currentPrice?.toFixed(decimals) || '--'}</span></div>
    <div class="detail-item"><span class="detail-label">Direction</span><span class="detail-value">${setup.signal}</span></div>
    <div class="detail-item"><span class="detail-label">Setup %</span><span class="detail-value">${setup.score}%</span></div>
    <div class="detail-item"><span class="detail-label">Criteria Fulfilled</span><span class="detail-value">${setup.passedCriteria}/${setup.totalCriteria}</span></div>
  `;
  els.setupDetails.innerHTML = detailsHTML;
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
// TRADE EXECUTION
// ═══════════════════════════════════════════════════════════════

async function executeTrade() {
  if (!state.lastSetup) {
    showToast('No setup generated yet. Click Generate Setup first.', 'warning');
    return;
  }
  const symbol = state.lastSetupSymbol || els.setupPairSelect.value;

  try {
    const result = await apiPost('/api/setup/execute', { symbol, setupId: Date.now() });
    showToast(`Position opened: ${result.position.id} on ${symbol}`, 'success');
    els.executeBtn.style.display = 'none';
    loadTrades();
  } catch (err) {
    handleApiError(err, 'execute trade');
  }
}

async function loadTrades() {
  try {
    const data = await apiGet('/api/trades');

    if (data.activePositions && data.activePositions.length > 0) {
      els.tradesBody.innerHTML = data.activePositions.map(pos => {
        const decimals = 2;
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
        const decimals = 2;
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
    console.error('[FRONTEND] Trades load error:', err);
  }
}

async function closePosition(id, symbol) {
  try {
    await apiPost(`/api/positions/${id}/close`, { symbol });
    showToast('Position closed', 'info');
    loadTrades();
  } catch (err) {
    handleApiError(err, 'close position');
  }
}

// ═══════════════════════════════════════════════════════════════
// SIGNAL LOG
// ═══════════════════════════════════════════════════════════════

function addSignalToLog(setup) {
  const time = new Date().toLocaleTimeString();
  const div = document.createElement('div');
  div.className = `signal-item ${setup.signal.toLowerCase()}`;
  const decimals = 2;
  div.innerHTML = `
    <span class="signal-time">${time}</span>
    <div class="signal-info">
      <div class="signal-symbol">${setup.symbol} &mdash; ${setup.signal}</div>
      <div class="signal-detail">Price: ${setup.currentPrice?.toFixed(decimals)} | Criteria: ${setup.passedCriteria}/${setup.totalCriteria}</div>
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
// BOT CONTROL
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
    handleApiError(err, 'bot control');
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
    console.error('[FRONTEND] Settings update failed:', err);
  }
}

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

    if (typeof status.demoMode === 'boolean') {
      state.demoMode = status.demoMode;
      els.demoToggle.checked = state.demoMode;
      updateDemoUI();
    }
  } catch (err) {
    console.error('[FRONTEND] Status load error:', err);
  }
}

// ═══════════════════════════════════════════════════════════════
// API USAGE
// ═══════════════════════════════════════════════════════════════

async function loadApiUsage() {
  try {
    const data = await apiGet('/api/usage');
    console.log('[FRONTEND] Usage data:', data);
    state.apiUsage = data;
    renderApiUsage(data);
  } catch (err) {
    console.error('[FRONTEND] API usage load error:', err);
    renderApiUsageError(err.message);
  }
}

function renderApiUsage(data) {
  const plan = data.plan || 'Unknown';
  const used = data.apiCreditsUsed || 0;
  const remaining = data.apiCreditsRemaining || 0;
  const total = data.apiCreditsLimit || (used + remaining) || 100;
  const reqPerMin = data.requestsThisMinute || 0;

  let resetText = 'Every minute';
  if (data.minuteResetAt) {
    const d = new Date(data.minuteResetAt);
    const now = new Date();
    const diff = Math.max(0, Math.floor((d - now) / 1000));
    if (diff > 0) {
      const mins = Math.floor(diff / 60);
      const secs = diff % 60;
      resetText = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    } else {
      resetText = 'Now';
    }
  }

  els.apiPlan.textContent = plan;
  els.apiPlanBadge.textContent = plan;
  els.apiUsed.textContent = used;
  els.apiRemaining.textContent = remaining;
  els.apiDailyUsed.textContent = used;
  els.apiDailyLimit.textContent = total;
  els.apiResetIn.textContent = resetText;
  els.apiReqPerMin.textContent = reqPerMin;

  const pct = total > 0 ? (used / total) * 100 : 0;
  els.creditBarFill.style.width = `${pct}%`;
  els.creditBarFill.className = 'credit-bar-fill ' + (pct > 80 ? 'danger' : pct > 50 ? 'warning' : '');
  els.creditBarText.textContent = `${used} / ${total} used (${Math.round(pct)}%)`;
  els.creditBarLimit.textContent = total;

  if (!data.hasData && data.message) {
    els.creditBarText.textContent = data.message;
    els.creditBarFill.style.width = '0%';
  }

  if (remaining <= 3 && data.hasData) {
    showToast('Low API credits remaining! Slow down requests.', 'warning', 5000);
  }
}

function renderApiUsageError(msg) {
  els.apiPlan.textContent = 'Error';
  els.apiPlanBadge.textContent = 'Error';
  els.apiUsed.textContent = '--';
  els.apiRemaining.textContent = '--';
  els.creditBarText.textContent = msg.includes('404') ? 'Server endpoint missing.' : 'Unable to load usage';
  els.creditBarFill.style.width = '0%';
}

// ═══════════════════════════════════════════════════════════════
// TOASTS
// ═══════════════════════════════════════════════════════════════

function showToast(message, type = 'info', duration = 4000) {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  els.toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

// ═══════════════════════════════════════════════════════════════
// EVENT LISTENERS
// ═══════════════════════════════════════════════════════════════

els.loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  attemptLogin();
});

els.logoutBtn.addEventListener('click', logout);
els.generateBtn.addEventListener('click', () => generateSetup());
els.executeBtn.addEventListener('click', executeTrade);
els.refreshTrades.addEventListener('click', loadTrades);
els.botToggle.addEventListener('change', toggleBot);
els.scanAllBtn.addEventListener('click', scanAllPairs);
els.demoToggle.addEventListener('change', toggleDemo);

els.adminSettingsBtn.addEventListener('click', openPasswordModal);
els.closePasswordModal.addEventListener('click', closePasswordModalFn);
els.cancelPasswordChange.addEventListener('click', closePasswordModalFn);
els.savePasswordChange.addEventListener('click', saveNewPassword);

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

async function initDashboard() {
  console.log('[FRONTEND] Initializing dashboard...');

  renderPairsGrid();

  const health = await checkHealth();
  if (!health) {
    showToast('Cannot connect to backend. Is the server running?', 'error', 10000);
  }

  await loadStatus();
  await loadAllMarketData();
  await loadTrades();
  await loadApiUsage();

  setInterval(checkHealth, 30000);
  setInterval(loadAllMarketData, 30000);
  setInterval(loadTrades, 15000);
  setInterval(loadApiUsage, 10000);

  console.log('[FRONTEND] Dashboard initialized');
}

async function init() {
  // Check for existing session
  const savedToken = getToken();
  if (savedToken) {
    try {
      const status = await apiGet('/api/auth/status');
      if (status.authenticated) {
        state.userRole = status.role;
        hideLoginOverlay();
        updateUserUI();
        await initDashboard();
        return;
      }
    } catch (err) {
      console.log('[FRONTEND] Saved token invalid, showing login');
      setToken(null);
    }
  }

  // No valid session — show login
  showLoginOverlay();
}

init();
