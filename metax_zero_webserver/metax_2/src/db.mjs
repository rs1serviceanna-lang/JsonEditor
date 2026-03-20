/*
================= db.mjs - Core File-Based Key-Value Storage ==================

This module implements a persistent high-performance key-value storage system 
built directly on the Node.js file system. It provides the low-level primitives 
(get, save, delete) for all higher-level Metax layers like ODM and REST APIs.

--- Storage Architecture ---

Every stored item is uniquely identified by a UUID. On disk, an item consists 
of exactly two files within the configured storage directory:

  1. Data file:     Contains the raw binary or text payload.
					Path: <storage_dir>/<uuid>
  2. Contract file: A JSON metadata record describing the data file.
					Path: <storage_dir>/<uuid>.contract
					Required schema: { "path": string, "mime": string }

The contract file is the "source of truth" for the content's MIME type and 
physical location. It must be present for a UUID to be considered valid state.

--- Key Format (UUIDs) ---

Metax uses a high-entropy "Double-UUID" format for data keys:
Format: "<uuid_v4>-<uuid_v4>" (two UUIDs concatenated by a dash).
This ensures statistically zero collision probability across large datasets.
All incoming keys are validated via global.is_valid_uuid() before processing.

--- Access Patterns & Concurrency ---

The module supports two access patterns:

  1. Asynchronous (Stream-based):
	 - get_uuid(): Returns a readable stream; supports HTTP Range requests
	   (Partial Content 206) for optimized media streaming (fixed 2MB chunks).
	 - save_uuid(): Returns a Promise; supports direct piping (Node streams)
	   or multipart/form-data boundary parsing.

  2. Synchronous (Blocking):
	 - get_uuid_sync(): Reads the entry into memory in a single blocked call.
	 - save_uuid_sync(): Writes the entire payload in a single blocked call.

  *CRITICAL:* Synchronous methods should only be used for small JSON or text 
  metadata. Using them for large payloads will freeze the Node.js event loop.

--- Write Protection (Integrity) ---

Concurrent write protection is handled by the `open_files` registry. If a write 
is requested for a UUID currently being written, the operation waits for the 
previous stream to close before starting. This prevents data corruption 
from race conditions.

--- Lifecycle & Initialization ---

initialize_db() verifies and prepares the storage path set in global.config. 
It ensures the path exists and is normalized. Failure to access the storage 
directory results in process termination (exit -1) as the system is disk-critical.

================================================================================
*/

// ====================== Node.js Standard Library Imports =====================

import {
	createReadStream,  // Optimized reading via streams (low memory overhead)
	createWriteStream, // Optimized writing via streams (prevents memory spikes)
	readFileSync,      // Sync read (blocking, only for small metadata)
	writeFileSync,     // Sync write (blocking, only for small metadata)
	existsSync,        // Check file presence
	mkdirSync,         // Create directories
	statSync,          // Get file metadata (size, dates)
	unlinkSync         // Delete files
} from "fs";

import { join } from "path"; // Precise cross-platform path handling

// Library for unique key generation
import { randomUUID } from "crypto";

// ======================= Third-Party Library Imports =======================
// Reserved for npm/external libraries if needed in the future.
// Currently, the core DB relies only on Node.js built-in modules.

// ============================ Open Files Tracking ==========================

// Keeps track of files being written to prevent simultaneous writes
// on the same file, which could corrupt data.
const open_files = {};

// ========================= Database Initialization =========================

// This function ensures that the storage directory exists and is ready for read/write operations.
// It must be called before any other database access (reading/writing UUID files).
//
// Responsibilities:
// - Verify that a storage path is set in the configuration.
// - Create the storage folder if it does not exist.
// - Normalize the path to always end with '/' for safe file path concatenation.
// - Exit the application if the folder cannot be created (permissions or invalid path).
// Normalizes and prepares the storage backend.
// This is critical startup logic that must succeed for Metax to operate.
export function initialize_db() {

	// Ensure that the storage path is defined in the configuration.
	assert(config.storage !== undefined, "storage path is not specified.");

	// Check if the storage directory already exists.
	if (!existsSync(config.storage)) {
		try {
			// If the directory does not exist, create it recursively.
			mkdirSync(config.storage, { recursive: true });
			console.log(`Storage directory created: ${config.storage}`);
		} catch (e) {
			if (e.code === "EACCES") {
				console.error(`FATAL: Permission denied to create storage: ${config.storage}`);
			} else {
				console.error(`FATAL: Unable to prepare storage directory: ${e.message}`);
			}
			process.exit(-1);
		}
	}

	// Normalize storage path to end with a directory separator for safe concatenation.
	if (config.storage[config.storage.length - 1] !== "/" && config.storage[config.storage.length - 1] !== "\\") {
		config.storage += "/";
	}

	console.log("metax db initialized successfully");
}

