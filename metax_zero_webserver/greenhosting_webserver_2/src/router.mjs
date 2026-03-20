/*
=================== router.mjs - Greenhosting WebServer Request Router =======

This module handles all incoming HTTP/2 stream requests for the greenhosting
webserver. It acts as a security gateway and proxy between external clients
(with mTLS certificates) and the local Metax backend.

--- Two Server Modes ---

  Write server (handle_new_write_server_stream):
	- Accepts all operations: GET, POST, save, delete, ODM, notify, translate.
	- Requires a valid client certificate (mTLS enforced).

  Read-only server (handle_new_read_only_stream):
	- Accepts only read operations: GET, register_listener, ODM reads, wrap.
	- Also requires a valid client certificate.

--- Security ---

  Every request is validated against the client's TLS certificate.
  Requests without a valid certificate fingerprint are rejected with 400.
  All sessions and streams are logged with the client's certificate CN.

--- Proxy Architecture ---

  For most requests, the router does NOT process data itself.
  Instead it proxies the request to the local Metax backend (metax_sessions):
  - Each session has a dedicated HTTP/2 connection to the local Metax server.
  - The router pipes the incoming stream to Metax and pipes the response back.
  - This allows the webserver to add mTLS authentication and audit logging
	on top of the existing Metax API without duplicating its logic.

--- WebSocket ---

  WebSocket connections are handled separately from HTTP/2 streams.
  Each connection gets a random UUID session token.
  Clients use this token to subscribe to UUID update events.
  A 30-second ping/pong keep-alive prevents silent disconnects.

--- Listener Tracking ---

  listened_uuids: Map of UUID -> [token, ...]
  wss_clients:    Map of token -> WebSocket connection
  When handle_metax_update_message(uuid) is called, all tokens registered
  for that UUID receive { event: "update", uuid } via WebSocket.

================================================================================
*/

//imports from this project
import { add_notifier } from "./notifier.mjs"
import { translate_property } from "./translator.mjs"
import { initialize_file_ops_logging, log_file_operation, extract_user_info } from "./file_ops_logger.mjs"

//imports from standard libraries
import { parse } from "url";
import { randomUUID } from "crypto";
import { connect } from "http2";
import { readFileSync } from "fs";

//imports from third party libraries

// ========================= Logging Aliases ===================================

// Short aliases for structured logger calls scoped to "router" module.
const trace = (m) => logger.console.log("router", m);
const warning = (m) => logger.warning("router", m);
const error = (m) => logger.error("router", m);

// ========================= State =============================================

// listened_uuids: Maps UUID -> [session_token, ...]
// Clients register here to receive WebSocket notifications on UUID updates.
const listened_uuids = {};

// wss_clients: Maps session_token (UUID) -> active WebSocket object.
// Used to push "update" events to the right client.
const wss_clients = {};

// metax_sessions: Maps session ID -> HTTP/2 connection to local Metax backend.
// Each client session has its own dedicated connection to Metax.
const metax_sessions = {};

// Auto-incrementing counter to give each session a unique numeric ID.
let session_id_counter = 1;

// ========================= Write Server Stream Handler =======================

