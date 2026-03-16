/*
================ db_rest_api.mjs - HTTP REST API Layer for DB ================

This file exposes the core key-value storage functions from db.mjs as an HTTP
REST API. It sits between the HTTP server (rest_api.mjs) and the underlying
storage layer (db.mjs), translating incoming HTTP requests into storage calls
and sending back appropriate JSON or streamed responses.

--- Supported Endpoints ---

  GET  /db/get                 - Retrieve stored file by UUID (streaming).
  POST /db/save/node           - Save a Node.js readable stream directly.
  POST /db/save/data           - Save a multipart/form-data upload.
  GET  /db/delete              - Delete a stored file and its contract.
  GET  /db/register_listener   - Subscribe a WebSocket session to a UUID.
  GET  /db/unregister_listener - Unsubscribe a WebSocket session from a UUID.
  GET  /db/live                - Serve a live JSON viewer HTML page.

--- Dependency on Globals ---

  Uses globals set in rest_api.mjs: is_valid_uuid, assert, wss_clients,
  listened_uuids, and send_notification_to_websocket_clients.

================================================================================
*/

// ====================== Imports from this project ============================

// Core DB primitives: init, read, save, delete.
import {
	initialize_db
	, get_uuid
	, save_uuid
	, delete_uuid
} from "./db.mjs";

// ====================== Imports from standard libraries ======================

// parse() extracts query parameters from URL strings.
// e.g. parse("/db/get?id=abc", true).query => { id: "abc" }
import { parse } from "url";

// ====================== Imports from third-party libraries ===================
// (None currently needed)

// ========================= Initialization ====================================

// Initializes the database storage directory. Must be called once at startup
// before any HTTP requests are handled. Delegates to db.mjs initialize_db().
export function initialize_db_rest_api() {
	initialize_db();
}

// ========================= Main Request Router ================================

// Routes all "/db/*" HTTP requests to the correct handler based on exact path.
//
// Parameters:
// - req: Incoming HTTP request object.
// - res: HTTP response object to write the result to.
//
// How it works:
// 1. Validates :path header presence.
// 2. Strips query string to get the clean path.
// 3. Asserts this is a /db/* request (sanity check).
// 4. Dispatches to the matching handler function.
export function handle_db_request(req, res) {
	if (req.headers[":path"] === undefined) {
		send_error(res, "request is not handled yet.");
		return;
	}
	// Remove query parameters to get the base path for routing.
	let req_path = req.headers[":path"].split("?")[0];
	assert(req_path.split("/")[1] === "db",
		"handle_db_request received non-db request");
	console.log(`handling db request`,
		`request path: ${req.headers[":path"]}`);
	switch (req_path) {
		case "/db/get":
			handle_get_request(req, res);
			break;
		case "/db/save/node":
		case "/db/save/data":
			// Both save types go to the same handler; type is read from the path.
			handle_save_request(req, res);
			break;
		case "/db/delete":
			handle_delete_request(req, res);
			break;
		case "/db/register_listener":
			handle_register_listener_request(req, res);
			break;
		case "/db/unregister_listener":
			handle_unregister_listener_request(req, res);
			break;
		case "/db/live":
			handle_live_view_request(req, res);
			break;
		default:
			send_error(res, "request is not handled yet.");
			break;
	}
}

// ========================= Error Helper ======================================

// Sends a 400 Bad Request response with a JSON error message.
// Used by all handlers to return errors in a consistent format.
//
// Parameters:
// - res: The HTTP response object.
// - msg: A human-readable error string.
function send_error(res, msg) {
	res.writeHead(400, { "content-type": "application/json" });
	res.end(`{"error":"${msg}"}`);
}

// ========================= Unregister Listener ================================