// ======================== Read UUID Operations =============================

// Retrieves data associated with a UUID from storage.
// Supports both full file reading and partial chunked streaming.
//
// Parameters:
// - uuid: Unique identifier of the stored file
// - start_byte: Byte position where reading should start (default: 0)
// - end_byte: Byte position where reading should stop (calculated if not provided)
// - chunking: Enables chunked streaming for large media files (default: true)
//
// Returns: An object containing MIME type, file length, stream type, and a readable stream
//
// How it works:
// 1. Validates that the UUID format is correct
// 2. Loads the contract file to obtain MIME metadata
// 3. Determines whether streaming should be partial (for video/audio) or full
// 4. For partial streaming, calculates the chunk range using Math.min to ensure
//    we don't read past the file end
// 5. Creates a readable file stream for either the full file or specific byte range
export function get_uuid(uuid, start_byte, end_byte, chunking = true) {
	// Validate UUID format
	if (!is_valid_uuid(uuid)) throw new Error("Invalid UUID format.");

	// Load contract metadata
	const contract = get_contract_file(uuid);

	// Ensure MIME type exists
	assert(contract.mime !== undefined, "Missing mime type in contract in get_uuid.");

	// Prepare response metadata
	const response = {
		mime: contract.mime,
		length: get_data_length(uuid)
	}

	// Enable chunked streaming for video/audio files
	// This allows seeking and prevents loading entire files into memory
	if (
		chunking &&
		(contract.mime.split("/")[0] === "video" ||
			contract.mime.split("/")[0] === "audio")
	) {
		response.type = "partial";

		// Fixed chunk size (2MB) - good balance for streaming
		const chunk_size = 2000000;

		// Calculate end byte if not provided
		// Math.min ensures we don't read past the file end:
		// - start_byte + chunk_size is the intended chunk end
		// - response.length - 1 is the actual last byte of the file
		// Example: if file is 1,500,000 bytes and start_byte = 0, chunk_size = 2,000,000
		// then Math.min(2,000,000, 1,499,999) = 1,499,999 (file's actual end)
		end_byte = (end_byte !== undefined && end_byte !== null)
			? end_byte
			: Math.min(start_byte + chunk_size, response.length - 1);
		response.end_byte = end_byte;

		// Create stream for specific byte range
		response.data_stream = read_file_stream(uuid, start_byte, end_byte);
	} else {
		// Return full file stream for non-media files or when chunking is disabled
		response.type = "full";
		response.data_stream = read_file_stream(uuid);
	}

	return response;
}

// Synchronous version of get_uuid.
// Reads the entire file into memory and returns the data directly.
//
// Parameters:
// - uuid: Unique identifier of the stored file
//
// Returns: Object containing MIME type and file data
//
// Use case:
// Suitable only for small files because it loads the entire file into memory.
// Use get_uuid (streaming version) for large files.
// WARNING: This blocks execution until the entire file is read.
export function get_uuid_sync(uuid) {
	// Validate UUID format
	if (!is_valid_uuid(uuid)) throw new Error("Invalid UUID format.");

	// Load contract metadata
	const contract = get_contract_file(uuid);

	// Ensure MIME type exists
	assert(contract.mime !== undefined, "Missing mime type in contract in get_uuid.");

	// Read full file content into memory
	const data = read_file(uuid);

	return {
		mime: contract.mime,
		data: data
	};
}

// ======================== Save UUID Operations =============================

