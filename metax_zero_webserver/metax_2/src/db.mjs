/*
=================db.mjs - Core File-Based Key-Value Storage====================

This file implements a disk-based key-value storage system, which serves as the
foundation for the rest of the application (e.g., db_rest_api.mjs, odm.mjs).

Key characteristics:
- Each item is stored using two files:
	1. Data file: contains the actual content (text, image, video, etc.)
	2. Contract file: contains metadata such as MIME type and other information
- Supports both full reads and chunked streaming, essential for large files
  (video/audio) to avoid loading them entirely into memory.
- Provides safe operations for creating, reading, writing, and deleting files.
- Tracks open files to prevent simultaneous writes that could corrupt data.

In short, this file represents the core database layer: a folder of files
with structured access that the rest of the application builds upon.
================================================================================
*/

// ====================== Node.js Standard Library Imports =====================

import {
	createReadStream,  // Creates a readable stream for a file on disk; allows reading large files in chunks without loading the whole file into memory. Useful for streaming video/audio or any large content.
	createWriteStream, // Creates a writable stream for a file on disk; allows writing data incrementally to avoid memory overload. Useful for large uploads or streaming content.
	readFileSync,      // Reads an entire file from disk into memory at once; blocks execution until done. Used for small files like JSON contract metadata or small text files.
	writeFileSync,     // Writes an entire buffer or string to a file on disk at once; blocks execution until done. Used for small files like metadata or short content.
	existsSync,        // Checks synchronously whether a file or directory exists on disk. Returns true/false. Used to verify storage path or file presence before operations.
	mkdirSync,         // Creates a new directory on disk synchronously. Throws an error if the folder cannot be created. Used to initialize storage directories.
	statSync,          // Retrieves file metadata (size, timestamps, etc.) synchronously. Used to calculate chunk ranges for streaming or verify file properties.
	unlinkSync         // Deletes a file from disk synchronously. Used when removing a stored UUID entry (data file or contract file).
} from "fs";

