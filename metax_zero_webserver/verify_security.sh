#!/bin/bash
# Backward compatibility wrapper for organized script location
# The actual script is now in scripts/
bash "$(dirname "$0")/scripts/verify_security.sh" "$@"
