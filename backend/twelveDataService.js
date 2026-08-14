/**
 * twelveDataService.js
 * ====================
 * Twelve Data API with request queue, caching, and rate limit handling.
 * Prevents HTTP 429 by spacing requests and caching aggressively.
 */

const axios = require('axios');

const API_BASE = 'https://api.twelvedata.com';

class TwelveDataService {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.lastPrices = new Map();
    this.requestCount = 0;
    this.lastRequestTime = 0;
    this.minDelayMs = 800; // Minimum 800ms between requests to avoid 429
    this.cache = new Map(); // symbol -> {quote, ohlcv, timestamp}
    this.cacheTTL = 30000; // Cache for 30 seconds
  }

  /**
   * Rate-limited request wrapper
   * Ensures we never make requests faster than minDelayMs apart
   */
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
      return await requestFn();
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

  async getTimeSeries(symbol, interval = '1h', outputsize = 100) {
    // Check cache first
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

        console.log(`[TwelveData] Request #${this.requestCount} - time_series for ${symbol}`);
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
    // Check cache first
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

        if (response.data.status === 'error') {
          console.error(`[TwelveData] quote ERROR for ${symbol}:`, response.data.message);
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
        console.log(`[TwelveData] quote OK for ${symbol}: ${quote.price}`);
        return quote;

      } catch (err) {
        console.error(`[TwelveData] quote exception for ${symbol}:`, err.message);
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
        const params = { symbol: 'EURUSD', apikey: this.apiKey, format: 'JSON' };
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