// Removes a WebSocket session token from the listener list for a UUID.
// After this, that session will no longer receive update notifications
// when the UUID's data is modified.
//
// Query parameters:
// - id:    The UUID to stop watching.
// - token: The WebSocket session token to remove.
//
// Validations: GET only, valid UUID, active WebSocket token, token must be registered.
function handle_unregister_listener_request(req, res) {
	console.log(`received unregister_listener request with path ${req.headers[":path"]}`);
	const query_object = parse(req.headers[":path"], true).query;
	if (req.method !== "GET") {
		send_error(res, `received /db/unregister_listener with request method ${req.method}`);
		return;
	}
	const { id, token } = query_object;
	if (!is_valid_uuid(id)) {
		send_error(res, `invalid uuid.`);
		return;
	}
	if (!is_valid_uuid(token)
		|| wss_clients[token] === undefined) {
		send_error(res, `session token not found.`);
		return;
	}
	if (listened_uuids[id] === undefined
		|| listened_uuids[id].indexOf(token) === -1) {
		send_error(res, `no listener register for ${id} in this session.`);
		return;
	}
	// Remove the token from the listener array for this UUID.
	listened_uuids[id].splice(listened_uuids[id].indexOf(token), 1);
	// Clean up the UUID entry entirely when no listeners remain.
	if (listened_uuids[id].length === 0) {
		delete listened_uuids[id];
	}
	res.writeHead(200, { "content-type": "application/json" });
	res.end(`{"status":"success"}`);
}

// ========================= Register Listener ==================================

// Registers a WebSocket session token as a listener for a UUID.
// Once registered, whenever that UUID is saved/updated, the session
// will receive a JSON "update" event over its WebSocket connection.
//
// Query parameters:
// - id:    The UUID to watch.
// - token: The WebSocket session token to register.
//
// Validations: GET only, valid UUID, active WebSocket token, no duplicate registrations.
function handle_register_listener_request(req, res) {
	console.log(`received register_listener request with path ${req.headers[":path"]}`);
	const query_object = parse(req.headers[":path"], true).query;
	if (req.method !== "GET") {
		send_error(res, `received /db/register_listener with request method ${req.method}`);
		return;
	}
	const { id, token } = query_object;
	if (!is_valid_uuid(id)) {
		send_error(res, `invalid uuid.`);
		return;
	}
	if (!is_valid_uuid(token)
		|| wss_clients[token] === undefined) {
		send_error(res, `session token not found.`);
		return;
	}
	// Initialize the listener array for this UUID if this is the first listener.
	if (listened_uuids[id] === undefined) {
		listened_uuids[id] = [];
	}
	if (listened_uuids[id].indexOf(token) === -1) {
		listened_uuids[id].push(token);
		res.writeHead(200, { "content-type": "application/json" });
		res.end(`{"status":"success"}`);
	} else {
		// Token is already registered; reject to prevent duplicates.
		send_error(res, `listener was already registered for this uuid`);
	}
}

// ========================= Get Handler ========================================

