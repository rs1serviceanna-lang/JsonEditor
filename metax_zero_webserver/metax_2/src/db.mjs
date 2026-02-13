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


export function get_uuid(uuid, start_byte, end_byte, chunking = true) {
	if (!is_valid_uuid(uuid)) throw "invalid uuid";
	const contract = get_contract_file(uuid);
	assert(contract.mime !== undefined, "Missing mime type in contract in get_uuid.");
	const response = {
		mime: contract.mime,
		length: get_data_length(uuid)
	}
	if (chunking && contract.mime.split("/")[0] === "video" ||
		contract.mime.split("/")[0] === "audio") {
		response.type = "partial";
		//const chunk_size = Math.floor(response.length / 200);
		const chunk_size = 2000000;
		end_byte = end_byte || Math.min(start_byte + chunk_size, response.length - 1);
		response.end_byte = end_byte;
		response.data_stream = read_file_stream(uuid, start_byte, end_byte);
	} else {
		response.type = "full";
		response.data_stream = read_file_stream(uuid);
	}
	return response;
}

export function get_uuid_sync(uuid, start_byte) {
	if (!is_valid_uuid(uuid)) throw "invalid uuid";
	const contract = get_contract_file(uuid);
	assert(contract.mime !== undefined, "Missing mime type in contract in get_uuid.");
	const data = read_file(uuid);
	return {
		mime: contract.mime,
		data: data
	};
}

export function save_uuid(data_stream, mime, type, uuid) {
	return new Promise(async (res, rej) => {
		if (is_valid_uuid(uuid)) {
			const contract = get_contract_file(uuid);
			if (contract.mime !== mime) {
				set_contract_file(uuid, mime);
			}
		} else {
			uuid = `${randomUUID()}-${randomUUID()}`;
			set_contract_file(uuid, mime);
		}
		try {
			if (type === "node") {
				const write_stream = await write_file_stream(uuid);
				data_stream.pipe(write_stream);
				write_stream.on("finish", () => {
					res(uuid);
				});
			} else if (type === "data") {
				await write_form_data_stream(data_stream, uuid, res, rej);
			}
		} catch (e) {
			rej("Can't save uuid");
			return
		}
	})
}

export function save_uuid_sync(data, uuid, mime) {
	if (is_valid_uuid(uuid)) {
		const contract = get_contract_file(uuid);
		if (contract.mime !== mime) {
			set_contract_file(uuid, mime);
		}
	} else {
		uuid = `${randomUUID()}-${randomUUID()}`;
		set_contract_file(uuid, mime);
	}
	assert(is_valid_uuid(uuid), "save_uuid_sync invalid uuid");
	assert(data !== undefined, "save_uuid_sync recerived empty data");
	try {
		writeFileSync(config.storage + uuid, data);
		return uuid;
	} catch (err) {
		throw new Error("faild save uuid sync");
	}

}

export function delete_uuid(uuid) {
	get_contract_file(uuid);
	delete_file(uuid + ".contract");
	delete_file(uuid);
}

function get_contract_file(uuid) {
	assert(is_valid_uuid(uuid), "get_contract_file received invalid uuid");
	const contract_blob = read_file(`${uuid}.contract`);
	let contract;
	try {
		contract = JSON.parse(contract_blob);
	} catch (e) {
		throw new Error("Unable to parse contract file");
	}
	if (contract.mime === undefined) {
		throw new Error(`Mime type missing in contract file of ${uuid}`);
	}
	return contract;
}

function set_contract_file(uuid, mime) {
	assert(is_valid_uuid(uuid), "set_contract_file received invalid uuid");
	const contract = { "path": `storage/${uuid}`, "mime": mime };
	write_file(`${uuid}.contract`, JSON.stringify(contract));
}

function get_data_length(f) {
	try {
		assert(f !== undefined, "get_file_stat didn't receive any argument");
		return statSync(config.storage + f).size;
	} catch (e) {
		throw new Error("failed to get uuid stat.");
	}
}

function read_file(f) {
	assert(f !== undefined, "read_file didn't receive any argument");
	try {
		return readFileSync(config.storage + f);
	} catch (e) {
		console.log(`Failed to read_file ${f}, error code: `, e.code);
		throw new Error(`${f} not found.`);
	}
}

function write_file(f, b) {
	try {
		assert(f !== undefined, "write_file didn't receive file path.");
		assert(b !== undefined, "write_file didn't receive file body.");
		return writeFileSync(config.storage + f, b);
	} catch (e) {
		console.log(`Failed to write_file ${f}, error code: `, e.code);
		throw new Error(`unable to save in ${f}`);
	}
}

function read_file_stream(f, start, end) {
	try {
		assert(f !== undefined, "read_file_stream didn't receive any argument");
		if (start === undefined || end === undefined) {
			return createReadStream(config.storage + f);
		} else {
			return createReadStream(config.storage + f, { start, end });
		}
	} catch (e) {
		console.log(`failed to get file ${f}, error code: `, e.code);
		throw new Error(`Unable to read uuid ${uuid}`);
	}
}

function write_file_stream(f) {
	assert(f !== undefined, "write_file_stream didn't receive any argument");
	return new Promise((res, rej) => {
		if (!open_files[f]) {
			const write_stream = create_write_file_stream(f);
			res(write_stream);
			return
		}
		open_files[f].on("close", () => {
			if (open_files[f] !== undefined) {
				console.error("file already opened for writing");
				rej();
			}
			const write_stream = create_write_file_stream(f);
			res(write_stream);
		})
	})
}

function create_write_file_stream(f) {
	try {
		const write_stream = createWriteStream(config.storage + f);
		open_files[f] = write_stream;
		write_stream.on("close", () => {
			delete open_files[f];
		})
		return write_stream
	} catch (e) {
		throw new Error(`failed to save ${f}`);
	}
}

async function write_form_data_stream(data_stream, uuid, res, rej) {
	let is_first_chunk = true;
	let separator = '';
	let body = "";
	let write_stream = await write_file_stream(uuid);
	data_stream.on('data', (chunk) => {
		if (is_first_chunk) {
			let i = chunk.indexOf("\n");
			separator = chunk.slice(0, i - 1);
			chunk = chunk.slice(i + 1);
			for (let j = 0; j < 3; j++) {
				i = chunk.indexOf("\n");
				chunk = chunk.slice(i + 1);
			}
			is_first_chunk = false;
		}
		const separator_index = chunk.indexOf("\r\n" + separator);
		if (separator_index !== -1) {
			chunk = chunk.slice(0, separator_index);
		}
		write_stream.write(chunk);
	}).on('end', () => {
		write_stream.close();
		res(uuid);
	}).on('error', (err) => {
		rej("failed to save");
	});
}

function delete_file(f) {
	try {
		assert(f !== undefined, "delete_file didn't receive any argument");
		unlinkSync(config.storage + f);
		return { "status": "success" };
	} catch (e) {
		throw new Error("failed delete file");
	}
}
