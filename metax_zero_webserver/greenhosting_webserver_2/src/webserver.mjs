/*
==================== webserver.mjs - Greenhosting WebServer Entry Point =======

This is the main application file for the greenhosting webserver. It:

  1. Configures the structured logger and file operations audit logger.
  2. Reads configuration from command-line arguments.
  3. Loads the sitemap (website/subdomain/certificate metadata) from Metax.
  4. Connects to the local Metax backend (HTTP/2 + WebSocket).
  5. Starts the read-only HTTPS server (public-facing).
  6. Starts the write HTTPS server (authenticated writes only).
  7. Attaches a WebSocket server for real-time client updates.

--- Dual Server Architecture ---

  Write server (port: config.port):
    - Handles create/update/delete operations.
    - Requires valid client TLS certificate (mTLS).
    - Delegates to handle_new_write_server_stream in router.mjs.

  Read-only server (port: config.port_read_only):
    - Handles public read requests and permission requests.
    - Also requires a client TLS certificate.
    - Delegates to handle_new_read_only_stream in router.mjs.

--- Connection to Metax ---

  The webserver connects to the local Metax process (metax_2) using HTTP/2
  with optional mTLS. A WebSocket connection to Metax is also maintained for
  receiving real-time UUID update events (then forwarded to browser clients).

  If either connection drops, the webserver reconnects automatically after a
  short delay, re-registers all UUID listeners, and triggers client updates.

--- Configuration (command-line key=value pairs) ---

  port=<number>            Write server port.
  port_read_only=<number>  Read-only server port.
  key=<path>               Server TLS private key.
  cert=<path>              Server TLS certificate.
  ca=<path>                CA certificate for mTLS verification.
  client_key=<path>        Client TLS key for connecting to Metax.
  client_cert=<path>       Client TLS cert for connecting to Metax.
  host_metax=<host:port>   Host and port of the local Metax backend.
  sitemap_uuid=<uuid>      UUID of the sitemap object in Metax.

--- Sitemap ---

  The sitemap is a JSON object in Metax that maps websites to:
  - Subdomains served by this webserver.
  - Client certificates authorized to connect.
  - TLS key/certificate paths per subdomain (SNI).
  - Service configurations (mail, API keys, etc.).
  - A list of website UUIDs to preload on startup.

================================================================================
*/

//imports from this project
import logger from "./logger.mjs";
import {
        handle_new_write_server_stream
        , handle_new_read_only_stream
        , handle_metax_update_message
        , handle_new_client_session
        , handle_websocket_new_connection
        , re_register_proxied_listeners
        , trigger_all_client_updates
} from "./router.mjs";
import { init_notifier_transporters } from "./notifier.mjs";
import { initialize_file_ops_logging } from "./file_ops_logger.mjs";

//imports from standard libraries
import {
        createSecureServer
        , connect
} from "http2";
import { readFileSync, createWriteStream } from "fs";
import { createSecureContext } from "tls";

//imports from third party libraries
import { WebSocketServer, WebSocket } from "ws";

process.on('uncaughtException', (err) => {
        console.log(Date.now(), "Uncaught exception", err);
});

// ========================= Path Resolution ===================================

// Resolve the absolute path to this module's directory.
// Used to compute paths relative to the project root (e.g., log directories).
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// ROOT_DIR points two levels up from /src/ to the project root.
const ROOT_DIR = join(__dirname, '../../');

// ========================= Global State ======================================

// Runtime configuration populated from command-line args.
const config = {};
// Logger options: enable both console and file output with 10 MB rotation.
const logger_options = {
        file_channel: {
                usage: true,
                rotation: 10,  // Max log file size in MB before rotation.
                path: join(ROOT_DIR, "logs/webserver/greenhosting_webserver.log")
        },
        console_channel: { usage: true },
        pattern: "%p %Y-%m-%d %H:%M:%S.%i %s: %t"
};

// sessions_log: Write stream for logging session-level connection events.
// Appended to across restarts so session history is preserved.
global.sessions_log = createWriteStream(join(ROOT_DIR, "logs/webserver_session.log"),
        { 'flags': 'a', 'encoding': "utf8" });