// Handles all incoming HTTP/2 streams on the write server port.
// Enforces mTLS (rejects requests without a valid client certificate).
// Dispatches to the appropriate handler based on the :path header.
// Logs each new session's first stream with the client CN and protocol.
//
// Parameters:
// - stream:  The HTTP/2 ServerHttp2Stream object.
// - headers: The HTTP/2 request headers object.
export function handle_new_write_server_stream(stream, headers) {
	try {
		const clientCert = stream.session.socket.getPeerCertificate();
		if (!clientCert || !clientCert.fingerprint256) {
			warning(`rejecting request without client certificate from ${stream.session.socket.remoteAddress}`);
			send_method_error(stream, "request is unauthorized, please insert a valid client certificate.", headers[":method"]);
			return;
		}

		// AUDIT: Extract who connected (Client Certificate CN) 
		const clientCN = clientCert.subject ? clientCert.subject.CN : "Unknown CN";
		const protocol = stream.session.alpnProtocol || "HTTP/1.1";

		if (protocol !== "h2" && headers['upgrade'] !== 'websocket') {
			console.warn(`[AUDIT] Non-HTTP/2 request detected from ${clientCN} via ${protocol}`);
		}

		if (stream.session.first_stream === true) {
			sessions_log.write(`Session ${stream.session.id} from ${clientCN} (${stream.session.socket.remoteAddress}) : ${headers["user-agent"]} via ${protocol}\n`);
			delete stream.session.first_stream
		}
		if (headers[":path"] === undefined) {
			send_method_error(stream, "invalid path.", headers[":method"]);
			return;
		}
		const path = parse(headers[":path"], true).pathname;
		console.log(`received new secure request: ${stream.session.id} path: ${path}`);
		switch (path) {
			case "/db/get":
				handle_get_request(stream, headers);
				break;
			case "/db/save/data":
			case "/db/save/node":
				handle_save_request(stream, headers);
				break;
			case "/db/register_listener":
				handle_register_listener_request(stream, headers);
				break;
			case "/db/unregister_listener":
				handle_unregister_listener_request(stream, headers);
				break;
			case "/db/delete":
				handle_delete_request(stream, headers);
				break;
			case "/config/get_user_id":
				handle_get_user_id_request(stream, headers);
				break;
			case "/notify":
				handle_notify_request(stream, headers);
				break;
			case "/translate_property":
				handle_translation_request(stream, headers);
				break;
			case "/oo/wrap":
			case "/oo/get_property":
			case "/oo/set_property":
			case "/oo/get_property/embedded":
			case "/oo/set_property/embedded":
			case "/oo/get_collection":
			case "/oo/add_element_to_collection":
			case "/oo/create_element_in_collection":
			case "/oo/create_element_in_collection/embedded":
			case "/oo/delete_element_from_collection":
			case "/oo/delete_element_from_collection/embedded":
			case "/oo/delete_element_from_embedded_collection":
			case "/oo/create_element_in_embedded_collection":
				handle_odm_request(stream, headers);
				break;
			default:
				handle_default_request(stream, headers);
				break;
		}
		stream.on("error", err => error(err));
	} catch (e) {
		error("error in handle_new_write_server_stream " + e);
	}
}

// ========================= Read-Only Server Stream Handler ===================

// Handles incoming HTTP/2 streams on the read-only server port.
// Also enforces mTLS (rejects requests without a valid client certificate).
// Only allows read operations (GET, register_listener, ODM reads, wrap).
// HEAD requests are rejected immediately.
//
// Parameters:
// - stream:  The HTTP/2 ServerHttp2Stream object.
// - headers: The HTTP/2 request headers object.
export function handle_new_read_only_stream(stream, headers) {
	try {
		const clientCert = stream.session.socket.getPeerCertificate();
		const clientCN = clientCert && clientCert.subject ? clientCert.subject.CN : "Anonymous";
		const protocol = stream.session.alpnProtocol || "HTTP/1.1";

		if (protocol !== "h2" && headers['upgrade'] !== 'websocket') {
			console.warn(`[AUDIT] Non-HTTP/2 read request detected from ${clientCN} via ${protocol}`);
		}

		if (headers[":method"] === "HEAD") {
			send_method_error(stream, null, headers[":method"]);
			return;
		}
		if (headers[":path"] === undefined) {
			send_error(stream, "invalid path.");
			return;
		}
		const path = parse(headers[":path"], true).pathname;
		console.log(`received new stream from ${stream.session.id}, path: ${path}`);
		switch (path) {
			case "/db/get":
				handle_get_request(stream, headers);
				break;
			case "/db/register_listener":
				handle_register_listener_request(stream, headers);
				break;
			case "/config/request_permission":
				handle_request_permission_request(stream, headers);
				break;
			case "/oo/wrap":
			case "/oo/get_property":
			case "/oo/get_collection":
				handle_odm_request(stream, headers);
				break;
			default:
				handle_default_request(stream, headers);
				break;
		}
	} catch (e) {
		error("error in handle_new_read_only_stream " + e);
	}
}

// ========================= Session Lifecycle =================================

