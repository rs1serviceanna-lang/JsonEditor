/*
================= rest_api.mjs - Metax Server Engine Core ===================

This is the central entry point for the Metax Data Platform. 
It instantiates the secure HTTP/2 server, manages the global configuration, 
and coordinates the interaction between raw DB storage and ODM layers.

--- Operational Flow ---

  1. Configuration: Parses command-line k=v pairs (storage, port, keys).
  2. Initialization: Prepares the disk-based DB layer and mTLS context.
  3. Server Context: Opens a secure HTTP/2 + WebSocket multiplexer on localhost.
  4. Dispatch: Routes traffic to /db (raw), /oo (ODM), or /config (identity).

--- Security & Audit ---

  - Enforces localhost-only access patterns by default.
  - Supports mutual TLS (mTLS) for cryptographic client identification.
  - Maintains a per-request audit trail including Client CN and Protocol.
  - WebSocket session isolation via high-entropy random tokens.

================================================================================
*/

// ========================= Imports from this project =========================

// DB initialization and HTTP request handler for /db/* routes.
import {
	initialize_db_rest_api
	, handle_db_request
} from "./db_rest_api.mjs";

// HTTP request handler for /oo/* (Object Data Model) routes.
import { handle_odm_request } from "./odm_rest_api.mjs";

// ========================= Imports from standard libraries ===================

// createSecureServer: Creates an HTTP/2 server with TLS support.
import { createSecureServer } from "http2";
// readFileSync: Loads certificate files synchronously at startup.
import { readFileSync } from "fs";
// randomUUID: Generates unique session tokens for each WebSocket connection.
import { randomUUID } from "crypto";

// ========================= Imports from third-party libraries ================

// WebSocketServer: Attaches a WebSocket server to the existing HTTP/2 server.
import { WebSocketServer } from "ws";

// ========================= Configuration Object ==============================

// Runtime configuration object populated from command-line args in configure_metax().
// All server settings (port, paths, etc.) are read from here at startup.
const config = {};

// ========================= Global Error Handler ==============================

// Catches any uncaught exceptions that escape the normal try/catch flow.
// Logs the error with timestamp and exits to prevent running in a broken state.
process.on('uncaughtException', (err, origin) => {
	console.log(new Date(), "Uncaught exception", err, origin);
	process.exit(-1);
});

// ========================= Global State ======================================

// wss_clients: Maps session token (UUID) -> active WebSocket connection object.
// Used to send "update" notifications to clients when a UUID is saved.
global.wss_clients = {};

// listened_uuids: Maps UUID -> [session_token, ...].
// When a UUID is updated, all tokens in its list receive a WebSocket notification.
global.listened_uuids = {};

// config is exposed globally so that db.mjs can access config.storage at runtime.
global.config = config;

// assert: Global assertion helper. Logs the message and terminates if condition is false.
// Used throughout the codebase to enforce invariants and catch invalid states early.
global.assert = (c, m) => {
	if (!c) {
		console.error("Assertion violation: ", m);
		process.exit(-1);
	}
};

// is_valid_uuid: Global UUID format validator.
// Accepts both standard UUIDs and the double-UUID format used by db.mjs for storage keys.
// Returns true if the string matches either format, false otherwise.
global.is_valid_uuid = (u) => {
	if (typeof u !== 'string') return false;
	return /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(u) ||
		/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}-[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(u);
};

// ========================= Application Startup ================================

// Entry point: configure, initialize DB, then start the server.
main();

// Main startup sequence:
// 1. Parse and validate command-line configuration.
// 2. Assert all required config values are present.
// 3. Initialize the database storage directory.
// 4. Start the secure HTTP/2 + WebSocket server.
function main() {
	configure_metax();
	assert(config.storage !== undefined, "storage path is not defined.");
	assert(config.port !== undefined, "port is not defined.");
	assert(config.key !== undefined, "private key path is not defined.");
	assert(config.cert !== undefined, "certificate path is not defined.");
	initialize_db_rest_api();
	start_server();
}

// ========================= Configuration =====================================

// Processes command-line arguments in "key=value" format.
// Populates the internal config registry for runtime availability.
function configure_metax() {
	const argv = process.argv.slice(2);
	argv.forEach(arg => {
		const [key, value] = arg.split("=");
		if (key && value) config[key] = value;
	});
	console.log(`[SYSTEM] Configuration loaded: ${Object.keys(config).join(", ")}`);
}

// ========================= Server Startup ====================================

// Creates and starts the HTTP/2 + WebSocket server.
//
// Security options:
// - If a CA cert is found, enables mTLS (requires client certificates).
// - If CA is not available, starts without client cert verification (logs a warning).
// - The server listens ONLY on 127.0.0.1 (loopback) for security isolation.
//
// WebSocket:
// - Attaches a WebSocket server to the same HTTP/2 server instance.
// - New WebSocket connections are handled by handle_websocket_new_connection().
function start_server() {
	assert(!isNaN(parseInt(config.port)), "port must be a number.");

	// Load CA certificate for optional mTLS client authentication.
	let ca;
	try {
		ca = readFileSync(config.ca || '../certs/localhost/ca.crt');
		console.log("Loaded CA certificate for client authentication");
	} catch (e) {
		console.warn("Warning: Could not load CA certificate for client auth, continuing without client verification");
	}

	// Create the HTTPS/HTTP2 server with TLS configuration.
	// requestCert and rejectUnauthorized are only enabled if a CA is available.
	const http_server = createSecureServer({
		peerMaxConcurrentStreams: 1000,
		key: readFileSync(config.key),
		cert: readFileSync(config.cert),
		ca: ca,
		requestCert: !!ca,            // Request client cert only if CA is configured.
		rejectUnauthorized: !!ca,     // Reject without valid cert only if CA is configured.
		allowHTTP1: true              // Also accept HTTP/1.1 for compatibility.
	}, route_incoming_request);
	http_server.on("error", handle_http_server_error)
	// Listen only on localhost (127.0.0.1) to prevent external access.
	http_server.listen(parseInt(config.port), "127.0.0.1",
		() => console.log("https server started on 127.0.0.1"));
	// Attach WebSocket server to the same HTTPS server.
	const wss = new WebSocketServer({ server: http_server });
	wss.on("connection", handle_websocket_new_connection);
}