// Retrieves a stored file by UUID and streams it back to the client.
// Supports full file delivery (200) and partial content delivery (206)
// for video/audio seeking via HTTP Range requests.
//
// Query parameters:
// - id:       UUID of the file to retrieve.
// - chunking: (optional) Set to "false" to get the whole file at once.
//
// Headers used:
// - range: (optional) e.g. "bytes=0-2000000" for partial reads.
//
// How it works:
// 1. Validates method (GET) and UUID.
// 2. Parses the Range header if present.
// 3. Calls get_uuid() from db.mjs for stream + metadata.
// 4. Sends 200 (full) or 206 (partial) with correct headers.
// 5. Pipes the file stream to the response.
function handle_get_request(req, res) {
	console.log(`received get request with path ${req.headers[":path"]}`);
	const query_object = parse(req.headers[":path"], true).query;
	if (query_object.id !== undefined) {
		query_object.id = query_object.id.split("?")[0];
	}
	if (req.method !== "GET") {
		send_error(res, `received /db/get with request method ${req.method}`);
		return;
	}
	if (!is_valid_uuid(query_object.id)) {
		send_error(res, `invalid uuid.`);
		return;
	}
	try {
		// Parse the Range header to support partial content (video seeking).
		// Format: "bytes=<start>-<end>"
		const range = req.headers["range"];
		const [start_byte, end_byte] = range ?
			range.slice(6).split("-").map(Number) : [0];
		const chunking = query_object.chunking !== "false";
		const get = get_uuid(query_object.id, start_byte, end_byte, chunking);
		assert(get.type === "full" || get.type === "partial", `get_uuid returned invalid type, ${get.type}`);
		assert(get.length !== undefined, `get_uuid did not return content length.`);
		if (get.type === "full") {
			// Deliver the whole file.
			res.setHeader("Content-Length", get.length);
			res.writeHead(200, { "content-type": get.mime });
		} else if (get.type === "partial") {
			// Deliver a partial byte range (HTTP 206 Partial Content).
			res.setHeader("Content-Length", get.end_byte - start_byte + 1);
			res.setHeader("Content-Range", `bytes ${start_byte}-${get.end_byte}/${get.length}`);
			res.setHeader("Accept-Ranges", `bytes`);
			res.writeHead(206, { "content-type": get.mime });
		}
		// Stream the file data directly to the HTTP response.
		get.data_stream.pipe(res);
		res.on("finish", () => {
			console.log("finish handling get request for " + query_object.id);
			res.end();
		});
		// If client disconnects mid-stream, close the file stream to free resources.
		req.on("aborted", e => {
			get.data_stream.close();
			console.log("aborted request for " + query_object.id);
		})
	} catch (e) {
		send_error(res, e);
	}
}

// ========================= Save Handler =======================================

// Saves uploaded data to disk and returns the UUID of the saved file.
// Supports two upload modes:
//   - "node": Pipes the raw HTTP stream to disk (e.g., JSON or binary upload).
//   - "data": Strips multipart/form-data boundaries before writing.
//
// Query parameters:
// - id: (optional) If valid UUID, updates the existing file. Otherwise, creates new.
//
// Required headers:
// - content-type or Metax-content-type: MIME type of the uploaded data.
//
// How it works:
// 1. Validates POST method and content-type presence.
// 2. Extracts the save mode ("node" or "data") from the URL path.
// 3. Calls db.mjs save_uuid() to handle the async write.
// 4. Notifies WebSocket listeners that this UUID was updated.
async function handle_save_request(req, res) {
	console.log(`received save request with path ${req.headers[":path"]}`);
	const query_object = parse(req.headers[":path"], true).query;
	if (req.method !== "POST") {
		send_error(res, `received /db/save with request method ${req.method}`);
		return;
	}
	if (req.headers["content-type"] === undefined
		&& req.headers["Metax-Content-Type"] === undefined) {
		send_error(res, "content-type of body not specified in request.")
		return;
	}
	// Extract save type: 4th segment of "/db/save/<type>".
	let save_type = req.headers[":path"].split("?")[0].split("/")[3];
	assert(save_type === "node" || save_type === "data", "received save request with invalid path");
	try {
		// Prefer the Metax-specific content-type header when provided.
		let content_type =
			req.headers["Metax-content-type"] !== undefined ?
				req.headers["Metax-content-type"] :
				req.headers["content-type"];
		const uuid = await save_uuid(
			req, content_type, save_type, query_object.id);
		// Notify any WebSocket clients listening for updates to this UUID.
		send_notification_to_websocket_clients(uuid);
		assert(is_valid_uuid(uuid), "save_uuid returned invalid uuid");
		res.writeHead(200, { "content-type": "application/json" });
		res.end(`{"uuid": "${uuid}"}`);
	} catch (e) {
		send_error(res, e);
	}
}

// ========================= Delete Handler =====================================

