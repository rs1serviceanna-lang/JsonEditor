//imports from this project
import {
	initialize_db
	, get_uuid
	, save_uuid
	, delete_uuid
} from "./db.mjs";

//imports from standard libraries
import { parse } from "url";

//imports from third party libraries

export function initialize_db_rest_api() {
	initialize_db();
}

export function handle_db_request(req, res) {
	if (req.headers[":path"] === undefined) {
		send_error(res, "request is not handled yet.");
		return;
	}
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

function send_error(res, msg) {
	res.writeHead(400, { "content-type": "application/json" });
	res.end(`{"error":"${msg}"}`);
}

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
	listened_uuids[id].splice(listened_uuids[id].indexOf(token), 1);
	if (listened_uuids[id].length === 0) {
		delete listened_uuids[id];
	}
	res.writeHead(200, { "content-type": "application/json" });
	res.end(`{"status":"success"}`);
}

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
	if (listened_uuids[id] === undefined) {
		listened_uuids[id] = [];
	}
	if (listened_uuids[id].indexOf(token) === -1) {
		listened_uuids[id].push(token);
		res.writeHead(200, { "content-type": "application/json" });
		res.end(`{"status":"success"}`);
	} else {
		send_error(res, `listener was already registered for this uuid`);
	}
}

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
		const range = req.headers["range"];
		const [start_byte, end_byte] = range ?
			range.slice(6).split("-").map(Number) : [0];
		const chunking = query_object.chunking !== "false";
		const get = get_uuid(query_object.id, start_byte, end_byte, chunking);
		assert(get.type === "full" || get.type === "partial", `get_uuid returned invalid type, ${get.type}`);
		assert(get.length !== undefined, `get_uuid did not return content length.`);
		if (get.type === "full") {
			res.setHeader("Content-Length", get.length);
			res.writeHead(200, { "content-type": get.mime });
		} else if (get.type === "partial") {
			res.setHeader("Content-Length", get.end_byte - start_byte + 1);
			res.setHeader("Content-Range", `bytes ${start_byte}-${get.end_byte}/${get.length}`);
			res.setHeader("Accept-Ranges", `bytes`);
			res.writeHead(206, { "content-type": get.mime });
		}
		get.data_stream.pipe(res);
		res.on("finish", () => {
			console.log("finish handling get request for " + query_object.id);
			res.end();
		});
		req.on("aborted", e => {
			get.data_stream.close();
			console.log("aborted request for " + query_object.id);
		})
	} catch (e) {
		send_error(res, e);
	}
}

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
	let save_type = req.headers[":path"].split("?")[0].split("/")[3];
	assert(save_type === "node" || save_type === "data", "received save request with invalid path");
	try {
		let content_type =
			req.headers["Metax-content-type"] !== undefined ?
				req.headers["Metax-content-type"] :
				req.headers["content-type"];
		const uuid = await save_uuid(
			req, content_type, save_type, query_object.id);
		send_notification_to_websocket_clients(uuid);
		assert(is_valid_uuid(uuid), "save_uuid returned invalid uuid");
		res.writeHead(200, { "content-type": "application/json" });
		res.end(`{"uuid": "${uuid}"}`);
	} catch (e) {
		send_error(res, e);
	}
}

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
                updateStatus('Disconnected - Reconnecting...', 'error');
                setTimeout(connect, 3000);
            };
        }
        
        connect();
    </script>
</body>
</html>`;

	res.writeHead(200, { "content-type": "text/html" });
	res.end(html);
}
