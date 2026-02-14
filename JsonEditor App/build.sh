#!/bin/bash
set -e

# Ensure we are running from the script's directory so build artifacts stay here
cd "$(dirname "$0")"

# 1. Find qmake automatically
QMAKE_PATH=$(which qmake || true)

if [ -z "$QMAKE_PATH" ]; then
    echo "Qt qmake not found in PATH. Trying common locations..."
    # Add common Qt paths
    for QT_DIR in /opt/qt*/bin ~/Qt/*/gcc_64/bin; do
        if [ -x "$QT_DIR/qmake" ]; then
            QMAKE_PATH="$QT_DIR/qmake"
            break
        fi
    done
fi

if [ -z "$QMAKE_PATH" ]; then
    echo "ERROR: qmake not found. Install Qt or add it to PATH."
    exit 1
fi

echo "Using qmake at $QMAKE_PATH"

# 2. Add Qt bin folder to PATH
QT_BIN=$(dirname "$QMAKE_PATH")
export PATH="$QT_BIN:$PATH"

# 3. Set library path for runtime
QT_LIB=$(dirname "$QT_BIN")/lib
export LD_LIBRARY_PATH="$QT_LIB:$LD_LIBRARY_PATH"

# 4. Clean old build
echo "Cleaning old build files..."
rm -f Makefile
rm -f *.o
rm -f moc_*.cpp

# 5. Generate Makefile
echo "Running qmake..."
"$QMAKE_PATH" -o Makefile JsonEditor.pro

# 6. Build project
echo "Running make..."
make

echo "Build completed successfully!"

