/*
==================== notifier.mjs - Email Notification System =================

This module sends email notifications to users (object "watchers") when a
Metax object is modified. Notifications are triggered via the /notify HTTP
endpoint in router.mjs and are rate-limited by a 5-minute debounce timer.

--- How Notifications Work ---

  1. When an object is edited by a user, the client sends a POST to /notify
	 with the object's UUID and a description of what changed.
  2. add_notifier() records the change in notify_map and starts a 5-minute
	 debounce timer. If more changes come in for the same object, the timer
	 is reset and changes accumulate.
  3. After 5 minutes of inactivity, notify_update() fires. It:
	   a. Fetches the full object from Metax.
	   b. Resolves the object's "watchers" array to get their email addresses.
	   c. Builds an HTML email with a table of all current property values
		  and a list of the accumulated changes (old value -> new value).
	   d. Sends the email via nodemailer using the website's SMTP transporter.

--- Email Content ---

  Subject: "Թարմացում: [<TypeName>] <ObjectName>"  (Armenian: "Update: ...")
  Body: HTML table of all property values + list of changes + editor name + time.
  Recipient: All users listed in the object's "watchers" array in Metax.

--- Mail Transporters ---

  Each website in the sitemap can have a "mail_notifier" configuration
  with SMTP credentials. init_notifier_transporters() creates a nodemailer
  SMTP transporter for each website at startup.

--- Notify Map Structure ---

  notify_map[uuid] = {
	changes: [...],       // Accumulated change descriptors
	timeout: <timer>      // The active debounce timer handle
  }

--- Change Descriptor Structure ---

  { type: "property", id: <prop_id>, old: <old_value>, locale: <locale> }
  { type: "collection_add", id: <coll_id>, locale: <locale> }
  { type: "collection_delete", id: <coll_id>, locale: <locale> }

================================================================================
*/

// ====================== Imports from third-party libraries ===================

// nodemailer: Node.js SMTP email sending library.
import nodemailer from "nodemailer"

// ========================= Logging Aliases ===================================

// Short aliases for logger calls scoped to this module.
const trace = (m) => logger.trace("notifier", m);
const warning = (m) => logger.warning("notifier", m);
const error = (m) => logger.error("notifier", m);

// ========================= Constants and State ================================

// Helper: Reads a property from a Metax object using the global ODM REST API.
// Uses the default locale "hy_AM" unless overridden.
const get_property = (u, id, l = "hy_AM") => http_get(`/oo/get_property?id=${u}&property=${id}&locale=${l}`)
	.then(r => JSON.parse(r))
	.then(r => r.value);

// notify_map: Tracks pending notifications per UUID.
// Keys are object UUIDs; values are { changes: [], timeout: <timer> }.
const notify_map = {};

// Debounce delay in milliseconds (5 minutes).
// Notifications are only sent after this much inactivity for a given object.
const notify_timeout = 300000;

// ========================= Public API ========================================

// Initializes nodemailer SMTP transporters for all websites in the sitemap
// that have mail_notifier credentials configured.
// Must be called once during server startup (after sitemap is loaded).
//
// For each website with valid SMTP credentials, creates a nodemailer transporter
// and attaches it to sitemap.websites[i].mail_transporter.
export async function init_notifier_transporters() {
	for (let i = 0; i < sitemap.websites.length; i++) {
		let p = await construct_transporter_package(i);
		if (p === 0) {
			// No mail_notifier config found for this website.
			trace(`${sitemap.websites[i].name} doesn't have mailing credentials, skipping`);
		} else {
			sitemap.websites[i].mail_transporter
				= nodemailer.createTransport(p);
			trace(`added transported for ${sitemap.websites[i].name}`);
		}
	}
}

