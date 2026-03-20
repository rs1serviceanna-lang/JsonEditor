/*
=================== odm.mjs - Object Data Model (ODM) Layer ==================

Metax ODM is a schema-aware document mapper built on the core DB storage. 
It provides a high-level API for managing structured JSON objects with 
support for inheritance (via types), versioning, and internationalization.

--- Data Architecture ---

  1. Typed Objects:
     Each JSON object contains a "type" field (Double-UUID). This points to 
      a "Type Strategy" object that defines allowed properties and collections.

  2. Property Strategy (pspec):
     - 'embedded': Value is stored inline within the parent JSON.
     - 'owned':    Value is a UUID pointing to another independent object.
     - i18n support: Automatically handles locale-based value resolution.
     - VCS support: Automatically manages value versioning via 'vcs_item' proxy.

  3. Collection Strategy (cspec):
     - 'embedded': Array of inline objects (good for small, fixed children).
     - 'composition': Array of UUIDs (good for large or shared children).
     - 'symmetric': Automatically manages two-way relationships (parent-child).

--- Core Logic Patterns ---

  - Wrapping: 'wrap_owned_object' recursively resolves types and properties 
    into a plain JS object for application consumption.
  - Property I/O: 'get_property' and 'set_property' handle the complexity of 
    VCI (Version Control Item) lookups and locale fallbacks.

================================================================================
*/

// ====================== Imports from this project ============================

// get_uuid_sync: Read a file from disk by UUID (blocking, for small JSON).
// save_uuid_sync: Write a file to disk by UUID (blocking, for JSON metadata).
import {
        get_uuid_sync,
        save_uuid_sync
} from './db.mjs'

// ========================= Well-Known UUID Constants =========================

// Maps concept names to their fixed Metax UUIDs.
// These UUIDs point to type definition and metadata objects in the database.
// Using this map avoids hard-coding raw UUID strings throughout the codebase.
const uuids = {
        true: "b4598a37-3126-42c1-a7b2-2906b12989f8",    // UUID representing boolean true
        false: "df868f39-896b-431b-b699-e71b4233eaf8",   // UUID representing boolean false
        "external_text": "3e76b8ff-9063-4052-b67a-ecd43302d269", // External text type
        "file": "37d76e87-acd6-434c-bed2-3a87d935b013",   // File type
        "vcs_item": "e1f12c03-f736-4e0a-9847-a85100903581", // Version control item type
        collection_kind: {
                embedded: "da952a26-e63c-49e0-a79e-c86852522ecd",    // Inline embedded collection
                composition: "7764d377-e113-434d-a610-8c334a57ed7c"  // UUID-reference collection
        },
        property_kind: {
                embedded: "ee4e31c1-25f8-4990-9872-3d77a515cb9d",    // Inline embedded property
                owned: "a23dbb9f-9625-4a55-9d16-9613845ebeda"        // Owned (referenced) property
        },
        version_control: {
                none: "8b5a3daa-556f-4e80-a41b-f78e305774db",        // No version tracking
                full: "19a3fd43-f2f8-4b3b-9cd1-472125542004",        // Full version history
                only_history: "1f24af20-8cd4-437b-bdee-343cd6071274", // History only
                automatic: "8d2ba44b-85ff-41f7-b1df-0468515ed8e4-6b4a2f25-7abc-4d94-8443-b86029f724c9" // Auto tracking
        },
        symmetric: {
                collection: "61d68b09-2514-4d2b-baf6-ef8dcc5ce99e", // Symmetric via collection
                property: "4f6620a8-8550-497c-9f9e-05c8b332c08c"    // Symmetric via property
        }
}

// Default locale used when no locale is specified by the caller.
const default_locale = "en_US";

// Internal cache for Type Strategy objects to prevent redundant disk I/O.
// Since schema types change infrequently, caching them improves wrap_object 
// performance by several orders of magnitude.
const type_cache = new Map();

// ========================= Property Spec Helpers =============================

