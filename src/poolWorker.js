const Stratum = require("kryptos-stratum-pool");
const redis = require("redis");
const net = require("net");

const ShareProcessor = require("./shareProcessor");

module.exports = function (logger) {
	let _this = this;
	let poolConfigurations = JSON.parse(process.env.pools);
	let portalConfiguration = JSON.parse(process.env.portalConfiguration);
	
	let forkId = process.env.forkId;
	let pools = {};
	let proxySwitch = {};
	let redisClient = redis.createClient(portalConfiguration.redis.port, portalConfiguration.redis.host);
	
	// Handle messages from master process sent via IPC
	process.on("message", function (message) {
		switch (message.type) {
			case "banIP":
				for (let p in pools) {
					if (pools[p].stratumServer) {
						pools[p].stratumServer.addBannedIP(message.ip);
					}
				}
				break;
			
			case "blocknotify":
				let messageCoin = message.coin.toLowerCase();
				let poolTarget = Object.keys(pools).filter(function (p) {
					return p.toLowerCase() === messageCoin;
				})[0];
				
				if (poolTarget) {
					pools[poolTarget].processBlockNotify(message.hash, "blocknotify script");
				}
				break;
			
			// IPC message for pool switching
			case "coinswitch":
				let logSystem = "Proxy";
				let logComponent = "Switch";
				let logSubcat = "Thread " + (parseInt(forkId) + 1);
				
				let switchName = message.switchName;
				let newCoin = message.coin;
				let algorithm = poolConfigurations[newCoin].coin.algorithm;
				let newPool = pools[newCoin];
				let oldCoin = proxySwitch[switchName].currentPool;
				let oldPool = pools[oldCoin];
				let proxyPorts = Object.keys(proxySwitch[switchName].ports);
				
				if (newCoin === oldCoin) {
					logger.debug(logSystem, logComponent, logSubcat,
					             "Switch message would have no effect - ignoring " + newCoin);
					break;
				}
				
				logger.debug(logSystem, logComponent, logSubcat,
				             "Proxy message for " + algorithm + " from " + oldCoin + " to " + newCoin);
				
				if (newPool) {
					oldPool.relinquishMiners(
						function (miner, cback) {
							// relinquish miners that are attached to one of the "Auto-Switch" ports and leave others
							// there
							cback(proxyPorts.indexOf(miner.client.socket.localPort.toString()) !== -1);
						},
						
						function (clients) {
							newPool.attachMiners(clients);
						}
					);
					
					proxySwitch[switchName].currentPool = newCoin;
					redisClient.hset("proxyStats", algorithm, newCoin, function (error, object) {
						if (error) {
							logger.error(logSystem, logComponent, logSubcat,
							             "Redis error writing proxy configuration: " + JSON.stringify(error));
						} else {
							logger.debug(logSystem, logComponent, logSubcat,
							             "Last proxy state saved to redis for " + algorithm);
						}
					});
				}
				break;
		}
	});
	
	Object.keys(poolConfigurations).forEach(function (coin) {
		let poolOptions = poolConfigurations[coin];
		
		let logSystem = "Pool";
		let logComponent = coin;
		let logSubcat = "Thread " + (parseInt(forkId) + 1);
		
		let handlers = {
			auth:  function () {},
			share: function () {},
			diff:  function () {}
		};
		
		let shareProcessor = new ShareProcessor(logger, poolOptions);
		handlers.auth = function (port, workerName, password, authCallback) {
			if (poolOptions.validateWorkerUsername !== true) {
				authCallback(true);
			} else {
				if (workerName.length === 40) {
					try {
						new Buffer(workerName, "hex");
						authCallback(true);
					} catch (e) {
						authCallback(false);
					}
				} else {
					pool.daemon.cmd("validateaddress", [workerName], function (results) {
						let isValid = results.filter(function (r) {
							return r.response.isvalid
						}).length > 0;
						authCallback(isValid);
					});
				}
			}
		};
		
		handlers.share = function (isValidShare, isValidBlock, data) {
			shareProcessor.handleShare(isValidShare, isValidBlock, data);
		};
		
		let authorizeFN = function (ip, port, workerName, password, callback) {
			handlers.auth(port, workerName, password, function (authorized) {
				let authString = authorized ? "Authorized" : "Unauthorized";
				
				logger.debug(logSystem, logComponent, logSubcat,
				             authString + " " + workerName + ":" + password + " [" + ip + "]");
				callback({
					         error:      null,
					         authorized: authorized,
					         disconnect: false
				         });
			});
		};
		
		let pool = Stratum.createPool(poolOptions, authorizeFN, logger);
		pool.on("share", function (isValidShare, isValidBlock, data) {
			let shareData = JSON.stringify(data);
			
			if (data.blockHash && !isValidBlock) {
				logger.debug(logSystem, logComponent, logSubcat,
				             "We thought a block was found but it was rejected by the daemon, share data: " +
				             shareData);
			} else if (isValidBlock) {
				logger.debug(logSystem, logComponent, logSubcat,
				             "Block found: " + data.blockHash + " by " + data.worker);
			}
			
			if (isValidShare) {
				if (data.shareDiff > 1000000000) {
					logger.debug(logSystem, logComponent, logSubcat,
					             "Share was found with diff higher than 1,000,000,000!");
				} else if (data.shareDiff > 1000000) {
					logger.debug(logSystem, logComponent, logSubcat,
					             "Share was found with diff higher than 1,000,000!");
				}
				logger.debug(logSystem, logComponent, logSubcat,
				             "Share accepted at diff " + data.difficulty + "/" + data.shareDiff + " by " + data.worker +
				             " [" + data.ip + "]");
			} else if (!isValidShare) {
				logger.debug(logSystem, logComponent, logSubcat, "Share rejected: " + shareData);
			}
			
			handlers.share(isValidShare, isValidBlock, data);
		}).on("difficultyUpdate", function (workerName, diff) {
			logger.debug(logSystem, logComponent, logSubcat,
			             "Difficulty update to diff " + diff + " workerName=" + JSON.stringify(workerName));
			handlers.diff(workerName, diff);
		}).on("log", function (severity, text) {
			logger[severity](logSystem, logComponent, logSubcat, text);
		}).on("banIP", function (ip, worker) {
			process.send({type: "banIP", ip: ip});
		}).on("started", function () {
			_this.setDifficultyForProxyPort(pool, poolOptions.coin.name, poolOptions.coin.algorithm);
		});
		
		pool.start();
		pools[poolOptions.coin.name] = pool;
	});
	
	if (portalConfiguration.switching) {
		let logSystem = "Switch";
		let logComponent = "Setup";
		let logSubcat = "Thread " + (parseInt(forkId) + 1);
		
		let proxyState = {};
		
		// Load proxy state for each algorithm from redis which allows Kryptos to resume operation on the last
		// pool it was using when reloaded or restarted
		logger.debug(logSystem, logComponent, logSubcat, "Loading last proxy state from redis");
		
		redisClient.hgetall("proxyState", function (error, object) {
			if (!error && object) {
				proxySwitch = object;
				logger.debug(logSystem, logComponent, logSubcat, "Last proxy state loaded from redis");
			}
			
			// Setup proxySwitch object to control proxy operations from configuration and any restored state.
			// Each algorithm has a listening port, current coin name, and an active pool to which traffic is
			// directed when activated in the configuration.
			//
			// In addition, the proxy configuration also takes diff and varDiff parameters and override the
			// defaults for the standard configuration of the coin.
			Object.keys(portalConfiguration.switching).forEach(function (switchName) {
				let algorithm = portalConfiguration.switching[switchName].algorithm;
				
				if (!portalConfiguration.switching[switchName].enabled) return;
				
				let initialPool = proxySwitch.hasOwnProperty(algorithm) ? proxySwitch[algorithm] :
				                  _this.getFirstPoolForAlgorithm(algorithm);
				proxySwitch[switchName] = {
					algorithm:   algorithm,
					ports:       portalConfiguration.switching[switchName].ports,
					currentPool: initialPool,
					servers:     []
				};
				
				Object.keys(proxySwitch[switchName].ports).forEach(function (port) {
					let f = net.createServer(function (socket) {
						let currentPool = proxySwitch[switchName].currentPool;
						
						logger.debug(logSystem, logComponent, logSubcat,
						             "Connection to " + switchName + " from " + socket.remoteAddress + " on " + port +
						             " routing to " + currentPool);
						
						if (pools[currentPool]) {
							pools[currentPool].getStratumServer().handleNewClient(socket);
						} else {
							pools[initialPool].getStratumServer().handleNewClient(socket);
						}
					}).listen(parseInt(port), function () {
						logger.debug(logSystem, logComponent, logSubcat,
						             "Switch " + switchName + " listening for " + algorithm + " on port " + port +
						             " into " + proxySwitch[switchName].currentPool);
					});
					proxySwitch[switchName].servers.push(f);
				});
			});
		});
	}
	
	this.getFirstPoolForAlgorithm = function (algorithm) {
		let foundCoin = "";
		Object.keys(poolConfigurations).forEach(function (coinName) {
			if (poolConfigurations[coinName].coin.algorithm === algorithm) {
				if (foundCoin === "") {
					foundCoin = coinName;
				}
			}
		});
		return foundCoin;
	};
	
	// Called when stratum pool emits its 'started' event to copy the initial diff and vardiff configuration for any
	// proxy switching ports configured into the stratum pool object
	this.setDifficultyForProxyPort = function (pool, coin, algorithm) {
		logger.debug("Switch", "Setup", "Thread " + (parseInt(forkId) + 1), algorithm,
		             "Setting proxy difficulties after pool start");
		
		Object.keys(portalConfiguration.switching).forEach(function (switchName) {
			if (!portalConfiguration.switching[switchName].enabled) return;
			
			let switchAlgorithm = portalConfiguration.switching[switchName].algorithm;
			if (pool.options.coin.algorithm !== switchAlgorithm) return;
			
			// We know the switch configuration matches the pool's algorithm, so setup the diff and vardiff for
			// each of the switch's ports
			for (let port in portalConfiguration.switching[switchName].ports) {
				if (portalConfiguration.switching[switchName].ports) {
					pools.setVarDiff(port, portalConfiguration.switching[switchName].ports[port].varDiff);
				}
				
				if (portalConfiguration.switching[switchName].ports[port].diff) {
					if (!pool.options.ports.hasOwnProperty(port)) {
						pool.options.ports[port] = {};
					}
					pool.options.ports[port].diff = portalConfiguration.switching[switchName].ports[port].diff;
				}
			}
		});
	};
};