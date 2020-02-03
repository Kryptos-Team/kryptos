const fs = require("fs");
const redis = require("redis");
const async = require("async");

const Stratum = require("kryptos-stratum-pool");
const util = require("kryptos-stratum-pool/src/util");

module.exports = function (logger) {
	let poolConfigurations = JSON.parse(process.env.pools);
	let enabledPools = [];

	Object.keys(poolConfigurations).forEach(function (coin) {
		let poolOptions = poolConfigurations[coin];
		if (poolOptions.paymentProcessing && poolOptions.paymentProcessing.enabled) {
			enabledPools.push(coin);
		}
	});

	async.filter(enabledPools, function (coin, callback) {
		SetupForPool(logger, poolConfigurations[coin], function (setupResults) {
			callback(setupResults);
		});
	}, function (coins) {
		coins.forEach(function (coin) {
			let poolOptions = poolConfigurations[coin];
			let processingConfiguration = poolOptions.paymentProcessing;
			let logSystem = "Payments";
			logger.debug(logSystem, coin,
				"Payment processing setup to run every " + processingConfiguration.paymentInterval +
				" seconds with daemon (" + processingConfiguration.daemon.user + "@" +
				processingConfiguration.daemon.host + ":" + processingConfiguration.daemon.port +
				") and redis (" + poolOptions.redis.host + ":" + poolOptions.redis.port + ")");
		});
	});
};