// Returns true if version tracking is enabled on this property specification.
// Version-tracked properties store their value inside a separate vcs_item object.
function is_version_control_enabled(pspec) {
        return pspec.enable_version_tracking === uuids.version_control.only_history ||
                pspec.enable_version_tracking === uuids.version_control.full ||
                pspec.enable_version_tracking === uuids.version_control.automatic
}

// Returns true if the object is a version control record (vcs_item).
// Such objects store the current value of a version-tracked property.
function is_version_control_record(o) {
        return o.type === uuids.vcs_item;
}

// Returns true if internationalization is enabled on this property specification.
// Internationalized properties store a { locale: value } map instead of a plain value.
function is_internalization_enabled(pspec) {
        return pspec.enable_internalization === uuids.true;
}

// Returns true if this collection is "embedded" (elements are stored inline).
// As opposed to "composition" where elements are stored by UUID reference.
function is_embedded_collection(cspec) {
        return cspec.kind === uuids.collection_kind.embedded;
}

// Returns true if this collection is "composition" (elements are UUID references).
function is_composition_collection(cspec) {
        return cspec.kind === uuids.collection_kind.composition;
}


// Returns true if this property has a non-empty default value.
function has_default_value(pspec) {
        return pspec.default_value != '' &&
                pspec.default_value != undefined;
}

// Returns true if this property is external (stored outside the main object JSON).
// External properties are embedded typed objects, owned objects, external texts, or files.
function is_external_property(pspec) {
        return pspec.kind === uuids.property_kind.embedded ||
                pspec.kind === uuids.property_kind.owned ||
                pspec.value_type === uuids.external_text ||
                pspec.value_type === uuids.file
}

// Returns true if this property is embedded (value is stored inline in the parent object).
function is_embedded_property(pspec) {
        return pspec.kind === uuids.property_kind.embedded
}

// ========================= Type Lookup Helpers ===============================

// Finds and returns the property specification for a given property id in a type.
// Returns undefined if no property with that id exists.
function get_propspec(type, id) {
        return type.properties.find(prop => prop.id === id);
}

// Finds and returns the collection specification for a given collection id in a type.
// Returns undefined if no collection with that id exists.
function get_collspec(type, id) {
        return type.collections.find(prop => prop.id === id);
}

// ========================= Core Object I/O ===================================

// Reads a JSON object from storage by UUID.
// Strictly validates JSON integrity.
function get_object(uuid) {
        let o = get_uuid_sync(uuid).data;
        try {
                o = JSON.parse(o);
        } catch (err) {
                throw new Error(`Data integrity error: ${uuid} is not a valid JSON document.`);
        }
        return o;
}

// Builds a virtual object by mapping the raw JSON data to its schema (Type).
// Only fields explicitly defined in the propspec/collspec are exposed.
function wrap_object(uuid) {
        const object = {};
        let o = get_object(uuid);
        if (!o.type || !is_valid_uuid(o.type)) {
                throw new Error(`Schema Violation: Item ${uuid} has an invalid or missing 'type' reference.`);
        }
        let type;
        if (type_cache.has(o.type)) {
                type = type_cache.get(o.type);
        } else {
                type = get_object(o.type);
                type_cache.set(o.type, type);
        }
        // Expose only defined properties.
        type.properties.forEach(property => {
                object[property.id] = o[property.id];
        });
        // Expose only defined collections.
        type.collections.forEach(collection => {
                object[collection.id] = o[collection.id];
        });
        object.type = type;
        object.uuid = uuid; // Keep reference to original key
        return object;
}

// Writes an object back to storage, serializing it as JSON.
// If the type field is an object (fully resolved), converts it back to its UUID.
//
// Parameters:
// - o: The object to save. Must have a uuid field.
function update_object(o) {
        // Convert type back to UUID if it was expanded into a full object.
        if (typeof (o.type) === "object") {
                o.type = o.type.uuid;
        }
        save_uuid_sync(JSON.stringify(o), o.uuid, "application/json");
}

// ========================= Embedded Object Navigation ========================

