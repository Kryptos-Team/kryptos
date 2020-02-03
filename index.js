const fs = require("fs");
const path = require("path");
const os = require("os");
const cluster = require("cluster");
const async = require("async");
const extend = require("extend");
const posix = require("posix");

const Logger = require("./src/logger");
const CliListener = require("./src/cliListener");
const PoolWorker = require("./src/poolWorker");
const PaymentProcessor = require("./src/paymentProcessor");

const algorithms = require("kryptos-stratum-pool/src/algoProperties");

JSON.minify = JSON.minify || require("node-json-minify");

if (!fs.existsSync("config.json")) {
	console.log("config.json file does not exist");
	return;
}

const portalConfiguration = JSON.parse(JSON.minify(fs.readFileSync("config.json", {encoding: "utf-8"})));
let poolConfigurations;

const logger = new Logger({
	logLevel: portalConfiguration.logLevel,
	logColors: portalConfiguration.logColors
});

try {
	posix.setrlimit("nofile", {soft: 100000, hard: 100000});
} catch (e) {
	if (cluster.isMaster) {
		logger.warning("POSIX", "Connection Limit", "(Safe to ignore) Must be ran as root to increase resource limits");
	}
} finally {
	const uid = parseInt(process.env.SUDO_ID);
	if (uid) {
		process.setuid(uid);
		logger.info("POSIX", "Connection Limit",
			"Raised to 100K concurrent connections, now running as non-root user: " + process.getuid());
	}
}

if (cluster.isWorker) {
	switch (process.env.workerType) {
		case 'pool':
			new PoolWorker(logger);
			break;
		case 'paymentProcessor':
			new PaymentProcessor(logger);
			break;
		case 'profitSwitch':
			break;
	}
	return;
}

// Read all pool configurations from pools and join them with their coin profile
const buildPoolConfigurations = function () {
	let configurations = {};
	const configurationDirectory = "pools/";
	let poolConfigurationFiles = [];

	// Get filenames of pool configuration json files that are enabled
	fs.readdirSync(configurationDirectory).forEach(function (file) {
		if (!fs.existsSync(configurationDirectory + file) || path.extname(configurationDirectory + file) !==
			'.json') {
			return;
		}
		let poolOptions = JSON.parse(JSON.minify(fs.readFileSync(configurationDirectory + file, {encoding: "utf-8"})));
		if (!poolOptions.enabled) return;
		poolOptions.fileName = file;
		poolConfigurationFiles.push(poolOptions);
	});

	// Ensure that every pool uses unique ports
	for (let i = 0; i < poolConfigurationFiles.length; i++) {
		let ports = Object.keys(poolConfigurationFiles[i].ports);
		for (let j = 0; j < poolConfigurationFiles.length; j++) {
			if (j === i) continue;
			let portsJ = Object.keys(poolConfigurationFiles[j].ports);
			for (let k = 0; k < portsJ.length; k++) {
				if (ports.indexOf(portsJ[k]) !== -1) {
					logger.error("Master", poolConfigurationFiles[j].fileName,
						"Has same configured port of " + portsJ[k] + " as " +
						poolConfigurationFiles[i].fileName);
					process.exit(1);
					return;
				}
			}

			if (poolConfigurationFiles[j].coin === poolConfigurationFiles[i].coin) {
				logger.error("Master", poolConfigurationFiles[j].fileName,
					"Pool has same configured coin file coins/" + poolConfigurationFiles[j].coin + " as " +
					poolConfigurationFiles[i].fileName + " pool");
				process.exit(1);
				return;
			}
		}
	}

	poolConfigurationFiles.forEach(function (poolOptions) {
		poolOptions.coinFileName = poolOptions.coin;

		let coinFilePath = "coins/" + poolOptions.coinFileName;
		if (!fs.existsSync(coinFilePath)) {
			logger.error("Master", poolOptions.coinFileName, "could not find file: " + coinFilePath);
			return;
		}

		let coinProfile = JSON.parse(JSON.minify(fs.readFileSync(coinFilePath, {encoding: "utf-8"})));
		poolOptions.coin = coinProfile;
		poolOptions.coin.name = poolOptions.coin.name.toLowerCase();

		if (poolOptions.coin.name in configurations) {
			logger.error("Master", poolOptions.fileName, "coins/" + poolOptions.coinFileName +
				" has same configured coin name " + poolOptions.coin.name +
				" as coins/" +
				configurations[poolOptions.coin.name].coinFileName +
				" used by pool configuration " +
				configurations[poolOptions.coin.name].fileName);
			process.exit(1);
			return;
		}

		for (let option in portalConfiguration.defaultPoolConfigurations) {
			if (!(option in poolOptions)) {
				let toCloneOption = portalConfiguration.defaultPoolConfigurations[option];
				let clonedOption = [];
				if (toCloneOption.constructor === Object) {
					extend(true, clonedOption, toCloneOption);
				} else {
					clonedOption = toCloneOption;
				}
				poolOptions[option] = clonedOption;
			}
		}

		configurations[poolOptions.coin.name] = poolOptions;

		if (!(coinProfile.algorithm in algorithms)) {
			logger.error("Master", coinProfile.name,
				"Cannot run a pool for unsupported algorithm: " + coinProfile.algorithm);
			process.exit(1);

		}
	});

	return configurations;
};