// Called when a new client TLS session is established.
// Assigns a numeric session ID and opens a dedicated HTTP/2 connection
// to the local Metax backend for this session.
//
// Connection to Metax uses mutual TLS if client_key, client_cert, and ca
// are configured; otherwise falls back to rejectUnauthorized: false.
//
// The Metax connection is stored in metax_sessions[session.id] and is
// closed automatically when the client session closes.
// Sessions have a 120-second idle timeout.
//
// Parameters:
// - session: The HTTP/2 session object from the "session" event.
export function handle_new_client_session(session) {
	session.id = session_id_counter++;
	session.first_stream = true;
	sessions_log.write("new session: " + session.socket.remoteAddress + "  , session id: " + session.id +
		"  , fingerprint: " + session.socket.getPeerCertificate().fingerprint256 + "\n");
	console.log("new session with id: " + session.id +
		"  , fingerprint: " + session.socket.getPeerCertificate().fingerprint256);
	// Create secure connection to metax with client certificate
	let metaxOptions = {};
	try {
		if (config.client_key && config.client_cert && config.ca) {
			metaxOptions = {
				key: readFileSync(config.client_key),
				cert: readFileSync(config.client_cert),
				ca: readFileSync(config.ca),
				rejectUnauthorized: true
			};
		} else {
			metaxOptions = { rejectUnauthorized: false };
			console.log("WARNING: Session metax connection without client certificate");
		}
	} catch (e) {
		error(`Failed to load TLS certs for session: ${e}`);
		metaxOptions = { rejectUnauthorized: false };
	}

	metax_sessions[session.id] = connect(`https://${config.host_metax}`, metaxOptions);
	session.on("close", () => {
		if (metax_sessions[session.id] &&
			metax_sessions[session.id].destroyed === false) {
			metax_sessions[session.id].close();
			delete metax_sessions[session.id];
		}
	});
	session.on("error", e => {
		error(`session error: ${e}`);
	});
	metax_sessions[session.id].on("error", (e) => {
		error(`metax error: ${e}`);
	});
	metax_sessions[session.id].on("close", (e) => {
		delete metax_sessions[session.id];
		if (session.destroyed === false) {
			session.close();
		}
	});
	session.setTimeout(120000);
	session.on('timeout', () => session.close());
}

// ========================= Listener Re-Registration =========================

// Re-registers all currently active UUID listeners with the Metax backend.
// Called after the WebSocket connection to Metax is reconnected, so that
// notifications for all tracked UUIDs resume correctly.
export async function re_register_proxied_listeners() {
	console.log("re-registering all proxied metax listeners.");
	const uuids = Object.keys(listened_uuids);
	for (let i = 0; i < uuids.length; i++) {
		try {
			await metax_register_listener(uuids[i]);
		} catch (e) {
			error(`failed to re-register listener for ${uuids[i]}: ${e}`);
		}
	}
}

// Forces an "update" WebSocket notification to be sent to all clients
// for every UUID that has at least one registered listener.
// Called after a Metax reconnection to ensure clients refresh their data.
export function trigger_all_client_updates() {
	console.log("triggering updates for all listened uuids.");
	const uuids = Object.keys(listened_uuids);
	for (let i = 0; i < uuids.length; i++) {
		handle_metax_update_message(uuids[i]);
	}
}

// Sends a WebSocket "update" event to all clients registered as listeners
// for the given UUID. Called when Metax signals that a UUID was modified.
//
// Parameters:
// - uuid: The UUID whose data was updated.
export function handle_metax_update_message(uuid) {
	assert(is_valid_uuid(uuid), "handle_metax_update_message received invalid uuid.");
	console.log("received handle_metax_update_message with uuid: " + uuid)
	if (listened_uuids[uuid] !== undefined) {
		for (let i = 0; i < listened_uuids[uuid].length; i++) {
			let token = listened_uuids[uuid][i];
			assert(wss_clients[token] !== undefined,
				"listened_uuids has token in list, but websocket object not found.");
			console.log("sending update_message for uuid: " + uuid + " to token: " + token);
			wss_clients[token].send(JSON.stringify({ event: "update", uuid }))
		}
	}
}

// ========================= WebSocket Connection Handler =====================

// Called when a new WebSocket client connects.
// Assigns a random UUID token and sends it to the client as:
//   { event: "connected", token: "<uuid>" }
// Sets up a 30-second ping/pong keep-alive to detect silent disconnects.
// On close: removes the client from wss_clients and cleans up all listener
// registrations to prevent memory leaks and stale notification targets.
//
// Parameters:
// - s: The WebSocket connection object.
export function handle_websocket_new_connection(s) {
	const token = randomUUID();
	wss_clients[token] = s;
	s.send(`{"event":"connected", "token": "${token}"}`);
	s.on("pong", () => s.isAlive = true);
	const send_ping = setInterval(() => {
		if (s.isAlive === false) {
			return s.terminate()
		};
		s.isAlive = false;
		s.ping();
	}, 30000);
	s.on("close", () => {
		console.log(`received websocket close event for session: ${token}`);
		assert(wss_clients[token] !== undefined,
			"websocket connection was closed improperly");
		clearInterval(send_ping);
		delete wss_clients[token];
		clean_up_listened_uuids_per_token(token);
	});
}

