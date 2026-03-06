#!/bin/bash

# Security and Logging Verification Script (New location: scripts/)
# This script verifies that all security enhancements are properly configured

# Get the absolute path to this script and the project root
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"

echo "======================================================================"
echo "Metax Zero Webserver - Security & Logging Verification"
echo "======================================================================"
echo "Working from Project Root: $ROOT_DIR"
echo ""

# Function to print status
print_status() {
    if [ $1 -eq 0 ]; then
        echo "✓ $2"
    else
        echo "✗ $2"
    fi
}

# Function to print info
print_info() {
    echo "  → $1"
}

# Check 1: Localhost Certificates
echo "[1] Checking Localhost Certificates..."
CERT_DIR="$ROOT_DIR/certs/localhost"
ALL_CERTS_EXIST=0

if [ -f "$CERT_DIR/ca.crt" ] && [ -f "$CERT_DIR/ca.key" ]; then
    print_status 0 "CA certificates found"
else
    print_status 1 "CA certificates missing"
    ALL_CERTS_EXIST=1
fi

if [ -f "$CERT_DIR/metax_localhost_server.crt" ] && [ -f "$CERT_DIR/metax_localhost_server.key" ]; then
    print_status 0 "Metax server certificates found"
else
    print_status 1 "Metax server certificates missing"
    ALL_CERTS_EXIST=1
fi

if [ -f "$CERT_DIR/greenhosting_client.crt" ] && [ -f "$CERT_DIR/greenhosting_client.key" ]; then
    print_status 0 "Webserver client certificates found"
else
    print_status 1 "Webserver client certificates missing"
    ALL_CERTS_EXIST=1
fi

# Check certificate validity
if [ $ALL_CERTS_EXIST -eq 0 ]; then
    echo ""
    echo "  Certificate Details:"
    print_info "CA Certificate:"
    openssl x509 -in "$CERT_DIR/ca.crt" -noout -subject -dates 2>/dev/null | sed 's/^/    /'
    print_info "Metax Server Certificate:"
    openssl x509 -in "$CERT_DIR/metax_localhost_server.crt" -noout -subject -dates 2>/dev/null | sed 's/^/    /'
    print_info "Webserver Client Certificate:"
    openssl x509 -in "$CERT_DIR/greenhosting_client.crt" -noout -subject -dates 2>/dev/null | sed 's/^/    /'
fi

echo ""

# Check 2: Configuration Files
echo "[2] Checking Configuration..."
if [ -f "$SCRIPT_DIR/start.conf" ]; then
    if grep -q "LOCALHOST_CA" "$SCRIPT_DIR/start.conf" && \
       grep -q "LOCALHOST_METAX_KEY" "$SCRIPT_DIR/start.conf" && \
       grep -q "LOCALHOST_CLIENT_CERT" "$SCRIPT_DIR/start.conf"; then
        print_status 0 "start.conf contains localhost certificate variables"
    else
        print_status 1 "start.conf missing localhost certificate variables"
    fi
else
    print_status 1 "start.conf not found at $SCRIPT_DIR/start.conf"
fi

echo ""

# Check 3: Code Modifications
echo "[3] Checking Code Modifications..."

if grep -E -q "requestCert.*(true|!!)" "$ROOT_DIR/metax_2/src/rest_api.mjs" 2>/dev/null; then
    print_status 0 "Metax server requires client certificates"
else
    print_status 1 "Metax server not requiring client certificates"
fi

if grep -q "isLocalhost" "$ROOT_DIR/metax_2/src/rest_api.mjs" 2>/dev/null; then
    print_status 0 "Metax server has localhost restriction"
else
    print_status 1 "Metax server missing localhost restriction"
fi

if grep -q "client_key" "$ROOT_DIR/greenhosting_webserver_2/src/webserver.mjs" 2>/dev/null; then
    print_status 0 "Webserver configured to use client certificates"
else
    print_status 1 "Webserver not configured for client certificates"
fi

if [ -f "$ROOT_DIR/greenhosting_webserver_2/src/file_ops_logger.mjs" ]; then
    print_status 0 "File operations logger module exists"
else
    print_status 1 "File operations logger module missing"
fi

if grep -q "log_file_operation" "$ROOT_DIR/greenhosting_webserver_2/src/router.mjs" 2>/dev/null; then
    print_status 0 "Router has file operation logging integrated"