// website_uuids: List of website UUIDs preloaded from the sitemap at startup.
const website_uuids = [];
// sitemap: Global sitemap object loaded from Metax. Used by router and notifier.
global.sitemap = {};
// config is exposed globally so all modules can access it.
global.config = config;
// assert: Global assertion helper. Logs the error and exits if condition is false.
// Used throughout all modules to enforce invariants.
global.assert = (c, m) => {
        if (!c) {
                error("Assertion violation: " + m);
                process.exit(-1);
        }
};
// is_valid_uuid: Global UUID format validator shared by all modules.
// Accepts both standard UUIDs and the double-UUID format used by db.mjs.
global.is_valid_uuid = (u) => {
        if (typeof u !== 'string') return false;
        return /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(u) ||
                /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}-[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(u);
};

// http_get: Global helper for making GET requests to the local Metax backend.
// Used by notifier.mjs (get_property) and other modules that need Metax data.
// Relies on the global `metax` HTTP/2 connection set up in start_metax_connection().
// Returns a Promise resolving to the raw response body string.
// Rejects if Metax returns a 400 error or any data error occurs.
global.http_get = (path) => {
        return new Promise((resolve, reject) => {
                const get_request = metax.request({
                        ":path": path,
                        ":method": "GET"
                })
                let data = "";
                let is_error = false;
                get_request
                        .on("response", headers => {
                                if (headers[":status"] === 400) {
                                        is_error = true;
                                }
                        })
                        .on("data", c => data += c)
                        .on("end", () => {
                                if (is_error) {
                                        reject(data);
                                } else {
                                        resolve(data);
                                }
                        })
                        .on("error", reject);
        });
}
global.http_post = (path, data, mime) => {
        return new Promise((resolve, reject) => {
                const post_request = metax.request({
                        ":path": path,
                        ":method": "POST",
                        "content-type": mime
                })
                post_request.write(data);
                post_request.end();
                let res = "";
                let is_error = false;
                post_request
                        .on("data", c => res += c)
                        .on("end", () => {
                                try {
                                        res = JSON.parse(res);
                                        if (!res.uuid) {
                                                reject(res.error);
                                        }
                                        resolve(res.uuid);
                                } catch (e) {
                                        reject(e);
                                }
                        })
                        .on("error", reject);
        });
}
global.logger = logger;
// metax: Global HTTP/2 client connection to the local Metax backend.
// Set to 0 initially; replaced with the active connection in connect_to_host_metax().
global.metax = 0;
// metax_wss_token: Session token received from Metax's WebSocket.
// Used as the listener token when calling metax_register_listener.
global.metax_wss_token = "";
// Shorthand helpers for common Metax API calls via http_get/http_post.
global.metax_get = (u) => http_get(`/db/get?id=${u}`);
global.metax_update = (u, d, m) => http_post(`/db/save/node?id=${u}`, d, m);
global.metax_register_listener = (u, t) => http_get(`/db/register_listener?id=${u}&token=${metax_wss_token}`);
global.metax_unregister_listener = (u, t) => http_get(`/db/unregister_listener?id=${u}&token=${metax_wss_token}`);

// ========================= Logging Aliases ===================================

// Short aliases for structured logger calls scoped to "webserver" module.
const trace = (m) => logger.console.log("webserver", m);
const warning = (m) => logger.warning("webserver", m);
const error = (m) => logger.error("webserver", m);

// ========================= Application Startup ================================

// Entry point: configures logger, then starts all subsystems in order.
main();

// Main startup sequence. Called once at process start.
// Order matters: logger must be ready before any other module logs.
// Metax HTTP/2 and WebSocket connections must be up before the sitemap loads.
// Servers start only after sitemap and notifiers are ready.
async function main() {
        const log = await logger.configure(logger_options);
        if (log.status === "success") {
                console.log("logger configured.");
                initialize_file_ops_logging();  // Initialize file operations audit log
                configure_webserver();
                await connect_to_host_metax();
                await connect_to_host_metax_websocket();
                await init_sitemap();
                await init_notifier_transporters();
                start_read_only_server(config.read_server_port);
                start_write_server(config.write_server_port);
        } else {
                console.log("logger error: ", log.message);
                process.exit(-1);
        }
}

