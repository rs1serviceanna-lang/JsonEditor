# Security and Logging Enhancements

## Overview
This document describes the security and logging improvements made to the Metax Zero Webserver system to enforce mutual TLS authentication for local connections and comprehensive file operation logging.

## Changes Implemented

### 1. Mutual TLS Authentication (Metax ↔ Webserver)

#### Problem
Previously, the webserver connected to the Metax server with `rejectUnauthorized: false`, which meant:
- No certificate validation
- Vulnerable to man-in-the-middle attacks
- No client authentication

#### Solution
Implemented mutual TLS authentication using self-signed certificates:

**Certificate Structure:**
```
certs/localhost/
├── ca.crt                    # Certificate Authority
├── ca.key                    # CA private key
├── metax-server.crt          # Metax server certificate (signed by CA)
├── metax-server.key          # Metax server private key
├── webserver-client.crt      # Webserver client certificate (signed by CA)
└── webserver-client.key      # Webserver client private key
```

**Certificate Generation:**
```bash
cd metax_zero_webserver
./setup_scripts/gen_localhost_certs.sh
```

This creates:
1. **CA Certificate** - Root of trust for localhost communication
2. **Server Certificate** - For Metax (localhost:5001), validates server identity
3. **Client Certificate** - For Webserver, authenticates client to Metax

#### Implementation Details

**Metax Server (`metax_2/src/rest_api.mjs`):**
- Loads CA certificate to validate client certificates
- Sets `requestCert: true` and `rejectUnauthorized: true`
- Only accepts connections from localhost (IP filtering)
- Validates client certificate against CA

**Webserver (`greenhosting_webserver_2/src/webserver.mjs`, `router.mjs`):**
- Loads client certificate and CA certificate
- Uses client cert to authenticate to Metax
- Validates Metax server certificate against CA
- Sets `rejectUnauthorized: true` (secure mode)

**Configuration (`start.conf`):**
```bash
# Localhost mutual TLS certs (for metax-webserver secure communication)
LOCALHOST_CA=../certs/localhost/ca.crt
LOCALHOST_METAX_KEY=../certs/localhost/metax-server.key
LOCALHOST_METAX_CERT=../certs/localhost/metax-server.crt
LOCALHOST_CLIENT_KEY=../certs/localhost/webserver-client.key
LOCALHOST_CLIENT_CERT=../certs/localhost/webserver-client.crt
```

### 2. Localhost-Only Restriction

**Implementation:**
Added IP address filtering in `metax_2/src/rest_api.mjs`:

```javascript
const isLocalhost = remoteAddr === '127.0.0.1' || 
                   remoteAddr === '::1' || 
                   remoteAddr === '::ffff:127.0.0.1' ||
                   remoteAddr === 'localhost';
```

- Rejects all non-localhost connections with HTTP 403
- Prevents remote access to Metax port (5001)
- Logs rejected connection attempts

### 3. HTTP/2 Usage Verification

**Current Status:**
- ✅ **HTTP/2** is used for all REST API calls
  - `http2.createSecureServer()` in both Metax and Webserver
  - `http2.connect()` for client connections
- ✅ **WebSocket over HTTP/1.1** (correct, WebSocket protocol requirement)
  - WebSocket inherently uses HTTP/1.1 for upgrade protocol
  - This is the only component still using HTTP/1.1 (as designed)

**Verification:**
All HTTP/2 connections are established via:
```javascript
import { createSecureServer, connect } from "http2";
```

### 4. Comprehensive File Operations Logging

#### New Logger Module (`file_ops_logger.mjs`)

Tracks all file operations with:
- **Operation type**: read, write, delete, copy
- **User identification**: CN from client certificate
- **Session information**: Session ID
- **Network details**: IP address, certificate fingerprint
- **File metadata**: UUID, MIME type, file size
- **Timestamp**: ISO 8601 format
- **Additional context**: User agent, HTTP status, etc.

#### Log Format
```
[2026-02-16T10:00:00.000Z] READ
  Log ID: 550e8400-e29b-41d4-a716-446655440000
  UUID: fbe1aafb-6fb9-43ff-a5c7-6fd4690e58d8
  User: Anna Blbulyan
  Session: 42
  IP: ::ffff:127.0.0.1
  Fingerprint: DD:3A:C1:F6:DD:9C:0B:FD:14:7F:26:71:62:31:02:A0:4F:52:92:BE:5A:D3:67:C4:BA:87:F9:4B:B2:26:90:A0
  MIME Type: application/json
  Additional Info:
    status: 200
    user_agent: Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0
```

#### Integration Points

**Logged operations:**
1. **GET /db/get** → `operation: 'read'`
2. **POST /db/save** → `operation: 'write'`
3. **GET /db/delete** → `operation: 'delete'`

**Log location:**
```
logs/file_operations/file_ops_2026-02-16T10-00-00-000Z.log
```

### 5. Updated Startup Script

**`start_server.sh`** now passes all certificate parameters:

```bash
# Start Metax with localhost server certificates
npm start storage=../storage/ port=$METAX_PORT \
  key=$LOCALHOST_METAX_KEY \
  cert=$LOCALHOST_METAX_CERT \
  ca=$LOCALHOST_CA &

# Start Webserver with client certificates
npm start host_metax=localhost:$METAX_PORT \
  sitemap_uuid=$SITEMAP_UUID \
  read_server_port=$READ_PORT \
  write_server_port=$WRITE_PORT \
  key=$SELF_PRIVKEY \
  cert=$SELF_CERT \
  client_key=$LOCALHOST_CLIENT_KEY \
  client_cert=$LOCALHOST_CLIENT_CERT \
  ca=$LOCALHOST_CA
```

## Security Benefits

1. **Mutual Authentication**
   - Metax verifies webserver identity via client certificate
   - Webserver verifies Metax identity via server certificate
   - Prevents unauthorized local connections

2. **Encrypted Local Traffic**
   - All metax-webserver traffic is TLS encrypted
   - Protection against local network sniffing

3. **Localhost Isolation**
   - Metax port 5001 only accessible from localhost
   - Prevents remote attacks on internal API

4. **Audit Trail**
   - Complete log of who accessed what files
   - Forensic investigation capability
   - Compliance and accountability

## Investigating File Access

### Query Logs

**Find who read a specific file:**
```bash
grep "UUID: fbe1aafb-6fb9-43ff-a5c7-6fd4690e58d8" logs/file_operations/*.log | grep "READ"
```

**Find all operations by a user:**
```bash
grep "User: Anna Blbulyan" logs/file_operations/*.log
```

**Find all write operations:**
```bash
grep "WRITE" logs/file_operations/*.log
```

**Find operations from a specific IP:**
```bash
grep "IP: 192.168.11.59" logs/file_operations/*.log
```

**Find operations by fingerprint:**
```bash
grep "Fingerprint: DD:3A:C1:F6:DD:9C:0B" logs/file_operations/*.log
```

## Testing

### 1. Test Certificate Generation
```bash
cd metax_zero_webserver
ls -la certs/localhost/
```

Should show:
- ca.crt, ca.key
- metax-server.crt, metax-server.key
- webserver-client.crt, webserver-client.key

### 2. Test Server Startup
```bash
./start_server.sh
```

Check logs for:
- "Loaded CA certificate for client authentication"
- "Using mutual TLS with client certificate"
- "File operations logging initialized"

### 3. Test Remote Connection Rejection
```bash
# From another machine, try to connect to Metax
curl -k https://YOUR_SERVER_IP:5001/db/get?id=test-uuid
```

Should receive:
```json
{"error":"Access denied. Only localhost connections allowed."}
```

### 4. Test File Operations Logging
```bash
# Perform a file operation
curl --cert path/to/client.pem --key path/to/client-key.pem \
  https://localhost:5003/db/get?id=some-uuid

# Check logs
tail -f logs/file_operations/file_ops_*.log
```

## Troubleshooting

### Certificate Issues

**Problem:** "Failed to load TLS certificates"
**Solution:** Ensure certificate paths are correct in `start.conf`

**Problem:** Connection refused
**Solution:** Check that certificates have correct permissions (readable by Node.js process)

### Localhost Connection Issues

**Problem:** "Access denied. Only localhost connections allowed."
**Solution:** Verify connections are coming from localhost (127.0.0.1, ::1, or ::ffff:127.0.0.1)

### Logging Issues

**Problem:** No logs created
**Solution:** Check that `logs/file_operations/` directory exists and is writable

## Backward Compatibility

The implementation includes fallback mechanisms:
- If CA certificate is not found, system falls back to `rejectUnauthorized: false`
- Warning messages are logged when running in insecure mode
- This allows gradual migration and testing

**For Production:** Ensure all certificates are properly configured to avoid fallback mode.

## Files Modified

1. `metax_2/src/rest_api.mjs` - Added CA validation and localhost restriction
2. `greenhosting_webserver_2/src/webserver.mjs` - Added client certificate usage
3. `greenhosting_webserver_2/src/router.mjs` - Added client cert to session connections and logging
4. `greenhosting_webserver_2/src/file_ops_logger.mjs` - New logging module
5. `setup_scripts/gen_localhost_certs.sh` - Certificate generation script
6. `start.conf` - Added localhost certificate paths
7. `start_server.sh` - Updated to pass certificate parameters

## Next Steps

1. **Certificate Management:**
   - Set up certificate rotation policy
   - Consider using longer validity periods for localhost certs
   
2. **Log Management:**
   - Implement log rotation for file operations logs
   - Set up log archival and retention policy
   - Consider centralized log aggregation

3. **Monitoring:**
   - Set up alerts for rejected connection attempts
   - Monitor certificate expiration dates
   - Track unusual file access patterns

4. **Compliance:**
   - Document retention requirements for file operations logs
   - Implement log integrity verification
   - Set up regular audit reviews

## References

- OpenSSL Documentation: https://www.openssl.org/docs/
- Node.js TLS: https://nodejs.org/api/tls.html
- HTTP/2 in Node.js: https://nodejs.org/api/http2.html