// ========================= Error Handler =====================================

// Handles fatal HTTP server errors.
// The most common case is EADDRINUSE (port already in use), which causes exit.
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

// ========================= Request Router ====================================

// Main request router. Routes traffic based on the first path segment.
// Implements CORS for browser clients and standardizes pseudo-headers.
function route_incoming_request(req, res) {
	const remoteAddr = req.socket.remoteAddress;
	const isLocalhost = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === 'localhost';

	if (!isLocalhost) {
		console.warn(`[SECURITY] Blocked non-localhost attempt from ${remoteAddr}`);
		res.writeHead(403, { "content-type": "application/json" });
		res.end('{"error":"Access Restricted: Only localhost connections are permitted."}');
		return;
	}

	const cert = req.socket.getPeerCertificate();
	const clientCN = cert && cert.subject ? cert.subject.CN : "System/Anonymous";
	const protocol = req.httpVersion >= 2 ? "H2" : "H1.1";

	// Internal normalization for HTTP/1.1 compatibility.
	if (!req.headers[":path"]) req.headers[":path"] = req.url;
	if (!req.headers[":method"]) req.headers[":method"] = req.method;

	const clean_path = req.headers[":path"].split("?")[0];
	const root_segment = clean_path.split("/")[1];

	console.log(`[AUDIT] [${protocol}] ${clientCN} -> ${clean_path}`);

	switch (root_segment) {
		case "db": handle_db_request(req, res); break;
		case "oo": handle_odm_request(req, res); break;
		case "config": handle_config_request(req, res); break;
		default:
			res.writeHead(404, { "content-type": "application/json" });
			res.end(`{"error":"Resource not found: ${clean_path}"}`);
			break;
	}
}

// ========================= WebSocket Handling ================================

// Called when a new WebSocket client connects.
// Assigns a random UUID token to the session and sends it to the client.
// The client uses this token to subscribe to UUID update notifications.
//
// On close:
// - Validates the session exists in wss_clients before cleanup.
// - Removes the session from wss_clients.
// - Removes the session token from all listened_uuids lists.
function handle_websocket_new_connection(s) {
	// Assign a unique session token for this WebSocket connection.
	const token = randomUUID();
	wss_clients[token] = s;
	// Inform the client of its session token so it can register listeners.
	s.send(`{"event":"connected", "token": "${token}"}`);

	// 30-second keep-alive to prevent silent disconnects
	const keep_alive = setInterval(() => {
		if (s.readyState === s.OPEN) s.ping();
	}, 30_000);

	s.on("close", () => {
		clearInterval(keep_alive);
		console.log(`received websocket close event for session: ${token}`);
		assert(wss_clients[token] !== undefined,
			"websocket connection was closed improperly");
		// Remove this session from the active clients map.
		delete wss_clients[token];
		// Remove this token from all UUID listener lists to prevent memory leaks.
		clean_up_listened_uuids_per_token(token);
	});
}

// Removes a WebSocket session token from all UUID listener lists.
// Called when a WebSocket connection closes to prevent stale references.
//
// Parameters:
// - token: The session token of the disconnected WebSocket client.
function clean_up_listened_uuids_per_token(token) {
	const uuids = Object.keys(listened_uuids);
	for (let i = 0; i < uuids.length; i++) {
		let token_index = listened_uuids[uuids[i]].indexOf(token);
		if (token_index !== -1) {
			// Remove this token from the listener array for this UUID.
			listened_uuids[uuids[i]].splice(token_index, 1);
		}
	}
}

// Sends a JSON "update" event to all WebSocket sessions listening for a UUID.
// Called after every successful save or mutation of a UUID's data.
// Global so that db_rest_api.mjs and odm_rest_api.mjs can call it directly.
//
// Parameters:
// - uuid: The UUID whose data was updated.
global.send_notification_to_websocket_clients = (uuid) => {
	if (listened_uuids[uuid] !== undefined) {
		for (let i = 0; i < listened_uuids[uuid].length; i++) {
			let token = listened_uuids[uuid][i];
			assert(wss_clients[token] !== undefined,
				"listened_uuids has token in list, but websocket object not found.");
			// Send the update event with the UUID so clients know which object changed.
			wss_clients[token].send(JSON.stringify({ event: "update", uuid }))
		}
	}
}

// ========================= Config Request Handler ============================

// Handles requests to /config/* endpoints.
// Currently only supports /config/get_user_id which returns a fixed user ID.
//
// Parameters:
// - req: Incoming HTTP request.
// - res: HTTP response object.
function handle_config_request(req, res) {
	console.log(`handling config request`, `request path: ${req.headers[":path"]}`);
	const req_path = req.headers[":path"].split("?")[0];
	if (req_path === "/config/get_user_id") {
		// Return the fixed "admin" user ID for this local metax instance.
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ user_id: "d0000000-0000-0000-0000-000000000000" }));
	} else {
		res.writeHead(400, { "content-type": "application/json" });
		res.end(`{"error":"config request is not handled yet."}`);
	}
}


