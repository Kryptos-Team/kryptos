const fs = require("fs");
const path = require("path");
const async = require("async");
const watch = require("node-watch");
const redis = require("redis");

const dot = require("dot");
const express = require("express");
const bodyParser = require("body-parser");
const compression = require("compression");

const Stratum = require("kryptos-stratum-pool");
const util = require("kryptos-stratum-pool/src/util");

const api = require("./api");

module.exports = function (logger) {
	dot.templateSettings.strip = false;

	let portalConfiguration = JSON.parse(process.env.portalConfiguration);
	let poolConfigurations = JSON.parse(process.env.pools);

	let websiteConfiguration = portalConfiguration.website;

	let portalApi = new api(logger, portalConfiguration, poolConfigurations);
	let portalStats = portalApi.stats;

	let logSystem = "Website";

	let pageFiles = {
		"index.html": "index",
		"home.html": "",
		"getting_stated.html": "getting_started",
		"stats.html": "stats",
		"tbs.html": "tbs",
		"workers.html": "workers",
		"api.html": "api",
		"admin.html": "admin",
		"mining_key.html": "mining_key"
	};

	let pageTemplates = {};
	let pageProcessed = {};
	let indexesProcessed = {};

	let keyScriptTemplate = "";
	let keyScriptProcessed = "";

	let processTemplates = function () {
		for (let pageName in pageTemplates) {
			if (pageName === "index") continue;
			pageProcessed[pageName] = pageTemplates[pageName]({
				poolConfigurations: poolConfigurations,
				stats: portalStats.stats,
				portalConfiguration: portalConfiguration
			});

			indexesProcessed[pageName] = pageTemplates.index({
				page: pageProcessed[pageName],
				selected: pageName,
				stats: portalStats.stats,
				poolConfigurations: poolConfigurations,
				portalConfiguration: portalConfiguration
			});
		}

		logger.debug(logSystem, "Stats", "Website updated to latest stats");
	};

	let readPageFiles = function (files) {
		async.each(files, function (fileName, callback) {
			let filePath = "website/" + (fileName === "index.html" ? "" : "pages/") + fileName;
			fs.readFile(filePath, "utf-8", function (error, data) {
				pageTemplates[pageFiles[fileName]] = dot.template(data);
				callback();
			});
		}, function (error) {
			if (error) {
				logger.error(logSystem, "Stats", "Error reading files for creating dot templates: " + JSON.stringify(error));
				return;
			}
			processTemplates();
		});
	};

	// If an HTML file was changed, reload it
	watch("website", function (evt, fileName) {
		let basename = path.basename(fileName);
		if (basename in pageFiles) {
			readPageFiles([basename]);
			logger.debug(logSystem, "Server", "Reloaded file " + basename);
		}
	});

	// portalStats.getGlobalStats(function () {
	// 	readPageFiles(Object.keys(pageFiles));
	// });
};