#!/bin/bash

# Get the absolute path to this script and the project root
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"

# Source the configuration file
source "$SCRIPT_DIR/start.conf"

echo "Current Directory: $ROOT_DIR"

# Start Metax server with localhost certificates for client validation
pushd "$ROOT_DIR/metax_2/" > /dev/null
npm start "storage=../storage/" "port=$METAX_PORT" "key=$LOCALHOST_METAX_KEY" "cert=$LOCALHOST_METAX_CERT" "ca=$LOCALHOST_CA" &
popd > /dev/null

sleep 5  # Wait for Metax to start

# Start Greenhosting webserver with client certificates
pushd "$ROOT_DIR/greenhosting_webserver_2/" > /dev/null
npm start "host_metax=localhost:$METAX_PORT" "sitemap_uuid=$SITEMAP_UUID" "read_server_port=$READ_PORT" "write_server_port=$WRITE_PORT" "key=$SELF_PRIVKEY" "cert=$SELF_CERT" "client_key=$LOCALHOST_CLIENT_KEY" "client_cert=$LOCALHOST_CLIENT_CERT" "ca=$LOCALHOST_CA"
popd > /dev/null
