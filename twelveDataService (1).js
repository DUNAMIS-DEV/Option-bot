/**
 * twelveDataService.js
 * ====================
 * FIXED: Symbol format kept as-is (XAU/USD) for Twelve Data compatibility.
 */

const axios = require('axios');
const API_BASE = 'https://api.twelvedata.com';

class TwelveDataService {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.lastPrices = new Map();
    this.requestCount = 0;
    this.lastRequestTime = 0;
    this.minDelayMs = 800;
    this.cache = new Map();
    this.cacheTTL = 30000;

    this.creditStats = {
      used: 0,
      remaining: 0,
      total: 0,
      lastUpdated: null,
      plan: 'Unknown',
      requestsThisMinute: 0,
      minuteResetAt: null
    };
  }

  async rateLimitedRequest(requestFn) {
    const now = Date.now();
    const timeSinceLast = now - this.lastRequestTime;
    if (timeSinceLast < this.minDelayMs) {
      await new Promise(r => setTimeout(r, this.minDelayMs - timeSinceLast));
    }
    this.lastRequestTime = Date.now();
    this.requestCount++;

    try {
      const response = await requestFn();

      if (response.headers) {
        const used = response.headers['api-credits-used'];
        const left = response.headers['api-credits-left'];
        if (used !== undefined && left !== undefined) {
          this.creditStats.used = parseInt(used) || 0;
          this.creditStats.remaining = parseInt(left) || 0;
          this.creditStats.total = this.creditStats.used + this.creditStats.remaining;
          this.creditStats.lastUpdated = new Date().toISOString();
        }
      }

      const now2 = new Date();
      if (!this.creditStats.minuteResetAt || now2 >= new Date(this.creditStats.minuteResetAt)) {
        this.creditStats.requestsThisMinute = 0;
        const nextMinute = new Date(now2);
        nextMinute.setSeconds(0, 0);
        nextMinute.setMinutes(nextMinute.getMinutes() + 1);
        this.creditStats.minuteResetAt = nextMinute.toISOString();
      }
      this.creditStats.requestsThisMinute++;

      return response;
    } catch (err) {
      if (err.response && err.response.status === 429) {
        await new Promise(r => setTimeout(r, 5000));
        this.lastRequestTime = Date.now();
        return await requestFn();
      }
      throw err;
    }
  }

  // FIXED: Keep symbol exactly as passed (XAU/USD)
  formatSymbol(symbol) {
    return symbol;
  }

  getCacheKey(symbol, type) { return `${symbol}_${type}`; }

  getCached(symbol, type) {
    const cached = this.cache.get(this.getCacheKey(symbol, type));
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) return cached.data;
    return null;
  }

  setCache(symbol, type, data) {
    this.cache.set(this.getCacheKey(symbol, type), { data, timestamp: Date.now() });
  }

  getCreditStats() { return { ...this.creditStats }; }

  async getTimeSeries(symbol, interval = '5min', outputsize = 100) {
    const cached = this.getCached(symbol, `ohlcv_${interval}`);
    if (cached) return cached;

    return this.rateLimitedRequest(async () => {
      try {
        const url = `${API_BASE}/time_series`;
        const params = {
          symbol: this.formatSymbol(symbol),
          interval,
          outputsize,
          apikey: this.apiKey,
          format: 'JSON'
        };

        console.log(`[TwelveData] Request #${this.requestCount} - time_series for ${symbol} (${interval})`);
        const response = await axios.get(url, { params, timeout: 15000 });

        if (response.data.status === 'error') {
          console.error(`[TwelveData] time_series ERROR for ${symbol}:`, response.data.message);
          return [];
        }

        const values = response.data.values || [];
        this.setCache(symbol, `ohlcv_${interval}`, values);
        return values;

      } catch (err) {
        console.error(`[TwelveData] time_series exception for ${symbol}:`, err.message);
        return [];
      }
    });
  }

  async getQuote(symbol) {
    const cached = this.getCached(symbol, 'quote');
    if (cached) return cached;

    return this.rateLimitedRequest(async () => {
      try {
        const url = `${API_BASE}/quote`;
        const params = {
          symbol: this.formatSymbol(symbol),
          apikey: this.apiKey,
          format: 'JSON'
        };

        console.log(`[TwelveData] Request #${this.requestCount} - quote for ${symbol}`);
        const response = await axios.get(url, { params, timeout: 10000 });

        if (response.data.status === 'error') {
          const msg = response.data.message || 'Unknown error';
          const code = response.data.code || 0;
          console.error(`[TwelveData] quote ERROR for ${symbol}: [${code}] ${msg}`);
          return { error: true, message: msg, code, symbol: this.formatSymbol(symbol) };
        }

        const quote = {
          price: parseFloat(response.data.close || response.data.price || 0),
          change: parseFloat(response.data.change || 0),
          changePercent: parseFloat(response.data.percent_change || 0),
          volume: parseInt(response.data.volume || 0),
          high: parseFloat(response.data.high || 0),
          low: parseFloat(response.data.low || 0),
          open: parseFloat(response.data.open || 0),
          timestamp: new Date().toISOString()
        };

        if (!quote.price || quote.price === 0) {
          return { error: true, message: 'Invalid price data (zero or null)', code: 0, symbol: this.formatSymbol(symbol) };
        }

        this.lastPrices.set(symbol, quote);
        this.setCache(symbol, 'quote', quote);
        console.log(`[TwelveData] quote OK for ${symbol}: ${quote.price}`);
        return quote;

      } catch (err) {
        const status = err.response?.status;
        const msg = err.message;
        console.error(`[TwelveData] quote exception for ${symbol}: [${status || 'NET'}] ${msg}`);
        return {
          error: true,
          message: msg,
          code: status || 0,
          networkError: !err.response,
          symbol: this.formatSymbol(symbol)
        };
      }
    });
  }

  async validateApiKey() {
    return this.rateLimitedRequest(async () => {
      try {
        const url = `${API_BASE}/quote`;
        const params = { symbol: 'XAU/USD', apikey: this.apiKey, format: 'JSON' };
        const response = await axios.get(url, { params, timeout: 10000 });
        if (response.data.status === 'error') return { valid: false, message: response.data.message };
        return { valid: true, message: 'API key is valid' };
      } catch (err) {
        return { valid: false, message: err.message };
      }
    });
  }
}

module.exports = TwelveDataService;