// Removes a session token from all UUID listener lists.
// Called when a WebSocket session closes to prevent sending
// notifications to dead sessions.
//
// Parameters:
// - token: The UUID session token of the disconnected client.
function clean_up_listened_uuids_per_token(token) {
	const uuids = Object.keys(listened_uuids);
	for (let i = 0; i < uuids.length; i++) {
		let token_index = listened_uuids[uuids[i]].indexOf(token);
		if (token_index !== -1) {
			listened_uuids[uuids[i]].splice(token_index, 1);
		}
	}
}

// ========================= Request Handlers ==================================

// Returns the user_id for the requesting client based on their client certificate.
// Searches the sitemap to find which website and which client certificate
// the request belongs to, then returns the associated user_id.
// Returns { user_id: "anonymous" } if no certificate is presented.
//
// Parameters:
// - stream:  The HTTP/2 stream object.
// - headers: Request headers including :authority for subdomain lookup.
function handle_get_user_id_request(stream, headers) {
	console.log(`processing get_user_id request with path ${headers[":path"]}`);
	try {
		if (headers[":method"] !== "GET") {
			send_method_error(stream, `received /config/get_user_id request with method ${headers[":method"]}`, headers[":method"]);
			return;
		}
		const authority = headers[":authority"] ? headers[":authority"].split(":")[0] : "";
		let i = sitemap.websites.findIndex(website => {
			let index = website.subdomains.findIndex(el => el.name === authority)
			return index !== -1;
		});
		if (i === -1) {
			console.log(`No website found in sitemap for authority: ${authority}`);
			send_error(stream, "couln't find user");
			return
		}

		const cert = stream.session.socket.getPeerCertificate();
		if (!cert || !cert.raw) {
			// Anonymous user (no certificate)
			stream.respond({
				":status": 200,
				"content-type": "application/json"
			});
			stream.end(JSON.stringify({ "user_id": "anonymous" }));
			return;
		}

		let client_key = cert.raw.toString('base64');
		let j = sitemap.websites[i].client_certificates.findIndex(el =>
			el["certificate"]
				.replace(/[\r\n]/gm, '')
				.replace(/[\n]/gm, '')
				.includes(client_key));
		if (j !== -1) {
			stream.respond({
				":status": 200,
				"content-type": "application/json"
			});
			let user_id = sitemap.websites[i].client_certificates[j]["user_id"];
			stream.end(JSON.stringify({ "user_id": user_id || "no defined yet" }));
		} else {
			send_error(stream, "couln't find user");
		}
	} catch (e) {
		error(e);
		send_error(stream, "cannot get user");
	}
}

// Handles a permission request from a new client.
// Saves the client's certificate to Metax storage and adds an entry
// to the sitemap's permission_requests list for admin review.
// Only available on the read-only server.
//
// Parameters:
// - stream:  The HTTP/2 stream object.
// - headers: Request headers; body must be the PEM certificate content.
function handle_request_permission_request(stream, headers) {
	console.log(`processing request_permission request with path ${headers[":path"]}`);
	if (headers[":method"] !== "POST") {
		send_method_error(stream, `received /config/request_permission request with method ${headers[":method"]}`, headers[":method"]);
		return;
	}
	if (!sitemap.permission_requests) {
		send_error(stream, `requesting permission isn't allowed`);
		return
	}
	const { name, website } = parse(headers[":path"], true).query;
	let data = "";
	if (!website) {
		send_error(stream, `no website specified`);
		return
	}
	const save_request = metax_sessions[stream.session.id].request({
		":path": `/db/save/node`,
		":method": "POST",
		"content-type": "application/x-x509-ca-cert"
	}).on("data", c => data += c)
		.on("error", err => {
			error("error when saving certificate: " + err);
			send_error(stream, "failed to save certificate");
		}).on("end", async () => {
			try {
				data = JSON.parse(data);
				if (!data.uuid) {
					error("error when saving certificate: " + data.error);
					send_error(stream, "failed to save certificate");
					return
				}
			} catch (e) {
				error("error when parsing save certificate response: " + e);
				send_error(stream, "failed to save certificate");
			}
			sitemap.permission_requests.requests.push({
				name: name,
				website: website,
				certificate: {
					name: "certificate.pem",
					file: data.uuid
				}
			});
			try {
				await metax_update(sitemap.permission_requests.uuid,
					JSON.stringify(sitemap.permission_requests),
					"application/json");
			} catch {
				send_error(stream, "failed to add permission request");
				error("failed to update permission requests " + e);
				return
			}
			stream.respond({
				":status": 200,
				"content-type": "application/json"
			});
			stream.end(`{"status":"success"}`);
			console.log(`end processing request_permission request with path ${headers[":path"]}`);
		});
	stream.pipe(save_request);
}