// Navigates into an embedded object (or collection element) within a parent object.
// Used to access deeply nested embedded structures, following the "child" chain.
//
// Parameters:
// - o:    The parent object (already read from storage).
// - t:    The type definition of the parent object.
// - c:    Navigation descriptor: { property?, collection?, index?, child? }
//         - property:   Navigate into an embedded property.
//         - collection: Navigate into an embedded collection.
//         - index:      Index within the collection.
//         - child:      Nested navigation descriptor to go deeper.
//
// Returns: [embedded_object, embedded_type] tuple.
function get_embedded_object(o, t, c) {
        if (!c.property && !(c.collection && c.index !== undefined)) {
                throw new Error("Navigation Error: No collection or property id specified in descriptor.");
        }
        let type_uuid;
        let object;
        if (c.property) {
                const propspec = get_propspec(t, c.property);
                type_uuid = propspec.value_type;
                object = o[c.property]
        } else {
                const collspec = get_collspec(t, c.collection);
                type_uuid = collspec.element_type;
                object = o[c.collection][c.index];
        }

        // Cache-aware type loading.
        let type;
        if (type_cache.has(type_uuid)) {
                type = type_cache.get(type_uuid);
        } else {
                type = get_object(type_uuid);
                type_cache.set(type_uuid, type);
        }

        if (!c.child) {
                return [object, type]
        }
        return get_embedded_object(object, type, c.child);
}

// ========================= Object Creation ===================================

// Creates a new blank object of a given type with defaults applied.
// Collections are initialized as empty arrays.
// Properties with default values are pre-filled.
// The name property is set to "New <TypeName>".
//
// Parameters:
// - type: The fully-loaded type definition object.
//
// Returns: A new object (not yet saved to disk).
function create_new_mani_object(type) {
        const o = {};
        const type_type = get_object(type.type);
        const name_pspec = get_propspec(type_type, "name");
        const type_name = get_property(type, name_pspec, default_locale);
        o.name = `New ${type_name}`;
        // Apply default values for all properties that have them.
        type.properties.forEach(pspec => {
                if (has_default_value(pspec)) {
                        o[pspec.id] = pspec.default_value;
                }
        });
        // Initialize all collections as empty arrays.
        type.collections.forEach(cspec => {
                o[cspec.id] = [];
        });
        o["type"] = type.uuid;
        return o;
}

// ========================= Property Read/Write ================================

// Reads a property value from an object, applying:
//   - Version control: dereferences the vcs_item to get the current value.
//   - Internationalization: picks the value for the requested locale.
//   - Fallback: uses default_locale or first available locale if requested not found.
//
// Parameters:
// - o:      The object whose property to read.
// - pspec:  The property specification descriptor.
// - locale: The requested locale (e.g., "en_US").
// - root:   (unused currently, for potential future context).
//
// Returns: The resolved property value, or "" if not set.
function get_property(o, pspec, locale, root) {
        let id = pspec.id;
        let value;
        // If version tracking is enabled, follow the vcs_item reference.
        if (is_version_control_enabled(pspec)) {
                if (is_valid_uuid(o[id])) {
                        const vci = get_object(o[id]);
                        if (is_version_control_record(vci)) {
                                o[id] = vci.value;
                        }
                }
        }
        // If internationalized, pick the value for the requested locale.
        if (is_internalization_enabled(pspec) && typeof o[id] === "object") {
                value = o[id][locale] ||
                        o[id][default_locale] ||
                        o[id][Object.keys(o[id])[0]]; // Fallback to first available locale
        } else {
                value = o[id];
        }
        return value || ""
}

// Writes a property value to an object, applying:
//   - Version control: if the property is tracked, writes to the vcs_item instead.
//   - Internationalization: stores the value inside the locale map.
//   - External property handling: creates external storage objects as needed.
//
// Parameters:
// - o:      The object to modify.
// - pspec:  The property specification descriptor.
// - value:  The new value to set.
// - locale: The locale to write to (for internationalized properties).
//
// Returns: The final stored value (may differ if external storage was created).
function set_property(o, pspec, value, locale) {
        let { id } = pspec;
        // If version tracking is enabled, write to the vcs_item referenced by this property.
        if (is_version_control_enabled(pspec)) {
                if (is_valid_uuid(o[id])) {
                        o = get_object(o[id]);
                        id = "value"; // Write to the "value" field of the vcs_item
                }
        }
        if (is_internalization_enabled(pspec)) {
                // For internationalized properties, ensure the locale map exists first.
                if (typeof o[id] !== "object") {
                        o[id] = { [default_locale]: o[id] };
                }
                o[id][locale] = value;
        } else {
                o[id] = value;
        }
        // For external properties (owned objects, files, etc.), create or update storage.
        if (is_external_property(pspec)) {
                value = set_external_property_value(o, id, value, pspec);
        }
        return value
}

