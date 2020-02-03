const net = require("net");

const defaultPort = 17117;
const defaultHost = "127.0.0.1";

let args = process.argv.slice(2);
let params = [];
let options = [];

for (let i = 0; i < args.length; i++) {
	if (args[i].indexOf("-") === 0 && args[i].indexOf("=") !== -1) {
		let s = args[i].substr(1).split("=");
		options[s[0]] = s[1];
	} else {
		params.push(args[i]);
	}
}

let command = params.shift();

let client = net.connect(options.port || defaultPort, options.host || defaultHost, function () {
	client.write(JSON.stringify({
		command: command,
		params: params,
		options: options
	}) + "\n");
}).on("error", function (error) {
	if (error.code === "ECONNREFUSED")
		console.error("Could not connect to Kryptos instance at " + defaultHost + ":" + defaultPort);
}).on("close", function () {
});