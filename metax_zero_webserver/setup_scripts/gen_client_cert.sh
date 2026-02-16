#!/bin/bash

# Script to generate a client certificate for a user
# Usage: ./gen_client_cert.sh <username>

if [ -z "$1" ]; then
    echo "Usage: $0 <username>"
    exit 1
fi

USERNAME="$1"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
CERT_DIR="$SCRIPT_DIR/../certs/localhost"
mkdir -p "$CERT_DIR"

echo "Generating client certificate for '$USERNAME'..."

# Generate private key
openssl genrsa -out "$CERT_DIR/$USERNAME.key" 4096

# Generate CSR
openssl req -new -key "$CERT_DIR/$USERNAME.key" -out "$CERT_DIR/$USERNAME.csr" \
    -subj "/C=AM/ST=Yerevan/L=Yerevan/O=MetaxLocal/OU=Clients/CN=$USERNAME"

# Create extension file for client auth
cat > "$CERT_DIR/$USERNAME-ext.cnf" << EOF
extendedKeyUsage = clientAuth
EOF

# Sign certificate with CA
openssl x509 -req -in "$CERT_DIR/$USERNAME.csr" -CA "$CERT_DIR/ca.crt" \
    -CAkey "$CERT_DIR/ca.key" -CAcreateserial -out "$CERT_DIR/$USERNAME.crt" \
    -days 3650 -extfile "$CERT_DIR/$USERNAME-ext.cnf"

# Convert to PKCS#12 for Browser Import (Windows/Mac/Linux/Android/iOS)
# This packages the Key + Cert + CA Cert into one file
openssl pkcs12 -export -out "$CERT_DIR/$USERNAME.p12" \
    -inkey "$CERT_DIR/$USERNAME.key" \
    -in "$CERT_DIR/$USERNAME.crt" \
    -certfile "$CERT_DIR/ca.crt" \
    -passout pass:metax123

# Clean up temporary files
rm -f "$CERT_DIR"/*.csr "$CERT_DIR"/*.cnf "$CERT_DIR"/*.srl

echo ""
echo "Certificate generated successfully!"
echo "Files located in: $CERT_DIR"
echo "1. $USERNAME.crt (Public Certificate)"
echo "2. $USERNAME.key (Private Key)"
echo "3. $USERNAME.p12 (For Browser/OS Import - Password: metax123)"
