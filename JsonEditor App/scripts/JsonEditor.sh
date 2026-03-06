#!/bin/bash
set -e

# Configuration
SERVER_DIR="../metax_zero_webserver"
APP_BIN="./JsonEditor"
DEFAULT_UUID="5909ce96-f166-4662-b291-11d651ed2f70-a27156a8-fb53-4e3d-be02-954feb7ac311"

# Validate paths
if [ ! -d "$SERVER_DIR" ]; then
    echo "Error: Server directory not found at $SERVER_DIR"
    exit 1
fi

if [ ! -f "$APP_BIN" ]; then
    echo "Error: Application binary not found at $APP_BIN"
    echo "Please build the application first (run 'make')"
    exit 1
fi

# Cleanup function
cleanup() {
    echo ""
    echo "Stopping processes..."
    if [ -n "$METAX_PID" ]; then
        kill "$METAX_PID" 2>/dev/null || true
    fi
    if [ -n "$WEBSERVER_PID" ]; then
        kill "$WEBSERVER_PID" 2>/dev/null || true
    fi
    echo "Done."
}

# Trap cleanup on exit
trap cleanup EXIT

# Load configuration
pushd "$SERVER_DIR" > /dev/null
source ./scripts/start.conf

# Step 1: Start Metax (data server) on port 5001 with localhost mTLS
echo "Starting Metax server on port $METAX_PORT..."
pushd ./metax_2/ > /dev/null
npm start "storage=../storage/" "port=$METAX_PORT" "key=$LOCALHOST_METAX_KEY" "cert=$LOCALHOST_METAX_CERT" "ca=$LOCALHOST_CA" &
METAX_PID=$!
popd > /dev/null

echo "Waiting for Metax to initialize..."
sleep 5

# Step 2: Start Greenhosting webserver on ports 5002/5003
echo "Starting Greenhosting webserver on ports $READ_PORT/$WRITE_PORT..."
pushd ./greenhosting_webserver_2/ > /dev/null
npm start "host_metax=localhost:$METAX_PORT" "sitemap_uuid=$SITEMAP_UUID" "read_server_port=$READ_PORT" "write_server_port=$WRITE_PORT" "key=$SELF_PRIVKEY" "cert=$SELF_CERT" "client_key=$LOCALHOST_CLIENT_KEY" "client_cert=$LOCALHOST_CLIENT_CERT" "ca=$LOCALHOST_CA" &
WEBSERVER_PID=$!
popd > /dev/null

echo "Waiting for webserver to initialize..."
sleep 3

popd > /dev/null

# Step 3: Start JsonEditor Qt application
CERT_PATH="$SERVER_DIR/certs/localhost/Mani.crt"
KEY_PATH="$SERVER_DIR/certs/localhost/Mani.key"

if [ -f "$CERT_PATH" ] && [ -f "$KEY_PATH" ]; then
    echo "Using client certificate: $CERT_PATH"
    $APP_BIN --server "https://localhost:$METAX_PORT" --uuid "$DEFAULT_UUID" --cert "$CERT_PATH" --key "$KEY_PATH"
else
    echo "Warning: Client certificates not found, attempting connection without them."
    $APP_BIN --server "https://localhost:$METAX_PORT" --uuid "$DEFAULT_UUID"
fi
