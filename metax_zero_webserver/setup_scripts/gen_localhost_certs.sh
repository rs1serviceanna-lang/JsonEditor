#!/bin/bash
# =============================================================================
# gen_localhost_certs.sh - Generate mTLS Certificates for Localhost
# =============================================================================
#
# This script creates all TLS certificates needed for the internal mTLS
# communication between the Greenhosting webserver and the Metax backend.
#
# Generated certificate structure:
#
#   CA (Certificate Authority):
#     ca.key / ca.crt
#       - Self-signed root CA used to sign both the server and client certs.
#       - Both processes use this CA to verify each other's certificates.
#
#   Metax Server Certificate (for localhost:METAX_PORT):
#     metax_localhost_server.key / metax_localhost_server.crt
#       - Used by the Metax backend (rest_api.mjs) as its TLS identity.
#       - SAN includes DNS:localhost, IP:127.0.0.1, IP:::1.
#       - extendedKeyUsage = serverAuth
#
#   Greenhosting Client Certificate (used by webserver to authenticate with Metax):
#     greenhosting_client.key / greenhosting_client.crt
#       - Used by webserver.mjs when connecting to Metax as a client.
#       - Metax uses the CA to verify this certificate.
#       - extendedKeyUsage = clientAuth
#
# All certificates are 4096-bit RSA with 3650-day validity (10 years).
# All files are placed in: certs/localhost/ relative to project root.
#
# Usage: ./gen_localhost_certs.sh
# Run once during initial setup, or whenever certificates need to be regenerated.
# =============================================================================

# Determine script directory to ensure correct paths
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
CERT_DIR="$SCRIPT_DIR/../certs/localhost"
mkdir -p "$CERT_DIR"

echo "Generating CA for localhost communication..."
# Generate CA private key (4096-bit RSA for strong security)
openssl genrsa -out "$CERT_DIR/ca.key" 4096

# Generate self-signed CA certificate (valid 10 years)
openssl req -new -x509 -days 3650 -key "$CERT_DIR/ca.key" -out "$CERT_DIR/ca.crt" \
  -subj "/C=AM/ST=Yerevan/L=Yerevan/O=MetaxLocal/OU=LocalCA/CN=Metax Local CA"

echo "Generating Metax server certificate for localhost..."
# Generate server private key
openssl genrsa -out "$CERT_DIR/metax_localhost_server.key" 4096

# Generate server Certificate Signing Request (CSR)
openssl req -new -key "$CERT_DIR/metax_localhost_server.key" -out "$CERT_DIR/metax_localhost_server.csr" \
  -subj "/C=AM/ST=Yerevan/L=Yerevan/O=MetaxLocal/OU=MetaxServer/CN=localhost"

# Create server extensions file: SAN for localhost and serverAuth usage
cat > "$CERT_DIR/server-ext.cnf" << EOF
subjectAltName = DNS:localhost,IP:127.0.0.1,IP:::1
extendedKeyUsage = serverAuth
EOF

# Sign server certificate with the local CA
openssl x509 -req -in "$CERT_DIR/metax_localhost_server.csr" -CA "$CERT_DIR/ca.crt" \
  -CAkey "$CERT_DIR/ca.key" -CAcreateserial -out "$CERT_DIR/metax_localhost_server.crt" \
  -days 3650 -extfile "$CERT_DIR/server-ext.cnf"

echo "Generating webserver client certificate..."
# Generate client private key (used by greenhosting_webserver_2)
openssl genrsa -out "$CERT_DIR/greenhosting_client.key" 4096

# Generate client CSR
openssl req -new -key "$CERT_DIR/greenhosting_client.key" -out "$CERT_DIR/greenhosting_client.csr" \
  -subj "/C=AM/ST=Yerevan/L=Yerevan/O=MetaxLocal/OU=Webserver/CN=webserver-client"

# Create client extensions file: clientAuth usage only
cat > "$CERT_DIR/client-ext.cnf" << EOF
extendedKeyUsage = clientAuth
EOF

# Sign client certificate with the local CA
openssl x509 -req -in "$CERT_DIR/greenhosting_client.csr" -CA "$CERT_DIR/ca.crt" \
  -CAkey "$CERT_DIR/ca.key" -CAcreateserial -out "$CERT_DIR/greenhosting_client.crt" \
  -days 3650 -extfile "$CERT_DIR/client-ext.cnf"

# Clean up temporary CSR and extension config files (not needed after signing)
rm -f "$CERT_DIR"/*.csr "$CERT_DIR"/*.cnf "$CERT_DIR"/*.srl

echo "Localhost certificates generated successfully in $CERT_DIR/"
echo ""
echo "Generated files:"
echo "  CA: ca.crt, ca.key"
echo "  Metax Server: metax_localhost_server.crt, metax_localhost_server.key"
echo "  Webserver Client: greenhosting_client.crt, greenhosting_client.key"
