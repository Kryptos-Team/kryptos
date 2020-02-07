const zlib = require("zlib");
const redis = require("redis");
const async = require("async");
const os = require("os");
const algorithms = require("kryptos-stratum-pool/src/algoProperties");

module.exports = function (logger, portalConfiguration, poolConfigurations) {
	let _this = this;
	let logSystem = "Stats";
	let redisClients = [];
	let redisStats;

	this.statsHIstory = [];
	this.statsPoolHistory = [];

	this.stat = {};
	this.statsString = "";

	setupStatsRedis();
	setupStatsHistory();

	let canDoStats = true;

	Object.keys(poolConfigurations).forEach(function (coin) {
		if (!canDoStats) return;

		let poolConfiguration = poolConfigurations[coin];
		let redisConfig = poolConfiguration.redis;

		for (let i = 0; i < redisClients.length; i++) {
			let client = redisClients[i];
			if (client.client.port === redisConfig.port && client.client.host === redisConfig.host) {
				client.coins.push(coin);
				return;
			}
		}

		redisClients.push({
			coins: [coin],
			client: redis.createClient(redisConfig.port, redisConfig.host)
		});
	});

	function setupStatsRedis() {
		redisStats = redis.createClient(portalConfiguration.port, portalConfiguration.redis.host);
		redisStats.on("error", function (error) {
			logger.error(logSystem, "History", "Redis for stats had an error " + JSON.stringify(error));
		});
	}

	function setupStatsHistory() {
		let retentionTime = (((Date.now() / 1000) - portalConfiguration.website.stats.historicalRetention) | 0).toString();
	}
};