// Creates or updates external storage for an owned or embedded property value.
// For owned properties and external_text, saves a new object to the DB and
// stores its UUID on the parent object. For embedded properties, stores the
// object directly inline.
//
// Parameters:
// - o:     The parent object being updated.
// - id:    The property id on the parent.
// - v:     The value being set.
// - pspec: The property specification.
//
// Returns: The UUID (for owned/external) or the embedded object (for embedded).
function set_external_property_value(o, id, v, pspec) {
        const type = get_object(pspec.value_type);
        const value = create_new_mani_object(type);
        if (pspec.kind === uuids.property_kind.owned ||
                pspec.value_type === uuids.external_text) {
                // Owned: save as independent object, store UUID reference.
                const uuid = save_uuid_sync("{}", null, "application/json");
                value.type = type;
                value.uuid = uuid;
                update_object(value);
                o[id] = uuid;
                return uuid
        }
        // Embedded: store the object inline in the parent.
        o[id] = value
        return value;
}

// ========================= Exported Property Access ==========================

// Returns the resolved value of a property in a top-level (owned) object.
// Handles version control and internationalization transparently.
//
// Parameters:
// - uuid:   UUID of the object.
// - id:     Property id (field name) to read.
// - locale: Locale code for i18n resolution.
//
// Returns: The resolved property value.
export function get_property_in_owned_object(uuid, id, locale) {
        const object = wrap_object(uuid);
        if (id === "type") {
                return object.type.uuid || object.type;
        }
        const propspec = get_propspec(object.type, id);
        if (propspec === undefined) {
                throw new Error(`Property Error: '${id}' not found in type schema for object ${uuid}.`);
        }
        return get_property(object, propspec, locale);
}

// Returns the resolved value of a property inside a deeply nested embedded object.
// The "child" parameter is a chain of navigation descriptors to reach the embedded target.
//
// Parameters:
// - uuid:   UUID of the root (owned) object.
// - id:     Property id to read in the embedded object.
// - child:  Navigation descriptor chain to the embedded object.
// - locale: Locale code for i18n resolution.
export function get_property_in_embedded_object(uuid, id, child, locale) {
        const object = wrap_object(uuid);
        const [embedded_object, type] = get_embedded_object(object, object.type, child);
        const propspec = get_propspec(type, id);
        if (propspec === undefined) {
                throw new Error(`Property Error: '${id}' not found in embedded object type.`);
        }
        return get_property(embedded_object, propspec, locale, object);
}

// Sets the value of a property in a top-level (owned) object and saves to disk.
//
// Parameters:
// - uuid:   UUID of the object to update.
// - id:     Property id to set.
// - value:  New value to assign.
// - locale: Locale for i18n properties.
//
// Returns: The final stored value.
export function set_property_in_owned_object(uuid, id, value, locale) {
        const o = wrap_object(uuid);
        const propspec = get_propspec(o.type, id);
        if (propspec === undefined) {
                throw new Error(`Property Error: cannot set unknown property '${id}' in object ${uuid}.`);
        }
        if (id === "type") {
                value = wrap_owned_object(value, true);
        }
        const r = set_property(o, propspec, value, locale);
        update_object(o);
        return r
}