// Unregisters a WebSocket session token as a listener for a UUID.
// After this, the session will no longer receive "update" events for the UUID.
// Also calls metax_unregister_listener to stop listening on the Metax backend.
//
// Query parameters: id (UUID), token (session token).
async function handle_unregister_listener_request(stream, headers) {
	console.log(`processing unregister_listener request with path ${headers[":path"]}`);
	const { id, token } = parse(headers[":path"], true).query;
	if (headers[":method"] !== "GET") {
		send_method_error(stream, `received /db/unregister_listener with request method ${headers[":method"]}`, headers[":method"]);
		return;
	}
	if (!is_valid_uuid(id)) {
		send_error(stream, `invalid uuid.`);
		return;
	}
	if (!is_valid_uuid(token)
		|| wss_clients[token] === undefined) {
		send_error(stream, `session token not found.`);
		return;
	}
	if (listened_uuids[id] === undefined
		|| listened_uuids[id].indexOf(token) === -1) {
		send_error(stream, `no listener register for ${id} in this session.`);
		return;
	}
	listened_uuids[id].splice(listened_uuids[id].indexOf(token), 1);
	if (listened_uuids[id].length === 0) {
		delete listened_uuids[id];
	}
	metax_unregister_listener(id)
		.then(r => JSON.parse(r))
		.then(r => {
			if (r.status !== "success") {
				error("failed to unregister_listener");
				send_error(stream, "failed to unregister_listener");
				return;
			}
			stream.respond({
				":status": 200,
				"content-type": "application/json"
			});
			stream.end(`{"status":"success"}`);
		})
		.catch(e => {
			error("error in unregister listener: " + e);
			send_error(stream, e);
		});
}

// Registers a WebSocket session token as a listener for a UUID.
// On successful registration, calls metax_register_listener to also
// subscribe on the Metax backend so update events flow through.
//
// Query parameters: id (UUID), token (session token).
async function handle_register_listener_request(stream, headers) {
	console.log(`processing register_listener request with path ${headers[":path"]}`);
	const { id, token } = parse(headers[":path"], true).query;
	if (headers[":method"] !== "GET") {
		send_method_error(stream, `received /db/register_listener with request method ${headers[":method"]}`, headers[":method"]);
		return;
	}
	if (!is_valid_uuid(id)) {
		send_error(stream, `invalid uuid.`);
		return;
	}
	if (!is_valid_uuid(token)
		|| wss_clients[token] === undefined) {
		send_error(stream, `session token not found.`);
		return;
	}
	metax_register_listener(id)
		.then(r => JSON.parse(r))
		.then(r => {
			if (r.status !== "success") {
				send_error(stream, "failed to register_listener");
				return;
			}
			add_uuid_in_listened_uuids(id, token, stream);
		})
		.catch(e => {
			if (e.toString().includes(`listener was already registered`)) {
				return add_uuid_in_listened_uuids(id, token, stream);
			}
			error(e);
			send_error(stream, e);
		});
}

// Adds a token to the listener list for a UUID and responds to the client.
// Prevents duplicate registrations. Sends 400 if already registered.
//
// Parameters:
// - id:     The UUID to watch.
// - token:  The session token to register.
// - stream: The HTTP/2 stream to respond on.
function add_uuid_in_listened_uuids(id, token, stream) {
	if (listened_uuids[id] === undefined) {
		listened_uuids[id] = [];
	}
	if (listened_uuids[id].indexOf(token) === -1) {
		listened_uuids[id].push(token);
		stream.respond({
			":status": 200,
			"content-type": "application/json"
		});
		stream.end(`{"status":"success"}`);
	} else {
		send_error(stream, `listener was already registered for this uuid`);
	}
}