// Establishes and maintains the HTTP/2 connection to the local Metax backend.
// Returns a Promise that resolves once connected.
// Automatically retries on error or connection close with a 500ms delay.
//
// Uses mutual TLS (mTLS) if client_key, client_cert, and ca are all configured.
// Falls back to rejectUnauthorized: false for backward compatibility (dev only).
// Sets global.metax to the active HTTP/2 session so all modules can use it.
function connect_to_host_metax() {
        return new Promise((resolve, reject) => {
                const _connect = () => {
                        console.log("connecting to host metax.");

                        // Load client certificate and CA for mutual TLS
                        let tlsOptions = {};
                        try {
                                if (config.client_key && config.client_cert && config.ca) {
                                        tlsOptions = {
                                                key: readFileSync(config.client_key),
                                                cert: readFileSync(config.client_cert),
                                                ca: readFileSync(config.ca),
                                                rejectUnauthorized: true  // SECURE: validate server certificate
                                        };
                                        console.log("Using mutual TLS with client certificate");
                                } else {
                                        // Fallback for backward compatibility (should not be used in production)
                                        tlsOptions = { rejectUnauthorized: false };
                                        console.log("WARNING: Connecting without client certificate validation");
                                }
                        } catch (e) {
                                error("Failed to load TLS certificates: " + e);
                                tlsOptions = { rejectUnauthorized: false };
                        }

                        metax = connect(`https://${config.host_metax}`, tlsOptions);
                        metax.on("error", e => {
                                error('failed to connect to host metax: ' + e + '. Retrying in 500ms...');
                                setTimeout(_connect, 500);
                        });
                        metax.on("connect", () => {
                                console.log("successfully connected to host metax.");
                                resolve("success");
                        });
                        metax.on("close", () => {
                                console.log("host metax connection closed. Retrying immediately...");
                                _connect();
                        });
                };
                _connect();
        });
}
// Placeholder handler for sitemap UUID updates from Metax.
// When the sitemap object is modified, this should reload website configurations.
// Currently a no-op (dynamic website adding is not yet implemented - TODO).
//TODO implement website adding dynamically
async function handle_sitemap_uuid_update() {
        console.log("handle_sitemap_uuid_update");
        /*
        const updated_sitemap = await metax_get(config.sitemap_uuid)
                                                        .then(JSON.parse);
        for(let i = 0; i < updated_sitemap.websites.length; i++) {
                if (website_uuids.indexOf(updated_sitemap.websites[i]) === -1) {
                        warning("adding new website with uuid: " + updated_sitemap.websites[i]);
                        const new_website = await get_website(updated_sitemap.websites[i]);
                        sitemap.websites.push(new_website);
                }
        }
        */
        console.log("END handle_sitemap_uuid_update");
}

// Reloads a single website's configuration from Metax when its UUID is updated.
// Finds the website by UUID in the sitemap and replaces it with a fresh copy.
// Called when Metax signals an update event for a known website UUID.
//
// Parameters:
// - w_uuid: UUID of the website object in Metax to reload.
async function handle_website_uuid_update(w_uuid) {
        console.log("handle_website_uuid_update for " + w_uuid);
        let i = sitemap.websites.findIndex(el => el.uuid === w_uuid);
        assert(i !== -1, "received website update for uuid which is not found in sitemap.");
        try {
                sitemap.websites[i] = await get_website(w_uuid);
        } catch (e) {
                error(e);
        }
        console.log("END handle_website_uuid_update for " + w_uuid);
}

// Performs a full global refresh after the Metax WebSocket reconnects.
// Steps:
//   1. Re-loads the sitemap and all website configurations from Metax.
//   2. Re-registers all UUID listeners with the new Metax session token.
//   3. Sends "update" events to all browser WebSocket clients so they refresh.
async function re_register_all_listeners() {
        console.log("performing global update on reconnection.");
        try {
                // 1. Refresh sitemap and websites metadata
                await init_sitemap();

                // 2. Re-register listeners for users (proxied uuids)
                await re_register_proxied_listeners();

                // 3. Trigger updates everywhere (notify all clients to refresh)
                trigger_all_client_updates();

                console.log("successfully performed global update.");
        } catch (e) {
                error("failed to perform global update: " + e);
        }
}

