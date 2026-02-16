/*
 * File Operations Logger
 * 
 * This module tracks all file operations (read, write, copy, delete) including:
 * - Who performed the operation (user ID from certificate)
 * - What operation was performed
 * - Which file/UUID was accessed  
 * - When the operation occurred
 * - Source IP address
 * - Session information
 */

import { createWriteStream, existsSync, mkdirSync } from "fs";
import { randomUUID } from "crypto";

const LOG_DIR = "../logs/file_operations";
let file_ops_log;

export function initialize_file_ops_logging() {
    if (!existsSync(LOG_DIR)) {
        mkdirSync(LOG_DIR, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const log_file = `${LOG_DIR}/file_ops_${timestamp}.log`;

    file_ops_log = createWriteStream(log_file, { flags: 'a', encoding: 'utf8' });

    // Write header
    file_ops_log.write("=".repeat(80) + "\n");
    file_ops_log.write("FILE OPERATIONS LOG\n");
    file_ops_log.write(`Started: ${new Date().toISOString()}\n`);
    file_ops_log.write("=".repeat(80) + "\n\n");

    console.log(`File operations logging initialized: ${log_file}`);
}

/**
 * Log a file operation
 * @param {Object} params - Log parameters
 * @param {string} params.operation - Operation type: 'read', 'write', 'copy', 'delete'
 * @param {string} params.uuid - UUID of the file being accessed
 * @param {string} params.user_id - User ID from certificate (if available)
 * @param {string} params.session_id - Session ID
 * @param {string} params.ip_address - Remote IP address
 * @param {string} params.mime_type - MIME type of the file (optional)
 * @param {number} params.file_size - Size of the file in bytes (optional)
 * @param {string} params.fingerprint - Certificate fingerprint (optional)
 * @param {Object} params.additional - Any additional metadata
 */
export function log_file_operation(params) {
    if (!file_ops_log) {
        console.error("File operations logger not initialized");
        return;
    }

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
    const log_id = randomUUID();

    // Create structured log entry
    const log_entry = {
        log_id,
        timestamp,
        operation,
        uuid,
        user_id,
        session_id,
        ip_address,
        fingerprint,
        mime_type,
        file_size,
        ...additional
    };

    // Write formatted log entry
    file_ops_log.write(`[${timestamp}] ${operation.toUpperCase()}\n`);
    file_ops_log.write(`  Log ID: ${log_id}\n`);
    file_ops_log.write(`  UUID: ${uuid}\n`);
    file_ops_log.write(`  User: ${user_id}\n`);
    file_ops_log.write(`  Session: ${session_id}\n`);
    file_ops_log.write(`  IP: ${ip_address}\n`);
    if (fingerprint) file_ops_log.write(`  Fingerprint: ${fingerprint}\n`);
    if (mime_type) file_ops_log.write(`  MIME Type: ${mime_type}\n`);
    if (file_size !== null) file_ops_log.write(`  Size: ${file_size} bytes\n`);

    // Log additional metadata
    const extra_keys = Object.keys(additional);
    if (extra_keys.length > 0) {
        file_ops_log.write(`  Additional Info:\n`);
        extra_keys.forEach(key => {
            file_ops_log.write(`    ${key}: ${JSON.stringify(additional[key])}\n`);
        });
    }

    file_ops_log.write("\n");
}

/**
 * Extract user information from a session/stream
 */
export function extract_user_info(session_or_stream) {
    try {
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
        return {
            fingerprint: '',
            subject: '',
            remote_address: 'unknown'
        };
    }
}

export function close_file_ops_logging() {
    if (file_ops_log) {
        file_ops_log.write("\n" + "=".repeat(80) + "\n");
        file_ops_log.write(`Closed: ${new Date().toISOString()}\n`);
        file_ops_log.write("=".repeat(80) + "\n");
        file_ops_log.end();
    }
}

// Ensure logging is closed on process exit
process.on('exit', close_file_ops_logging);
process.on('SIGINT', () => {
    close_file_ops_logging();
    process.exit(0);
});
