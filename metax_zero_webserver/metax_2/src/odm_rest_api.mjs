/*
================ odm_rest_api.mjs - HTTP REST API Layer for the ODM ===========

This layer exposes the high-level Object Data Model from odm.mjs via HTTP. 
It facilitates complex object graphs management, including nested properties, 
symmetric collections, and locale-aware resolution.

--- Endpoint Groups ---

  1. Managed Properties:
	 - GET /oo/get_property: Reads an owned object property.
	 - POST /oo/set_property: Writes an owned object property.
	 - POST /oo/get_property/embedded: Navigates and reads nested properties.
	 - POST /oo/set_property/embedded: Navigates and writes nested properties.

  2. Managed Collections:
	 - GET /oo/get_collection: Lists resolved collection elements.
	 - GET /oo/add_element_to_collection: Links an existing object.
	 - GET /oo/create_element_in_collection: Creates and links a new object.
	 - POST /oo/create_element_in_collection/embedded: Creates nested list items.
	 - GET /oo/delete_element_from_collection: Unlinks an object.

  3. Object Resolution:
	 - GET /oo/wrap: Returns a fully-resolved JSON snapshot of an object tree.

--- Dependencies ---

  Uses global utility functions (assert, is_valid_uuid) and WebSocket 
  notification state managed in rest_api.mjs.

================================================================================
*/

// ====================== Imports from this project ============================

// All exported ODM operations from the Object Data Model layer.
import {
	get_property_in_owned_object
	, get_property_in_embedded_object
	, set_property_in_owned_object
	, set_property_in_embedded_object
	, get_collection
	, add_element_to_collection
	, create_element_in_collection
	, create_element_in_embedded_collection
	, create_element_in_embedded_objects_collection
	, delete_element_from_collection
	, delete_element_from_embedded_collection
	, delete_element_from_embedded_objects_collection
	, wrap_owned_object
} from './odm.mjs'

// ====================== Imports from standard libraries ======================

// parse() extracts query parameters from URL strings.
import { parse } from "url";

// ====================== Imports from third-party libraries ===================
// (None currently needed)

// ========================= Main Request Router ================================

// Routes all "/oo/*" HTTP requests to the appropriate ODM handler.
//
// Parameters:
// - req: Incoming HTTP request object.
// - res: HTTP response object to write results to.
//
// How it works:
// 1. Extracts and validates the :path header.
// 2. Asserts this is an /oo/* request (sanity check).
// 3. Dispatches to the matching handler based on the clean path.
export function handle_odm_request(req, res) {
	let req_path = req.headers[":path"].split("?")[0];
	assert(req_path.split("/")[1] === "oo",
		"handle_odm_request received non-oo request");
	console.log(`handling odm request`,
		`request path: ${req.headers[":path"]}`);
	switch (req_path) {
		case "/oo/get_property":
			handle_get_property_request(req, res);
			break;
		case "/oo/get_property/embedded":
			handle_get_property_in_embedded_object_request(req, res);
			break;
		case "/oo/set_property":
			handle_set_property_request(req, res);
			break;
		case "/oo/set_property/embedded":
			handle_set_property_in_embedded_object_request(req, res);
			break;
		case "/oo/get_collection":
			handle_get_collection_request(req, res);
			break;
		case "/oo/add_element_to_collection":
			handle_add_element_to_collection_request(req, res);
			break;
		case "/oo/create_element_in_collection":
			handle_create_element_in_collection_request(req, res);
			break;
		case "/oo/create_element_in_collection/embedded":
			handle_create_element_in_embedded_objects_collection_request(req, res);
			break;
		case "/oo/delete_element_from_collection":
			handle_delete_element_from_collection_request(req, res);
			break;
		case "/oo/delete_element_from_collection/embedded":
			handle_delete_element_from_embedded_objects_collection_request(req, res);
			break;
		case "/oo/create_element_in_embedded_collection":
			handle_create_element_in_embedded_collection_request(req, res);
			break;
		case "/oo/delete_element_from_embedded_collection":
			handle_delete_element_from_embedded_collection_request(req, res);
			break;
		case "/oo/wrap":
			handle_wrap_request(req, res);
			break;
		default:
			send_error(res, "request is not handled yet.");
			break;
	}
}

// ========================= Error Helper ======================================

// Sends a 400 Bad Request response with a JSON error body.
// Used consistently by all handlers for error responses.
function send_error(res, msg) {
	res.writeHead(400, { "content-type": "application/json" });
	res.end(`{"error":"${msg}"}`);
}

// ========================= Property Handlers - Owned Objects ==================

