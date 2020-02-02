const request = require("request");
const nonce = require("nonce");

module.exports = function () {
	const version = "0.1.0";
	const PUBLIC_API_URL = "https://bittrex.com/api/v1/public";
	const PRIVATE_API_URL = "https://bittrex.com/api/v1/market";
	const USER_AGENT = "kryptos/mining-portal";
	
	function Bittrex(key, secret) {
		// Generate headers signed by user's key and secret.
		// The secret is encapsulated and never exposed
		this._getPrivateHeaders = function (params) {
			let paramString, signature;
			
			if (!key || !secret) {
				throw "Bittrex: Error: API key and secret is required"
			}
			
			// Sort params alphabetically and convert to `arg1=foo&arg2=bar`
			paramString = Object.keys(params).sort().map(function (param) {
				return encodeURIComponent(param) + "=" + encodeURIComponent(params[param]);
			}).join("&");
			
			signature = crypto.createHmac("sha256", secret).update(paramString).digest("hex");
			
			return {
				key:       key,
				signature: signature
			};
		};
	}
	
	// If a site uses non-trusted SSL certificates, set this value to false
	Bittrex.STRICT_SSL = false;
	
	// Helper methods
	function joinCurrencies(currencyA, currencyB) {
		return currencyA + "-" + currencyB;
	}
	
	// Prototype
	Bittrex.prototype = {
		constructor: Bittrex,
		
		// Make an API request
		_request: function (options, callback) {
			if (!("headers" in options)) {
				options.headers = {};
			}
			
			options.headers["User-Agent"] = USER_AGENT;
			options.json = true;
			options.strictSSL = Bittrex.STRICT_SSL;
			
			request(options, function (error, response, body) {
				callback(error, body);
			});
			
			return this;
		},
		
		// Make a public API request
		_public: function (params, callback) {
			let options = {
				method: "GET",
				url:    PUBLIC_API_URL,
				qs:     params
			};
			
			return this._request(options, callback);
		},
		
		// Make a private API request
		_private: function (params, callback) {
			let options;
			
			params.nonce = nonce();
			options = {
				method:  "POST",
				url:     PRIVATE_API_URL,
				form:    params,
				headers: this._getPrivateHeaders(params)
			};
			
			return this._request(options, callback);
		},
		
		getTicker: function (callback) {
			let options = {
				method: "GET",
				url:    PUBLIC_API_URL + "/getmarketsummaries",
				qs:     null
			};
			
			return this._request(options, callback);
		},
		
		getOrderBook: function (currencyA, currencyB, callback) {
			let params = {
				market: joinCurrencies(currencyA, currencyB),
				type:   "buy",
				depth:  "50"
			};
			
			let options = {
				method: "GET",
				url:    PUBLIC_API_URL + "/getorderbook",
				qs:     params
			};
			
			return this._request(options, callback);
		},
		
		getTradeHistory: function (currencyA, currencyB, callback) {
			let params = {
				command:      "returnTradeHistory",
				currencyPair: joinCurrencies(currencyA, currencyB)
			};
			
			return this._request(options, callback);
		},
		
		myBalances: function (callback) {
			let params = {
				command: "returnBalances"
			};
			
			return this._private(params, callback);
		},
		
		myOpenOrders: function (currencyA, currencyB, callback) {
			let params = {
				command:      "returnOpenOrders",
				currencyPair: joinCurrencies(currencyA, currencyB)
			};
			
			return this._private(params, callback);
		},
		
		myTradeHistory: function (currencyA, currencyB, callback) {
			let params = {
				command:      "returnTradeHistory",
				currencyPair: joinCurrencies(currencyA, currencyB)
			};
			
			return this._private(params, callback);
		},
		
		buy: function (currencyA, currencyB, rate, amount, callback) {
			let params = {
				command:      "buy",
				currencyPair: joinCurrencies(currencyA, currencyB),
				rate:         rate,
				amount:       amount
			};
			
			return this._private(params, callback);
		},
		
		sell: function (currencyA, currencyB, rate, amount, callback) {
			let params = {
				command:      "sell",
				currencyPair: joinCurrencies(currencyA, currencyB),
				rate:         rate,
				amount:       amount
			};
			
			return this._private(params, callback);
		},
		
		cancelOrder: function (currencyA, currencyB, orderNumber, callback) {
			let params = {
				command:      "cancelOrder",
				currencyPair: joinCurrencies(currencyA, currencyB),
				orderNumber:  orderNumber
			};
			
			return this._private(options, callback);
		},
		
		withdraw: function (currency, amount, address, callback) {
			let params = {
				command:  "withdraw",
				currency: currency,
				amount:   amount,
				address:  address
			};
			
			return this._private(params, callback);
		}
	};
	
	return Bittrex;
}();