// Sets the value of a property inside a deeply nested embedded object and saves to disk.
//
// Parameters:
// - uuid:   UUID of the root (owned) object.
// - id:     Property id to set inside the embedded object.
// - value:  New value to assign.
// - child:  Navigation descriptor chain to the embedded object.
// - locale: Locale for i18n properties.
//
// Returns: The final stored value.
export function set_property_in_embedded_object(uuid, id, value, child, locale) {
        const object = wrap_object(uuid);
        const [embedded_object, type] = get_embedded_object(object, object.type, child);
        const propspec = get_propspec(type, id);
        if (propspec === undefined) {
                throw new Error(`Property Error: Cannot set unknown property '${id}' in embedded object.`);
        }
        if (id === "type") {
                value = wrap_owned_object(value, true);
        }
        const r = set_property(embedded_object, propspec, value, locale);
        update_object(object);
        return r
}

// ========================= Object Wrapping ===================================

// Builds a fully-resolved representation of an owned object, with all properties
// and embedded collections resolved according to their type specifications.
// Resolves i18n properties to their locale values, expands version-tracked
// properties, and recursively resolves embedded sub-objects and collections.
//
// Parameters:
// - uuid:         UUID of the object to wrap.
// - locale:       Locale code for i18n resolution.
// - is_type:      Internal flag: true if this object is being wrapped as a type.
// - is_type_type: Internal flag: true if this is the type-of-type (avoids infinite recursion).
//
// Returns: A fully-resolved JavaScript object with all property values.
export function wrap_owned_object(uuid, locale, is_type, is_type_type) {
        const object = get_object(uuid);
        // Base case: type-of-type is returned raw to avoid infinite recursion.
        if (is_type_type === true) return object
        // Recursively wrap the object's type definition.
        object.type = wrap_owned_object(object.type, locale, true, is_type);
        const type = object.type;
        // Resolve all top-level properties.
        get_all_properties(object, type, locale);
        // Resolve embedded collection elements.
        type.collections.forEach(c => {
                if (is_embedded_collection(c)) {
                        if (!object[c.id]) return
                        const eltype = get_object(c.element_type);
                        object[c.id].forEach(el => {
                                get_all_properties(el, eltype, locale, object);
                        });
                }
        });
        // Resolve embedded property values.
        type.properties.forEach(pspec => {
                if (is_embedded_property(pspec) && object[pspec.id]) {
                        const vt = get_object(pspec.value_type);
                        get_all_properties(object[pspec.id], vt, locale, object);
                }
        });
        if (is_type) {
                // When used as a type reference, store only the UUID (not the full object).
                object.type = object.type.uuid;
        }
        return object
}

// Resolves all type-declared properties of an object in place.
// For each property in the type spec, calls get_property() to apply
// version control and i18n resolution.
//
// Parameters:
// - object: The object to update (mutated in place).
// - type:   The type definition containing property specs.
// - locale: Locale for i18n resolution.
// - root:   (optional) Root object reference for future context use.
//
// Returns: The mutated object (for chaining convenience).
function get_all_properties(object, type, locale, root) {
        type.properties.forEach(property => {
                object[property.id] = get_property(object, property, locale, root);
        });
        return object
}

// ========================= Collection Operations =============================

// Adds an existing object (by UUID) as an element to a composition collection.
// Validates that the element's type matches the collection's element_type.
// If the collection is symmetric, also updates the reverse side of the relationship.
//
// Parameters:
// - uuid:       UUID of the object that owns the collection.
// - id:         The collection id (field name) on the object.
// - el:         UUID of the element object to add.
//
// Returns: The UUID of the added element.
export function add_element_to_collection(uuid, id, el) {
        const object = wrap_object(uuid);
        const element = wrap_object(el);
        const cspec = get_collspec(object.type, id);
        if (cspec === undefined) {
                throw new Error(`Collection Error: '${id}' not found in object '${uuid}'.`);
        }
        // Enforce type safety: the element must match the collection's declared element type.
        if (cspec.element_type !== element.type.uuid) {
                throw new Error(`Type Mismatch: element '${el}' is not of type '${cspec.element_type}'.`);
        }
        object[id].push(el);
        // For symmetric collections, update the other side of the relationship too.
        if (cspec.symmetric) {
                add_object_in_symmetric_element(uuid, element, cspec);
                update_object(element);
        }
        update_object(object);
        return el
}