// Deletes both the data file and the .contract metadata file for a given UUID.
//
// Query parameters:
// - id: The UUID of the file to delete.
//
// Validations: GET only, valid UUID.
//
// Response: 200 with { status, uuid } on success, 400 on error.
function handle_delete_request(req, res) {
	console.log(`received delete request with path ${req.headers[":path"]}`);
	const query_object = parse(req.headers[":path"], true).query;
	if (req.method !== "GET") {
		send_error(res, `received /db/delete with request method ${req.method}`);
		return;
	}
	if (!is_valid_uuid(query_object.id)) {
		send_error(res, `invalid uuid.`);
		return;
	}
	try {
		delete_uuid(query_object.id);
		res.writeHead(200, { "content-type": "application/json" });
		res.end(`{"status":"success", "uuid": "${query_object.id}"}`);
	} catch (err) {
		send_error(res, err);
	}
}

// ========================= Live View Handler ==================================

// Serves a self-contained HTML page that displays live-updating JSON for a UUID.
// The page connects via WebSocket, registers as a listener, and re-fetches
// the JSON data automatically whenever an "update" event is received.
// Useful for real-time debugging and monitoring.
//
// Query parameters:
// - id: The UUID to display live.
//
// Validations: GET only, valid UUID.
// Response: 200 OK with text/html content type.
function handle_live_view_request(req, res) {
	console.log(`received live view request with path ${req.headers[":path"]}`);
	const query_object = parse(req.headers[":path"], true).query;
	if (req.method !== "GET") {
		send_error(res, `received /db/live with request method ${req.method}`);
		return;
	}
	const id = query_object.id;
	if (!is_valid_uuid(id)) {
		send_error(res, `invalid uuid.`);
		return;
	}

	// Build a self-contained HTML page with the UUID embedded.
	// The inline JS handles WS connection, listener registration and data refresh.
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Metax Live View - ${id}</title>
    <style>
        body { font-family: 'Consolas', 'Monaco', monospace; padding: 20px; background: #f8f9fa; }
        pre { background: #fff; padding: 15px; border: 1px solid #eee; border-radius: 4px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); white-space: pre-wrap; word-wrap: break-word; }
        .success { color: #155724; background-color: #d4edda; padding: 5px; border-radius: 3px; display: inline-block; margin-bottom: 10px; }
        .error { color: #721c24; background-color: #f8d7da; padding: 5px; border-radius: 3px; display: inline-block; margin-bottom: 10px; }
    </style>
</head>
<body>
    <div id="status">Connecting...</div>
    <pre id="json-display">Loading...</pre>
    <script>
        const uuid = "${id}";
        const WS_URL = 'wss://' + window.location.host;
        const BASE_URL = 'https://' + window.location.host;
        let wsToken = '';
        let ws;

        function updateStatus(msg, type) {
            const el = document.getElementById('status');
            el.textContent = msg;
            el.className = type;
        }

        async function fetchData() {
            try {
                const response = await fetch(\`\${BASE_URL}/db/get?id=\${uuid}\`);
                if (!response.ok) throw new Error(response.statusText);
                const json = await response.json();
                document.getElementById('json-display').textContent = JSON.stringify(json, null, 2);
                updateStatus('Live Sync: Active', 'success');
            } catch (e) {
                updateStatus('Error: ' + e.message, 'error');
            }
        }

        async function registerListener() {
            if (!wsToken) return;
            await fetch(\`\${BASE_URL}/db/register_listener?id=\${uuid}&token=\${wsToken}\`);
        }

        function connect() {
            ws = new WebSocket(WS_URL);
            ws.onopen = () => updateStatus('Connected', 'success');
            ws.onmessage = (e) => {
                const data = JSON.parse(e.data);
                if (data.event === 'connected') {
                    wsToken = data.token;
                    registerListener();
                    fetchData(); // Initial load
                } else if (data.event === 'update' && data.uuid === uuid) {
                    fetchData();
                }
            };
            ws.onclose = () => {
                updateStatus('Disconnected - Reconnecting in 1s...', 'error');
                setTimeout(connect, 1000);
            };
            ws.onerror = () => {
                ws.close(); // Ensure onclose is triggered
            };
        }
        
        connect();
    </script>
</body>
</html>`;

	res.writeHead(200, { "content-type": "text/html" });
	res.end(html);
}
