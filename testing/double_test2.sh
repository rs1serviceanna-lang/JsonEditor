#!/bin/bash
# double_test2.sh - Automated Reconnection Test for Metax & Webserver

# 1. Configuration
METAX_PORT=5001
READ_PORT=5002
WRITE_PORT=5003
SITEMAP_UUID="5909ce96-f166-4662-b291-11d651ed2f70-a27156a8-fb53-4e3d-be02-954feb7ac311"
SERVER_DIR="../metax_zero_webserver"

# 2. Cleanup function
cleanup() {
    echo ""
    echo "[Cleanup] Stopping all processes..."
    kill $METAX_PID $WEBSERVER_PID 2>/dev/null || true
    # Restore original webserver code (disable console logs)
    if [ -f "$SERVER_DIR/greenhosting_webserver_2/src/webserver.mjs.bak" ]; then
        mv "$SERVER_DIR/greenhosting_webserver_2/src/webserver.mjs.bak" "$SERVER_DIR/greenhosting_webserver_2/src/webserver.mjs"
    fi
    echo "[Cleanup] Done."
}
trap cleanup EXIT

# 3. Pre-flight checks
echo "[1/6] Preparing environment..."
mkdir -p "$SERVER_DIR/logs/webserver/"
fuser -k $METAX_PORT/tcp $READ_PORT/tcp $WRITE_PORT/tcp 2>/dev/null || true
sleep 1

# 4. Enable Console Logging for testing
echo "[2/6] Enabling real-time logs..."
cp "$SERVER_DIR/greenhosting_webserver_2/src/webserver.mjs" "$SERVER_DIR/greenhosting_webserver_2/src/webserver.mjs.bak"
sed -i 's/console_channel: { usage: false }/console_channel: { usage: true }/' "$SERVER_DIR/greenhosting_webserver_2/src/webserver.mjs"

# 5. Start Metax
echo "[3/6] Starting Metax Server..."
pushd "$SERVER_DIR/metax_2" > /dev/null
node ../../rest_api_stable.mjs storage=../storage/ port=$METAX_PORT key=../certs/metax.key cert=../certs/metax.crt > ../../metax_standalone.log 2>&1 &
METAX_PID=$!
popd > /dev/null
sleep 3

# 6. Start Webserver
echo "[4/6] Starting Greenhosting Webserver..."
pushd "$SERVER_DIR/greenhosting_webserver_2" > /dev/null
export NODE_TLS_REJECT_UNAUTHORIZED=0
node src/webserver.mjs \
    host_metax=localhost:$METAX_PORT \
    sitemap_uuid=$SITEMAP_UUID \
    key=../certs/metax.key \
    cert=../certs/metax.crt \
    write_server_port=$WRITE_PORT \
    read_server_port=$READ_PORT &
WEBSERVER_PID=$!
popd > /dev/null

echo "--- Waiting for connection to stabilize (7s) ---"
sleep 7

echo ""
echo "[5/6] ATTENTION: DISCONNECTING METAX NOW..."
kill $METAX_PID
echo ">>> Metax Stopped. Webserver should start retry attempts now. <<<"
sleep 6

echo ""
echo "[6/6] ATTENTION: RECONNECTING METAX NOW..."
pushd "$SERVER_DIR/metax_2" > /dev/null
node ../../rest_api_stable.mjs storage=../storage/ port=$METAX_PORT key=../certs/metax.key cert=../certs/metax.crt > ../../metax_standalone.log 2>&1 &
METAX_PID=$!
popd > /dev/null

echo ">>> Metax Restarted. Observe the 're-registering' logs above shortly. <<<"
echo "--- Finalizing test in 10s ---"
sleep 10

echo ""
echo "TEST COMPLETE."
echo "If you saw 'successfully connected' and 're-registering' in the logs above, the feature is working perfectly."
echo "Press Enter to stop servers and exit."
read