// Establishes and maintains the WebSocket connection to the local Metax backend.
// Returns a Promise that resolves once the initial "connected" token is received.
// Automatically reconnects on close or error (with re_register_all_listeners).
//
// On "message" events:
//   - "connected": Saves the session token (metax_wss_token) for listener calls.
//     If this is a reconnect, triggers re_register_all_listeners().
//   - "update":    If the UUID matches sitemap or website, handles the update.
//     Otherwise, forwards the update to browser clients via handle_metax_update_message.
function connect_to_host_metax_websocket() {
        return new Promise((resolve, reject) => {
                const _connect = () => {
                        console.log("connecting to metax websocket.");

                        // Load client certificate and CA for mutual TLS (WebSocket)
                        let wssOptions = {};
                        try {
                                if (config.client_key && config.client_cert && config.ca) {
                                        wssOptions = {
                                                key: readFileSync(config.client_key),
                                                cert: readFileSync(config.client_cert),
                                                ca: readFileSync(config.ca),
                                                rejectUnauthorized: true
                                        };
                                        console.log("Using mutual TLS for WebSocket with client certificate");
                                } else {
                                        wssOptions = { rejectUnauthorized: false };
                                        console.log("WARNING: WebSocket connecting without client certificate validation");
                                }
                        } catch (e) {
                                error("Failed to load TLS certificates for WebSocket: " + e);
                                wssOptions = { rejectUnauthorized: false };
                        }

                        const metax_wss = new WebSocket(`wss://${config.host_metax}`, wssOptions);

                        metax_wss.on("error", (e) => {
                                error("metax websocket error: " + e + ". Retrying in 500ms...");
                                setTimeout(_connect, 500);
                        });

                        metax_wss.on("open", () => {
                                console.log("successfully connected to metax websocket.");
                        });

                        metax_wss.on("close", () => {
                                warning("metax websocket connection closed. Reconnecting immediately...");
                                _connect();
                        });

                        metax_wss.on("message", async (m) => {
                                try {
                                        m = JSON.parse(m);
                                        if (m.event === "connected") {
                                                const is_reconnect = (metax_wss_token !== "");
                                                metax_wss_token = m.token;
                                                console.log("metax websocket token received: " + metax_wss_token);
                                                if (is_reconnect) {
                                                        await re_register_all_listeners();
                                                }
                                                resolve();
                                        } else if (m.event === "update") {
                                                if (is_valid_uuid(m.uuid)) {
                                                        if (m.uuid === config.sitemap_uuid) {
                                                                handle_sitemap_uuid_update();
                                                        }
                                                        if (website_uuids.indexOf(m.uuid) !== -1) {
                                                                handle_website_uuid_update(m.uuid);
                                                        }
                                                        handle_metax_update_message(m.uuid);
                                                } else {
                                                        error("received update message with invalid uuid.");
                                                }
                                        }
                                } catch (e) {
                                        error("unable to parse websocket message from metax:", e);
                                }
                        });
                };
                _connect();
        });
}

// Reads command-line arguments in key=value format and populates config.
// Validates that all required configuration fields are present using assert().
// Called before any servers start so config is fully initialized.
function configure_webserver() {
        console.log("configure_webserver");
        const argv = process.argv.slice(2);
        for (let i = 0; i < argv.length; i++) {
                let pairs = argv[i].split("=");
                config[pairs[0]] = pairs[1];
        }
        assert(config.host_metax !== undefined, "host metax is not defined.");
        assert(is_valid_uuid(config.sitemap_uuid), "sitemap_uuid is not a valid uuid.");
        assert(config.key !== undefined, "private key path is not defined.");
        assert(config.cert !== undefined, "certificate path is not defined.");
        assert(config.write_server_port !== undefined, "write server port is not defined.");
        assert(config.read_server_port !== undefined, "read server port is not defined.");
        console.log("END configure_webserver");
}

// Creates and starts the public-facing HTTPS/HTTP2 read-only server.
// Uses SNI (Server Name Indication) via sni_callback_read_only to serve
// the correct TLS certificate per subdomain.
// Requires client certificates (mTLS) for authentication.
// Also attaches a WebSocket server for real-time client notifications.
//
// Parameters:
// - port: The port number to listen on (config.read_server_port).
function start_read_only_server(port) {
        assert(!isNaN(port), "port must be a number.");
        console.log("starting read-only server");
        const http_server = createSecureServer({
                peerMaxConcurrentStreams: 1000,
                SNICallback: sni_callback_read_only,
                key: readFileSync(config.key),
                cert: readFileSync(config.cert),
                ca: config.ca ? readFileSync(config.ca, "utf8") : undefined,
                allowHTTP1: true
        });
        http_server.on('secureConnection', (socket) => {
                console.log(`New secure connection to 5002: ${socket.servername} from ${socket.remoteAddress}`);
        });
        http_server.on("session", handle_new_client_session);
        http_server.on("stream", handle_new_read_only_stream);
        http_server.on("error", handle_http_server_error);
        http_server.listen(port,
                () => console.log(`read-only server running on port: ${port}`));
        const wss = new WebSocketServer({ server: http_server });
        wss.on("connection", handle_websocket_new_connection);
}

