/*
====================== translator.mjs - AI Property Translation ===============

This module provides automatic translation of localized object properties
using the OpenAI Chat Completions API (GPT-4o by default).

--- How It Works ---

  1. Reads the target object from Metax storage by UUID.
  2. Finds the property to translate (must be a locale map: { locale: value }).
  3. Gathers all existing locale values (except the target locale).
  4. Constructs a prompt asking GPT to translate the existing text to the target locale.
  5. Makes an HTTPS POST request to the OpenAI API.
  6. Returns the translated text string.

--- Usage ---

  Called via the HTTP route /translate_property handled in router.mjs.
  Requires an OpenAI API key stored in the website's sitemap configuration.

--- API Configuration ---

  API_URL_HOST    - OpenAI API hostname.
  API_URL_PATH    - Chat completions endpoint path.
  API_MODEL       - Which GPT model to use (currently "gpt-4o").
  API_TEMPERATURE - Controls randomness (0.3 = fairly deterministic).
  GPT_SYSTEM_INSTRUCTION - The system message given to GPT as context.

================================================================================
*/

// ====================== Imports from standard libraries ======================

// Built-in Node.js HTTPS module used to make requests to the OpenAI API.
import https from 'https'

// ========================= API Configuration =================================

// OpenAI API connection settings.
const API_URL_HOST = "api.openai.com";       // Hostname for all OpenAI API requests.
const API_URL_PATH = "/v1/chat/completions"; // Endpoint for Chat Completions.
const API_MODEL = "gpt-4o";                  // GPT model to use for translation.
const API_TEMPERATURE = 0.3;                 // Low temperature = more deterministic output.

// System instruction given to GPT to set the translation context.
// Instructs GPT not to use transliterated or foreign words.
const GPT_SYSTEM_INSTRUCTION = "You are a powerful translator of modern and ancient languages. You aren't using transliterated or foreign words."

// ========================= Public API ========================================

// Translates a specific property of a Metax object to the requested locale.
// The property must be an internationalized locale map (e.g., { en_US: "Cat", hy_AM: "Կատու" }).
//
// Parameters:
// - id:       UUID of the Metax object containing the property.
// - property: The property key (field name) to translate.
// - locale:   Target locale code to translate into (e.g., "fr_FR").
// - api_key:  OpenAI API key for authentication.
//
// Returns: A Promise resolving to the translated text string.
//
// Throws if:
// - The object is not valid JSON.
// - The property doesn't exist or is not a locale map object.
// - No source values are available to translate from.
// - The OpenAI API returns an invalid response.
export async function translate_property(id, property, locale, api_key) {
        // Load and parse the object from Metax storage.
        const object = await metax_get(id).then(JSON.parse).catch(e => {
                throw "invalid object"
        });
        // Verify the property exists and is a locale map (i18n-enabled object property).
        if (!object[property] || typeof object[property] !== "object") {
                throw "no such property or it's not translatable " + property
        }
        // Collect all existing locale values (excluding the target locale and empty values).
        const langs = [];
        for (let l of Object.keys(object[property])) {
                // Skip the target locale (we're translating TO it) and empty strings.
                if (l === locale || !object[property][l]) continue
                langs.push({
                        locale: l,
                        value: object[property][l]
                });
        }
        // Need at least one source value to translate from.
        if (langs.length === 0) {
                throw "can't translate property, no value available"
        }
        // Build the GPT message array and make the API call.
        const messages = construct_messages(object, property, locale, langs);
        const data = await openai_api_request(messages, api_key);
        return data
}

// ========================= Internal Helpers ==================================

// Builds the GPT conversation messages needed to request a translation.
// Constructs a user prompt listing all available source values and asking
// for translation to the target locale.
//
// Parameters:
// - object:   The Metax object (used for context in future TODO expansion).
// - property: The property key being translated.
// - locale:   The target locale to translate into.
// - langs:    Array of { locale, value } pairs with existing translations.
//
// Returns: Array of chat message objects in OpenAI API format.
function construct_messages(object, property, locale, langs) {
        // TODO: Add some context about the object to improve translation accuracy
        const messages = [{ role: "system", content: GPT_SYSTEM_INSTRUCTION }];
        // Build a prompt that lists all source language values.
        let prompt = `Translate text from `
        langs.forEach(l => {
                prompt += `${l.locale} : "${l.value}" `;
        });
        prompt += `to ${locale}.`;
        // Ask GPT to return only the translated text, no quotes or extra formatting.
        prompt += " Please provide only translated text without quotes.";
        messages.push({ role: "user", content: prompt });
        return messages
}

// Makes an HTTPS POST request to the OpenAI Chat Completions API.
// Returns a Promise that resolves with the translated text content from the response.
//
// Parameters:
// - messages: Array of chat messages in OpenAI API format.
// - api_key:  Bearer token for OpenAI API authentication.
//
// Returns: Promise<string> resolving to the GPT-generated translation text.
//
// Rejects if:
// - The HTTPS request fails.
// - The response cannot be parsed as JSON.
// - The response structure is missing choices[0].message.content.
function openai_api_request(messages, api_key) {
        return new Promise((res, rej) => {
                let data = '';
                // Request body: model settings and the conversation messages.
                const body = {
                        model: API_MODEL,
                        temperature: API_TEMPERATURE,
                        messages: messages
                }
                const request = https.request({
                        hostname: API_URL_HOST,
                        path: API_URL_PATH,
                        method: "POST",
                        headers: {
                                "Content-Type": "application/json",
                                "Authorization": `Bearer ${api_key}` // API key as Bearer token
                        }
                }, (r) => {
                        // Accumulate chunks of the response body.
                        r.on("data", d => {
                                data += d;
                        })
                        r.on("error", e => {
                                error("error in openai request " + e);
                                rej(e);
                        })
                        r.on("end", () => {
                                try {
                                        // Parse the JSON response and extract the translation text.
                                        data = JSON.parse(data);
                                        res(data.choices[0].message.content);
                                } catch (e) {
                                        error("Invalid response from openai " +
                                                data.toString());
                                        rej("invalid response");
                                }
                        })
                });
                // Send the request body and close the request stream.
                request.write(JSON.stringify(body));
                request.end();
        })
}
