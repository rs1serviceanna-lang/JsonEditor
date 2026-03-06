# Metax Zero Webserver

A lightweight, secure metadata server environment that handles high-performance data storage and synchronization via mTLS (Mutual TLS).

## Project Structure

This environment consists of two main Node.js (MJS) services:
- **Metax Data Server (`metax_2/`)**: Manages the low-level data and contract storage.
- **Greenhosting Webserver (`greenhosting_webserver_2/`)**: Acts as a gateway/proxy with specialized permissions and notification logic.

## Prerequisites

- **Node.js**: Version 16 or higher is required.
- **SSL Certificates**: mTLS is used for security. Certificates must be generated (see `setup_scripts/`).

## Installation

Everything is consolidated into a single root-level dependency management system:

```bash
cd metax_zero_webserver
npm install
```

## Running the Servers

Use the centralized start script which handles environment variables and secure certificate paths:

```bash
# Start all services (Metax + Greenhosting)
npm run start-all

# Or use the script directly
bash scripts/start_server.sh
```

### Individual Service Control
You can also start services individually using npm scripts:
- `npm run start:metax`: Starts only the Metax data server.
- `npm run start:webserver`: Starts only the Greenhosting gateway.

## Configuration

Settings (ports, certificate paths, UUIDs) are managed in:
- `scripts/start.conf`: The central configuration source.

## Logging

Logs are automatically managed and rotated in:
- `metax_zero_webserver/logs/`

## Security and Verification

The environment contains advanced auditing tools to verify mTLS and protocol integrity:
```bash
npm run verify
# or
bash scripts/verify_security.sh
```

---
*Maintained by the Metax Development Team.*