// Creates and starts the write HTTPS/HTTP2 server for authenticated writes.
// Uses SNI via sni_callback to serve per-subdomain certificates.
// Logs each new secure connection's client CN and address.
// Also requires mTLS and attaches a WebSocket server.
//
// Parameters:
// - port: The port number to listen on (config.write_server_port).
function start_write_server(port) {
        assert(!isNaN(port), "port must be a number.");
        console.log("starting write server");
        const http_server = createSecureServer({
                peerMaxConcurrentStreams: 1000,
                SNICallback: sni_callback,
                key: readFileSync(config.key),
                cert: readFileSync(config.cert),
                ca: config.ca ? readFileSync(config.ca, "utf8") : undefined,
                allowHTTP1: true,
                requestCert: true,
                rejectUnauthorized: true
        });
        http_server.on('secureConnection', (socket) => {
                const cert = socket.getPeerCertificate();
                if (cert && cert.subject) {
                        console.log(`New secure connection to ${socket.servername} from ${cert.subject.CN} (${socket.remoteAddress})`);
                }
        });
        http_server.on("stream", handle_new_write_server_stream);
        http_server.on("session", handle_new_client_session);
        http_server.on("error", handle_http_server_error);
        http_server.listen(port,
                () => console.log(`write server running on port: ${port}`));
        const wss = new WebSocketServer({ server: http_server });
        wss.on("connection", handle_websocket_new_connection);
}

// Handles fatal HTTP server errors.
// EADDRINUSE means the port is already in use; exits the process.
function handle_http_server_error(e) {
        switch (e.code) {
                case "EADDRINUSE":
                        console.error(`the port already in use`);
                        process.exit(-1);
                        break;
        }
}

// Loads the sitemap object and all its websites from Metax into global.sitemap.
// Also loads the permission_requests sub-object and all client certificates.
// Registers a Metax listener on the sitemap UUID so updates are detected.
// Exits the process if the sitemap cannot be loaded (it is required to operate).
async function init_sitemap() {
        sitemap = await metax_get(config.sitemap_uuid)
                .then(r => JSON.parse(r))
                .catch(e => {
                        error("unable to get sitemap uuid: " + e);
                        process.exit(-1);
                });
        if (sitemap.permission_requests) {
                sitemap.permission_requests = await metax_get(sitemap.permission_requests)
                        .then(r => JSON.parse(r))
                        .catch(e => {
                                error("unable to get sitemap permission requests object: " + e);
                        });
        }
        await metax_register_listener(config.sitemap_uuid);
        for (let i = 0; i < sitemap.websites.length; i++) {
                sitemap.websites[i] = await get_website(sitemap.websites[i]);
        }
}

// Loads a single website configuration from Metax by its UUID.
// Fetches and inlines: TLS private key, TLS certificate, and all client certificates.
// Registers a Metax listener for this website UUID so config updates are detected.
// Tracks loaded website UUIDs in website_uuids to avoid duplicate registrations.
//
// Parameters:
// - website_uuid: UUID of the website object to load.
//
// Returns: The fully-loaded website configuration object.
async function get_website(website_uuid) {
        console.log(`get_website for ${website_uuid}`)
        const website = await metax_get(website_uuid)
                .then(r => JSON.parse(r))
                .catch(e => {
                        error("unable to get website uuid: " + e);
                        process.exit(-1);
                });
        let is_default = false;
        await metax_get(website.ssl_private_key?.file)
                .then(r => website.ssl_private_key = r)
                .catch(e => {
                        is_default = true;
                        error(`unable to get private key for ${website.name}, defaulting`);
                        website.ssl_private_key = null;
                })
        if (is_default) {
                website.ssl_certificate = null;
        } else {
                await metax_get(website.ssl_certificate?.file)
                        .then(r => website.ssl_certificate = r)
                        .catch(e => {
                                error(`unable to get ssl certificate for ${website.name}, defaulting`);
                                website.ssl_certificate = null;
                                website.ssl_private_key = null;
                        })
        }
        for (let i = 0; i < website.client_certificates.length; i++) {
                let ca = website.client_certificates[i];
                await metax_get(ca.certificate.file)
                        .then(r => website.client_certificates[i].certificate = r)
                        .catch(e => {
                                error(`unable to get ssl certificate for ${ca.name}, skipping`);
                        })
        }
        if (website_uuids.indexOf(website_uuid) === -1) {
                website_uuids.push(website_uuid);
                await metax_register_listener(website_uuid)
        }
        console.log(`END get_website for ${website_uuid}`)
        return website;
}

