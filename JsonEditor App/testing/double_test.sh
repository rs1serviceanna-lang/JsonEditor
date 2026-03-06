#!/bin/bash
set -e

# Configuration
SERVER_DIR="../../metax_zero_webserver"
SERVER_SCRIPT="./start_server.sh"
APP_BIN="../JsonEditor"
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
source ./scripts/start.conf
pushd ./metax_2/ > /dev/null
node "../../JsonEditor App/testing/rest_api_stable.mjs" storage=../storage/ port=$METAX_PORT key=$SELF_PRIVKEY cert=$SELF_CERT &
SERVER_PID=$!
popd > /dev/null
popd > /dev/null

echo "Waiting for server to initialize..."
sleep 5


# Screen width assumption (e.g. 1920) for split screen
# Left window: x=0, y=100, w=900, h=800
echo "Starting JsonEditor Instance 1 (Left)..."
$APP_BIN --x 50 --y 100 --width 900 --height 800 --uuid "$DEFAULT_UUID" &

# Right window: x=960, y=100, w=900, h=800
echo "Starting JsonEditor Instance 2 (Right)..."
$APP_BIN --x 970 --y 100 --width 900 --height 800 --uuid "$DEFAULT_UUID" &

echo "Both instances started side-by-side."
echo "Press Enter to stop the server and exit..."
read
