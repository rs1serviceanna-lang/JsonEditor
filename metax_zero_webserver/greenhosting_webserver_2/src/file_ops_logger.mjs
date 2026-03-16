/*
================ file_ops_logger.mjs - File Operations Audit Logger ===========

This module provides structured audit logging for all file operations
performed through the greenhosting webserver. It tracks:

  - Who performed the operation (user ID from their client certificate CN).
  - What operation was performed: "read", "write", "copy", or "delete".
  - Which file/UUID was accessed.
  - When the operation occurred (ISO timestamp).
  - The source IP address of the session.
  - Session ID and fingerprint for correlation with connection logs.
  - Optional metadata: MIME type, file size, and arbitrary additional fields.

--- Log File Lifecycle ---

  Each server startup creates a new timestamped log file in LOG_DIR:
    logs/file_operations/file_ops_<timestamp>.log

  The file is opened in append mode and each operation is written as a
  human-readable block with one field per line.

  On process exit (normal or SIGINT), the log file is cleanly closed
  with a footer timestamp.

--- Log Entry Format ---

  [<ISO timestamp>] <OPERATION>
    Log ID:      <random UUID for this log entry>
    UUID:        <UUID of the accessed file>
    User:        <user_id from certificate>
    Session:     <session_id>
    IP:          <remote IP address>
    Fingerprint: <certificate fingerprint256>  (if available)
    MIME Type:   <mime_type>                   (if available)
    Size:        <file_size> bytes             (if available)
    Additional Info:
      <key>: <value>                           (for each extra field)

================================================================================
*/

// ====================== Imports from standard libraries ======================

// File system utilities for creating log directories and write streams.
import { createWriteStream, existsSync, mkdirSync } from "fs";
// randomUUID: Generates a unique log entry ID for each operation log line.
import { randomUUID } from "crypto";

// ========================= Constants =========================================

// Directory where all file operation audit logs are stored.
// Relative to the server's working directory.
const LOG_DIR = "../logs/file_operations";

// The active write stream for the current log file.
// Set by initialize_file_ops_logging() and used by log_file_operation().
let file_ops_log;

// ========================= Initialization ====================================

// Creates the log directory if it doesn't exist, then opens a new timestamped
// log file for this server session. Writes a header block to mark the start.
//
// Must be called once at server startup before any file operations are logged.
// Called from webserver.mjs main() after the logger is configured.
export function initialize_file_ops_logging() {
    // Create the log directory (including any missing parent directories).
    if (!existsSync(LOG_DIR)) {
        mkdirSync(LOG_DIR, { recursive: true });
    }

    // Generate a timestamp string safe for use in filenames (dots and colons replaced).
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const log_file = `${LOG_DIR}/file_ops_${timestamp}.log`;

    // Open the log file in append mode with UTF-8 encoding.
    file_ops_log = createWriteStream(log_file, { flags: 'a', encoding: 'utf8' });

    // Write a header block to mark the start of this log session.
    file_ops_log.write("=".repeat(80) + "\n");
    file_ops_log.write("FILE OPERATIONS LOG\n");
    file_ops_log.write(`Started: ${new Date().toISOString()}\n`);
    file_ops_log.write("=".repeat(80) + "\n\n");

    console.log(`File operations logging initialized: ${log_file}`);
}

// ========================= Log Operation =====================================

/**
 * Logs a single file operation as a structured block to the audit log file.
 *
 * @param {Object} params - Parameters describing the operation.
 * @param {string} params.operation   - Operation type: 'read', 'write', 'copy', 'delete'.
 * @param {string} params.uuid        - UUID of the file being accessed.
 * @param {string} [params.user_id]   - User ID from certificate CN (default: 'anonymous').
 * @param {string} [params.session_id]- Session ID for correlation (default: 'unknown').
 * @param {string} [params.ip_address]- Remote IP address (default: 'unknown').
 * @param {string} [params.mime_type] - MIME type of the file (optional).
 * @param {number} [params.file_size] - File size in bytes (optional).
 * @param {string} [params.fingerprint] - Certificate fingerprint256 (optional).
 * @param {Object} [params.additional] - Any extra key-value metadata to log.
 */
