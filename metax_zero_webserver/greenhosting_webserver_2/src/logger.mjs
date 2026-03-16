/*
======================= logger.mjs - Structured Logger Singleton ==============

This module implements a singleton Logger class that supports writing structured
log messages to both the console and a rotating log file simultaneously.

--- Log Levels ---

  trace(module, message)   - Detailed debug/trace information.
  info(module, message)    - General informational messages.
  warning(module, message) - Non-fatal warnings.
  error(module, message)   - Error conditions.

--- Log Format ---

  Log entries follow a configurable pattern string.
  Default pattern: "%p %Y-%m-%d %H:%M:%S.%i %s: %t"
  Tokens:
	%p - Log level/priority (Trace, Info, Warning, Error)
	%Y - 4-digit year
	%m - Month (1-12)
	%d - Day of month
	%H - Hours
	%M - Minutes
	%S - Seconds
	%i - Milliseconds
	%s - Module/source name
	%t - The actual log message text

--- File Channel and Log Rotation ---

  When a file channel is configured, logs are written to a file.
  The file is automatically rotated when it reaches the configured size limit
  (default: 50 MB). On rotation:
	1. The current log file is renamed to "<path>.tmp".
	2. The .tmp file is compressed with gzip into "<path>_<timestamp>.gz".
	3. A new log file is opened at the original path.
  While rotating, new log entries are buffered in tmp_file_log and written
  to the new file once it is open.

--- Singleton Pattern ---

  Only one instance of Logger can exist. The constructor asserts failure if
  a second instance is attempted. The singleton is exported as the default.
  Import as: import logger from "./logger.mjs"

================================================================================
*/

// ====================== Imports from standard libraries ======================

// File stream utilities for reading, writing, rotating log files.
import {
	createReadStream
	, createWriteStream
	, statSync      // Used to check the existing log file size on startup.
	, unlinkSync    // Used to delete the .tmp file after compression.
	, renameSync
} from "fs"; // Renames the log file to .tmp during rotation.
// createGzip: Creates a Gzip transform stream for log file compression.
import { createGzip } from "zlib";

// ========================= Singleton Guard ===================================

// Sentinel value to track whether the Logger has been instantiated.
// Compared in the constructor to prevent creating a second instance.
const notDefinedYet = 0;

/** The logger singleton object - export target. Set after class definition. */
let logger = notDefinedYet;

// ========================= Logger Class =====================================

class Logger {
	// Constructor enforces singleton: asserts if Logger is instantiated twice.
	// Initializes all channels as disabled and sets default pattern.
	constructor() {
		console.assert(logger === notDefinedYet,
			'Trying to create second instance of class Logger');
		this.file_channel = { usage: false };   // File logging disabled by default.
		this.console_channel = { usage: false }; // Console logging disabled by default.
		this.pattern = "%p %Y-%m-%d %H:%M:%S.%i %s: %t"; // Default log format.
		this.log_size = 0;          // Tracks current log file size in bytes for rotation.
		this.tmp_file_log = "";     // Buffers log entries written during a rotation.
		this.is_rotating = false;   // Prevents re-entrant rotation.
	}

	/*  
	  *  @summary Configures logger with the given options object.
		  *  @param {Object} config - Configuration object containing:
		  *    - console_channel.usage: boolean - enable console output.
		  *    - file_channel.usage: boolean - enable file output.
		  *    - file_channel.path: string - path to log file.
		  *    - file_channel.rotation: number - max file size in MB before rotation.
		  *    - pattern: string - log format pattern string.
		  *  @returns {Object|Promise} success result or Promise resolving to it.
		  *  Opens the file channel if enabled and resolves once the stream is ready.
	 */
	configure = (config) => {
		const success_res = { "status": "success" };
		if (config.console_channel.usage === true) {
			this.console_channel = config.console_channel;
		}
		if (config.pattern !== undefined) {
			this.pattern = config.pattern;
		}
		if (config.file_channel.usage === true) {
			this.file_channel = config.file_channel;
			if (this.file_channel.path === undefined) {
				return {
					"status": "error",
					"message": "file channel is enabled, but path not specified"
				};
			}
			// Default rotation size: 50 MB.
			if (this.file_channel.rotation === undefined) {
				this.file_channel.rotation = 50;
			}
			// Convert rotation limit from MB to bytes.
			this.file_channel.rotation *= 1024 ** 2;
			// Open the log file for appending; resolve the promise when ready.
			return new Promise((res, rej) => {
				this.file_channel.stream = createWriteStream(this.file_channel.path,
					{ 'flags': 'a', 'encoding': "utf8" });
				this.file_channel.stream.on("open", () => {
					// Record the existing file size so rotation triggers at the right time.
					this.change_log_size(
						(statSync(this.file_channel.path).size))
					res(success_res)
				});
				this.file_channel.stream.on("error",
					(e) => res({
						"status": "error",
						"message": this.handle_file_channel_error(e)
					}))
			})

		}
		return success_res;
	};

	/* private method
	 * Translates a file stream error code into a human-readable error message.
	 * Handles EACCES (permission denied) and ENOENT (directory not found).
	 */
	handle_file_channel_error = (e) => {
		switch (e.code) {
			case "EACCES":
				return "Unable to initialize file logger, permission denied.";
			case "ENOENT":
				return "Unable to initialize file logger, no such directory.";
			default:
				return e.message;
		}
	}

