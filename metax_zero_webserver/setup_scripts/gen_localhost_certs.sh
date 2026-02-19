#!/bin/bash

# Generate localhost certificates for metax-webserver mutual TLS authentication
# This script creates:
# 1. CA certificate (to sign both server and client certs)
# 2. Server certificate for metax (localhost:5001)
# 3. Client certificate for webserver to authenticate with metax

# Determine script directory to ensure correct paths
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
CERT_DIR="$SCRIPT_DIR/../certs/localhost"
mkdir -p "$CERT_DIR"

echo "Generating CA for localhost communication..."
# Generate CA private key
openssl genrsa -out "$CERT_DIR/ca.key" 4096

# Generate CA certificate
openssl req -new -x509 -days 3650 -key "$CERT_DIR/ca.key" -out "$CERT_DIR/ca.crt" \
  -subj "/C=AM/ST=Yerevan/L=Yerevan/O=MetaxLocal/OU=LocalCA/CN=Metax Local CA"

echo "Generating Metax server certificate for localhost..."
# Generate server private key
openssl genrsa -out "$CERT_DIR/metax_localhost_server.key" 4096

# Generate server CSR
openssl req -new -key "$CERT_DIR/metax_localhost_server.key" -out "$CERT_DIR/metax_localhost_server.csr" \
  -subj "/C=AM/ST=Yerevan/L=Yerevan/O=MetaxLocal/OU=MetaxServer/CN=localhost"

# Create server extensions file
cat > "$CERT_DIR/server-ext.cnf" << EOF
subjectAltName = DNS:localhost,IP:127.0.0.1,IP:::1
extendedKeyUsage = serverAuth
EOF

# Sign server certificate with CA
openssl x509 -req -in "$CERT_DIR/metax_localhost_server.csr" -CA "$CERT_DIR/ca.crt" \
  -CAkey "$CERT_DIR/ca.key" -CAcreateserial -out "$CERT_DIR/metax_localhost_server.crt" \
  -days 3650 -extfile "$CERT_DIR/server-ext.cnf"

echo "Generating webserver client certificate..."
# Generate client private key
openssl genrsa -out "$CERT_DIR/greenhosting_client.key" 4096

# Generate client CSR
openssl req -new -key "$CERT_DIR/greenhosting_client.key" -out "$CERT_DIR/greenhosting_client.csr" \
  -subj "/C=AM/ST=Yerevan/L=Yerevan/O=MetaxLocal/OU=Webserver/CN=webserver-client"

# Create client extensions file
cat > "$CERT_DIR/client-ext.cnf" << EOF
extendedKeyUsage = clientAuth
EOF

# Sign client certificate with CA
openssl x509 -req -in "$CERT_DIR/greenhosting_client.csr" -CA "$CERT_DIR/ca.crt" \
  -CAkey "$CERT_DIR/ca.key" -CAcreateserial -out "$CERT_DIR/greenhosting_client.crt" \
  -days 3650 -extfile "$CERT_DIR/client-ext.cnf"

# Clean up CSR and extension files
rm -f "$CERT_DIR"/*.csr "$CERT_DIR"/*.cnf "$CERT_DIR"/*.srl

echo "Localhost certificates generated successfully in $CERT_DIR/"
echo ""
echo "Generated files:"
echo "  CA: ca.crt, ca.key"
echo "  Metax Server: metax_localhost_server.crt, metax_localhost_server.key"
echo "  Webserver Client: greenhosting_client.crt, greenhosting_client.key"
