/**
 * twelveDataService.js
 * ====================
 * Twelve Data API integration with detailed error logging.
 */

const axios = require('axios');

const API_BASE = 'https://api.twelvedata.com';

class TwelveDataService {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.lastPrices = new Map();
    this.requestCount = 0;
  }

  /**
   * Format symbol for Twelve Data API
   * Forex: EUR/USD -> EURUSD
   * Crypto: BTC/USD -> BTC/USD (Twelve Data uses slash for crypto)
   * Metals: XAU/USD -> XAU/USD
   */
  formatSymbol(symbol) {
    // Twelve Data forex pairs typically don't use slash
    // But some endpoints accept both. Let's try without slash first.
    return symbol.replace('/', '');
  }

  async getTimeSeries(symbol, interval = '1h', outputsize = 100) {
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

      console.log(`[TwelveData] Fetching time_series for ${symbol} (formatted: ${formattedSymbol})`);
      const response = await axios.get(url, { params, timeout: 15000 });

      if (response.data.status === 'error') {
        console.error(`[TwelveData] TimeSeries error for ${symbol}:`, response.data.message);
        throw new Error(response.data.message);
      }

      if (!response.data.values || response.data.values.length === 0) {
        console.error(`[TwelveData] No data returned for ${symbol}`);
        return [];
      }

      return response.data.values;
    } catch (err) {
      console.error(`[TwelveData] TimeSeries error for ${symbol}:`, err.message);
      return [];
    }
  }

  async getQuote(symbol) {
    try {
      const formattedSymbol = this.formatSymbol(symbol);
      const url = `${API_BASE}/quote`;
      const params = {
        symbol: formattedSymbol,
        apikey: this.apiKey,
        format: 'JSON'
      };

      this.requestCount++;
      console.log(`[TwelveData] Request #${this.requestCount} - Quote for ${symbol} (formatted: ${formattedSymbol})`);

      const response = await axios.get(url, { params, timeout: 10000 });

      // Log the raw response for debugging
      if (response.data.status === 'error') {
        console.error(`[TwelveData] Quote ERROR for ${symbol}:`, response.data.message);
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
        console.error(`[TwelveData] Quote for ${symbol} returned zero/invalid price`);
        return { error: true, message: 'Invalid price data', symbol: formattedSymbol };
      }

      this.lastPrices.set(symbol, quote);
      console.log(`[TwelveData] Quote OK for ${symbol}: ${quote.price}`);
      return quote;

    } catch (err) {
      console.error(`[TwelveData] Quote exception for ${symbol}:`, err.message);
      return { error: true, message: err.message, symbol: symbol.replace('/', '') };
    }
  }

  async getQuotes(symbols) {
    const results = {};
    for (const symbol of symbols) {
      results[symbol] = await this.getQuote(symbol);
      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 200));
    }
    return results;
  }

  async getForexPairs() {
    try {
      const url = `${API_BASE}/forex_pairs`;
      const params = { apikey: this.apiKey, format: 'JSON' };
      const response = await axios.get(url, { params, timeout: 10000 });
      return response.data.data || [];
    } catch (err) {
      console.error('[TwelveData] Forex pairs error:', err.message);
      return [];
    }
  }

  // Validate that the API key works
  async validateApiKey() {
    try {
      const url = `${API_BASE}/quote`;
      const params = {
        symbol: 'EURUSD',
        apikey: this.apiKey,
        format: 'JSON'
      };
      const response = await axios.get(url, { params, timeout: 10000 });

      if (response.data.status === 'error') {
        return { valid: false, message: response.data.message };
      }

      return { valid: true, message: 'API key is valid' };
    } catch (err) {
      return { valid: false, message: err.message };
    }
  }
}

module.exports = TwelveDataService;