function SetupForPool(logger, poolOptions, setupFinished) {
	let coin = poolOptions.coin.name;
	let processingConfiguration = poolOptions.paymentProcessing;

	let logSystem = "Payments";
	let logComponent = coin;

	let daemon = new Stratum.daemon.interface([processingConfiguration.daemon], function (severity, message) {
		logger[severity](logSystem, logComponent, message);
	});

	let redisClient = redis.createClient(poolOptions.redis.port, poolOptions.redis.host);

	let magnitude;
	let minPaymentSatoshis;
	let coinPrecision;

	let paymentInterval;

	async.parallel([
			function (callback) {
				daemon.cmd("validateaddress", [poolOptions.address], function (result) {
					logger.debug(logSystem, logComponent, "Daemon running validateaddress for " +
						poolOptions.address);
					if (result.error) {
						logger.error(logSystem, logComponent,
							"Error with payment processing daemon " + JSON.stringify(result.error));
						callback(true);
					} else if (!result.response || !result.response.ismine) {
						daemon.cmd("getaddressinfo", [poolOptions.address], function (result) {
							logger.debug(logSystem, logComponent, "Daemon running getaddressinfo for " +
								poolOptions.address);
							if (result.error) {
								logger.error(logSystem, logComponent,
									"Error with payment processing daemon, getaddressinfo failed " +
									JSON.stringify(result.error));
								callback(true);
							} else if (!result.response || !result.response.ismine) {
								logger.error(logSystem, logComponent,
									"Daemon does not own pool address - payment processing cannot be done with this daemon, " +
									JSON.stringify(result.response));
								callback(true);
							} else {
								callback();
							}
						}, true);
					} else {
						callback();
					}
				}, true);
			},
			function (callback) {
				daemon.cmd("getbalance", [], function (result) {
					logger.debug(logSystem, logComponent, "Daemon running getbalance");

					if (result.error) {
						logger.error(logSystem, logComponent,
							"Daemon encountered error while running getbalance " +
							JSON.stringify(result.error));
						callback(true);
						return;
					}
					try {
						let d = result.data.split('result":')[1].split(",")[0].split(".")[1];
						magnitude = parseInt("10" + new Array(d.length).join("0"));
						minPaymentSatoshis = parseInt(processingConfiguration.minimumPayment * magnitude);
						coinPrecision = magnitude.toString().length - 1;
						callback();
					} catch (e) {
						logger.error(logSystem, logComponent,
							"Error detecting number of satoshis in a coin, cannot do payment processing. Tried parsing: " +
							result.data);
						callback(true);
					}
				}, true, true);
			}
		],
		function (error) {
			if (error) {
				setupFinished(false);
				return;
			}

			paymentInterval = setInterval(function () {
				try {
					processPayments();
				} catch (e) {
					throw e;
				}
			}, processingConfiguration.paymentInterval * 1000);
			setTimeout(processPayments, 100);
			setupFinished(true);
		});

	let satoshisToCoins = function (satoshis) {
		return parseFloat((satoshis / magnitude).toFixed(coinPrecision));
	};

	let coinsToSatoshis = function (coins) {
		return coins * magnitude;
	};

	/*
	 Deal with numbers in smallest possible units as much as possible. This greatly helps with accuracy when rounding.
	 When we are storing numbers for only humans to see, store in while coin units.
	 */
	let processPayments = function () {
		let startPaymentProcess = Date.now();

		logger.debug(logSystem, logComponent, "Payment processing started");

		let timeSpentRPC = 0;
		let timeSpentRedis = 0;

		let startTimeRPC = 0;
		let startTimeRedis = 0;

		let startRedisTimer = function () { startTimeRedis = Date.now() };
		let endRedisTimer = function () { timeSpentRedis += Date.now() - startTimeRedis };

		let startRPCTimer = function () { startTimeRPC = Date.now() };
		let endRPCTimer = function () { timeSpentRPC += Date.now() - startTimeRedis };

		async.waterfall([
				// Call redis to get an array of rounds, which are coinbase transactions and block heights
				// from submitted blocks
				function (callback) {
					startRedisTimer();
					redisClient.multi([
						["hgetall", coin + ":balances"],
						["smembers", coin + ":blocksPending"]
					]).exec(function (error, results) {
						endRedisTimer();

						if (error) {
							logger.error(logSystem, logComponent,
								"Could not get blocks from redis " + JSON.stringify(error));
							callback(true);
							return;
						}

						let workers = {};
						for (let w in results[0]) {
							workers[w] = {balance: coinsToSatoshis(parseFloat(results[0][w]))};
						}

						let rounds = results[1].map(function (r) {
							let details = r.split(":");
							return {
								blockHash: details[0],
								tcHash: details[1],
								height: details[2],
								serialized: r
							};
						});

						callback(null, workers, rounds);
					});
				},
				// Does a batch RPC call to daemon with all the transaction hashes to see if they are
				// configured yet. It also adds the blockreward amount to the round object, which the
				// daemon also gives us
				function (workers, rounds, callback) {
					let batchRPCCommand = rounds.map(function (r) {
						return ["gettransaction", [r.txHash]];
					});

					batchRPCCommand.push(["getaccount", [poolOptions.address]]);

					startRPCTimer();
					daemon.batchCmd(batchRPCCommand, function (error, txDetails) {
						endRPCTimer();

						if (error || !txDetails) {
							logger.error(logSystem, logComponent,
								"Check finished - daemon RDP error with batch gettransactions " +
								JSON.stringify(error));
							callback(true);
							return;
						}

						let addressAccount;

						txDetails.forEach(function (tx, i) {
							if (i === txDetails.length - 1) {
								addressAccount = tx.result;
								return;
							}

							let round = rounds[i];

							if (tx.error && tx.error.code === -5) {
								logger.warning(logSystem, logComponent,
									"daemon reports invalid transaction: " + round.txHash);
								round.category = "kicked";
								return;
							} else if (!tx.result.details || tx.result.details &&
								tx.result.details.length === 0) {
								logger.warning(logSystem, logComponent,
									"Daemon reports no details for transaction: " +
									round.txHash);
								round.category = "kicked";
								return;
							} else if (tx.error || !tx.result) {
								logger.error(logSystem, logComponent,
									"Old error with gettransaction " + round.txHash + " " +
									JSON.stringify(tx));
								return;
							}

							let generationTx = tx.result.details.filter(function (tx) {
								return tx.address === poolOptions.address;
							})[0];

							if (!generationTx && tx.result.details.length === 1) {
								generationTx = tx.result.details[0];
							}

							if (!generationTx) {
								logger.error(logSystem, logComponent,
									"Missing output details to pool address for transaction " +
									round.txHash);
								return;
							}

							round.category = generationTx.category;
							if (round.category === "generate") {
								round.reward = generationTx.amount || generationTx.value;
							}
						});

						let canDeleteShares = function (tx) {
							for (let i = 0; i < rounds.length; i++) {
								let compareR = rounds[i];
								if ((compareR.category === r.height)
									&& (compareR.category !== "kicked")
									&& (compareR.category !== "orphan")
									&& (compareR.serialized !== r.serialized)) {
									return false;
								}
							}

							return true;
						};

						// Filter out all rounds that immature (not confirmed or orphaned)
						rounds = rounds.filter(function (r) {
							switch (r.category) {
								case "orphan":
								case "kicked":
									r.canDeleteShares = canDeleteShares(r);
									break;
								case "generate":
									return true;
								default:
									return false;
							}
						});

						callback(null, workers, rounds, addressAccount);
					});
				},

				// Does a batch redis call to get shares contributed to each round. Then calculates the
				// reward amount owned to each miner for each round
				function (workers, rounds, addressAccount, callback) {
					let shareLookups = rounds.map(function (r) {
						return ["hgetall", coin + ":shares:round", r.height];
					});

					startRedisTimer();
					redisClient.multi(shareLookups).exec(function (error, allWorkersShares) {
						endRedisTimer();

						if (error) {
							callback("Check finished - redis error with multi get rounds share");
							return;
						}

						rounds.forEach(function (round, i) {
							let workerShares = allWorkersShares[i];

							if (!workerShares) {
								logger.error(logSystem, logComponent,
									"No worker shares for round: " + round.height +
									" blockHash: " + round.blockHash);
								return;
							}

							switch (round.category) {
								case "kicked":
								case "orphan":
									round.workerShares = workerShares;
									break;

								case "generate":
									// We found a confirmed block! Now get the reward for it and calculate
									// how much we owe each miner based on the shares they submitted during
									// that block round
									let reward = parseInt(round.reward * magnitude);
									let totalShares = Object.keys(workerShares).reduce(function (p, c) {
										return p + parseFloat(workerShares[c]);
									}, 0);

									for (let workerAddress in workerShares) {
										let percent = parseFloat(workerShares[workerAddress]) / totalShares;
										let workerRewardTotal = Math.floor(reward * percent);
										let worker = workers[workerAddress] =
											(workers[workerAddress] || {});
										worker.reward = (worker.reward || 0) + workerRewardTotal;
									}
									break;
							}
						});

						callback(null, workers, rounds, addressAccount);
					});
				},
				// Calculate if any payments are ready to be sent and trigger them sending
				// Get balance different for each address and pass it along as object of latest balances
				// such as {worker1: balance1, worker2: balance2} when deciding the sent balance, it the
				// difference should be -1 * amount they had in db, if not sending the balance, the
				// difference should be +(the amount they earned this round)
				function (workers, rounds, addressAccount, callback) {
					let trySend = function (withholdPercent) {
						let addressAmounts = {};
						let totalSent = 0;

						for (let w in workers) {
							let worker = workers[w];
							worker.balance = worker.balance || 0;
							worker.reward = worker.reward || 0;
							let toSend = (worker.balance + worker.reward) * (1 - withholdPercent);
							if (toSend >= minPaymentSatoshis) {
								totalSent += toSend;
								let address = worker.address = (worker.address || getProperAddresses(w));
								worker.sent = addressAmounts[address] = satoshisToCoins(toSend);
								worker.balanceChange = Math.min(worker.balance, toSend) * -1;
							} else {
								worker.balance = Math.max(toSend - worker.balance, 0);
								worker.sent = 0;
							}
						}

						if (Object.keys(addressAmounts).length === 0) {
							callback(null, workers, rounds);
							return;
						}

						daemon.cmd("sendmany", [addressAccount || "", addressAmounts], function (result) {
							// Check if payments failed because wallet does not have enough coins to pay
							// for tx fees
							if (result.error && result.error.code === -6) {
								let highestPercent = withholdPercent + 0.01;
								logger.warning(logSystem, logComponent,
									"Not enough funds to cover the tx fees for sending out payments, decreasing rewards by " +
									(highestPercent * 100) + "% and retrying");
								trySend(highestPercent);
							} else if (result.error) {
								logger.error(logSystem, logComponent,
									"Error trying to send payments with RPC sendmany " +
									JSON.stringify(result.error));
								callback(true);
							} else {
								logger.debug(logSystem, logComponent,
									"Sent out a total of " + (totalSent / magnitude) + " to " +
									Object.keys(addressAmounts).length + " workers");
								if (withholdPercent > 0) {
									logger.warning(logSystem, logComponent,
										"Had to withhold " + (withholdPercent * 100) +
										"% of rewards from miners to cover transaction fees. " +
										"Fund pool wallet with coins to prevent this from happening");
								}
								callback(null, workers, rounds);
							}
						}, true, true);
					};
					trySend(0);
				},
				function (workers, rounds, callback) {
					let totalPaid = 0;
					let balanceUpdateCommands = [];
					let workerPayoutsCommand = [];

					for (let w in workers) {
						let worker = workers[w];
						if (worker.balanceChange !== 0) {
							balanceUpdateCommands.push(["hincrbyfloat", coin + ":balances", w,
								satoshisToCoins(worker.balanceChange)]);
						}

						if (worker.sent !== 0) {
							workerPayoutsCommand.push(["hincrbyfloat", coin + ":payouts", w, worker.sent]);
							totalPaid += worker.sent;
						}
					}

					let movePendingCommands = [];
					let roundsToDelete = [];
					let orphanMergeCommands = [];

					let moveSharesToCurrent = function (r) {
						let workerShares = r.workerShares;
						Object.keys(workerShares).forEach(function (worker) {
							orphanMergeCommands.push(
								["hincrby", coin + ":shares:roundCurrent", worker, workerShares[worker]]);
						});
					};

					rounds.forEach(function (r) {
						switch (r.category) {
							case "kicked":
								movePendingCommands.push(
									["smove", coin + ":blocksPending", coin + ":blocksKicked",
										r.serialized]);
								return;

							case "orphan":
								movePendingCommands.push(
									["smove", coin + ":blocksPending", coin + ":blocksOrphaned",
										r.serialized]);
								if (r.canDeleteShares) {
									moveSharesToCurrent(r);
									roundsToDelete.push(coin + ":shares:round", r.height);
								}
								return;

							case "generate":
								movePendingCommands.push(
									["smove", coin + ":blocksPending", coin + ":blocksConfirmed",
										r.serialized]);
								roundsToDelete.push(coin + ":shares:round" + r.height);
								return;
						}
					});

					let finalRedisCommands = [];

					if (movePendingCommands.length > 0) {
						finalRedisCommands = finalRedisCommands.concat(movePendingCommands);
					}

					if (orphanMergeCommands.length > 0) {
						finalRedisCommands = finalRedisCommands.concat(orphanMergeCommands);
					}

					if (balanceUpdateCommands.length > 0) {
						finalRedisCommands = finalRedisCommands.concat(balanceUpdateCommands);
					}

					if (workerPayoutsCommand.length > 0) {
						finalRedisCommands = finalRedisCommands.concat(workerPayoutsCommand);
					}

					if (roundsToDelete.length > 0) {
						finalRedisCommands = finalRedisCommands.concat(roundsToDelete);
					}

					if (finalRedisCommands.length === 0) {
						callback();
						return;
					}

					startRedisTimer();
					redisClient.multi(finalRedisCommands).exec(function (error, results) {
						endRedisTimer();
						if (error) {
							clearInterval(paymentInterval);
							logger.error(logSystem, logComponent,
								"Payments sent but could not update redis. " +
								JSON.stringify(error) +
								" Disabling payment processing to prevent possible double-payouts. " +
								"The redis commands in " + coin +
								"_finalRedisCommands.txt must be ran manually");
							fs.write(coin + "_finalRedisCommands.txt", JSON.stringify(finalRedisCommands),
								function (error) {
									logger.error(logSystem, logComponent,
										"Could not write finalRedisCommands.txt, you are fucked");
								});
						}
						callback();
					});
				}
			],
			function () {
				let paymentProcessorTime = Date.now() - startPaymentProcess;
				logger.debug(logSystem, logComponent,
					"Finished interval - time spent: " + paymentProcessorTime + "ms total, " +
					timeSpentRedis + "ms redis, " + timeSpentRPC + "ms daemon RPC");
			});
	};

	let getProperAddress = function (address) {
		if (address.length === 40) {
			return util.addressFromEx(poolOptions.address, address);
		} else {
			return address;
		}
	};
}