/**
 * twelveDataService.js
 * ====================
 * Twelve Data API with request queue, caching, rate limit handling,
 * and credit usage tracking from response headers.
 * 
 * FIXES:
 * 1. Removed external /api_usage call (endpoint may not exist on all plans)
 * 2. Credit stats now come purely from response headers on every request
 * 3. Better market-closed and error code detection
 * 4. All errors include a 'code' field for frontend classification
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

    // Credit tracking from response headers
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
      const wait = this.minDelayMs - timeSinceLast;
      console.log(`[TwelveData] Rate limit: waiting ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
    }

    this.lastRequestTime = Date.now();
    this.requestCount++;

    try {
      const response = await requestFn();

      // Track credits from response headers (present on every successful call)
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

      // Track per-minute requests
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
        console.error('[TwelveData] RATE LIMITED (429). Waiting 5s then retrying...');
        await new Promise(r => setTimeout(r, 5000));
        this.lastRequestTime = Date.now();
        return await requestFn();
      }
      throw err;
    }
  }

  formatSymbol(symbol) {
    return symbol.replace('/', '');
  }

  getCacheKey(symbol, type) {
    return `${symbol}_${type}`;
  }

  getCached(symbol, type) {
    const key = this.getCacheKey(symbol, type);
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      console.log(`[TwelveData] Cache HIT for ${symbol} (${type})`);
      return cached.data;
    }
    return null;
  }

  setCache(symbol, type, data) {
    const key = this.getCacheKey(symbol, type);
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  getCreditStats() {
    return { ...this.creditStats };
  }

  /**
   * getApiUsage() — REMOVED external call to Twelve Data /api_usage
   * That endpoint doesn't exist on all plans. We now rely purely on
   * response headers tracked during normal API calls.
   */

  async getTimeSeries(symbol, interval = '5min', outputsize = 100) {
    const cached = this.getCached(symbol, `ohlcv_${interval}`);
    if (cached) return cached;

    return this.rateLimitedRequest(async () => {
      try {
        const formattedSymbol = this.formatSymbol(symbol);
        const url = `${API_BASE}/time_series`;
        const params = {
          symbol: formattedSymbol,
          interval,
          outputsize,
          apikey: this.apiKey,
          format: 'JSON'
        };

        console.log(`[TwelveData] Request #${this.requestCount} - time_series for ${symbol} (${interval})`);
        const response = await axios.get(url, { params, timeout: 15000 });

        if (response.data.status === 'error') {
          const msg = response.data.message || 'Unknown error';
          console.error(`[TwelveData] time_series ERROR for ${symbol}:`, msg);
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
        const formattedSymbol = this.formatSymbol(symbol);
        const url = `${API_BASE}/quote`;
        const params = {
          symbol: formattedSymbol,
          apikey: this.apiKey,
          format: 'JSON'
        };

        console.log(`[TwelveData] Request #${this.requestCount} - quote for ${symbol}`);
        const response = await axios.get(url, { params, timeout: 10000 });

        // Check for API-level errors (market closed, invalid symbol, etc.)
        if (response.data.status === 'error') {
          const msg = response.data.message || 'Unknown error';
          const code = response.data.code || 0;
          console.error(`[TwelveData] quote ERROR for ${symbol}: [${code}] ${msg}`);

          // Detect market closed
          const isMarketClosed = msg.toLowerCase().includes('market') || 
                                 msg.toLowerCase().includes('closed') ||
                                 msg.toLowerCase().includes('not available') ||
                                 code === 404;

          return { 
            error: true, 
            message: msg,
            code: code,
            marketClosed: isMarketClosed,
            symbol: formattedSymbol 
          };
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
          return { error: true, message: 'Invalid price data (zero or null)', code: 0, symbol: formattedSymbol };
        }

        this.lastPrices.set(symbol, quote);
        this.setCache(symbol, 'quote', quote);
        console.log(`[TwelveData] quote OK for ${symbol}: ${quote.price}`);
        return quote;

      } catch (err) {
        const isNetworkError = !err.response;
        const status = err.response?.status;
        const msg = err.message;

        console.error(`[TwelveData] quote exception for ${symbol}: [${status || 'NET'}] ${msg}`);

        return { 
          error: true, 
          message: msg,
          code: status || 0,
          networkError: isNetworkError,
          symbol: symbol.replace('/', '') 
        };
      }
    });
  }

  async getQuotes(symbols) {
    const results = {};
    for (const symbol of symbols) {
      results[symbol] = await this.getQuote(symbol);
    }
    return results;
  }

  async validateApiKey() {
    return this.rateLimitedRequest(async () => {
      try {
        const url = `${API_BASE}/quote`;
        const params = { symbol: 'XAUUSD', apikey: this.apiKey, format: 'JSON' };
        const response = await axios.get(url, { params, timeout: 10000 });

        if (response.data.status === 'error') {
          return { valid: false, message: response.data.message };
        }
        return { valid: true, message: 'API key is valid' };
      } catch (err) {
        return { valid: false, message: err.message };
      }
    });
  }
}

module.exports = TwelveDataService;
