const dateFormat = require("dateformat");
const colors = require("colors");

const severityToColor = function (severity, text) {
    switch (severity) {
        case 'info':
            return text.cyan;
        case 'special':
            return text.cyan.underline;
        case 'warning':
            return text.yellow;
        case 'error':
            return text.red;
        default:
            console.log("Unknown severity " + severity);
            return text.italic;
    }

};

const severityValues = {
    'debug': 1,
    'info': 2,
    'warning': 3,
    'error': 4,
    'special': 5
};

const Logger = function (configuration) {
    const logLevelInt = severityValues[configuration.logLevel];
    const logColors = configuration.logColors;

    let log = function (severity, system, component, text, subcat) {
        if (severityValues[severity] < logLevelInt)
            return;

        if (subcat) {
            let realText = subcat;
            let realSubcat = text;
            text = realText;
            subcat = realSubcat;
        }

        let entryDescription = dateFormat(new Date(), 'yyyy-mm-dd HH:MM:ss Z') + ' [' + system + ']\t';
        let logString = "";
        if (logColors) {
            entryDescription = severityToColor(severity, entryDescription);
            logString = entryDescription + ('[' + component + '] ').italic;

            if (subcat)
                logString += ('(' + subcat + ') ').bold.blue;
            logString += text.blue;
        } else {
            logString = entryDescription + '[' + component + '] ';
            if (subcat)
                logString += '(' + subcat + ') ';
            logString += text;
        }
        console.log(logString);
    };

    var _this = this;
    Object.keys(severityValues).forEach(function (logType) {
        _this[logType] = function () {
            var args = Array.prototype.slice.call(arguments, 0);
            args.unshift(logType);
            log.apply(this, args);
        };
    });
};

module.exports = Logger;