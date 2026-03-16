#!/bin/bash
# =============================================================================
# create_sitemap.sh - Initialize the Sitemap Object in Metax Storage
# =============================================================================
#
# This is a one-time setup script run during initial project configuration.
# It creates the sitemap storage files that webserver.mjs reads at startup.
#
# What it does:
#   1. Generates a fresh UUID for the sitemap object (via gen_uuid.sh).
#   2. Reads the template files (sitemap_file, sitemap_file.contract) and
#      replaces all SITEMAP_UUID placeholders with the generated UUID.
#      Also replaces YYYY-mm-dd with today's date.
#   3. Writes the processed files as <UUID> and <UUID>.contract.
#      These two files must then be copied into the storage/ directory.
#   4. Updates start.conf so SITEMAP_UUID points to the new UUID.
#
# After running this script:
#   - Move the generated <UUID> and <UUID>.contract files to storage/.
#   - Verify that SITEMAP_UUID in scripts/start.conf matches the new UUID.
#
# Prerequisites:
#   - gen_uuid.sh must be in the same directory and executable.
#   - sitemap_file and sitemap_file.contract template files must exist here.
#   - scripts/start.conf must exist and contain a SITEMAP_UUID placeholder.
#
# Usage: cd setup_scripts && ./create_sitemap.sh
# =============================================================================

# Run the gen_uuid.sh script and capture the generated UUID into SITEMAP_UUID
SITEMAP_UUID=$(./gen_uuid.sh)
if [ $? -ne 0 ]; then
  echo "Error: gen_uuid.sh failed to execute." >&2
  exit 1
fi

# Validate that a UUID was actually produced
if [ -z "$SITEMAP_UUID" ]; then
  echo "Error: gen_uuid.sh did not produce a valid output." >&2
  exit 1
fi

echo "Generated Sitemap UUID: $SITEMAP_UUID"

# Template and output file names
ORIGINAL_FILE="sitemap_file"           # JSON template for the sitemap object
CONTRACT_FILE="sitemap_file.contract"  # Metadata contract for the sitemap
CONF_FILE="../scripts/start.conf"       # Server configuration file

# Output file names use the UUID so Metax can locate them by UUID key
NEW_FILE="${SITEMAP_UUID}"
NEW_CONTRACT_FILE="${SITEMAP_UUID}.contract"

# Process the JSON template: replace SITEMAP_UUID and today's date
if [ -f "$ORIGINAL_FILE" ]; then
  sed -e "s/SITEMAP_UUID/${SITEMAP_UUID}/g" -e "s/YYYY-mm-dd/$(date +'%Y-%m-%d')/g" "$ORIGINAL_FILE" > "$NEW_FILE"
  echo "Updated file written to: $NEW_FILE"
else
  echo "Warning: File '$ORIGINAL_FILE' not found. Skipping."
fi

# Process the contract template: replace SITEMAP_UUID placeholder
if [ -f "$CONTRACT_FILE" ]; then
  sed "s/SITEMAP_UUID/${SITEMAP_UUID}/g" "$CONTRACT_FILE" > "$NEW_CONTRACT_FILE"
  echo "Updated file written to: $NEW_CONTRACT_FILE"
else
  echo "Warning: File '$CONTRACT_FILE' not found. Skipping."
fi

# Update start.conf so the server knows which UUID is the sitemap at startup
if [ -f "$CONF_FILE" ]; then
  cp $CONF_FILE $CONF_FILE.orig
  sed "s/'__SITEMAPUUID__'/${SITEMAP_UUID}/g" "$CONF_FILE" > "$CONF_FILE.tmp" && mv "$CONF_FILE.tmp" "$CONF_FILE"
  echo "Updated file written to: $CONF_FILE"
else
  echo "Warning: File '$CONF_FILE' not found. Skipping."
fi

echo "All done!"
echo "Now you can move generated files to storage/ and change SITEMAP_UUID in start.conf"
