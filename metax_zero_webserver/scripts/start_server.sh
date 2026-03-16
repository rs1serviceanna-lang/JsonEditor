#!/bin/bash
# =============================================================================
# start_server.sh - Start the Metax Backend and Greenhosting Webserver
# =============================================================================
#
# This script starts both server processes in the correct order:
#
#   1. Metax server (rest_api.mjs on port $METAX_PORT)
#      - Handles raw storage and ODM operations on localhost only.
#      - Uses localhost mTLS certificates so only the webserver can connect.
#      - Launched in the background (&) so the script continues.
#
#   2. Greenhosting webserver (webserver.mjs on ports $READ_PORT / $WRITE_PORT)
#      - Connects to Metax as an authenticated client.
#      - Serves external HTTPS/WebSocket traffic.
#      - Waits 5 seconds after Metax starts to ensure it is ready.
#
# Configuration is loaded from start.conf in the same directory.
# All paths and ports are defined in that file.
#
# Usage: ./start_server.sh
# =============================================================================

# Get the absolute path to this script and the project root
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"

# Source the configuration file (defines METAX_PORT, READ_PORT, WRITE_PORT, etc.)
source "$SCRIPT_DIR/start.conf"

echo "Current Directory: $ROOT_DIR"

# Start Metax server with localhost certificates for client validation.
# Runs in background; greenhosting webserver will connect to it as a client.
node "$ROOT_DIR/metax_2/src/rest_api.mjs" "storage=$ROOT_DIR/storage/" "port=$METAX_PORT" "key=$LOCALHOST_METAX_KEY" "cert=$LOCALHOST_METAX_CERT" "ca=$LOCALHOST_CA" &

sleep 5  # Wait for Metax to fully initialize before the webserver connects

# Start Greenhosting webserver with client certificates.
# Connects to Metax via mTLS using the greenhosting client certificate.
node "$ROOT_DIR/greenhosting_webserver_2/src/webserver.mjs" "host_metax=localhost:$METAX_PORT" "sitemap_uuid=$SITEMAP_UUID" "read_server_port=$READ_PORT" "write_server_port=$WRITE_PORT" "key=$SELF_PRIVKEY" "cert=$SELF_CERT" "client_key=$LOCALHOST_CLIENT_KEY" "client_cert=$LOCALHOST_CLIENT_CERT" "ca=$LOCALHOST_CA"
