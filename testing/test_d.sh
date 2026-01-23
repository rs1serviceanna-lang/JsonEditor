#!/bin/bash
# test_d.sh - Test manual WebSocket disconnection using the 'd' key

set -e

# Configuration
SERVER_DIR="../metax_zero_webserver"
APP_BIN="../JsonEditor"
METAX_PORT=5001
DEFAULT_UUID="5909ce96-f166-4662-b291-11d651ed2f70-a27156a8-fb53-4e3d-be02-954feb7ac311"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

cleanup() {
    echo -e "\n${YELLOW}[Cleanup] Stopping processes...${NC}"
    if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; fi
    if [ -n "$APP1_PID" ]; then kill "$APP1_PID" 2>/dev/null || true; fi
    if [ -n "$APP2_PID" ]; then kill "$APP2_PID" 2>/dev/null || true; fi
    echo -e "${GREEN}[Cleanup] Done.${NC}"
}

trap cleanup EXIT

echo -e "${CYAN}Starting Metax Server...${NC}"
pushd "$SERVER_DIR" > /dev/null
source ./start.conf
pushd ./metax_2/ > /dev/null
node ../../rest_api_stable.mjs storage=../storage/ port=$METAX_PORT key=$SELF_PRIVKEY cert=$SELF_CERT &
SERVER_PID=$!
popd > /dev/null
popd > /dev/null

sleep 3
echo -e "${GREEN}✓ Server running (PID: $SERVER_PID)${NC}"

echo -e "${CYAN}Starting JsonEditor Instance 1 (Left)...${NC}"
$APP_BIN --x 50 --y 100 --width 900 --height 800 --uuid "$DEFAULT_UUID" &
APP1_PID=$!

echo -e "${CYAN}Starting JsonEditor Instance 2 (Right)...${NC}"
$APP_BIN --x 970 --y 100 --width 900 --height 800 --uuid "$DEFAULT_UUID" &
APP2_PID=$!

sleep 2
echo -e "${GREEN}✓ Apps running (PIDs: $APP1_PID, $APP2_PID)${NC}"

echo ""
echo -e "${BLUE}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║          WEB SOCKET DISCONNECT TEST (KEYBOARD)           ║${NC}"
echo -e "${BLUE}╠══════════════════════════════════════════════════════════╣${NC}"
echo -e "${BLUE}║  Press ${YELLOW}'d'${BLUE} to disconnect ONLY the WebSockets in apps      ║${NC}"
echo -e "${BLUE}║  Press ${YELLOW}'k'${BLUE} to kill the server (tests backoff)             ║${NC}"
echo -e "${BLUE}║  Press ${YELLOW}'r'${BLUE} to restart the server                          ║${NC}"
echo -e "${BLUE}║  Press ${YELLOW}'q'${BLUE} to quit                                        ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""

while true; do
    read -n 1 -s key
    case $key in
        d|D)
            echo -e "${RED}Sending DISCONNECT signal to BOTH apps...${NC}"
            kill -USR1 "$APP1_PID" "$APP2_PID" 2>/dev/null || echo -e "${RED}Apps are not running!${NC}"
            echo -e "${CYAN}Watch the terminal logs - they should reconnect immediately!${NC}"
            ;;
        k|K)
            if [ -n "$SERVER_PID" ]; then
                echo -e "${RED}Killing Server...${NC}"
                kill "$SERVER_PID" 2>/dev/null || true
                SERVER_PID=""
            else
                echo -e "${YELLOW}Server is already stopped.${NC}"
            fi
            ;;
        r|R)
            if [ -z "$SERVER_PID" ]; then
                echo -e "${GREEN}Restarting Server...${NC}"
                pushd "$SERVER_DIR/metax_2" > /dev/null
                source ../start.conf
                node ../../rest_api_stable.mjs storage=../storage/ port=$METAX_PORT key=$SELF_PRIVKEY cert=$SELF_CERT &
                SERVER_PID=$!
                popd > /dev/null
                echo -e "${GREEN}✓ Server started.${NC}"
            else
                echo -e "${YELLOW}Server is already running.${NC}"
            fi
            ;;
        q|Q)
            exit 0
            ;;
    esac
done