// SNI callback for the read-only server.
// Called by Node.js TLS per connection to pick the right TLS certificate for a subdomain.
// Builds combined CA from all client certificates for the matched website plus the global CA.
// Note: Per-website SSL cert/key are disabled here; always uses the global server cert.
//
// Parameters:
// - serverName: SNI hostname from the TLS ClientHello.
// - cb: Callback(null, SecureContext) to return the context to Node's TLS layer.
function sni_callback_read_only(serverName, cb) {
        console.log("sni_callback_read_only received serverName: " + serverName);
        let cert = null
        let key = null
        let ca = "";
        let i = sitemap.websites.findIndex(website => {
                let index = website.subdomains.findIndex(el => el.name === serverName)
                if (index !== -1) {
                        return website;
                }
        })

        // Always using certs from config
        key = readFileSync(config.key);
        cert = readFileSync(config.cert);

        if (i !== -1) {
                // DISABLING TLS CERT AND KEY from sitemap for prevent TLS certs leak by get request
                //key = sitemap.websites[i].ssl_private_key;
                //cert = sitemap.websites[i].ssl_certificate;
                for (let j = 0; j < sitemap.websites[i].client_certificates.length; j++) {
                        ca += sitemap.websites[i].client_certificates[j]["certificate"] + "\n";
                }
        }// else if (cert === null && key === null) {
        //        key = readFileSync(config.key);
        //        cert = readFileSync(config.cert);
        //}

        const global_ca = config.ca ? readFileSync(config.ca, "utf8") : "";
        cb(null, createSecureContext({
                cert,
                key,
                ca: ca + (ca.length > 0 && global_ca.length > 0 ? "\n" : "") + global_ca
        }));
}

// SNI callback for the write server.
// Identical to sni_callback_read_only but also loads per-website TLS key/cert if available.
// Falls back to the global server cert/key when no website-specific cert is configured.
// Falls back to the first website if the serverName is not found in the sitemap.
//
// Parameters:
// - serverName: SNI hostname from the TLS ClientHello.
// - cb: Callback(null, SecureContext) to return the context to Node's TLS layer.
function sni_callback(serverName, cb) {
        console.log("sni_callback received serverName: " + serverName);
        let cert = null
        let key = null
        let ca = "";
        let i = sitemap.websites.findIndex(website => {
                let index = website.subdomains.findIndex(el => el.name === serverName)
                if (index !== -1) {
                        return true;
                }
        })

        if (i === -1 && sitemap.websites.length > 0) {
                console.log("serverName not found or missing, falling back to first website: " + sitemap.websites[0].name);
                i = 0;
        }

        // Always using certs from config
        key = readFileSync(config.key);
        cert = readFileSync(config.cert);

        if (i !== -1) {
                console.log("Found matching website for SNI: " + sitemap.websites[i].name);
                for (let j = 0; j < sitemap.websites[i].client_certificates.length; j++) {
                        ca += sitemap.websites[i].client_certificates[j]["certificate"] + "\n";
                }
                console.log("Loaded CA string length: " + ca.length);
        } else {
                console.log("No matching website found for SNI and no websites available in sitemap.");
        }

        const global_ca = config.ca ? readFileSync(config.ca, "utf8") : "";
        console.log("trying new secure connection " + serverName);
        cb(null, createSecureContext({
                cert,
                key,
                ca: ca + (ca.length > 0 && global_ca.length > 0 ? "\n" : "") + global_ca
        }));
}
