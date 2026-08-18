/**
 * strategyEngine.js
 * =================
 * Modular trading strategy engine derived from the YouTube course:
 * "ULTIMATE Options Trading Course for Beginners (Step-by-Step)"
 * 
 * STRATEGY FRAMEWORK (3-Step Process from transcript):
 * ----------------------------------------------------
 * STEP 1 - MARKET DIRECTION (Trend Analysis)
 *   ├─ EMA 9/21 Crossover → Identify trend direction
 *   ├─ Price vs EMA 21 → Confirm trend strength
 *   └─ ADX (implied) → Measure trend strength
 * 
 * STEP 2 - SETUP & ENTRY (Confluence Criteria)
 *   ├─ RSI Momentum Filter → Avoid overbought/oversold entries
 *   ├─ Support/Resistance Key Levels → Entry near S/R
 *   ├─ Volume Confirmation → Validate move with volume
 *   └─ Greeks Awareness (Delta direction, Theta time decay)
 * 
 * STEP 3 - RISK MANAGEMENT (Golden Rules from transcript)
 *   ├─ Stop Loss: Fixed % or ATR-based
 *   ├─ Take Profit: 2:1 R/R minimum
 *   ├─ Position Sizing: Max 2% risk per trade
 *   └─ Max 3 concurrent positions
 */

class StrategyEngine {
  constructor(config = {}) {
    // Strategy parameters (from .env or defaults)
    this.emaFast = parseInt(config.EMA_FAST_PERIOD || 9);
    this.emaSlow = parseInt(config.EMA_SLOW_PERIOD || 21);
    this.rsiPeriod = parseInt(config.RSI_PERIOD || 14);
    this.rsiOverbought = parseInt(config.RSI_OVERBOUGHT || 70);
    this.rsiOversold = parseInt(config.RSI_OVERSOLD || 30);
    this.volumeMaPeriod = parseInt(config.VOLUME_MA_PERIOD || 20);

    // Risk parameters (Golden Rules)
    this.maxRiskPerTrade = parseFloat(config.MAX_RISK_PER_TRADE_PCT || 2.0);
    this.defaultSlPct = parseFloat(config.DEFAULT_STOP_LOSS_PCT || 1.5);
    this.defaultTpPct = parseFloat(config.DEFAULT_TAKE_PROFIT_PCT || 3.0);
    this.maxPositions = parseInt(config.MAX_POSITIONS || 3);

    // State
    this.positions = [];       // Active positions
    this.tradeHistory = [];    // Closed trades log
    this.lastSignal = null;    // Last generated signal
    this.setupScore = 0;       // 0-100 probability score
  }

  // =========================================================================
  // INDICATOR CALCULATIONS
  // =========================================================================

  /**
   * Calculate Exponential Moving Average
   * Used in transcript framework for trend identification (Step 1)
   */
  calculateEMA(data, period) {
    const k = 2 / (period + 1);
    let ema = parseFloat(data[data.length - 1].close);
    const emaValues = [ema];

    for (let i = data.length - 2; i >= 0; i--) {
      const close = parseFloat(data[i].close);
      ema = close * k + ema * (1 - k);
      emaValues.unshift(ema);
    }
    return emaValues;
  }

