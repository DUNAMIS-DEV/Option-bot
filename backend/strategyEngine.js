/**
 * strategyEngine.js
 * =================
 * Strategy: Parabolic SAR + Donchian Channel (middle line) confluence
 * Source: "1 MINUTE Pocket Option Strategy" — Steven Day Trader
 *
 * RULES (from the video):
 * ------------------------------------------------------------------
 * 1) Parabolic SAR (acceleration 0.03, max 0.3)
 *      Dots BELOW price → uptrend  → bullish bias
 *      Dots ABOVE price → downtrend → bearish bias
 *
 * 2) Donchian Channel, period 10, MIDDLE LINE only
 *      Price crosses midline TOP → BOTTOM → reversal to downtrend → bearish
 *      Price crosses midline BOTTOM → TOP → reversal to uptrend → bullish
 *
 * 3) Entry: both signals agreeing in the same direction = strongest setup.
 *    Either signal alone still counts, just worth less.
 *
 * SCORING (each worth 50% of the total):
 *   - SAR agrees with the resolved direction        → +50%   (0% if it disagrees)
 *   - Donchian agrees with the resolved direction    → +50%   (0% if it disagrees)
 *   - A *fresh* crossover/flip on either indicator (vs the previous candle)
 *     adds a small bonus on top, since the video treats a fresh cross as
 *     the strongest form of that signal.
 *   Direction is resolved by whichever indicator is currently bullish/bearish;
 *   if they disagree, direction follows the fresher of the two signals but
 *   score stays low since only one side agrees.
 */

class StrategyEngine {
  constructor(config = {}) {
    // Parabolic SAR parameters (from the video: accel 0.03, max 0.3)
    this.sarStep = parseFloat(config.SAR_STEP || 0.03);
    this.sarMax = parseFloat(config.SAR_MAX || 0.3);

    // Donchian Channel period (from the video: period 10)
    this.donchianPeriod = parseInt(config.DONCHIAN_PERIOD || 10);

    // Used only to compute the informational suggested entry/SL/TP/size
    // shown alongside a setup — no positions are opened or tracked.
    this.maxRiskPerTrade = parseFloat(config.MAX_RISK_PER_TRADE_PCT || 2.0);
    this.defaultSlPct = parseFloat(config.DEFAULT_STOP_LOSS_PCT || 1.5);
    this.defaultTpPct = parseFloat(config.DEFAULT_TAKE_PROFIT_PCT || 3.0);

    this.lastSignal = null;    // Last generated signal
  }

  // =========================================================================
  // INDICATOR CALCULATIONS
  // =========================================================================

  /**
   * Parabolic SAR
   * Returns an array (chronological order, same length as input) of
   * { sar, trend: 'up' | 'down' } for each candle.
   * Standard Wilder/AFL implementation.
   */
  calculateParabolicSAR(chronological) {
    const len = chronological.length;
    const result = new Array(len);
    if (len < 2) return result;

    const high = i => parseFloat(chronological[i].high);
    const low = i => parseFloat(chronological[i].low);

    // Seed: assume uptrend if the second candle's close is higher than the first's
    let trend = parseFloat(chronological[1].close) >= parseFloat(chronological[0].close) ? 'up' : 'down';
    let af = this.sarStep;
    let ep = trend === 'up' ? high(0) : low(0); // extreme point
    let sar = trend === 'up' ? low(0) : high(0);

    result[0] = { sar, trend };

    for (let i = 1; i < len; i++) {
      let prevSar = sar;
      sar = prevSar + af * (ep - prevSar);

      if (trend === 'up') {
        // SAR can't be above the prior two candles' lows
        const clampLow = Math.min(low(i - 1), i >= 2 ? low(i - 2) : low(i - 1));
        if (sar > clampLow) sar = clampLow;

        if (low(i) < sar) {
          // Flip to downtrend
          trend = 'down';
          sar = ep;
          ep = low(i);
          af = this.sarStep;
        } else {
          if (high(i) > ep) {
            ep = high(i);
            af = Math.min(af + this.sarStep, this.sarMax);
          }
        }
      } else {
        // downtrend: SAR can't be below the prior two candles' highs
        const clampHigh = Math.max(high(i - 1), i >= 2 ? high(i - 2) : high(i - 1));
        if (sar < clampHigh) sar = clampHigh;

        if (high(i) > sar) {
          // Flip to uptrend
          trend = 'up';
          sar = ep;
          ep = high(i);
          af = this.sarStep;
        } else {
          if (low(i) < ep) {
            ep = low(i);
            af = Math.min(af + this.sarStep, this.sarMax);
          }
        }
      }

      result[i] = { sar, trend };
    }

    return result;
  }