// Saves data to disk and assigns it a UUID (unique identifier).
// This function handles both new saves (generates a new UUID) and updates (uses existing UUID).
//
// Parameters:
// - data_stream: The incoming data (as a stream) to be saved
// - mime: The MIME type of the data (e.g., "image/png", "video/mp4")
// - type: How the data is formatted - either "node" (Node.js stream) or "data" (form data)
// - uuid: Optional. If provided and valid, updates existing file. If not, creates new UUID.
//
// Returns: A promise that resolves with the UUID when save completes
//
// How it works:
// 1. Checks if UUID already exists and updates its contract file if MIME type changed
// 2. If no valid UUID provided, generates a new one (combining two randomUUIDs for uniqueness)
//    and creates a contract file
// 3. Saves the actual data using either:
//    - pipe (for Node streams) - direct streaming to disk
//    - write_form_data_stream (for form data) - handles multipart boundaries
// 4. Returns the UUID via Promise resolution for async handling
export function save_uuid(data_stream, mime, type, uuid) {
	return new Promise(async (res, rej) => {
		// Check if we're updating an existing file
		if (is_valid_uuid(uuid)) {
			const contract = get_contract_file(uuid);
			// If the MIME type has changed, update the contract file
			if (contract.mime !== mime) {
				set_contract_file(uuid, mime);
			}
		} else {
			// Generate a new UUID by combining two random UUIDs for extra uniqueness
			uuid = `${randomUUID()}-${randomUUID()}`;
			// Create a new contract file for this UUID
			set_contract_file(uuid, mime);
		}
		try {
			// Handle Node.js stream (simpler case)
			if (type === "node") {
				// Get a write stream for this file
				const write_stream = await write_file_stream(uuid);
				// Pipe the incoming data directly to the file without loading into RAM
				data_stream.pipe(write_stream);
				// When writing is complete, resolve with the UUID
				write_stream.on("finish", () => {
					res(uuid);
				});
			}
			// Handle form data (requires special processing to extract file content)
			else if (type === "data") {
				await write_form_data_stream(data_stream, uuid, res, rej);
			}
		} catch (e) {
			// If anything goes wrong, reject the promise
			rej("Can't save uuid");
			return
		}
	})
}

// Saves data to disk synchronously (blocks execution until complete).
// Use this for small files where you need immediate confirmation of save.
//
// Parameters:
// - data: The actual data to save (buffer or string)
// - uuid: Optional. If provided and valid, updates existing file. If not, creates new UUID.
// - mime: The MIME type of the data
//
// Returns: The UUID of the saved file
//
// How it works:
// 1. Similar to save_uuid, but handles everything in one blocking operation
// 2. Validates inputs and UUID
// 3. Writes data directly to disk in one operation (entire file at once)
// 4. Returns UUID immediately when done
// WARNING: This blocks execution - use only for small files
export function save_uuid_sync(data, uuid, mime) {
	// Check if we're updating an existing file
	if (is_valid_uuid(uuid)) {
		const contract = get_contract_file(uuid);
		// If the MIME type has changed, update the contract file
		if (contract.mime !== mime) {
			set_contract_file(uuid, mime);
		}
	} else {
		// Generate a new UUID
		uuid = `${randomUUID()}-${randomUUID()}`;
		// Create a new contract file
		set_contract_file(uuid, mime);
	}

	// Safety checks to ensure we have valid inputs
	assert(is_valid_uuid(uuid), "save_uuid_sync invalid uuid");
	assert(data !== undefined, "save_uuid_sync received empty data");

	try {
		// Write the entire data to disk at once (blocking operation)
		writeFileSync(join(config.storage, uuid), data);
		return uuid;
	} catch (err) {
		throw new Error("failed save uuid sync");
	}
}

// ======================== Delete UUID Operations ===========================

// Removes a file and its contract from storage.
//
// Parameters:
// - uuid: The unique identifier of the file to delete
//
// How it works:
// 1. First checks that the contract file exists (validates UUID and ensures file exists)
// 2. Deletes the contract file (metadata - contains MIME type and path)
// 3. Deletes the data file (actual content)
// This ensures complete cleanup and maintains storage consistency.
export function delete_uuid(uuid) {
	// Verify the UUID exists by getting its contract (throws error if not found)
	get_contract_file(uuid);
	// Delete the contract file (contains metadata like MIME type)
	delete_file(uuid + ".contract");
	// Delete the actual data file
	delete_file(uuid);
}

// ==================== Contract File Operations =============================

// Reads and parses the contract file for a UUID.
// Contract files store metadata about the data file (like MIME type and path).
//
// Parameters:
// - uuid: The unique identifier whose contract to read
//
// Returns: An object with the contract data (must include 'mime' property)
//
// How it works:
// 1. Validates the UUID format
// 2. Reads the contract file from disk (JSON file with .contract extension)
// 3. Parses the JSON content
// 4. Validates that MIME type is present (required field)
// 5. Returns the contract object
//
// Contract file example:
// { "path": "storage/abc-123", "mime": "image/png" }
function get_contract_file(uuid) {
	// Make sure the UUID format is correct
	assert(is_valid_uuid(uuid), "get_contract_file received invalid uuid");

	// Read the contract file (it's a JSON file with .contract extension)
	const contract_blob = read_file(`${uuid}.contract`);

	let contract;
	try {
		// Parse the JSON content
		contract = JSON.parse(contract_blob);
	} catch (e) {
		throw new Error("Unable to parse contract file");
	}

	// Every contract must have a MIME type
	if (contract.mime === undefined) {
		throw new Error(`Mime type missing in contract file of ${uuid}`);
	}

	return contract;
}

