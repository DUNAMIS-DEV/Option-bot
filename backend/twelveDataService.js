/**
 * twelveDataService.js
 * ====================
 * Handles all Twelve Data API interactions:
 * - REST API calls for OHLCV, price, quote data
 * - WebSocket connection for real-time price streaming
 * - Rate limiting and error handling
 */

const axios = require('axios');

const API_BASE = 'https://api.twelvedata.com';
const WS_BASE = 'wss://ws.twelvedata.com/v1/quotes/price';

class TwelveDataService {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.ws = null;
    this.subscribers = new Map(); // symbol -> callback[]
    this.lastPrices = new Map();
  }

  /**
   * Fetch historical OHLCV time series data
   * Used by strategyEngine for indicator calculations (EMA, RSI, etc.)
   */
  async getTimeSeries(symbol, interval = '1h', outputsize = 100) {
    try {
      const url = `${API_BASE}/time_series`;
      const params = {
        symbol: symbol.replace('/', ''), // EUR/USD -> EURUSD for Twelve Data
        interval,
        outputsize,
        apikey: this.apiKey,
        format: 'JSON'
      };
      const response = await axios.get(url, { params, timeout: 15000 });

      if (response.data.status === 'error') {
        throw new Error(response.data.message);
      }

      return response.data.values || [];
    } catch (err) {
      console.error('[TwelveData] TimeSeries error:', err.message);
      return [];
    }
  }

  /**
   * Fetch current quote for a symbol
   * Used for real-time price display and P&L calculations
   */
  async getQuote(symbol) {
    try {
      const url = `${API_BASE}/quote`;
      const params = {
        symbol: symbol.replace('/', ''),
        apikey: this.apiKey,
        format: 'JSON'
      };
      const response = await axios.get(url, { params, timeout: 10000 });

      if (response.data.status === 'error') {
        throw new Error(response.data.message);
      }

      this.lastPrices.set(symbol, {
        price: parseFloat(response.data.close || response.data.price),
        change: parseFloat(response.data.change || 0),
        changePercent: parseFloat(response.data.percent_change || 0),
        volume: parseInt(response.data.volume || 0),
        timestamp: new Date().toISOString()
      });

      return this.lastPrices.get(symbol);
    } catch (err) {
      console.error('[TwelveData] Quote error:', err.message);
      // Return cached price if available
      return this.lastPrices.get(symbol) || null;
    }
  }

  /**
   * Fetch multiple quotes at once (batch)
   */
  async getQuotes(symbols) {
    const results = {};
    for (const symbol of symbols) {
      results[symbol] = await this.getQuote(symbol);
    }
    return results;
  }

  /**
   * Get real-time price via WebSocket
   * Note: Twelve Data WS requires paid plan for forex/crypto.
   * Fallback to REST polling implemented in server.js
   */
  connectWebSocket(symbols, onMessage) {
    // WebSocket implementation placeholder
    // For free tier, we use REST polling instead (see server.js polling loop)
    console.log('[TwelveData] WebSocket: Free tier uses REST polling fallback');
    return false;
  }

  /**
   * Get available forex pairs (for dropdown)
   */
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
}

module.exports = TwelveDataService;