// Reads a property from a top-level (owned) object and returns its value.
//
// Query parameters:
// - id:       UUID of the owned object.
// - property: Property id (field name) to read.
// - locale:   Locale for i18n resolution (default: "en_US").
//
// Validation: GET only, valid UUID, property must be provided.
// Response: 200 with { value: <resolved value> } or 400 on error.
// Reads a property from a top-level (owned) object.
// Returns the resolved value considering locale and status.
function handle_get_property_request(req, res) {
	console.log(`received get_property request: ${req.headers[":path"]}`);
	const query_object = parse(req.headers[":path"], true).query;
	if (req.method !== "GET") {
		send_error(res, `Method ${req.method} not allowed for property retrieval.`);
		return;
	}
	const { id, property, locale } = query_object;
	if (!is_valid_uuid(id)) {
		send_error(res, `Provided ID is not a valid UUID.`);
		return;
	}
	if (!property) {
		send_error(res, `Missing 'property' query parameter.`);
		return
	}
	try {
		const value = get_property_in_owned_object(id, property, locale || "en_US");
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ value }));
	} catch (e) {
		send_error(res, e.message || e);
	}
}

// Reads a property from an embedded object inside a root object.
// The "child" navigation path (sent as POST body JSON) describes how to
// navigate from the root object into the target embedded object.
//
// Query parameters:
// - id:       UUID of the root (owned) object.
// - property: Property id to read in the embedded object.
// - locale:   Locale for i18n resolution.
//
// Body: JSON navigation descriptor (child chain) that describes the path
//       into the embedded object.
//
// Validation: POST only, valid UUID, property must be provided, valid JSON body.
// Response: 200 with { value: <resolved value> } or 400 on error.
// Navigates into an embedded object and reads a property.
// Requires a navigation descriptor in the POST body.
function handle_get_property_in_embedded_object_request(req, res) {
	console.log(`received get_property/embedded: ${req.headers[":path"]}`);
	const query_object = parse(req.headers[":path"], true).query;
	if (req.method !== "POST") {
		send_error(res, `Method ${req.method} not allowed; POST navigation body required.`);
		return;
	}
	const { id, property, locale } = query_object;
	if (!is_valid_uuid(id)) {
		send_error(res, `Root ID must be a valid UUID.`);
		return;
	}
	if (!property) {
		send_error(res, `Embedded property name missing.`);
		return
	}
	let data = '';
	req.on('data', chunk => data += chunk).on('end', () => {
		try {
			const nav_descriptor = JSON.parse(data);
			const value = get_property_in_embedded_object(id, property, nav_descriptor, locale || "en_US");
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ value }));
		} catch (e) {
			send_error(res, `Navigation Failure: ${e.message || e}`);
		}
	});
}

// Writes a value to a property in a top-level (owned) object and saves to disk.
// Notifies WebSocket listeners after the update by sending an "update" event.
//
// Query parameters:
// - id:       UUID of the owned object to update.
// - property: Property id (field name) to set.
// - locale:   Locale for i18n properties.
//
// Body: The new property value (plain text or JSON string).
//
// Validation: POST only, valid UUID, property must be provided.
// Response: 200 with { value: <stored value> } or 400 on error.
// Writes a value to a property in an owned object.
// Automatically triggers WebSocket "update" event for the object.
function handle_set_property_request(req, res) {
	console.log(`received set_property request: ${req.headers[":path"]}`);
	const query_object = parse(req.headers[":path"], true).query;
	if (req.method !== "POST") {
		send_error(res, `Method ${req.method} not allowed; POST value body required.`);
		return;
	}
	const { id, property, locale } = query_object;
	if (!is_valid_uuid(id)) {
		send_error(res, `Target object ID must be a valid UUID.`);
		return;
	}
	if (!property) {
		send_error(res, `Target property ID missing.`);
		return
	}
	let value = '';
	req.on('data', chunk => value += chunk).on('end', () => {
		try {
			const response = set_property_in_owned_object(id, property, value, locale || "en_US");
			// Broadcast update event to all subscribers.
			send_notification_to_websocket_clients(id);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ value: response }));
		} catch (e) {
			send_error(res, `Write Failure: ${e.message || e}`);
		}
	});
}