// Creates or updates a contract file for a UUID.
// This stores metadata about the data file.
//
// Parameters:
// - uuid: The unique identifier to create/update contract for
// - mime: The MIME type of the data (e.g., "image/jpeg", "text/plain")
//
// How it works:
// 1. Validates UUID format
// 2. Creates a contract object with path and MIME type
// 3. Serializes to JSON and saves to disk with .contract extension
//
// This metadata is essential for later retrieval and proper content type handling.
function set_contract_file(uuid, mime) {
	// Make sure the UUID format is correct
	assert(is_valid_uuid(uuid), "set_contract_file received invalid uuid");

	// Create the contract object with file path and MIME type
	const contract = { "path": `storage/${uuid}`, "mime": mime };

	// Save the contract as a JSON file
	write_file(`${uuid}.contract`, JSON.stringify(contract));
}

// ===================== File Metadata Operations ============================

// Gets the size of a file in bytes.
//
// Parameters:
// - f: The filename (without path, path is added automatically from config.storage)
//
// Returns: The file size in bytes
//
// How it works:
// 1. Uses statSync to get file statistics (size, timestamps, etc.)
// 2. Extracts and returns only the size property
//
// Used primarily in get_uuid to determine chunk ranges for streaming.
// Gets the size of a data file in bytes.
// Path is automatically resolved within the storage directory.
function get_data_length(f) {
	try {
		assert(f !== undefined, "get_data_length received undefined argument");
		const stats = statSync(join(config.storage, f));
		return stats.size;
	} catch (e) {
		throw new Error(`Failed to resolve file length for storage item: ${f}`);
	}
}

// ======================= File Reading Operations ===========================

// Reads an entire file into memory at once.
// Use this for small files only (like contract files).
//
// Parameters:
// - f: The filename to read
//
// Returns: The file contents as a buffer or string
//
// How it works:
// 1. Validates filename is provided
// 2. Reads entire file synchronously (blocks execution)
// 3. Returns the complete content
//
// WARNING: Only use for small files (contract files, small text files)
// For large files, use read_file_stream to avoid memory issues.
function read_file(f) {
	assert(f !== undefined, "read_file didn't receive any argument");
	try {
		return readFileSync(join(config.storage, f));
	} catch (e) {
		console.log(`Failed to read_file ${f}, error code: `, e.code);
		throw new Error(`${f} not found in storage.`);
	}
}

// Creates a stream to read a file (or part of it).
// Use this for large files to avoid loading everything into memory.
//
// Parameters:
// - f: The filename to read
// - start: Optional. Byte position to start reading from
// - end: Optional. Byte position to stop reading at
//
// Returns: A readable stream
//
// How it works:
// 1. If no start/end provided, streams the entire file
// 2. If start/end provided, streams only that byte range (useful for video seeking)
//
// This enables efficient handling of large media files where only portions
// need to be read at a time (e.g., video player seeking).
function read_file_stream(f, start, end) {
	try {
		assert(f !== undefined, "read_file_stream didn't receive any argument");

		const filePath = join(config.storage, f);
		if (start === undefined || end === undefined) {
			return createReadStream(filePath);
		}
		else {
			return createReadStream(filePath, { start, end });
		}
	} catch (e) {
		console.log(`failed to get file ${f}, error code: `, e.code);
		throw new Error(`Unable to read uuid ${f}`);
	}
}

// ======================= File Writing Operations ===========================

// Writes data to a file all at once (blocking operation).
// Use this for small files where you have all the data ready.
//
// Parameters:
// - f: The filename to write to
// - b: The data to write (buffer or string)
//
// How it works:
// 1. Validates both filename and data are provided
// 2. Writes entire content to disk in one synchronous operation
//
// Used primarily for contract files and other small metadata files.
function write_file(f, b) {
	try {
		assert(f !== undefined, "write_file didn't receive file path.");
		assert(b !== undefined, "write_file didn't receive file body.");
		return writeFileSync(join(config.storage, f), b);
	} catch (e) {
		console.log(`Failed to write_file ${f}, error code: `, e.code);
		throw new Error(`Unable to save in ${f}`);
	}
}

