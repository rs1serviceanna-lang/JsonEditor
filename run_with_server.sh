#!/bin/bash

# Configuration
SERVER_DIR="./metax_zero_webserver"
SERVER_SCRIPT="./start_server.sh"
APP_BIN="./JsonEditor"

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

echo "Starting Metax Zero Webserver (Stable Version)..."
pushd "$SERVER_DIR" > /dev/null
source ./start.conf
pushd ./metax_2/ > /dev/null
node ../../rest_api_stable.mjs storage=../storage/ port=$METAX_PORT key=$SELF_PRIVKEY cert=$SELF_CERT &
SERVER_PID=$!
popd > /dev/null
popd > /dev/null

echo "Waiting for server to initialize..."
sleep 5 # Give it a moment to start up

echo "Starting JsonEditor..."
$APP_BIN

# cleanup
echo "Stopping server (PID: $SERVER_PID)..."
kill $SERVER_PID
echo "Done."