  /**
   * Donchian Channel — returns { upper, lower, middle } for the given period,
   * computed from the `period` candles ending at index `endIdx` (chronological array).
   */
  calculateDonchian(chronological, endIdx, period) {
    const start = Math.max(0, endIdx - period + 1);
    const slice = chronological.slice(start, endIdx + 1);
    const highs = slice.map(d => parseFloat(d.high));
    const lows = slice.map(d => parseFloat(d.low));
    const upper = Math.max(...highs);
    const lower = Math.min(...lows);
    const middle = (upper + lower) / 2;
    return { upper, lower, middle };
  }

  /**
   * Calculate Average True Range (ATR) — kept for stop-loss/take-profit sizing.
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

  calculateSMA(values, period) {
    if (values.length < period) return values.reduce((a, b) => a + b, 0) / values.length;
    const slice = values.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
  }

  // =========================================================================
  // SIGNAL GENERATION (The "Generate Setup" Button Logic)
  // =========================================================================

  /**
   * generateSetup()
   * ---------------
   * Evaluates Parabolic SAR + Donchian Channel confluence and produces:
   *   - signal: 'BUY' | 'SELL' | 'HOLD'
   *   - score: 0-100 (% match of the two-signal setup)
   *   - suggestedEntry, stopLoss, takeProfit
   */
  generateSetup(ohlcvData, currentPrice, symbol = 'EUR/USD') {
    const minCandles = this.donchianPeriod + 5;
    if (!ohlcvData || ohlcvData.length < minCandles) {
      return {
        signal: 'HOLD',
        score: 0,
        error: 'Insufficient data for analysis. Need at least ' + minCandles + ' candles.',
        timestamp: new Date().toISOString()
      };
    }

    // Reverse data so index 0 is oldest (chronological order)
    const chronological = [...ohlcvData].reverse();
    const lastIdx = chronological.length - 1;
    const prevIdx = lastIdx - 1;

    const atr = this.calculateATR(ohlcvData, 14);

    // ── PARABOLIC SAR ──
    const sarSeries = this.calculateParabolicSAR(chronological);
    const sarCurrent = sarSeries[lastIdx];
    const sarPrev = sarSeries[prevIdx];

    const sarBullish = sarCurrent.trend === 'up';   // dots below price
    const sarBearish = sarCurrent.trend === 'down';  // dots above price
    const sarFlipped = sarCurrent.trend !== sarPrev.trend; // fresh flip this candle

    // ── DONCHIAN CHANNEL (middle line) ──
    const donchianCurrent = this.calculateDonchian(chronological, lastIdx, this.donchianPeriod);
    const donchianPrev = this.calculateDonchian(chronological, prevIdx, this.donchianPeriod);

    // Use the live quote (currentPrice) rather than the last CLOSED candle's
    // close. Candles only update once per interval (e.g. every 5 minutes),
    // so judging "above/below midline" off a stale candle close can
    // disagree with what the live price is actually doing right now,
    // especially mid-candle. currentPrice always reflects the latest quote.
    const closeCurrent = parseFloat(currentPrice);
    const closePrev = parseFloat(chronological[lastIdx].close); // last closed candle, for detecting a fresh cross

    const priceAboveMidNow = closeCurrent > donchianCurrent.middle;
    const priceAboveMidPrev = closePrev > donchianCurrent.middle;

    // A "cross" is live price now sitting on the opposite side of the
    // midline from where the last completed candle closed.
    const donchianCrossedDown = priceAboveMidPrev && !priceAboveMidNow; // top → bottom = bearish
    const donchianCrossedUp = !priceAboveMidPrev && priceAboveMidNow;   // bottom → top = bullish

    const donchianBullish = priceAboveMidNow;
    const donchianBearish = !priceAboveMidNow;
    const donchianFreshCross = donchianCrossedUp || donchianCrossedDown;

    // ── RESOLVE DIRECTION ──
    // If SAR and Donchian agree, that's the direction. If they disagree,
    // favor whichever one just gave a fresh signal (flip/cross); if neither
    // is fresh, favor SAR as the primary trend filter (per the video, SAR
    // is introduced first as the trend signal, Donchian confirms reversal).
    let direction;
    if (sarBullish && donchianBullish) direction = 'BUY';
    else if (sarBearish && donchianBearish) direction = 'SELL';
    else if (donchianFreshCross) direction = donchianCrossedUp ? 'BUY' : 'SELL';
    else if (sarFlipped) direction = sarBullish ? 'BUY' : 'SELL';
    else direction = sarBullish ? 'BUY' : 'SELL';

    const wantsBullish = direction === 'BUY';

    // ── SCORING: each indicator is worth 50% ──
    const criteria = [];
    let score = 0;

    const sarAgrees = wantsBullish ? sarBullish : sarBearish;
    criteria.push({
      name: 'Parabolic SAR',
      description: `SAR ${sarCurrent.sar.toFixed(5)} — dots ${sarCurrent.trend === 'up' ? 'below' : 'above'} price`,
      passed: sarAgrees,
      detail: sarAgrees
        ? (sarFlipped ? `Fresh flip to ${sarCurrent.trend}trend — strong signal` : `Confirms ${sarCurrent.trend}trend`)
        : `SAR shows ${sarCurrent.trend}trend — disagrees with Donchian`,
      weight: 50,
      score: sarAgrees ? (sarFlipped ? 50 : 42) : 0
    });
    score += criteria[criteria.length - 1].score;

    const donchianAgrees = wantsBullish ? donchianBullish : donchianBearish;
    criteria.push({
      name: 'Donchian Channel Midline',
      description: `Price ${closeCurrent.toFixed(5)} vs midline ${donchianCurrent.middle.toFixed(5)}`,
      passed: donchianAgrees,
      detail: donchianAgrees
        ? (donchianFreshCross ? `Fresh cross ${donchianCrossedUp ? 'up' : 'down'} through midline — reversal confirmed` : `Price holding ${donchianBullish ? 'above' : 'below'} midline`)
        : `Price on the ${donchianBullish ? 'upper' : 'lower'} side — disagrees with SAR`,
      weight: 50,
      score: donchianAgrees ? (donchianFreshCross ? 50 : 42) : 0
    });
    score += criteria[criteria.length - 1].score;

    const passedCount = criteria.filter(c => c.passed).length;
    let confidence = Math.min(100, Math.round(score));

    // ── SIGNAL DETERMINATION ──
    // Above 57% → BUY or SELL in the resolved direction. Below/equal 57% → HOLD.
    let signal = 'HOLD';
    if (confidence > 57) {
      signal = direction;
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
      score: confidence,
      passedCriteria: passedCount,
      totalCriteria: criteria.length,
      currentPrice,
      suggestedEntry: parseFloat(suggestedEntry.toFixed(5)),
      stopLoss: parseFloat(stopLoss.toFixed(5)),
      takeProfit: parseFloat(takeProfit.toFixed(5)),
      positionSize: Math.floor(positionSize),
      riskRewardRatio: '1:2',
      indicators: {
        sar: parseFloat(sarCurrent.sar.toFixed(5)),
        sarTrend: sarCurrent.trend,
        sarBasedOnCandleClose: parseFloat(chronological[lastIdx].close.toFixed ? chronological[lastIdx].close.toFixed(5) : chronological[lastIdx].close),
        donchianUpper: parseFloat(donchianCurrent.upper.toFixed(5)),
        donchianLower: parseFloat(donchianCurrent.lower.toFixed(5)),
        donchianMiddle: parseFloat(donchianCurrent.middle.toFixed(5)),
        atr: parseFloat(atr.toFixed(5)),
        candleCount: chronological.length,
        lastCandleTime: chronological[lastIdx].datetime
      },
      criteria,
      timestamp: new Date().toISOString()
    };

    this.lastSignal = setup;
    return setup;
  }
}

module.exports = StrategyEngine;
          
