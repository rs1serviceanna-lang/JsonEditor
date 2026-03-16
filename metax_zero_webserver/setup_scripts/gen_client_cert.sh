#!/bin/bash
# =============================================================================
# gen_client_cert.sh - Generate a Client TLS Certificate for a User
# =============================================================================
#
# Creates a client certificate for a named user so they can authenticate
# with the Greenhosting webserver via mTLS. The certificate is signed by
# the local CA (ca.crt / ca.key) in certs/localhost/.
#
# Generated files (placed in certs/localhost/):
#   <username>.key  - RSA private key (4096-bit). Keep this secret.
#   <username>.crt  - Signed client certificate (PEM format).
#   <username>.p12  - PKCS#12 bundle (key + cert + CA) for browser/OS import.
#                     Password: metax123
#
# The certificate uses extendedKeyUsage = clientAuth so it is only valid
# for client authentication (not for signing other certs or server use).
# CN is set to <username> which is used as the user identifier in audit logs
# and in the sitemap's client_certificates list.
#
# Prerequisites:
#   - Run gen_localhost_certs.sh first to create the CA.
#
# Usage: ./gen_client_cert.sh <username>
# Example: ./gen_client_cert.sh anna
# =============================================================================

# Require a username argument
if [ -z "$1" ]; then
    echo "Usage: $0 <username>"
    exit 1
fi

USERNAME="$1"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
CERT_DIR="$SCRIPT_DIR/../certs/localhost"
mkdir -p "$CERT_DIR"

echo "Generating client certificate for '$USERNAME'..."

# Generate RSA private key (4096-bit for strong security)
openssl genrsa -out "$CERT_DIR/$USERNAME.key" 4096

# Generate Certificate Signing Request (CSR) with the username as CN
# CN is used by router.mjs for audit logging and user identification
openssl req -new -key "$CERT_DIR/$USERNAME.key" -out "$CERT_DIR/$USERNAME.csr" \
    -subj "/C=AM/ST=Yerevan/L=Yerevan/O=MetaxLocal/OU=Clients/CN=$USERNAME"

# Create extension config: restrict this cert to client authentication only
cat > "$CERT_DIR/$USERNAME-ext.cnf" << EOF
extendedKeyUsage = clientAuth
EOF

# Sign the CSR with the local CA to produce the final client certificate
openssl x509 -req -in "$CERT_DIR/$USERNAME.csr" -CA "$CERT_DIR/ca.crt" \
    -CAkey "$CERT_DIR/ca.key" -CAcreateserial -out "$CERT_DIR/$USERNAME.crt" \
    -days 3650 -extfile "$CERT_DIR/$USERNAME-ext.cnf"

# Convert to PKCS#12 for Browser Import (Windows/Mac/Linux/Android/iOS).
# PKCS#12 bundles the private key, certificate, and CA cert into one file.
# The browser/OS uses this to present the certificate during TLS handshake.
openssl pkcs12 -export -out "$CERT_DIR/$USERNAME.p12" \
    -inkey "$CERT_DIR/$USERNAME.key" \
    -in "$CERT_DIR/$USERNAME.crt" \
    -certfile "$CERT_DIR/ca.crt" \
    -passout pass:metax123

# Clean up temporary files (CSR, extension config, serial file)
rm -f "$CERT_DIR"/*.csr "$CERT_DIR"/*.cnf "$CERT_DIR"/*.srl

echo ""
echo "Certificate generated successfully!"
echo "Files located in: $CERT_DIR"
echo "1. $USERNAME.crt (Public Certificate)"
echo "2. $USERNAME.key (Private Key)"
echo "3. $USERNAME.p12 (For Browser/OS Import - Password: metax123)"