else
    print_status 1 "Router missing file operation logging"
fi

echo ""

# Check 4: Log Directories
echo "[4] Checking Log Directory Structure..."
if [ -d "$ROOT_DIR/logs" ]; then
    print_status 0 "Main logs directory exists"
    
    if [ -d "$ROOT_DIR/logs/file_operations" ]; then
        print_status 0 "File operations log directory exists"
        LOG_COUNT=$(ls "$ROOT_DIR"/logs/file_operations/*.log 2>/dev/null | wc -l)
        if [ $LOG_COUNT -gt 0 ]; then
            print_info "$LOG_COUNT log file(s) found"
        else
            print_info "No log files yet (expected on first run)"
        fi
    else
        print_info "File operations log directory will be created on first run"
    fi
else
    print_status 1 "Logs directory missing"
fi

echo ""

# Check 5: HTTP/2 Usage
echo "[5] Verifying HTTP/2 Implementation..."
if grep -q "\"http2\"" "$ROOT_DIR/metax_2/src/rest_api.mjs" 2>/dev/null; then
    print_status 0 "Metax uses http2 module"
else
    print_status 1 "Metax not using http2 module"
fi

if grep -q "\"http2\"" "$ROOT_DIR/greenhosting_webserver_2/src/webserver.mjs" 2>/dev/null; then
    print_status 0 "Webserver uses http2 module"
else
    print_status 1 "Webserver not using http2 module"
fi

if grep -q "createSecureServer" "$ROOT_DIR/metax_2/src/rest_api.mjs" 2>/dev/null; then
    print_status 0 "HTTP/2 secure server creation found"
else
    print_status 1 "HTTP/2 secure server not found"
fi

echo ""

# Check 6: Process Status
echo "[6] Checking Running Processes..."
if pgrep -f "metax_2.*npm start" > /dev/null; then
    print_status 0 "Metax server process running"
    METAX_PID=$(pgrep -f "metax_2.*npm start" | head -1)
    print_info "PID: $METAX_PID"
else
    print_status 1 "Metax server not running"
fi

if pgrep -f "greenhosting_webserver_2.*npm start" > /dev/null; then
    print_status 0 "Webserver process running"
    WEB_PID=$(pgrep -f "greenhosting_webserver_2.*npm start" | head -1)
    print_info "PID: $WEB_PID"
else
    print_status 1 "Webserver not running"
fi

echo ""

# Check 7: Port Listening
echo "[7] Checking Port Status..."
source "$SCRIPT_DIR/start.conf" 2>/dev/null
if [ ! -z "$METAX_PORT" ]; then
    if netstat -tuln 2>/dev/null | grep -q ":$METAX_PORT " || ss -tuln 2>/dev/null | grep -q ":$METAX_PORT "; then
        print_status 0 "Metax port $METAX_PORT is listening"
    else
        print_status 1 "Metax port $METAX_PORT not listening"
    fi
fi

if [ ! -z "$READ_PORT" ]; then
    if netstat -tuln 2>/dev/null | grep -q ":$READ_PORT " || ss -tuln 2>/dev/null | grep -q ":$READ_PORT "; then
        print_status 0 "Read server port $READ_PORT is listening"
    else
        print_status 1 "Read server port $READ_PORT not listening"
    fi
fi

if [ ! -z "$WRITE_PORT" ]; then
    if netstat -tuln 2>/dev/null | grep -q ":$WRITE_PORT " || ss -tuln 2>/dev/null | grep -q ":$WRITE_PORT "; then
        print_status 0 "Write server port $WRITE_PORT is listening"
    else
        print_status 1 "Write server port $WRITE_PORT not listening"
    fi
fi

echo ""

# Summary
echo "======================================================================"
echo "Verification Complete!"
echo "======================================================================"
echo ""
echo "Next Steps:"
echo "  1. If certificates are missing, run: ./setup_scripts/gen_localhost_certs.sh"
echo "  2. If servers are not running, run: ./scripts/start_server.sh"
echo "  3. Check logs for any errors: tail -f logs/webserver/greenhosting_webserver.log"
echo "  4. Monitor file operations: tail -f logs/file_operations/*.log"
echo ""
echo "For more information, see: docs/SECURITY_ENHANCEMENTS.md"
echo ""