// Proxies a /db/save request to the Metax backend.
// Validates the request method (POST), extracts user info for audit logging,
// then pipes the incoming stream to the Metax backend and the response back.
// Logs the write operation after completion via log_file_operation().
//
// Parameters:
// - stream:  The HTTP/2 stream (incoming data body is piped from this).
// - headers: Request headers forwarded to Metax.
function handle_save_request(stream, headers) {
	console.log(`processing /db/save request with path ${headers[":path"]}`);
	// Extract user info for logging
	const user_info_save = extract_user_info(stream.session);
	const cert_save = stream.session.socket?.getPeerCertificate();
	const user_id_save = cert_save?.subject?.CN || 'anonymous';
	if (headers[":method"] !== "POST") {
		send_method_error(stream, `received /db/save with request method ${headers[":method"]}`, headers[":method"]);
		return;
	}
	const query_object = parse(headers[":path"], true).query;
	const save_request = metax_sessions[stream.session.id].request(headers)
		.on("response", respHeaders => {
			try {
				stream.respond(respHeaders);
				save_request.pipe(stream);
			} catch (e) {
				error(e);
			}
		}).on("error", err => {
			send_error(stream, "save request failed");
			error("error in save request: " + err);
		}).on("end", () => {
			save_request.close();
			stream.end();
			// Log write operation
			log_file_operation({
				operation: 'write',
				uuid: query_object.id || 'new',
				user_id: user_id_save,
				session_id: stream.session.id,
				ip_address: user_info_save.remote_address,
				fingerprint: user_info_save.fingerprint,
				mime_type: headers['content-type'] || '',
				additional: { path: headers[':path'] }
			});
			console.log(`finished /db/save request for ${query_object.id}`);
		});
	stream.pipe(save_request);
}

// Proxies an /oo/* ODM request to the Metax backend.
// Accepts GET and POST methods. For POST, pipes the incoming stream body.
// Pipes the Metax response back to the client.
//
// Parameters:
// - stream:  The HTTP/2 stream.
// - headers: Request headers forwarded to Metax.
function handle_odm_request(stream, headers) {
	console.log(`processing odm request with path ${headers[":path"]}.`);
	if (headers[":method"] !== "GET" && headers[":method"] !== "POST") {
		send_method_error(stream, `received /oo request with method ${headers[":method"]}`, headers[":method"]);
		return;
	}
	const odm_request = metax_sessions[stream.session.id].request(headers)
		.on("response", respHeaders => {
			try {
				stream.respond(respHeaders);
				odm_request.pipe(stream);
			} catch (e) {
				error(e);
			}
		}).on("error", err => {
			send_error(stream, "odm request failed");
			error("odm request error: " + err);
		}).on("end", () => {
			odm_request.close();
			stream.end();
			console.log(`finished odm request with path ${headers[":path"]}.`);
		});
	if (headers[":method"] === "POST") {
		stream.pipe(odm_request);
	}
}

// Proxies a /db/delete request to the Metax backend.
// Validates the request method (GET) and UUID.
// Logs the delete operation after completion via log_file_operation().
//
// Parameters:
// - stream:  The HTTP/2 stream.
// - headers: Request headers including the UUID in the query string.
function handle_delete_request(stream, headers) {
	const query_object = parse(headers[":path"], true).query;
	if (headers[":method"] !== "GET") {
		send_method_error(stream, `received /db/delete with request method ${headers[":method"]}`, headers[":method"]);
		return;
	}
	if (query_object.id !== undefined) {
		query_object.id = query_object.id.split("?")[0];
	}
	if (is_valid_uuid(query_object.id)) {
		console.log(`processing /db/delete for ${query_object.id}`);
		// Extract user info for logging
		const user_info_del = extract_user_info(stream.session);
		const cert_del = stream.session.socket?.getPeerCertificate();
		const user_id_del = cert_del?.subject?.CN || 'anonymous';
		const get_request = metax_sessions[stream.session.id].request(headers)
			.on("response", respHeaders => {
				try {
					stream.respond(respHeaders);
					get_request.pipe(stream);
				} catch (e) {
					error(e);
				}
			})
			.on("error", err => {
				error(err);
			})
			.on("end", () => {
				get_request.close();
				stream.end();
				// Log delete operation
				log_file_operation({
					operation: 'delete',
					uuid: query_object.id,
					user_id: user_id_del,
					session_id: stream.session.id,
					ip_address: user_info_del.remote_address,
					fingerprint: user_info_del.fingerprint
				});
				console.log(`finished /db/delete for ${query_object.id}`);
			});
		stream.on("close", () => get_request.close())
	} else {
		send_error(stream, "invalid uuid.");
	}
}

