/**
 * twelveDataService.js
 * ====================
 * Twelve Data API with request queue, caching, rate limit handling,
 * AND credit usage tracking from response headers.
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

    // Credit tracking
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
      await new Promise(r => setTimeout(r, wait));
    }

    this.lastRequestTime = Date.now();
    this.requestCount++;

    try {
      const response = await requestFn();

      // Track credits from response headers
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

  async getApiUsage() {
    return this.rateLimitedRequest(async () => {
      try {
        const url = `${API_BASE}/api_usage`;
        const params = { apikey: this.apiKey, format: 'JSON' };
        const response = await axios.get(url, { params, timeout: 10000 });

        if (response.data.status === 'error') {
          return { error: true, message: response.data.message };
        }

        const data = response.data;
        this.creditStats.plan = data.plan || 'Unknown';

        return {
          plan: data.plan || 'Unknown',
          apiCreditsUsed: data.api_credits_used || 0,
          apiCreditsRemaining: data.api_credits_remaining || 0,
          apiCreditsLimit: data.api_credits_limit || 0,
          websocketCreditsUsed: data.websocket_credits_used || 0,
          websocketCreditsRemaining: data.websocket_credits_remaining || 0,
          websocketCreditsLimit: data.websocket_credits_limit || 0,
          dailyLimit: data.daily_limit || null,
          dailyLimitUsed: data.daily_limit_used || null,
          dailyLimitRemaining: data.daily_limit_remaining || null,
          minuteLimit: data.minute_limit || null,
          minuteLimitUsed: data.minute_limit_used || null,
          minuteLimitRemaining: data.minute_limit_remaining || null,
          resetTime: data.reset_time || null,
          resetInSeconds: data.reset_in_seconds || null
        };
      } catch (err) {
        return { error: true, message: err.message };
      }
    });
  }

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

        const response = await axios.get(url, { params, timeout: 15000 });

        if (response.data.status === 'error') {
          return [];
        }

        const values = response.data.values || [];
        this.setCache(symbol, `ohlcv_${interval}`, values);
        return values;

      } catch (err) {
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

        const response = await axios.get(url, { params, timeout: 10000 });

        if (response.data.status === 'error') {
          return { 
            error: true, 
            message: response.data.message,
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
          return { error: true, message: 'Invalid price data', symbol: formattedSymbol };
        }

        this.lastPrices.set(symbol, quote);
        this.setCache(symbol, 'quote', quote);
        return quote;

      } catch (err) {
        return { error: true, message: err.message, symbol: symbol.replace('/', '') };
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
