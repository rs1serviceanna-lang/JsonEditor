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
    if [ -n "$SERVER_PID" ]; then
        kill "$SERVER_PID" 2>/dev/null || true
    fi
    echo "Done."
}

# Trap cleanup on exit
trap cleanup EXIT

echo "Starting Metax Zero Webserver (Stable Version)..."
pushd "$SERVER_DIR" > /dev/null
source ./start.conf
pushd ./metax_2/ > /dev/null
echo "Starting Node server..."
# Note: we are in metax_zero_webserver/metax_2/
# We need to access rest_api_stable.mjs which is in JsonEditor App/
# Path from metax_2 to Root is ../../
# So ../../JsonEditor App/rest_api_stable.mjs
node "../../JsonEditor App/rest_api_stable.mjs" storage=../storage/ port=$METAX_PORT key=$SELF_PRIVKEY cert=$SELF_CERT &
SERVER_PID=$!
popd > /dev/null
popd > /dev/null

echo "Waiting for server to initialize..."
sleep 5

echo "Starting JsonEditor..."
# Run the application in the foreground so the script waits for it.
# When the application is closed, the script will exit and the trap will clean up the server.
$APP_BIN --server "https://localhost:$METAX_PORT" --uuid "$DEFAULT_UUID"