// Proxies a /db/get request to the Metax backend.
// Validates the request method (GET) and UUID.
// Logs the read operation after completion via log_file_operation().
// Handles "aborted" events to close resources cleanly.
//
// Parameters:
// - stream:  The HTTP/2 stream; response is piped from Metax into this.
// - headers: Request headers including UUID and optional Range header.
function handle_get_request(stream, headers) {
	const query_object = parse(headers[":path"], true).query;
	if (headers[":method"] !== "GET") {
		send_method_error(stream, `received /db/get with request method ${headers[":method"]}`, headers[":method"]);
		return;
	}
	if (query_object.id !== undefined) {
		query_object.id = query_object.id.split("?")[0];
	}
	if (!is_valid_uuid(query_object.id)) {
		send_error(stream, "invalid uuid.");
		return
	}
	console.log(`processing /db/get for ${query_object.id}`);
	// Extract user info for logging
	const user_info_get = extract_user_info(stream.session);
	const cert_get = stream.session.socket?.getPeerCertificate();
	const user_id_get = cert_get?.subject?.CN || 'anonymous';
	const get_request = metax_sessions[stream.session.id].request(headers)
		.on("response", respHeaders => {
			try {
				stream.respond(respHeaders);
				get_request.pipe(stream);
				// Log read operation
				log_file_operation({
					operation: 'read',
					uuid: query_object.id,
					user_id: user_id_get,
					session_id: stream.session.id,
					ip_address: user_info_get.remote_address,
					fingerprint: user_info_get.fingerprint,
					mime_type: respHeaders['content-type'] || '',
					additional: { status: respHeaders[':status'], user_agent: headers['user-agent'] }
				});
			} catch (e) {
				error("error when piping get " + e);
			}
		}).on("end", () => {
			get_request.close();
			stream.end();
			console.log(`finished /db/get for ${query_object.id}`);
		}).on("error", err => {
			stream.end()
			error(err);
		})
	stream.on("aborted", () => {
		get_request.close();
		stream.end();
		console.log(`stream aborted for ${query_object.id}`);
	})
}

// Handles requests that don't match any specific route.
// If the path starts with /db/, delegates to handle_get_request.
// Otherwise, searches the sitemap for a matching subdomain and path,
// then proxies a /db/get request to serve the configured destination UUID.
// Returns 400 if no matching path is found in the sitemap.
function handle_default_request(stream, headers) {
	const authority = headers[":authority"] ? headers[":authority"].split(":")[0] : "";
	const req_path = parse(headers[":path"], true).pathname;
	console.log("received default request from " + authority + " with path " + req_path);

	// Եթե path-ը արդեն /db/get կամ /db/save, ուղիղ մատուցել
	if (req_path.startsWith("/db/")) {
		handle_get_request(stream, headers);  // եթե GET է
		return;
	}

	// Երկար առաջի fallback (sitemap) մնացակա
	for (let i = 0; i < sitemap.websites.length; i++) {
		const subdomain = sitemap.websites[i].subdomains.find(s => s.name === authority);
		if (!subdomain || !subdomain.paths) continue;

		const path = subdomain.paths.find(p => p.name === req_path);
		if (!path || !is_valid_uuid(path.destination_uuid)) {
			continue; // Check other websites/subdomains if current one doesn't have the path
		}
		const req_headers = { ":path": `/db/get?id=${path.destination_uuid}` };
		console.log("piping default request with path " + req_path);
		const get_request = metax_sessions[stream.session.id].request(req_headers)
			.on("response", respHeaders => {
				if (!stream.destroyed) {
					stream.respond(respHeaders);
					get_request.pipe(stream);
				}
			}).on("error", err => {
				error(err);
				send_error(stream, "request not handled yet.");
			}).on("end", () => {
				get_request.close();
				stream.end();
				console.log(`finished handle default request`);
			});
		return;
	}
	console.log("skipping default request with path " + req_path);
	send_error(stream, "request not handled yet.");
}