// Writes a value to a property inside a nested embedded object and saves to disk.
//
// Query parameters:
// - id:       UUID of the root (owned) object.
// - property: Property id to set inside the embedded object.
// - locale:   Locale for i18n properties.
//
// Body: JSON object with { value: <new value>, child: <navigation descriptor> }.
//       The "child" field describes the path to the embedded object.
//
// Validation: POST only, valid UUID, property must be provided, valid JSON body.
// Response: 200 with { value: <stored value> } or 400 on error.
function handle_set_property_in_embedded_object_request(req, res) {
	console.log(`received set_property request with path ${req.headers[":path"]}`);
	const query_object = parse(req.headers[":path"], true).query;
	if (req.method !== "POST") {
		send_error(res, `received /oo/set_property/embedded with request method ${req.method}`);
		return;
	}
	const { id, property, locale } = query_object;
	if (!is_valid_uuid(id)) {
		send_error(res, `Invalid uuid.`);
		return;
	}
	if (!property) {
		send_error(res, `Missing property id`);
		return
	}
	// Accumulate the POST body: { value, child } JSON object.
	let data = '';
	req.on('data', (chunk) => {
		data += chunk;
	}).on('end', () => {
		try {
			data = JSON.parse(data);
		} catch (e) {
			send_error(res, "Request body is not valid json.");
		}
		try {
			let response = set_property_in_embedded_object(id, property, data.value, data.child, locale || "en_US");
			// Serialize the response: objects become JSON, primitives become quoted strings.
			if (typeof response === "object") {
				response = JSON.stringify(response);
			} else {
				response = `"${response}"`;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(`{"value": ${response}}`);
		} catch (e) {
			send_error(res, e);
		}
	}).on('error', (e) => {
		send_error(res, 'Failed get request body');
	})
}

// ========================= Collection Handlers ================================

// Returns the elements of an owned object's collection.
// If a "property" is specified, returns each element with that property's value
// resolved (plus the UUID), instead of raw UUIDs.
//
// Query parameters:
// - id:         UUID of the owning object.
// - collection: The collection id to read.
// - property:   (optional) Property id to resolve for each element.
// - locale:     Locale for i18n resolution.
//
// Validation: GET only, valid UUID, collection must be provided.
// Response: 200 with { collection: [...] } or 400 on error.
// Lists elements in an owned object's collection.
// Elements can be returned as raw UUIDs or partially resolved properties.
function handle_get_collection_request(req, res) {
	console.log(`received get_collection request: ${req.headers[":path"]}`);
	const query_object = parse(req.headers[":path"], true).query;
	if (req.method !== "GET") {
		send_error(res, `Method ${req.method} not allowed.`);
		return;
	}
	const { id, collection, property, locale } = query_object;
	if (!is_valid_uuid(id)) {
		send_error(res, `Owning object ID must be a valid UUID.`);
		return;
	}
	if (!collection) {
		send_error(res, `Collection identifier missing.`);
		return
	}
	try {
		const elements = get_collection(id, collection, property, locale || "en_US");
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ collection: elements }));
	} catch (e) {
		send_error(res, `Collection Read Failure: ${e.message || e}`);
	}
}

// Adds an existing object (by UUID) as an element to a collection.
// Validates the element's type matches the collection's expected element type.
// Notifies WebSocket listeners after the update.
//
// Query parameters:
// - id:         UUID of the owning object.
// - collection: The collection id to add to.
// - element:    UUID of the object to add.
//
// Validation: GET only, valid UUIDs for id and element, collection must be provided.
// Response: 200 with { uuid: <element uuid> } or 400 on error.
function handle_add_element_to_collection_request(req, res) {
	console.log(`received add_element_to_collection request with path ${req.headers[":path"]}`);
	const query_object = parse(req.headers[":path"], true).query;
	if (req.method !== "GET") {
		send_error(res, `received /oo/add_element_to_collection with request method ${req.method}`);
		return;
	}
	const { id, collection, element } = query_object;
	if (!is_valid_uuid(id)) {
		send_error(res, `Invalid uuid.`);
		return;
	}
	if (!collection) {
		send_error(res, `Missing collection id`);
		return
	}
	if (!is_valid_uuid(element)) {
		send_error(res, `Invalid element uuid.`);
		return;
	}
	try {
		add_element_to_collection(id, collection, element);
		send_notification_to_websocket_clients(id);
		res.writeHead(200, { "content-type": "application/json" });
		res.end(`{"uuid":"${element}"}`);
	} catch (e) {
		send_error(res, e);
	}
}