	/* private method
	 * Writes a log payload string to the file channel.
	 * If rotation is in progress, buffers the message in tmp_file_log instead.
	 */
	write_in_file_channel = (payload) => {
		if (this.file_channel.usage) {
			if (!this.is_rotating) {
				// Normal operation: write directly to the log file stream.
				this.file_channel.stream.write(`${payload}`)
				this.change_log_size(payload.length);
			} else {
				// During rotation: buffer the entry to write once the new file opens.
				this.tmp_file_log += payload;
			}
		}

	}

	/*  
	  *  @summary Logs a warning-level message.
		  *  @param {String} module - The module/source name to include in the log entry.
		  *  @param {String} message - The warning message text. 
	 */
	warning = (module, message) => {
		let payload = this.construct_log("Warning", module, message);
		this.write_in_file_channel(payload);
		if (this.console_channel.usage) console.warn(payload)
	}


	/*
	  *  @summary Logs an error-level message.
		  *  @param {String} module - The module/source name to include in the log entry.
		  *  @param {String} message - The error message text. 
	 */
	error = (module, message) => {
		let payload = this.construct_log("Error", module, message);
		this.write_in_file_channel(payload);
		if (this.console_channel.usage) console.error(payload)
	}

	/*  
	  *  @summary Logs a trace-level (debug) message.
		  *  @param {String} module - The module/source name to include in the log entry.
		  *  @param {String} message - The trace message text. 
	 */
	trace = (module, message) => {
		let payload = this.construct_log("Trace", module, message);
		this.write_in_file_channel(payload);
		if (this.console_channel.usage) console.log(payload)
	}

	/*  
	  *  @summary Logs an info-level message.
		  *  @param {String} module - The module/source name to include in the log entry.
		  *  @param {String} message - The informational message text. 
	 */
	info = (module, message) => {
		let payload = this.construct_log("Info", module, message);
		this.write_in_file_channel(payload);
		if (this.console_channel.usage) console.log(payload)
	}

	/* private method
	 * Increments the tracked log file size by s bytes and triggers rotation
	 * if the total exceeds the configured rotation threshold.
	 */
	change_log_size = (s) => {
		this.log_size += s;
		if (this.log_size >= this.file_channel.rotation) {
			this.rotate_log_file();
		}
	}

	/* private method
	 * Compresses the renamed .tmp log file using gzip and writes the archive.
	 * Called after the current log file has been renamed to "<path>.tmp".
	 * The archive is saved as "<path>_<timestamp>.gz".
	 * Deletes the .tmp file after compression is complete.
	 */
	archive_log_file = () => {
		createReadStream(`${this.file_channel.path}.tmp`)
			.pipe(createGzip())
			.pipe(createWriteStream(
				`${this.file_channel.path}_${Date.now()}.gz`))
			.on("finish", () =>
				unlinkSync(`${this.file_channel.path}.tmp`)
			)
	}

	/* private method
	 * Performs log file rotation:
	 * 1. Sets is_rotating = true to buffer new log writes during rotation.
	 * 2. Closes the current log file stream.
	 * 3. Renames the current file to "<path>.tmp".
	 * 4. Starts asynchronous gzip compression of the .tmp file.
	 * 5. Opens a new log file stream.
	 * 6. Flushes the buffered tmp_file_log to the new file.
	 * Prevents re-entrant rotation via the is_rotating guard.
	 */
	rotate_log_file = async () => {
		// Prevent multiple concurrent rotations.
		if (this.is_rotating) return;
		this.is_rotating = true;
		this.file_channel.stream.close(() => {
			this.log_size = 0;
			// Move current log to .tmp for archiving.
			renameSync(this.file_channel.path, `${this.file_channel.path}.tmp`);
			// Compress the .tmp file into a dated .gz archive.
			this.archive_log_file();
			// Open a new log file at the original path.
			this.file_channel.stream = createWriteStream(
				this.file_channel.path,
				{ 'flags': 'a', 'encoding': "utf8" });
			this.file_channel.stream.on("open", () => {
				// Flush any log entries that accumulated during rotation.
				this.file_channel.stream.write(this.tmp_file_log);
				this.is_rotating = false;
				this.change_log_size(this.tmp_file_log.length);
				this.tmp_file_log = "";
			});
		})
	}

	/* private method
	 * Builds a formatted log line by replacing all pattern tokens with their
	 * current values (timestamp components, level, module, message).
	 * Appends a newline at the end.
	 *
	 * @param {String} t   - Log level label (e.g., "Trace", "Error").
	 * @param {String} mod - Module/source name.
	 * @param {String} mes - The log message.
	 * @returns {String} The formatted log line.
	 */
	construct_log = (t, mod, mes) => {
		const date = new Date();
		let payload = this.pattern;
		payload = payload.replace("%p", t);            // Log level
		payload = payload.replace("%Y", date.getFullYear()); // Year
		payload = payload.replace("%m", date.getMonth() + 1); // Month (1-based)
		payload = payload.replace("%d", date.getDate()); // Day
		payload = payload.replace("%H", date.getHours()); // Hours
		payload = payload.replace("%M", date.getMinutes()); // Minutes
		payload = payload.replace("%S", date.getSeconds()); // Seconds
		payload = payload.replace("%i", date.getMilliseconds()); // Milliseconds
		payload = payload.replace("%s", mod);          // Module name
		payload = payload.replace("%t", mes);          // Message text
		return payload + '\n'
	}

}

// ========================= Singleton Instantiation ===========================

// Create the single Logger instance and assign to the module-level variable.
// This prevents any future constructor call from succeeding (the assert fires).
logger = new Logger();

// Export the singleton as the default export.
export default logger;