// Updates the reverse side of a symmetric relationship when an element is added.
// If symmetric via property, sets the property to the parent UUID.
// If symmetric via collection, appends the parent UUID to the sibling array.
//
// Parameters:
// - uuid:    UUID of the parent object.
// - element: The element object being linked.
// - cspec:   The collection specification containing symmetric metadata.
function add_object_in_symmetric_element(uuid, element, cspec) {
        if (cspec.symmetric_kind === uuids.symmetric.property) {
                // Symmetric via property: point the element's property at the parent.
                element[cspec.symmetric] = uuid;
        } else {
                // Symmetric via collection: add the parent UUID to the element's array.
                if (element[cspec.symmetric] &&
                        Array.isArray(element[cspec.symmetric])) {
                        element[cspec.symmetric].push(uuid);
                }
        }
}

// Updates the reverse side of a symmetric relationship when an element is removed.
// If symmetric via property, clears the property.
// If symmetric via collection, removes the parent UUID from the sibling array.
//
// Parameters:
// - uuid:    UUID of the parent object.
// - element: The element object being unlinked.
// - cspec:   The collection specification containing symmetric metadata.
function delete_element_in_symmetric_element(uuid, element, cspec) {
        if (cspec.symmetric_kind === uuids.symmetric.property) {
                // Clear the back-reference property.
                element[cspec.symmetric] = '';
        } else {
                // Remove the parent UUID from the symmetric collection.
                if (element[cspec.symmetric] &&
                        Array.isArray(element[cspec.symmetric])) {
                        const i = element[cspec.symmetric].indexOf(uuid);
                        element[cspec.symmetric].splice(i, 1);
                }
        }
}

// Removes an existing object (by UUID) from a composition collection.
// If the collection is symmetric and composition, also updates the reverse side.
//
// Parameters:
// - uuid: UUID of the owning object.
// - id:   The collection id on the owning object.
// - el:   UUID of the element to remove.
//
// Returns: The UUID of the removed element.
export function delete_element_from_collection(uuid, id, el) {
        const object = wrap_object(uuid);
        const cspec = get_collspec(object.type, id);
        if (cspec === undefined) {
                throw new Error(`Collection Error: '${id}' not found in object '${uuid}'.`);
        }
        const index = object[id].indexOf(el);
        if (index === -1) {
                throw new Error(`Not Found: element '${el}' not found in collection '${id}'.`);
        }
        object[id].splice(index, 1);
        if (is_composition_collection(cspec) && cspec.symmetric) {
                const element = wrap_object(el);
                delete_element_in_symmetric_element(uuid, element, cspec);
                update_object(element);
        }
        update_object(object);
        return el
}

// Creates a new object of the collection's element type, saves it to disk,
// and adds its UUID to the collection. The new object has default values set.
//
// Parameters:
// - uuid: UUID of the owning object.
// - id:   The collection id to add the new element to.
//
// Returns: The UUID of the newly created element.
export function create_element_in_collection(uuid, id) {
        const object = wrap_object(uuid);
        const cspec = get_collspec(object.type, id);
        if (cspec === undefined) {
                throw new Error(`Collection Error: '${id}' not found in object '${uuid}'.`);
        }
        const type = get_object(cspec.element_type);
        const new_object = create_new_mani_object(type)
        // Save as a new independent object; get its UUID.
        const new_uuid = save_uuid_sync("{}", null, "application/json");
        new_object.type = type;
        new_object.uuid = new_uuid;
        update_object(new_object);
        if (object[id] === undefined) {
                object[id] = []
        }
        object[id].push(new_uuid);
        update_object(object);
        return new_uuid
}

