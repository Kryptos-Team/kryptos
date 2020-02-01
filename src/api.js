const redis = require("redis");
const async = require("async");
const stats = require("./stats");

module.exports = function (logger, portalConfiguration, poolConfigurations) {
    let _this = this;
    let portalStats = this.stats = new stats(logger, portalConfiguration, poolConfigurations);
    this.liveStatConnections = {};
    this.handleApiRequest = function (request, response, next) {
        switch (request.params.method) {
            case "stats":
                response.writeHead(200, {"Content-Type": "application/json"});
                response.end(portalStats.statsString);
                return;

            case "poolStats":
                response.writeHead(200, {"Content-Type": "application/json"});
                response.end(JSON.stringify(portalStats.statPoolHistory));
                return;

            case "liveStats":
                response.writeHead(200, {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive"
                });
                response.write("\n");
                let uid = Math.random().toString();
                _this.liveStatConnections[uid] = response;
                request.on("close", function () {
                    delete _this.liveStatConnections[uid];
                });

                return;

            default:
                next();
        }
    };

    this.handleApiRequest = function (request, response, next) {
        switch (request.params.method) {
            case "pools": {
                response.end(JSON.stringify({result: poolConfigurations}));
                return;
            }

            default:
                next();
        }
    };
};