// Handles /notify requests that trigger email notifications to object watchers.
// Validates the request method (POST) and UUID.
// Parses the JSON request body for the change descriptor and type.
// Calls add_notifier() which debounces and eventually sends the email.
//
// Body format: { id: <target_uuid>, type: "property"|"collection_add"|"collection_delete", ... }
function handle_notify_request(stream, headers) {
	const query_object = parse(headers[":path"], true).query;
	if (headers[":method"] !== "POST") {
		send_method_error(stream, `received /notify with request method ${headers[":method"]}`, headers[":method"]);
		return;
	}
	if (query_object.id !== undefined) {
		query_object.id = query_object.id.split("?")[0];
	}
	if (!is_valid_uuid(query_object.id)) {
		send_error(stream, "invalid uuid.");
		return
	}
	console.log(`processing /notify for ${query_object.id}`);
	let body = "";
	stream.on("data", (c) => {
		body += c;
	})
	stream.on("end", async () => {
		try {
			body = JSON.parse(body);
			if (!body.id) {
				throw "no id specified"
			}
			const acceptable_types = ["property", "collection_add", "collection_delete"];
			if (!body.type || !acceptable_types.includes(body.type)) {
				throw "invalid notify type"
			}
			await add_notifier(
				query_object.id,
				stream.session.socket.getPeerCertificate(),
				body,
				headers
			)
			stream.respond({
				":status": 200,
				"content-type": "application/json"
			});
			stream.write(`{"status":"success"}`);
			stream.end();
		} catch (e) {
			send_error(stream, e);
			error("notify failed " + e);
		}
	})
}

// Handles /translate_property requests that use OpenAI to translate a property.
// Validates the request method (GET) and retrieves the API key from the sitemap.
// Calls translate_property() from translator.mjs and returns the translated value.
//
// Query parameters: id (object UUID), property (field name), locale (target locale).
async function handle_translation_request(stream, headers) {
	const query_object = parse(headers[":path"], true).query;
	if (headers[":method"] !== "GET") {
		send_method_error(stream, `received /translate_property request with method ${headers[":method"]}`, headers[":method"]);
		return;
	}
	const { id, property, locale } = query_object;
	const website_name = headers[":authority"].split(":")[0];
	const api_key = find_website_in_sitemap(website_name).openai_api_key;
	console.log(`processing /translate_property request for property ${property} in ${id}`);
	try {
		const response = await translate_property(id, property, locale, api_key);
		stream.respond({
			":status": 200,
			"content-type": "application/json"
		});
		stream.write(JSON.stringify({ value: response }));
		stream.end();
		console.log(`finished /translate_property request for property ${property} in ${id}`);
	} catch (e) {
		send_error(stream, e);
		error(`failed to translate property ${property} in ${id}, ${e}`);
	}
}

// ========================= Sitemap Helpers ===================================

// Finds and returns the website object in the sitemap that owns a given subdomain name.
// Returns undefined if no matching website is found.
//
// Parameters:
// - subdomain: The subdomain/authority string to search for.
function find_website_in_sitemap(subdomain) {
	for (let i = 0; i < sitemap.websites.length; i++) {
		const sd = sitemap.websites[i].subdomains.find(d => d.name === subdomain);
		if (sd) return sitemap.websites[i];
	}
}

// ========================= Error Helpers =====================================

// Sends an error response, handling HEAD requests specially.
// HEAD requests must not include a body, so only status and content-type are sent.
// All other methods use send_error() for a full JSON error body.
//
// Parameters:
// - res:    The HTTP/2 stream to respond on.
// - msg:    The error message text.
// - method: The HTTP method of the original request.
function send_method_error(res, msg, method) {
	if (method === "HEAD") {
		res.respond({
			":status": 400
			, "content-type": "plain/text"
		});
		res.end();
	} else {
		send_error(res, msg);
	}
}

// Sends a 400 Bad Request response with a JSON error body.
// Used consistently by all handlers for error responses.
//
// Parameters:
// - res: The HTTP/2 stream to respond on.
// - msg: The error message (will be JSON-serialized).
function send_error(res, msg) {
	res.respond({
		":status": 400
		, "content-type": "application/json"
	});
	res.write(JSON.stringify({ error: msg }));
	res.end();
}