// Creates a new embedded element in an embedded collection and stores it inline.
// Unlike create_element_in_collection, no separate UUID is assigned; the element
// is stored directly within the parent object JSON.
//
// Parameters:
// - uuid: UUID of the owning object.
// - id:   The embedded collection id.
//
// Returns: The new embedded element object.
export function create_element_in_embedded_collection(uuid, id) {
        const object = wrap_object(uuid);
        const cspec = get_collspec(object.type, id);
        if (cspec === undefined) {
                throw new Error(`Collection Error: '${id}' not found in object '${uuid}'.`);
        }
        const type = get_object(cspec.element_type);
        const new_object = create_new_mani_object(type)
        if (object[id] === undefined) {
                object[id] = []
        }
        // Push the new inline object directly into the collection array.
        object[id].push(new_object);
        update_object(object);
        return new_object
}

// Removes an element from an embedded collection by its array index.
//
// Parameters:
// - uuid:  UUID of the owning object.
// - id:    The embedded collection id.
// - index: Array index of the element to remove.
//
// Returns: "deleted" string on success.
export function delete_element_from_embedded_collection(uuid, id, index) {
        const object = wrap_object(uuid);
        const cspec = get_collspec(object.type, id);
        if (cspec === undefined) {
                throw new Error(`Collection Error: '${id}' not found in object '${uuid}'.`);
        }
        if (object[id][index] === undefined) {
                throw new Error(`Not Found: no element at index ${index} in collection.`);
        }
        object[id].splice(index, 1);
        update_object(object);
        return "deleted"
}

// Creates a new embedded element inside a collection that lives within a
// nested embedded object (accessed via the "child" navigation chain).
//
// Parameters:
// - uuid:  UUID of the root (owned) object.
// - id:    The collection id within the embedded object.
// - child: Navigation descriptor chain to reach the embedded object.
//
// Returns: The new embedded element object.
export function create_element_in_embedded_objects_collection(uuid, id, child) {
        const object = wrap_object(uuid);
        const [embedded_object, type] = get_embedded_object(object, object.type, child);
        const cspec = get_collspec(type, id);
        if (cspec === undefined) {
                throw new Error(`Collection Error: '${id}' not found in object '${uuid}'.`);
        }
        const element_type = get_object(cspec.element_type);
        const new_object = create_new_mani_object(element_type)
        embedded_object[id].push(new_object);
        // Save the root object since embedded changes are stored inline.
        update_object(object);
        return new_object
}

// Removes an element from a collection inside a nested embedded object.
//
// Parameters:
// - uuid:  UUID of the root (owned) object.
// - id:    The collection id within the embedded object.
// - index: Array index of the element to remove.
// - child: Navigation descriptor chain to reach the embedded object.
//
// Returns: "deleted" string on success.
export function delete_element_from_embedded_objects_collection(uuid, id, index, child) {
        const object = wrap_object(uuid);
        const [embedded_object, type] = get_embedded_object(object, object.type, child);
        const cspec = get_collspec(type, id);
        if (cspec === undefined) {
                throw new Error(`Collection Error: '${id}' not found in object '${uuid}'.`);
        }
        if (embedded_object[id][index] === undefined) {
                throw new Error(`Not Found: no element at index ${index} in collection.`);
        }
        embedded_object[id].splice(index, 1);
        update_object(object);
        return "deleted"
}

// ========================= Collection Read ====================================

// Returns the contents of an owned object's collection.
// If a property id is provided, maps each element UUID to an object
// containing that property's resolved value plus the UUID.
//
// Parameters:
// - uuid:     UUID of the owning object.
// - id:       The collection id to read.
// - property: (optional) If provided, returns [{[property]: value, uuid}] pairs.
// - locale:   Locale for i18n resolution.
//
// Returns: Array of UUIDs, or array of {property, uuid} objects if property is given.
export function get_collection(uuid, id, property, locale) {
        const object = wrap_object(uuid);
        const cspec = get_collspec(object.type, id);
        if (cspec === undefined || object[cspec.id] === undefined) {
                throw new Error(`Collection Error: '${id}' not found in object '${uuid}'.`);
        }
        const collection = [];
        // Without a property filter, return the raw array of UUIDs.
        if (!property) return object[cspec.id]
        // With a property filter, resolve that property for each element.
        object[cspec.id].forEach(e => {
                collection.push({
                        [property]: get_property_in_owned_object(e, property, locale),
                        uuid: e
                });
        });
        return collection
}