const spawnPoolWorkers = function () {
	Object.keys(poolConfigurations).forEach(function (coin) {
		let p = poolConfigurations[coin];

		if (!Array.isArray(p.daemons) || p.daemons.length < 1) {
			logger.error("Master", coin, "No daemons configured so a pool cannot be started for this coin");
			delete poolConfigurations[coin];
		}
	});

	if (Object.keys(poolConfigurations).length === 0) {
		logger.warning("Master", "PoolWorker", "No pool configurations exists or are enabled in pools folder");
		return;
	}

	let serializedConfigurations = JSON.stringify(poolConfigurations);
	let numForks = (function () {
		if (!portalConfiguration.clustering || !portalConfiguration.clustering.enabled) {
			return 1;
		}
		if (portalConfiguration.clustering.forks === "auto") {
			return os.cpus().length;
		}
		if (!portalConfiguration.clustering.forks || isNaN(portalConfiguration.clustering.forks)) {
			return 1;
		}
		return portalConfiguration.clustering.forks;
	})();

	let poolWorkers = {};
	let createPoolWorker = function (forkId) {
		let worker = cluster.fork({
			workerType: "pool",
			forkId: forkId,
			pools: serializedConfigurations,
			portalConfiguration: JSON.stringify(portalConfiguration)
		});
		worker.forkId = forkId;
		worker.type = "pool";
		poolWorkers[forkId] = worker;
		worker.on("exit", function (code, signal) {
			logger.error("Master", "PoolWorker", "Fork " + forkId + " died, spawning replacement worker...");
			setTimeout(function () {
				createPoolWorker(forkId);
			}, 2000);
		}).on("message", function (message) {
			switch (message.type) {
				case "banIP":
					Object.keys(cluster.workers).forEach(function (id) {
						if (cluster.workers[id].type === "pool") {
							cluster.workers[id].send({type: "banIP", ip: message.ip});
						}
					});
					break;
			}
		});
	};

	let i = 0;
	let spawnInterval = setInterval(function () {
		createPoolWorker(i);
		i++;
		if (i === numForks) {
			clearInterval(spawnInterval);
			logger.debug("Master", "PoolWorker",
				"Spawned " + Object.keys(poolConfigurations).length + " pool(s) on " + numForks +
				" thread(s)");
		}
	}, 250);
};

const startPaymentProcessor = function () {
	let enabledForAny = false;

	for (let pool in poolConfigurations) {
		let p = poolConfigurations[pool];
		let enabled = p.enabled && p.paymentProcessing && p.paymentProcessing.enabled;
		if (enabled) {
			enabledForAny = true;
			break;
		}
	}

	if (!enabledForAny) return;

	let worker = cluster.fork({
		workerType: "paymentProcessor",
		pools: JSON.stringify(poolConfigurations)
	});
	worker.on("exit", function (code, signal) {
		logger.error("Master", "Payment Processor", "Payment processor died, spawning replacement...");
		setTimeout(function () {
			startPaymentProcessor(poolConfigurations);
		}, 2000);
	});
};

const startCliListener = function () {
	let cliPort = portalConfiguration.cliPort;
	let listener = new CliListener(cliPort);

	listener.on("log", function (text) {
		logger.debug("Master", "CLI", text);
	}).on("command", function (command, params, options, reply) {
		switch (command) {
			case "blocknotify":
				Object.keys(cluster.workers).forEach(function (id) {
					cluster.workers[id].send({
						type: command,
						coin: params[0],
						hash: params[1]
					});
				});
				reply("Pool workers notified");
				break;

			case "reloadpool":
				Object.keys(cluster.workers).forEach(function (id) {
					cluster.workers[id].send({
						type: command,
						coin: params[0]
					});
				});
				reply("Pool reloaded " + params[0]);
				break;

			default:
				reply("Unrecognized command: " + command);
				break;
		}
	}).start();
};

(function init() {
	poolConfigurations = buildPoolConfigurations();
	spawnPoolWorkers();
	startPaymentProcessor();
	startCliListener();
})();