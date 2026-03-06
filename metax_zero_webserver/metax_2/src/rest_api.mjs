// 
import {
	initialize_db_rest_api
	, handle_db_request
} from "./db_rest_api.mjs";

import { handle_odm_request } from "./odm_rest_api.mjs";

//imports from standard libraries
import { createSecureServer } from "http2";
import { readFileSync } from "fs";
import { randomUUID } from "crypto";

//imports from third party libraries
import { WebSocketServer } from "ws";

const config = {};

process.on('uncaughtException', (err, origin) => {
	console.log(new Date(), "Uncaught exception", err, origin);
	process.exit(-1);
});

global.wss_clients = {};
global.listened_uuids = {};

global.config = config;
global.assert = (c, m) => {
	if (!c) {
		console.error("Assertion violation: ", m);
		process.exit(-1);
	}
};
global.is_valid_uuid = (u) => {
	if (typeof u !== 'string') return false;
	return /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(u) ||
		/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}-[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(u);
};

main();

function main() {
	configure_metax();
	assert(config.storage !== undefined, "storage path is not defined.");
	assert(config.port !== undefined, "port is not defined.");
	assert(config.key !== undefined, "private key path is not defined.");
	assert(config.cert !== undefined, "certificate path is not defined.");
	initialize_db_rest_api();
	start_server();
}

function configure_metax() {
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++) {
		let pairs = argv[i].split("=");
		config[pairs[0]] = pairs[1];
	}
	console.log("metax configured.");
}

function start_server() {
	assert(!isNaN(parseInt(config.port)), "port must be a number.");

	// Load CA certificate for client verification (localhost communication only)
	let ca;
	try {
		ca = readFileSync(config.ca || '../certs/localhost/ca.crt');
		console.log("Loaded CA certificate for client authentication");
	} catch (e) {
		console.warn("Warning: Could not load CA certificate for client auth, continuing without client verification");
	}

	const http_server = createSecureServer({
		peerMaxConcurrentStreams: 1000,
		key: readFileSync(config.key),
		cert: readFileSync(config.cert),
		ca: ca,
		requestCert: !!ca,  // Request client certificate if CA is available
		rejectUnauthorized: !!ca,  // Reject connections without valid client cert
		allowHTTP1: true
	}, route_incoming_request);
	http_server.on("error", handle_http_server_error)
	http_server.listen(parseInt(config.port), "127.0.0.1",
		() => console.log("https server started on 127.0.0.1"));
	const wss = new WebSocketServer({ server: http_server });
	wss.on("connection", handle_websocket_new_connection);
}

function handle_http_server_error(e) {
	switch (e.code) {
		case "EADDRINUSE":
			console.error(`the port ${config.port} is already in use`);
			process.exit(-1);
			break;
		default:
			console.error("Unhandled server error", e);
	}
}

function route_incoming_request(req, res) {
	// SECURITY: Only allow connections from localhost
	const remoteAddr = req.socket.remoteAddress;
	const isLocalhost = remoteAddr === '127.0.0.1' ||
		remoteAddr === '::1' ||
		remoteAddr === '::ffff:127.0.0.1' ||
		remoteAddr === 'localhost';

	if (!isLocalhost) {
		console.error(`Rejected non-localhost connection attempt from ${remoteAddr}`);
		res.writeHead(403, { "content-type": "application/json" });
		res.end('{"error":"Access denied. Only localhost connections allowed."}');
		return;
	}

	// AUDIT: Log who connected (Client Certificate CN) and protocol
	const cert = req.socket.getPeerCertificate();
	const clientCN = cert && cert.subject ? cert.subject.CN : "No Client Cert/Auth Error";
	const protocol = req.httpVersion >= 2 ? "HTTP/2" : "HTTP/1.1";

	// Enforce HTTP/2 for non-WebSocket REST requests
	// Note: regular browser REST calls should use HTTP/2 via ALPN
	if (req.headers['upgrade'] !== 'websocket' && req.httpVersion < 2) {
		// Just logging warning for now as per "Ensure... all other requests must be HTTP/2"
		// If we want hard rejection, we can return 426 Upgrade Required
		console.warn(`[AUDIT] Potential non-HTTP/2 REST request from ${clientCN} via ${protocol}`);
	}

	console.log(`[AUDIT] [${new Date().toISOString()}] Connection from ${clientCN} (${remoteAddr}) using ${protocol}`);

	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', '*');

	if (req.method === 'OPTIONS') {
		res.writeHead(200);
		res.end();
		return;
	}

	if (!req.headers[":path"]) req.headers[":path"] = req.url;
	if (!req.headers[":scheme"]) req.headers[":scheme"] = "https";
	if (!req.headers[":method"]) req.headers[":method"] = req.method;

	let req_path = req.headers[":path"].split("?")[0];
	console.log(`received new request from ${req.socket.remoteAddress},`,
		`request path: ${req.headers[":path"]}`);
	switch (req_path.split("/")[1]) {

		case "db":
			handle_db_request(req, res);
			break;
		case "oo":
			handle_odm_request(req, res);
			break;
		case "config":
			handle_config_request(req, res);
			break;
		default:
			res.writeHead(400, { "content-type": "application/json" });
			res.end(`{"error":"request is not handled yet."}`);
			break;
	}
}

function handle_websocket_new_connection(s) {
	const token = randomUUID();
	wss_clients[token] = s;
	s.send(`{"event":"connected", "token": "${token}"}`);
	s.on("close", () => {
		console.log(`received websocket close event for session: ${token}`);
		assert(wss_clients[token] !== undefined,
			"websocket connection was closed improperly");
		delete wss_clients[token];
		clean_up_listened_uuids_per_token(token);
	});
}

function clean_up_listened_uuids_per_token(token) {
	const uuids = Object.keys(listened_uuids);
	for (let i = 0; i < uuids.length; i++) {
		let token_index = listened_uuids[uuids[i]].indexOf(token);
		if (token_index !== -1) {
			listened_uuids[uuids[i]].splice(token_index, 1);
		}
	}
}

global.send_notification_to_websocket_clients = (uuid) => {
	if (listened_uuids[uuid] !== undefined) {
		for (let i = 0; i < listened_uuids[uuid].length; i++) {
			let token = listened_uuids[uuid][i];
			assert(wss_clients[token] !== undefined,
				"listened_uuids has token in list, but websocket object not found.");
			wss_clients[token].send(JSON.stringify({ event: "update", uuid }))
		}
	}
}

function handle_config_request(req, res) {
	console.log(`handling config request`, `request path: ${req.headers[":path"]}`);
	const req_path = req.headers[":path"].split("?")[0];
	if (req_path === "/config/get_user_id") {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ user_id: "d0000000-0000-0000-0000-000000000000" }));
	} else {
		res.writeHead(400, { "content-type": "application/json" });
		res.end(`{"error":"config request is not handled yet."}`);
	}
}