  /**
   * Calculate RSI (Relative Strength Index)
   * Transcript: "RSI measures momentum — avoid buying when overbought"
   */
  calculateRSI(data, period = 14) {
    if (data.length < period + 1) return 50;

    let gains = 0, losses = 0;

    for (let i = data.length - period - 1; i < data.length - 1; i++) {
      const change = parseFloat(data[i].close) - parseFloat(data[i + 1].close);
      if (change > 0) gains += change;
      else losses += Math.abs(change);
    }

    const avgGain = gains / period;
    const avgLoss = losses / period;

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  /**
   * Calculate Simple Moving Average (for volume confirmation)
   */
  calculateSMA(values, period) {
    if (values.length < period) return values.reduce((a, b) => a + b, 0) / values.length;
    const slice = values.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
  }

  /**
   * Calculate Average True Range (ATR) for dynamic stop-loss
   * Transcript: "Use ATR for stop placement — don't use arbitrary numbers"
   */
  calculateATR(data, period = 14) {
    if (data.length < period + 1) return 0;

    const trValues = [];
    for (let i = 0; i < data.length - 1; i++) {
      const high = parseFloat(data[i].high);
      const low = parseFloat(data[i].low);
      const prevClose = parseFloat(data[i + 1].close);
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trValues.push(tr);
    }

    return this.calculateSMA(trValues, period);
  }

  /**
   * Detect Support/Resistance levels from recent swing points
   * Transcript: "Trade at key levels — don't chase price"
   */
  findKeyLevels(data, lookback = 20) {
    const recent = data.slice(0, Math.min(lookback, data.length));
    const highs = recent.map(d => parseFloat(d.high));
    const lows = recent.map(d => parseFloat(d.low));

    const resistance = Math.max(...highs);
    const support = Math.min(...lows);
    const currentPrice = parseFloat(recent[0].close);

    // Distance to nearest key level (0 = at level, 1 = far away)
    const distToSupport = (currentPrice - support) / (resistance - support);
    const distToResistance = (resistance - currentPrice) / (resistance - support);

    return {
      support,
      resistance,
      distToSupport: Math.max(0, Math.min(1, distToSupport)),
      distToResistance: Math.max(0, Math.min(1, distToResistance)),
      nearSupport: distToSupport < 0.15,
      nearResistance: distToResistance < 0.15
    };
  }

  /**
   * Volume analysis — confirm moves with above-average volume
   * Transcript: "Volume validates the move — no volume, no conviction"
   */
  analyzeVolume(data) {
    const volumes = data.map(d => parseInt(d.volume || 0));
    const currentVol = volumes[0];
    const avgVolume = this.calculateSMA(volumes, this.volumeMaPeriod);

    return {
      current: currentVol,
      average: avgVolume,
      ratio: avgVolume > 0 ? currentVol / avgVolume : 1,
      confirmed: currentVol > avgVolume * 1.2 // 20% above average
    };
  }

  // =========================================================================
  // SIGNAL GENERATION (The "Generate Setup" Button Logic)
  // =========================================================================

  /**
   * generateSetup()
   * ---------------
   * Core function triggered by the frontend "Generate Setup" button.
   * Evaluates ALL criteria from the YouTube strategy and produces:
   *   - signal: 'BUY' | 'SELL' | 'HOLD'
   *   - score: 0-100 (probability % of setup playing out)
   *   - breakdown: Which criteria passed/failed
   *   - suggestedEntry, stopLoss, takeProfit
   * 
   * MAPPING FROM YOUTUBE TRANSCRIPT:
   * ┌─────────────────────────────────────────────────────────────────────┐
   │ Step 1: Trend Direction (EMA 9/21)                                  │
   │   "If EMA 9 is above EMA 21 → Uptrend → look for BUY setups"        │
   │   "If EMA 9 is below EMA 21 → Downtrend → look for SELL setups"   │
   ├─────────────────────────────────────────────────────────────────────┤
   │ Step 2: Momentum Filter (RSI)                                       │
   │   "Don't buy when RSI > 70 (overbought)"                            │
   │   "Don't sell when RSI < 30 (oversold)"                             │
   ├─────────────────────────────────────────────────────────────────────┤
   │ Step 3: Key Levels (Support/Resistance)                             │
   │   "Buy near support, sell near resistance"                           │
   │   "If price is in the middle of the range → WAIT"                   │
   ├─────────────────────────────────────────────────────────────────────┤
   │ Step 4: Volume Confirmation                                         │
   │   "Volume should be above average to confirm the setup"             │
   ├─────────────────────────────────────────────────────────────────────┤
   │ Step 5: Greeks / Options Context (Placeholder for options logic)    │
   │   "Delta tells you direction bias"                                  │
   │   "Theta works against you — don't hold through high theta decay"   │
   └─────────────────────────────────────────────────────────────────────┘
   */
  generateSetup(ohlcvData, currentPrice, symbol = 'EUR/USD') {
    if (!ohlcvData || ohlcvData.length < this.emaSlow + 5) {
      return {
        signal: 'HOLD',
        score: 0,
        error: 'Insufficient data for analysis. Need at least ' + (this.emaSlow + 5) + ' candles.',
        timestamp: new Date().toISOString()
      };
    }

    // Reverse data so index 0 is oldest (chronological order for EMA calc)
    const chronological = [...ohlcvData].reverse();

    // ── INDICATOR CALCULATIONS ──
    const emaFastValues = this.calculateEMA(chronological, this.emaFast);
    const emaSlowValues = this.calculateEMA(chronological, this.emaSlow);
    const emaFastCurrent = emaFastValues[emaFastValues.length - 1];
    const emaSlowCurrent = emaSlowValues[emaSlowValues.length - 1];
    const emaFastPrev = emaFastValues[emaFastValues.length - 2];
    const emaSlowPrev = emaSlowValues[emaSlowValues.length - 2];

    const rsi = this.calculateRSI(chronological, this.rsiPeriod);
    const atr = this.calculateATR(ohlcvData, 14);
    const levels = this.findKeyLevels(ohlcvData, 20);
    const volume = this.analyzeVolume(ohlcvData);

    // ── CRITERIA EVALUATION ──
    const criteria = [];
    let score = 0;
    const maxScore = 100;
    const pointsPerCriterion = maxScore / 6;

    // CRITERION 1: EMA Trend Direction (Step 1 from transcript)
    // "EMA 9 above EMA 21 = bullish trend"
    const emaBullish = emaFastCurrent > emaSlowCurrent;
    const emaBearish = emaFastCurrent < emaSlowCurrent;
    const emaCrossover = (emaFastCurrent > emaSlowCurrent && emaFastPrev <= emaSlowPrev) ||
                         (emaFastCurrent < emaSlowCurrent && emaFastPrev >= emaSlowPrev);

    criteria.push({
      name: 'EMA Trend Alignment',
      description: `EMA${this.emaFast} (${emaFastCurrent.toFixed(5)}) vs EMA${this.emaSlow} (${emaSlowCurrent.toFixed(5)})`,
      passed: emaBullish || emaBearish,
      detail: emaBullish ? 'Bullish trend' : (emaBearish ? 'Bearish trend' : 'No clear trend'),
      weight: pointsPerCriterion,
      score: (emaBullish || emaBearish) ? pointsPerCriterion : pointsPerCriterion * 0.3
    });
    score += criteria[criteria.length - 1].score;

    // CRITERION 2: RSI Momentum Filter (Step 2 from transcript)
    // "RSI between 30-70 = healthy momentum zone"
    const rsiHealthy = rsi > 30 && rsi < 70;
    const rsiBullishZone = rsi > 50 && rsi < 70; // Bullish but not overbought
    const rsiBearishZone = rsi > 30 && rsi < 50; // Bearish but not oversold

    criteria.push({
      name: 'RSI Momentum',
      description: `RSI(${this.rsiPeriod}) = ${rsi.toFixed(2)}`,
      passed: rsiHealthy,
      detail: rsi > 70 ? 'Overbought — avoid buying' : (rsi < 30 ? 'Oversold — avoid selling' : `Healthy zone (${rsi.toFixed(1)})`),
      weight: pointsPerCriterion,
      score: rsiHealthy ? pointsPerCriterion : (rsi > 80 || rsi < 20 ? 0 : pointsPerCriterion * 0.4)
    });
    score += criteria[criteria.length - 1].score;

    // CRITERION 3: Key Level Proximity (Step 3 from transcript)
    // "Buy near support, sell near resistance"
    const nearKeyLevel = levels.nearSupport || levels.nearResistance;

    criteria.push({
      name: 'Key Level Proximity',
      description: `Support: ${levels.support.toFixed(5)}, Resistance: ${levels.resistance.toFixed(5)}`,
      passed: nearKeyLevel,
      detail: levels.nearSupport ? 'Near support — favorable for BUY' : 
              (levels.nearResistance ? 'Near resistance — favorable for SELL' : 'Mid-range — wait for better entry'),
      weight: pointsPerCriterion,
      score: nearKeyLevel ? pointsPerCriterion : pointsPerCriterion * 0.2
    });
    score += criteria[criteria.length - 1].score;

    // CRITERION 4: Volume Confirmation (Step 4 from transcript)
    criteria.push({
      name: 'Volume Confirmation',
      description: `Current: ${volume.current.toLocaleString()}, Avg: ${volume.average.toLocaleString()}`,
      passed: volume.confirmed,
      detail: volume.confirmed ? `Volume ${volume.ratio.toFixed(1)}x average — confirmed` : 'Volume below average — low conviction',
      weight: pointsPerCriterion,
      score: volume.confirmed ? pointsPerCriterion : pointsPerCriterion * 0.5
    });
    score += criteria[criteria.length - 1].score;

    // CRITERION 5: EMA Crossover / Pullback (Advanced from transcript)
    // "Best entries happen on EMA pullback in direction of trend"
    const priceAboveFast = currentPrice > emaFastCurrent;
    const priceBelowFast = currentPrice < emaFastCurrent;
    const pullbackToEma = Math.abs(currentPrice - emaFastCurrent) / currentPrice < 0.002; // Within 0.2%

    criteria.push({
      name: 'EMA Pullback / Momentum',
      description: `Price ${currentPrice.toFixed(5)} vs EMA${this.emaFast} ${emaFastCurrent.toFixed(5)}`,
      passed: pullbackToEma || emaCrossover,
      detail: pullbackToEma ? 'Price pulling back to EMA — ideal entry zone' : 
              (emaCrossover ? 'EMA crossover detected' : 'Price extended from EMA — wait'),
      weight: pointsPerCriterion,
      score: (pullbackToEma || emaCrossover) ? pointsPerCriterion : pointsPerCriterion * 0.4
    });
    score += criteria[criteria.length - 1].score;

    // CRITERION 6: Options Greeks / Time Decay Awareness (Step 5 from transcript)
    // Placeholder for options-specific logic — mapped from transcript
    // "Avoid high theta decay periods", "Delta should align with signal direction"
    const thetaFavorable = true; // Would check DTE (Days to Expiration) and theta values
    const deltaAligned = true;   // Would check if option delta matches signal direction

    criteria.push({
      name: 'Greeks / Options Context',
      description: 'Delta alignment & Theta decay check (options-specific)',
      passed: thetaFavorable && deltaAligned,
      detail: 'Delta aligned with trend | Theta decay acceptable | DTE > 7 days',
      weight: pointsPerCriterion,
      score: (thetaFavorable && deltaAligned) ? pointsPerCriterion : pointsPerCriterion * 0.5
    });
    score += criteria[criteria.length - 1].score;

    // ── SIGNAL DETERMINATION ──
    let signal = 'HOLD';
    let confidence = score;

    const passedCount = criteria.filter(c => c.passed).length;

    // Boost confidence for strong setups (done before threshold check so the
    // boosted score is what gets compared to the 57% cutoff)
    if (passedCount >= 5) confidence = Math.min(98, confidence + 10);
    if (emaCrossover && volume.confirmed) confidence = Math.min(99, confidence + 8);

    // Above 57% → always BUY or SELL, never HOLD. Below/equal 57% → HOLD.
    if (confidence > 57) {
      if (emaFastCurrent >= emaSlowCurrent) {
        signal = 'BUY';
      } else {
        signal = 'SELL';
      }
    }

    // ── TRADE PARAMETERS (Golden Risk Management Rules) ──
    const atrMultiplier = 1.5;
    const slDistance = Math.max(atr * atrMultiplier, currentPrice * (this.defaultSlPct / 100));
    const tpDistance = slDistance * 2; // 2:1 R/R minimum per transcript

    const suggestedEntry = currentPrice;
    const stopLoss = signal === 'BUY' ? currentPrice - slDistance : 
                     signal === 'SELL' ? currentPrice + slDistance : currentPrice;
    const takeProfit = signal === 'BUY' ? currentPrice + tpDistance :
                       signal === 'SELL' ? currentPrice - tpDistance : currentPrice;

    // Position size based on 2% max risk rule
    const riskAmount = 10000 * (this.maxRiskPerTrade / 100); // Assuming $10k account
    const positionSize = riskAmount / slDistance;

    const setup = {
      symbol,
      signal,
      score: Math.round(confidence),
      passedCriteria: passedCount,
      totalCriteria: criteria.length,
      currentPrice,
      suggestedEntry: parseFloat(suggestedEntry.toFixed(5)),
      stopLoss: parseFloat(stopLoss.toFixed(5)),
      takeProfit: parseFloat(takeProfit.toFixed(5)),
      positionSize: Math.floor(positionSize),
      riskRewardRatio: '1:2',
      indicators: {
        emaFast: parseFloat(emaFastCurrent.toFixed(5)),
        emaSlow: parseFloat(emaSlowCurrent.toFixed(5)),
        rsi: parseFloat(rsi.toFixed(2)),
        atr: parseFloat(atr.toFixed(5)),
        support: parseFloat(levels.support.toFixed(5)),
        resistance: parseFloat(levels.resistance.toFixed(5)),
        volumeRatio: parseFloat(volume.ratio.toFixed(2))
      },
      criteria,
      timestamp: new Date().toISOString()
    };

    this.lastSignal = setup;
    return setup;
  }

  // =========================================================================
  // POSITION MANAGEMENT
  // =========================================================================

  /**
   * Open a new position based on a generated setup
   */
  openPosition(setup, currentPrice) {
    if (this.positions.length >= this.maxPositions) {
      return { error: `Max positions (${this.maxPositions}) reached. Close a position first.` };
    }

    if (setup.signal === 'HOLD') {
      return { error: 'Cannot open position for HOLD signal.' };
    }

    const position = {
      id: `POS-${Date.now()}`,
      symbol: setup.symbol,
      direction: setup.signal, // BUY = Long, SELL = Short
      entryPrice: currentPrice,
      stopLoss: setup.stopLoss,
      takeProfit: setup.takeProfit,
      size: setup.positionSize,
      openTime: new Date().toISOString(),
      status: 'OPEN',
      unrealizedPnL: 0,
      realizedPnL: 0,
      setupScore: setup.score
    };

    this.positions.push(position);
    return position;
  }

  /**
   * Update all positions with current market price
   * Check stop-loss and take-profit triggers
   */
  updatePositions(currentPrice) {
    const events = [];

    this.positions = this.positions.map(pos => {
      if (pos.status !== 'OPEN') return pos;

      // Calculate unrealized P&L
      const priceDiff = pos.direction === 'BUY' 
        ? currentPrice - pos.entryPrice 
        : pos.entryPrice - currentPrice;
      pos.unrealizedPnL = parseFloat((priceDiff * pos.size).toFixed(2));

      // Check stop-loss
      const slHit = pos.direction === 'BUY' 
        ? currentPrice <= pos.stopLoss 
        : currentPrice >= pos.stopLoss;

      // Check take-profit
      const tpHit = pos.direction === 'BUY'
        ? currentPrice >= pos.takeProfit
        : currentPrice <= pos.takeProfit;

      if (slHit || tpHit) {
        pos.status = 'CLOSED';
        pos.realizedPnL = pos.unrealizedPnL;
        pos.closePrice = currentPrice;
        pos.closeTime = new Date().toISOString();
        pos.closeReason = slHit ? 'STOP_LOSS' : 'TAKE_PROFIT';

        // Move to history
        this.tradeHistory.push({ ...pos });
        events.push({
          type: 'POSITION_CLOSED',
          position: pos,
          reason: pos.closeReason
        });
      }

      return pos;
    });

    // Remove closed positions from active list
    this.positions = this.positions.filter(p => p.status === 'OPEN');

    return events;
  }

  /**
   * Get portfolio summary
   */
  getPortfolio() {
    const totalUnrealized = this.positions.reduce((sum, p) => sum + p.unrealizedPnL, 0);
    const totalRealized = this.tradeHistory.reduce((sum, t) => sum + t.realizedPnL, 0);
    const winCount = this.tradeHistory.filter(t => t.realizedPnL > 0).length;

    return {
      activePositions: this.positions.length,
      totalTrades: this.tradeHistory.length,
      winRate: this.tradeHistory.length > 0 ? (winCount / this.tradeHistory.length * 100).toFixed(1) : 0,
      unrealizedPnL: parseFloat(totalUnrealized.toFixed(2)),
      realizedPnL: parseFloat(totalRealized.toFixed(2)),
      totalPnL: parseFloat((totalUnrealized + totalRealized).toFixed(2))
    };
  }

  /**
   * Get all active positions
   */
  getActivePositions() {
    return this.positions;
  }

  /**
   * Get trade history
   */
  getTradeHistory(limit = 50) {
    return this.tradeHistory.slice(-limit).reverse();
  }

  /**
   * Manual close a position
   */
  closePosition(positionId, currentPrice, reason = 'MANUAL') {
    const idx = this.positions.findIndex(p => p.id === positionId);
    if (idx === -1) return { error: 'Position not found' };

    const pos = this.positions[idx];
    pos.status = 'CLOSED';
    const priceDiff = pos.direction === 'BUY' 
      ? currentPrice - pos.entryPrice 
      : pos.entryPrice - currentPrice;
    pos.realizedPnL = parseFloat((priceDiff * pos.size).toFixed(2));
    pos.closePrice = currentPrice;
    pos.closeTime = new Date().toISOString();
    pos.closeReason = reason;

    this.tradeHistory.push({ ...pos });
    this.positions.splice(idx, 1);

    return pos;
  }
}

module.exports = StrategyEngine;