// Records a change to a Metax object and schedules a debounced email notification.
// Called from router.mjs when a /notify request is received.
//
// Parameters:
// - uuid:    UUID of the changed object (or a child of a parent object).
// - cert:    TLS client certificate of the user who made the change.
// - body:    Change descriptor { type, id, locale, ... }.
// - headers: HTTP request headers (used to extract authority and referer).
//
// How it works:
// 1. Resolves the parent UUID (if the changed object is a child).
// 2. Creates or resets the debounce timer for the notify UUID.
// 3. For property changes, merges if the same property was already queued.
// 4. Appends the change to the pending list.
// 5. After notify_timeout ms of silence, fires notify_update().
export async function add_notifier(uuid, cert, body, headers) {
	// Try to get a parent UUID (e.g., if a sub-object was changed).
	const parent_uuid = await get_property(uuid, "parent").catch(e => "");
	// Use the parent UUID as the notification key so changes to children
	// trigger notifications for the parent object.
	const notify_uuid = parent_uuid || uuid;
	if (notify_map[notify_uuid] === undefined) {
		// First change for this UUID: create a new pending entry.
		notify_map[notify_uuid] = { changes: [] }
	} else {
		// Subsequent change: reset the debounce timer to wait for more changes.
		clearTimeout(notify_map[notify_uuid].timeout)
	}
	// Tag the change with the child UUID if it comes from a sub-object.
	if (parent_uuid) {
		body.child_uuid = uuid;
	}
	// For property changes, deduplicate: if the same property was already
	// queued, record its old value from the first change and replace the entry.
	if (body.type === "property") {
		const i = notify_map[notify_uuid].changes.findIndex(c => c.id === body.id);
		if (i !== -1) {
			body.old = notify_map[notify_uuid].changes[i].old
			notify_map[notify_uuid].changes.splice(i, 1);
		}
	}
	notify_map[notify_uuid].changes.push(body)
	// Schedule the actual email send after notify_timeout ms of no new changes.
	notify_map[notify_uuid].timeout = setTimeout(async () => {
		await notify_update(notify_uuid, cert, notify_map[notify_uuid].changes, headers);
		delete notify_map[notify_uuid]
	}, notify_timeout)
}

// ========================= Internal Helpers ==================================

// Sends the accumulated email notification for a UUID after the debounce fires.
// Fetches the full object, resolves watcher emails, builds HTML, and sends.
//
// Parameters:
// - uuid:    UUID of the object (or parent object) being notified about.
// - cert:    Client certificate of the editor (used to identify the user).
// - changes: Array of accumulated change descriptors.
// - headers: HTTP headers from the original notify request (authority, referer).
async function notify_update(uuid, cert, changes, headers) {
	try {
		const { locale = "hy_AM" } = changes[0];
		trace("start notify_update for uuid: " + uuid);
		const authority = headers[":authority"];
		const referer = headers["referer"];
		// Find the website and certificate indices in the sitemap.
		const u_i = await get_user_sitemap_indices(cert, authority);
		// Check that mail transporter is available for this website.
		if (sitemap.websites[u_i["website_index"]].mail_transporter === undefined) {
			warning("received notify, but mail transporter is not registered");
			return;
		}
		// Fetch the full object for building the email body.
		const obj = await get_mani_user_object(uuid)
		const t = await sitemap.websites[u_i["website_index"]].mail_transporter;
		// Resolve the editor's display name.
		const username = await get_user_name_from_sitemap(u_i, locale);
		const user_mail = sitemap.websites[u_i["website_index"]]
		["mail_notifier"]["user"];
		// Build the full email HTML body.
		const m_p = await construct_mailing_package(obj, user_mail,
			username, referer, changes);
		if (m_p["to"].length > 0) {
			await send_mail(t, m_p);
		} else {
			trace("notify_update received notify command with no watchers, uuid: " + uuid)
		}
		trace("END notify_update for uuid: " + uuid);
	} catch (e) {
		error("failed to notify users, " + e);
		trace("END notify_update for uuid: " + uuid);
	}
}

// Fetches and validates a Metax object for use in email notifications.
// Ensures the object has a valid type, UUID, and watchers array.
// Throws if the object is not valid JSON or missing required fields.
//
// Parameters:
// - uuid: UUID of the object to fetch.
async function get_mani_user_object(uuid) {
	trace("get_mani_user_object");
	const obj = await metax_get(uuid)
		.then(r => JSON.parse(r))
		.catch(e => {
			trace("END get_mani_user_object");
			throw new Error("notify_update received non-json data: " + uuid);
		});
	// Validate that the object has the structure required for notification.
	if (obj
		&& is_valid_uuid(obj["type"])
		&& is_valid_uuid(obj["uuid"])
		&& Array.isArray(obj["watchers"])) {
		trace("END get_mani_user_object");
		return obj;
	} else {
		trace("END get_mani_user_object");
		throw new Error("notify_update received invalid object for notifying");
	}
}

// Builds the nodemailer SMTP transporter configuration for a website.
// Returns the config object if the website has valid SMTP credentials,
// or 0 if the website is not configured for email.
//
// Parameters:
// - w: Index into sitemap.websites array.
async function construct_transporter_package(w) {
	trace("construct_transporter_package");
	let s = sitemap.websites[w];
	if (s
		&& s["mail_notifier"]
		&& s["mail_notifier"]["host"]
		&& s["mail_notifier"]["port"]
		&& s["mail_notifier"]["user"]
		&& s["mail_notifier"]["password"]) {
		trace("END construct_transporter_package");
		return {
			host: s["mail_notifier"]["host"],
			port: +s["mail_notifier"]["port"], // Convert port string to number
			secure: true,                       // Use TLS for SMTP
			auth: {
				user: s["mail_notifier"]["user"],
				pass: s["mail_notifier"]["password"]
			}
		}
	} else {
		trace("END construct_transporter_package");
		return 0; // Signal that this website has no mail config
	}
}