export function log_file_operation(params) {
    // Cannot log if the logger was not initialized.
    if (!file_ops_log) {
        console.error("File operations logger not initialized");
        return;
    }

    // Destructure params with defaults for optional fields.
    const {
        operation,
        uuid,
        user_id = 'anonymous',
        session_id = 'unknown',
        ip_address = 'unknown',
        mime_type = '',
        file_size = null,
        fingerprint = '',
        additional = {}
    } = params;

    const timestamp = new Date().toISOString();
    // Assign a unique ID to each log entry for cross-referencing.
    const log_id = randomUUID();

    // Write the formatted log entry, one field per line.
    file_ops_log.write(`[${timestamp}] ${operation.toUpperCase()}\n`);
    file_ops_log.write(`  Log ID: ${log_id}\n`);
    file_ops_log.write(`  UUID: ${uuid}\n`);
    file_ops_log.write(`  User: ${user_id}\n`);
    file_ops_log.write(`  Session: ${session_id}\n`);
    file_ops_log.write(`  IP: ${ip_address}\n`);
    // Only write optional fields if they have a value.
    if (fingerprint) file_ops_log.write(`  Fingerprint: ${fingerprint}\n`);
    if (mime_type) file_ops_log.write(`  MIME Type: ${mime_type}\n`);
    if (file_size !== null) file_ops_log.write(`  Size: ${file_size} bytes\n`);

    // Log any additional metadata as an indented block.
    const extra_keys = Object.keys(additional);
    if (extra_keys.length > 0) {
        file_ops_log.write(`  Additional Info:\n`);
        extra_keys.forEach(key => {
            file_ops_log.write(`    ${key}: ${JSON.stringify(additional[key])}\n`);
        });
    }

    // Blank line separator between log entries for readability.
    file_ops_log.write("\n");
}

// ========================= User Info Extraction ==============================

/**
 * Extracts user identity and network information from a session or stream object.
 * Returns an object with fingerprint, subject (CN), and remote IP address.
 *
 * Used by router.mjs before calling log_file_operation() to populate
 * the fingerprint and ip_address fields.
 *
 * @param {Object} session_or_stream - An HTTP/2 session or stream object
 *   that has a .socket property with getPeerCertificate().
 * @returns {{ fingerprint: string, subject: string, remote_address: string }}
 *   Returns empty strings on any failure (e.g., no certificate present).
 */
export function extract_user_info(session_or_stream) {
    try {
        // Support both session objects and stream objects.
        const socket = session_or_stream.socket || session_or_stream.session?.socket;
        if (!socket) return {};

        const cert = socket.getPeerCertificate();
        const fingerprint = cert.fingerprint256 || '';
        const subject = cert.subject?.CN || '';

        return {
            fingerprint,
            subject,
            remote_address: socket.remoteAddress || 'unknown'
        };
    } catch (e) {
        // Return safe defaults if anything goes wrong (no cert, no socket, etc.).
        return {
            fingerprint: '',
            subject: '',
            remote_address: 'unknown'
        };
    }
}

// ========================= Cleanup ===========================================

// Closes the log file cleanly with a footer timestamp.
// Called automatically on process exit to prevent truncated log files.
export function close_file_ops_logging() {
    if (file_ops_log) {
        file_ops_log.write("\n" + "=".repeat(80) + "\n");
        file_ops_log.write(`Closed: ${new Date().toISOString()}\n`);
        file_ops_log.write("=".repeat(80) + "\n");
        file_ops_log.end();
    }
}

// ========================= Process Exit Handlers =============================

// Ensure the log file is properly closed on normal process exit.
process.on('exit', close_file_ops_logging);

// Close the log file cleanly on Ctrl+C (SIGINT) before exiting.
process.on('SIGINT', () => {
    close_file_ops_logging();
    process.exit(0);
});
