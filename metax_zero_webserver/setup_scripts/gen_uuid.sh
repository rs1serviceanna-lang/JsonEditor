#!/bin/bash
# =============================================================================
# gen_uuid.sh - Generate a Double-UUID Storage Key
# =============================================================================
#
# Outputs a single "double UUID" string to stdout by concatenating two random
# UUIDs separated by a dash. This matches the format used by db.mjs when
# creating new storage keys to ensure uniqueness across distributed systems.
#
# Format: <uuid>-<uuid>
# Example: 550e8400-e29b-41d4-a716-446655440000-f47ac10b-58cc-4372-a567-0e02b2c3d479
#
# Used by create_sitemap.sh and any other setup scripts that need a fresh UUID
# for naming storage files.
#
# Usage: ./gen_uuid.sh
#        SITEMAP_UUID=$(./gen_uuid.sh)
# =============================================================================

# Generate two random UUIDs and join them with a dash to form a double-UUID
echo $(uuidgen -r)-$(uuidgen -r)