// Creates a stream for writing to a file.
// Use this for large files or when data arrives in chunks.
//
// Parameters:
// - f: The filename to write to
//
// Returns: A promise that resolves with a writable stream
//
// How it works:
// 1. Checks if file is already being written (prevents corruption from concurrent writes)
// 2. If file is free, creates a new write stream immediately
// 3. If file is busy, waits for "close" event, then creates stream
//
// The open_files tracking is critical for data integrity - it prevents
// multiple simultaneous writes to the same file which could corrupt data.
function write_file_stream(f) {
	// Make sure a filename was provided
	assert(f !== undefined, "write_file_stream didn't receive any argument");

	return new Promise((res, rej) => {
		// Check if this file is currently being written to
		if (!open_files[f]) {
			// File is free, create write stream now
			const write_stream = create_write_file_stream(f);
			res(write_stream);
			return
		}

		// File is busy, wait for it to close
		open_files[f].on("close", () => {
			const write_stream = create_write_file_stream(f);
			res(write_stream);
		})
	})
}

// Actually creates the write stream and registers it as open.
// This is called by write_file_stream after checking if file is available.
//
// Parameters:
// - f: The filename to create stream for
//
// Returns: A writable stream
//
// How it works:
// 1. Creates the write stream
// 2. Registers it in open_files to prevent simultaneous writes
// 3. Sets up cleanup when stream closes (removes from open_files)
//
// The registration/cleanup cycle ensures concurrent write protection.
function create_write_file_stream(f) {
	try {
		const write_stream = createWriteStream(join(config.storage, f));
		open_files[f] = write_stream;
		write_stream.on("close", () => {
			delete open_files[f];
		})
		return write_stream
	} catch (e) {
		throw new Error(`Failed to initialize write stream for ${f}`);
	}
}

// Handles saving form data (multipart/form-data) to a file.
// Form data includes boundaries and headers that need to be stripped out.
//
// Parameters:
// - data_stream: The incoming form data stream
// - uuid: The UUID to save data under
// - res: Promise resolve function (called when save completes)
// - rej: Promise reject function (called if save fails)
//
// How it works:
// 1. First chunk processing:
//    - Extract boundary separator (first line before \n)
//    - Skip next 3 lines (Content-Disposition, Content-Type, blank line)
//    - Only actual file data remains
// 2. Subsequent chunks:
//    - Check for closing boundary (\r\n + separator)
//    - If found, truncate chunk before the boundary
//    - Write cleaned data to file
// 3. Stream end:
//    - Close file and resolve promise with UUID
//
// Example boundary format:
// ------WebKitFormBoundary7MA4YWxkTrZu0gW
// Content-Disposition: form-data; name="file"; filename="image.png"
// Content-Type: image/png
// [blank line]
// [actual file data]
// ------WebKitFormBoundary7MA4YWxkTrZu0gW--
async function write_form_data_stream(data_stream, uuid, res, rej) {
	let is_first_chunk = true;  // Track if this is the first piece of data
	let separator = '';          // Will store the boundary string

	// Get a write stream for this UUID
	let write_stream = await write_file_stream(uuid);

	// Process each chunk of data as it arrives
	data_stream.on('data', (chunk) => {
		// Special handling for the first chunk
		if (is_first_chunk) {
			// Find the boundary separator (first line before newline)
			let i = chunk.indexOf("\n");
			separator = chunk.slice(0, i - 1);
			chunk = chunk.slice(i + 1);

			// Skip the next 3 lines (Content-Disposition, Content-Type, blank line)
			for (let j = 0; j < 3; j++) {
				i = chunk.indexOf("\n");
				chunk = chunk.slice(i + 1);
			}

			is_first_chunk = false;
		}

		// Check if this chunk contains the closing boundary
		const separator_index = chunk.indexOf("\r\n" + separator);
		if (separator_index !== -1) {
			// Cut off everything from the boundary onward
			chunk = chunk.slice(0, separator_index);
		}

		// Write the actual file data (headers and boundaries removed)
		write_stream.write(chunk);
	})
		.on('end', () => {
			// All data received, close the file
			write_stream.close();
			// Notify that save completed successfully
			res(uuid);
		})
		.on('error', (err) => {
			// Something went wrong during save
			rej("failed to save");
		});
}

// ======================= File Deletion Operations ==========================

// Removes a file from disk.
//
// Parameters:
// - f: The filename to delete
//
// Returns: An object with status "success"
//
// How it works:
// 1. Validates filename is provided
// 2. Deletes the file from disk synchronously
// 3. Returns success status
//
// Used by delete_uuid to remove both data and contract files.
function delete_file(f) {
	try {
		assert(f !== undefined, "delete_file didn't receive any argument");
		unlinkSync(join(config.storage, f));
		return { "status": "success" };
	} catch (e) {
		throw new Error(`Failed to delete storage file: ${f}`);
	}
}