// Creates a new object of the collection's element type, saves it, and adds it.
// Returns the UUID of the newly created element.
// Notifies WebSocket listeners after the update.
//
// Query parameters:
// - id:         UUID of the owning object.
// - collection: The collection id to add to.
//
// Validation: GET only, valid UUID, collection must be provided.
// Response: 200 with { uuid: <new uuid> } or 400 on error.
function handle_create_element_in_collection_request(req, res) {
	console.log(`received create_element_in_collection request with path ${req.headers[":path"]}`);
	const query_object = parse(req.headers[":path"], true).query;
	if (req.method !== "GET") {
		send_error(res, `received /oo/create_element_in_collection with request method ${req.method}`);
		return;
	}
	const { id, collection } = query_object;
	if (!is_valid_uuid(id)) {
		send_error(res, `Invalid uuid.`);
		return;
	}
	if (!collection) {
		send_error(res, `Missing collection id`);
		return
	}
	try {
		const uuid = create_element_in_collection(id, collection);
		send_notification_to_websocket_clients(id);
		res.writeHead(200, { "content-type": "application/json" });
		res.end(`{"uuid":"${uuid}"}`);
	} catch (e) {
		send_error(res, e);
	}
}

// Creates a new embedded element (stored inline) in an embedded collection.
// For embedded collections, the element is stored as part of the parent object JSON.
// Returns the full new embedded element object.
// Notifies WebSocket listeners after the update.
//
// Query parameters:
// - id:         UUID of the owning object.
// - collection: The embedded collection id.
//
// Validation: GET only, valid UUID, collection must be provided.
// Response: 200 with the serialized new element object, or 400 on error.
function handle_create_element_in_embedded_collection_request(req, res) {
	console.log(`received create_element_in_collection request with path ${req.headers[":path"]}`);
	const query_object = parse(req.headers[":path"], true).query;
	if (req.method !== "GET") {
		send_error(res,
			`received /oo/create_element_in_embedded_collection with request method ${req.method}`);
		return;
	}
	const { id, collection } = query_object;
	if (!is_valid_uuid(id)) {
		send_error(res, `Invalid uuid.`);
		return;
	}
	if (!collection) {
		send_error(res, `Missing collection id`);
		return
	}
	try {
		const object = create_element_in_embedded_collection(id, collection);
		send_notification_to_websocket_clients(id);
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(object));
	} catch (e) {
		send_error(res, e);
	}
}

// Creates a new embedded element inside a collection that is nested within
// an embedded object. The target embedded object is located via the POST
// body "child" navigation descriptor.
//
// Query parameters:
// - id:         UUID of the root (owned) object.
// - collection: The collection id within the embedded object.
//
// Body: JSON navigation descriptor (child chain) to locate the embedded object.
//
// Validation: POST only, valid UUID, collection must be provided, valid JSON body.
// Response: 200 with the new element object, or 400 on error.
function handle_create_element_in_embedded_objects_collection_request(req, res) {
	console.log(`received create_element_in_collection request with path ${req.headers[":path"]}`);
	const query_object = parse(req.headers[":path"], true).query;
	if (req.method !== "POST") {
		send_error(res,
			`received /oo/create_element_in_collection/embedded with request method ${req.method}`);
		return;
	}
	const { id, collection } = query_object;
	if (!is_valid_uuid(id)) {
		send_error(res, `Invalid uuid.`);
		return;
	}
	if (!collection) {
		send_error(res, `Missing collection id`);
		return
	}
	// Accumulate and parse the POST body (child navigation descriptor).
	let data = '';
	req.on('data', (chunk) => {
		data += chunk;
	}).on('end', () => {
		try {
			data = JSON.parse(data);
		} catch (e) {
			send_error(res, "Request body is not valid json.");
			return
		}
		try {
			const new_element = create_element_in_embedded_objects_collection(id, collection, data);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(new_element));
		} catch (e) {
			send_error(res, e);
		}
	}).on('error', (e) => {
		send_error(res, 'Failed get request body');
	})
}

// Removes an existing element (by UUID) from a composition collection.
// Notifies WebSocket listeners after deletion.
//
// Query parameters:
// - id:         UUID of the owning object.
// - collection: The collection id to remove from.
// - element:    UUID of the element to remove.
//
// Validation: GET only, valid UUID, collection must be provided.
// Response: 200 with { deleted: <element uuid> } or 400 on error.
function handle_delete_element_from_collection_request(req, res) {
	console.log(`received delete_element_from_collection request with path ${req.headers[":path"]}`);
	const query_object = parse(req.headers[":path"], true).query;
	if (req.method !== "GET") {
		send_error(res, `received /oo/delete_element_from_collection with request method ${req.method}`);
		return;
	}
	const { id, collection, element } = query_object;
	if (!is_valid_uuid(id)) {
		send_error(res, `Invalid uuid.`);
		return;
	}
	if (!collection) {
		send_error(res, `Missing collection id`);
		return
	}
	try {
		const deleted_uuid = delete_element_from_collection(id, collection, element);
		send_notification_to_websocket_clients(id);
		res.writeHead(200, { "content-type": "application/json" });
		res.end(`{"deleted":"${deleted_uuid}"}`);
	} catch (e) {
		send_error(res, e);
	}
}