// Builds the full HTML email body for a notification.
// Creates an HTML table of all property values, a list of changes,
// the editor's name, the time, and a link back to the object.
//
// Parameters:
// - obj:     The Metax object that was modified.
// - from:    The sender's email address.
// - u:       The editor's display name (Armenian: "Խmբagrer").
// - referer: URL referer for building the "View here" link.
// - changes: Array of change descriptors to display.
//
// Returns: { from, to, subject, html } for nodemailer.
async function construct_mailing_package(obj, from, u, referer, changes) {
	trace("construct_mailing_package")
	const { locale = "hy_AM" } = changes[0];
	const tname = await get_property(obj["type"], "name", locale); // Type display name
	const objname = await get_property(obj["uuid"], "name", locale); // Object display name
	const to = await get_watcher_mails(obj); // Recipient emails from watchers array
	const subject = `Թարմացում: [${tname}] ${objname}`; // Email subject in Armenian
	// Build the property table header.
	let html = `<table style="border:1px solid black; border-collapse:collapse">`;
	const type = await metax_get(obj.type).then(r => JSON.parse(r));
	// Add a row for each property, resolving its current value.
	for (let p of type.properties) {
		if (p.id === "uuid") continue // Skip the UUID field in the table
		let v = await get_property(obj.uuid, p.id, locale)
		// For UUID values, resolve to the object's name for readability.
		if (is_valid_uuid(v)) {
			v = await get_property(v, "name", locale) + "*";
		}
		html += `<tr><th style="border:1px solid black;text-align:left;padding:5px">
                        ${p.name[locale] || Object.values(p.name)[0]}</th>
                        <td style="border:1px solid black;padding:5px">${v}</td></tr>`;
	}
	html += `</table><p>Խmbagrox՝ ${u}</p>
	 <p>Pokhokhowtʿyownner՝ </p>` // "Editor" and "Changes" labels in Armenian
	// Add a change entry for each recorded change.
	for (let change of changes) {
		if (change.child_uuid !== undefined) {
			// This change was on a child object: show which child type changed.
			const child_type_uuid = await get_property(change.child_uuid, "type");
			const child_type = await metax_get(child_type_uuid).then(r => JSON.parse(r));
			html += `Pokhokhal e ${await get_property(child_type_uuid, "name", locale)}` +
				` ( Anown՝ ${await get_property(change.child_uuid, "name", locale)} )՝ ` +
				await construct_change_html(change.child_uuid, child_type, change, locale);
		} else {
			html += await construct_change_html(obj.uuid, type, change, locale);
		}
	}
	const date = new Date();
	html += `<p>Ham՝ ${("0" + date.getHours()).slice(-2)}:${("0" + date.getMinutes()).slice(-2)}</p>`
	html += `<p>Tʿarmakowme kʿarogh eq tesnel <a href="${referer}#${obj["uuid"]}">aystex</a></p>` // "You can see the update here"
	trace("END construct_mailing_package")
	return { from, to, subject, html };
}

// Builds an HTML snippet describing a single property or collection change.
// For property changes: shows old value -> new value in red/green.
// For collection changes: shows a brief text about what was added or deleted.
//
// Parameters:
// - uuid:   UUID of the object containing the property.
// - type:   Type definition of the object.
// - change: Change descriptor { type, id, old, ... }.
// - locale: Locale for resolving property names and values.
//
// Returns: HTML string for this specific change.
async function construct_change_html(uuid, type, change, locale) {
	if (change.type === "property") {
		// Find the property spec to get the display name.
		const p = type.properties.find(p => p.id === change.id)
		if (p === undefined) {
			throw new Error("no such property in object " + id)
		}
		let new_value = await get_property(uuid, p.id, locale);
		let old_value = change.old;
		// Resolve UUID values to human-readable names.
		if (is_valid_uuid(new_value)) {
			new_value = await get_property(new_value, "name", locale) + "*";
		}
		if (is_valid_uuid(change.old)) {
			old_value = await get_property(change.old, "name", locale) + "*";
		} else {
			// For locale-map old values, pick the right locale or default to empty.
			old_value = typeof change.old === "object" ?
				change.old[locale] || "" : change.old || "";
		}
		// Build "PropertyName: <old value in red> => <new value in green>".
		return `<p>&emsp;<b>${p.name[locale] || Object.values(p.name)[0]}՝ </b>
                                        <span style="color:red">${old_value}</span> => 
                                        <span style="color:green">${new_value}</span></p>`;
	} else {
		// Collection change: show which collection element type was added/deleted.
		const c = type.collections.find(c => c.id === change.id)
		if (c === undefined) {
			throw new Error("no such collection in object " + id)
		}
		const type_name = await get_property(c.element_type, "name", locale);
		if (change.type === "collection_add") {
			return `<p>&emsp;Avelacovel e nor ${type_name}։</p>` // "A new <type> was added"
		} else if (change.type === "collection_delete") {
			return `<p>&emsp;Jnjvel e ${type_name}:</p>` // "<type> was deleted"
		} else {
			throw new Error("unknown change")
		}
	}

}

