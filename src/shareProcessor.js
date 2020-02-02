const redis = require("redis");
const Stratum = require("kryptos-stratum-pool");

/*
This module delas with handling shares when in internal payment processing mode. It connects to a redis database and
inserts shares with the database structure of:

key: coin_name + ":" + block_height
value: a hash with key:
 */

module.exports = function (logger, poolConfiguration) {
    let redisConfig = poolConfiguration.redis;
    let coin = poolConfiguration.coin.name;

    let forkId = process.env.forkId;
    let logSystem = "Pool";
    let logComponent = coin;
    let logSubcat = "Thread " + (parseInt(forkId) + 1);

    let connection = redis.createClient(redisConfig.port, redisConfig.host);

    connection.on("ready", function () {
        loger.debug(logSystem, logComponent, logSubcat, "Share processing setup with redis (" + redisConfig.host + ":" + redisConfig.port + ")");
    });

    connection.on("error", function (error) {
        logger.error(logSystem, logComponent, logSubcat, "Redis client had an error: " + JSON.stringify(error));
    });

    connection.on("end", function () {
        logger.error(logSystem, logComponent, logSubcat, "Connection to redis database has ended");
    });

    connection.info(function (error, response) {
        if (error) {
            logger.error(logSystem, logComponent, logSubcat, "Redis version check failed");
            return;
        }

        let parts = response.split("\r\n");
        let version;
        let versionString;

        for (let i = 0; i < parts.length; i++) {
            if (parts[i].indexOf(":") !== -1) {
                let valParts = parts[i].split(":");
                if (valParts[0] === "redis_version") {
                    versionString = valParts[1];
                    version = parseFloat(versionString);
                    break;
                }
            }
        }

        if (!version) {
            logger.error(logSystem, logComponent, logSubcat, "Could not detect redis version");
        } else if (version < 2.6) {
            logger.error(logSystem, logComponent, logSubcat, "Unsupported version: " + version + ". Minimum version required is 2.6");
        }
    });

    this.handleShare = function (isValidShare, isValidBlock, shareData) {
        let redisCommands = [];

        if (isValidShare) {
            redisCommands.push(["hincrbyfloat", coin + ":shares:roundCurrent", shareData.worker, shareData.difficulty]);
            redisCommands.push(["hincrby", coin + ":stats", "validShares", 1]);
        } else {
            redisCommands.push(["hincrby", coin + ":stats", "invalidShares", 1]);
        }
        /*
        Stores shares diff, worker, and unique value with a score that is the timestamp. Unique value ensures it
        doesn't overwrite an existing entry, and timestamp as score lets us query shares from last X minutes to
        generate hashrate for each worker and pool
         */
        let dateNow = Date.now();
        let hashrateData = [isValidShare ? shareData.difficulty : -shareData.difficulty, shareData.worker, dateNow];
        redisCommands.push(["zadd", coin + ":hashrate", dateNow / 1000 | 0, hashrateData.join(":")]);

        if (isValidBlock) {
            redisCommands.push(["rename", coin + ":shares:roundCurrent", coin + ":shares:round" + shareData.height]);
            redisCommands.push(["sadd", coin + ":blocksPending", [shareData.blockHash, shareData.txHash, shareData.height].join(":")]);
            redisCommands.push(["hincrby", coin + ":stats", "validBlocks", 1]);
        } else if (shareData.blockHash) {
            redisCommands.push(["hincrby", coin + ":stats", "invalidBlocks", 1]);
        }

        connection.multi(redisCommands).exec(function (error, replies) {
            if (error) {
                logger(logSystem, logComponent, logSubcat, "Error with share processor multi " + JSON.stringify(error));
            }
        });
    };
};