// Removes an element from an embedded collection by its array index.
// Embedded elements are stored inline; no separate storage cleanup needed.
//
// Query parameters:
// - id:         UUID of the owning object.
// - collection: The embedded collection id.
// - index:      The array index of the element to remove.
//
// Validation: GET only, valid UUID, collection must be provided.
// Response: 200 with { status: <result> } or 400 on error.
function handle_delete_element_from_embedded_collection_request(req, res) {
	console.log(`received delete_element_from_collection request with path ${req.headers[":path"]}`);
	const query_object = parse(req.headers[":path"], true).query;
	if (req.method !== "GET") {
		send_error(res,
			`received /oo/delete_element_from_embedded_collection with request method ${req.method}`);
		return;
	}
	const { id, collection, index } = query_object;
	if (!is_valid_uuid(id)) {
		send_error(res, `Invalid uuid.`);
		return;
	}
	if (!collection) {
		send_error(res, `Missing collection id`);
		return
	}
	try {
		const delete_status = delete_element_from_embedded_collection(id, collection, index);
		res.writeHead(200, { "content-type": "application/json" });
		res.end(`{"status":"${delete_status}"}`);
	} catch (e) {
		send_error(res, e);
	}
}

// Removes an element from a collection inside a nested embedded object.
// The "child" navigation descriptor (in the POST body) locates the embedded object.
//
// Query parameters:
// - id:         UUID of the root (owned) object.
// - collection: The collection id within the embedded object.
// - index:      The array index of the element to remove.
//
// Body: JSON navigation descriptor (child chain) to locate the embedded object.
//
// Validation: POST only, valid UUID, collection must be provided, valid JSON body.
// Response: 200 with { deleted: <result> } or 400 on error.
function handle_delete_element_from_embedded_objects_collection_request(req, res) {
	console.log(`received delete_element_from_collection request with path ${req.headers[":path"]}`);
	const query_object = parse(req.headers[":path"], true).query;
	if (req.method !== "POST") {
		send_error(res,
			`received /oo/delete_element_from_collection/embedded with request method ${req.method}`);
		return;
	}
	const { id, collection, index } = query_object;
	if (!is_valid_uuid(id)) {
		send_error(res, `Invalid uuid.`);
		return;
	}
	if (!collection) {
		send_error(res, `Missing collection id`);
		return
	}
	// Accumulate and parse the POST body (child navigation descriptor).
	let data = '';
	req.on('data', (chunk) => {
		data += chunk;
	}).on('end', () => {
		try {
			data = JSON.parse(data);
		} catch (e) {
			send_error(res, "Request body is not valid json.");
		}
		try {
			const deleted_uuid = delete_element_from_embedded_objects_collection(id, collection, index, data);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(`{"deleted":"${deleted_uuid}"}`);
		} catch (e) {
			send_error(res, e);
		}
	}).on('error', (e) => {
		send_error(res, 'Failed get request body');
	})
}

// ========================= Wrap Handler =======================================

// Returns a fully-resolved object representation with all properties, embedded
// collections, and embedded sub-objects populated according to the type spec.
// Applies version control and i18n resolution throughout.
// Useful for getting a complete snapshot of an object in one request.
//
// Query parameters:
// - id:     UUID of the object to wrap and resolve.
// - locale: Locale for i18n property resolution.
//
// Validation: GET only, valid UUID.
// Response: 200 with the serialized fully-resolved object, or 400 on error.
// Returns a fully-resolved deep-clone snapshot of an object tree.
// Recursively follows type specs to expand all mandatory properties and collections.
function handle_wrap_request(req, res) {
	console.log(`received wrap request: ${req.headers[":path"]}`);
	const query_object = parse(req.headers[":path"], true).query;
	if (req.method !== "GET") {
		send_error(res, `Method ${req.method} not allowed.`);
		return;
	}
	const { id, locale } = query_object;
	if (!is_valid_uuid(id)) {
		send_error(res, `Target ID must be a valid UUID.`);
		return;
	}
	try {
		const object = wrap_owned_object(id, locale || "en_US");
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(object));
	} catch (e) {
		send_error(res, `Object Wrap Failure: ${e.message || e}`);
	}
}