// Resolves the human-readable display name for the editor user.
// Looks up the user object in Metax using the sitemap indices.
// If the user has associated accounts, returns the first account's name.
//
// Parameters:
// - index:  { website_index, cert_index } from get_user_sitemap_indices().
// - locale: Locale for resolving the name property.
async function get_user_name_from_sitemap(index, locale) {
	trace("get_user_name_from_sitemap");
	const user_id = sitemap.websites[index.website_index]
		.client_certificates[index.cert_index].user_id;
	let user = await metax_get(user_id)
		.then(r => JSON.parse(r));
	if (user && is_valid_uuid(user["type"])) {
		// tmp solution, getting first account name
		// if accounts array has elements, first element will be selected
		if (Array.isArray(user["accounts"]) && user["accounts"].length > 0) {
			trace("END get_user_name_from_sitemap");
			return await get_property(user["accounts"][0], "name", locale);
		} else {
			trace("END get_user_name_from_sitemap");
			return await get_property(user_id, "name", locale);
		}
	} else {
		trace("END get_user_name_from_sitemap");
		throw new Error("invalid user in sitemap, uuid: " + user_id);
	}
}

// Collects the email addresses of all "watchers" on a Metax object.
// Fetches each watcher UUID from Metax and reads their "email" field.
// Skips watchers with invalid or missing email addresses (with a warning).
//
// Parameters:
// - obj: The Metax object with a "watchers" array of UUIDs.
//
// Returns: Array of valid email address strings.
async function get_watcher_mails(obj) {
	trace("get_watcher_mails");
	// Basic email format validation regex.
	const mail_regexp = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	let mails = [];
	for (let i = 0; i < obj["watchers"].length; i++) {
		let recepient = await metax_get(obj["watchers"][i])
			.then(r => JSON.parse(r));
		if (mail_regexp.test(recepient["email"])) {
			mails.push(recepient["email"]);
		} else {
			warning("notify_update: recepient " +
				recepient["uuid"] + " doesn't have a valid mail, skipping");
		}
	}
	trace("END get_watcher_mails");
	return mails;
}

// Sends the composed email via the nodemailer transporter.
// Logs errors if the send fails but does not throw (notifications are best-effort).
//
// Parameters:
// - transporter: The nodemailer SMTP transporter for this website.
// - m:           The email object { from, to, subject, html }.
async function send_mail(transporter, m) {
	trace("send_mail");
	const info = await transporter.sendMail(m)
		.catch(e => {
			error("failed to send mail: " + e);
		});
	trace("END send_mail");
}

// Finds the website and certificate indices in the sitemap for a given
// client certificate and authority (subdomain name).
// Used to identify which website the user belongs to.
//
// Parameters:
// - cert:      TLS peer certificate object from the requesting session.
// - authority: The ":authority" header value (subdomain:port).
//
// Returns: { website_index, cert_index } into sitemap.websites arrays.
// Throws if the website or certificate is not found.
async function get_user_sitemap_indices(cert, authority) {
	trace("get_user_sitemap_indices");
	// Find the website that owns the requested subdomain.
	let i = sitemap.websites.findIndex(website => {
		let index = website.subdomains.findIndex(el => el.name === authority.split(":")[0])
		return index !== -1;
	});
	if (i !== -1) {
		// Match the client certificate against stored certificates for this website.
		let client_key = cert.raw.toString('base64');
		let j = sitemap.websites[i].client_certificates.findIndex(el =>
			el["certificate"]
				.replace(/[\r\n]/gm, '')
				.replace(/[\n]/gm, '')
				.includes(client_key));
		if (j !== -1) {
			trace("END get_user_sitemap_indices");
			return { website_index: i, cert_index: j }
		} else {
			trace("END get_user_sitemap_indices");
			throw new Error("unable to find user.");
		}
	} else {
		trace("END get_user_sitemap_indices");
		throw new Error("unable to find user.");
	}
}