// Generates a unique identifier (UUID) for each file, serving as the key in the database and preventing collisions.
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
export function initialize_db() {

	// Ensure that the storage path is defined in the configuration.
	// Throws an error if config.storage is undefined.
	assert(config.storage !== undefined, "storage path is not specified.");

	// Check if the storage directory already exists.
	if (!existsSync(config.storage)) {
		try {
			// If the directory does not exist, create it.
			mkdirSync(config.storage);

			// Ensure the path ends with a trailing slash '/'
			// This prevents path concatenation errors when accessing files.
			if (config.storage[config.storage.length - 1] !== "/") {
				config.storage += "/";
			}
		} catch (e) {
			// Permission error: the process cannot create the directory due to lack of rights.
			if (e.code === "EACCES") {
				console.error("Unable to create storage directory, permission denied.");
			}
			// Invalid path error: the specified path does not exist or is incorrect.
			else if (e.code === "ENOENT") {
				console.error("Unable to create storage directory, invalid path.");
			}

			// Stop the application if the storage directory cannot be created.
			process.exit(-1);
		}
	}

	// Storage directory is ready; database operations can safely proceed.
	console.log("db initialized");
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
// 2. If no valid UUID provided, generates a new one and creates a contract file
// 3. Saves the actual data using either pipe (for Node streams) or custom handler (for form data)
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
				// Pipe the incoming data directly to the file
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
// 3. Writes data directly to disk in one operation
// 4. Returns UUID immediately when done
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
		writeFileSync(config.storage + uuid, data);
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
// 1. First checks that the contract file exists (validates UUID)
// 2. Deletes the contract file (metadata)
// 3. Deletes the data file (actual content)
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
// Contract files store metadata about the data file (like MIME type).
//
// Parameters:
// - uuid: The unique identifier whose contract to read
//
// Returns: An object with the contract data (must include 'mime' property)
//
// How it works:
// 1. Validates the UUID format
// 2. Reads the contract file from disk
// 3. Parses the JSON content
// 4. Validates that MIME type is present
// 5. Returns the contract object
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
// 3. Converts to JSON and saves to disk
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
// - f: The filename (without path, path is added automatically)
//
// Returns: The file size in bytes
//
// How it works:
// 1. Uses statSync to get file statistics
// 2. Extracts and returns the size property
function get_data_length(f) {
	try {
		// Make sure a filename was provided
		assert(f !== undefined, "get_file_stat didn't receive any argument");
		// Get file stats and return the size
		return statSync(config.storage + f).size;
	} catch (e) {
		throw new Error("failed to get uuid stat.");
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
// 2. Reads entire file synchronously
// 3. Returns the content
function read_file(f) {
	// Make sure a filename was provided
	assert(f !== undefined, "read_file didn't receive any argument");

	try {
		// Read the entire file from disk
		return readFileSync(config.storage + f);
	} catch (e) {
		console.log(`Failed to read_file ${f}, error code: `, e.code);
		throw new Error(`${f} not found.`);
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
function read_file_stream(f, start, end) {
	try {
		// Make sure a filename was provided
		assert(f !== undefined, "read_file_stream didn't receive any argument");

		// Create stream for entire file
		if (start === undefined || end === undefined) {
			return createReadStream(config.storage + f);
		}
		// Create stream for specific byte range
		else {
			return createReadStream(config.storage + f, { start, end });
		}
	} catch (e) {
		console.log(`failed to get file ${f}, error code: `, e.code);
		throw new Error(`Unable to read uuid ${uuid}`);
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
// 1. Validates inputs
// 2. Writes entire content to disk in one operation
function write_file(f, b) {
	try {
		// Make sure we have both filename and data
		assert(f !== undefined, "write_file didn't receive file path.");
		assert(b !== undefined, "write_file didn't receive file body.");

		// Write the data to disk
		return writeFileSync(config.storage + f, b);
	} catch (e) {
		console.log(`Failed to write_file ${f}, error code: `, e.code);
		throw new Error(`unable to save in ${f}`);
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
// 1. Checks if file is already being written (prevents corruption)
// 2. If file is free, creates a new write stream immediately
// 3. If file is busy, waits for it to close, then creates stream
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
			// Double-check file is actually closed (safety check)
			if (open_files[f] !== undefined) {
				console.error("file already opened for writing");
				rej();
			}
			// Now create the write stream
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
// 3. Sets up cleanup when stream closes
function create_write_file_stream(f) {
	try {
		// Create the write stream
		const write_stream = createWriteStream(config.storage + f);

		// Mark this file as being written to
		open_files[f] = write_stream;

		// When writing is done, remove from open files list
		write_stream.on("close", () => {
			delete open_files[f];
		})

		return write_stream
	} catch (e) {
		throw new Error(`failed to save ${f}`);
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
// 1. First chunk contains boundary separator and headers - extract and remove them
// 2. For remaining chunks, write directly to file
// 3. When final chunk arrives (contains closing boundary), stop before the boundary
// 4. Close the file and resolve the promise
async function write_form_data_stream(data_stream, uuid, res, rej) {
	let is_first_chunk = true;  // Track if this is the first piece of data
	let separator = '';          // Will store the boundary string
	let body = "";               // Not used in current implementation

	// Get a write stream for this UUID
	let write_stream = await write_file_stream(uuid);

	// Process each chunk of data as it arrives
	data_stream.on('data', (chunk) => {
		// Special handling for the first chunk
		if (is_first_chunk) {
			// Find the boundary separator (first line)
			let i = chunk.indexOf("\n");
			separator = chunk.slice(0, i - 1);
			chunk = chunk.slice(i + 1);

			// Skip the next 3 lines (headers like Content-Disposition, Content-Type, blank line)
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

		// Write the actual file data
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
// 2. Deletes the file from disk
function delete_file(f) {
	try {
		// Make sure a filename was provided
		assert(f !== undefined, "delete_file didn't receive any argument");

		// Delete the file
		unlinkSync(config.storage + f);

		return { "status": "success" };
	} catch (e) {
		throw new Error("failed delete file");
	}
}