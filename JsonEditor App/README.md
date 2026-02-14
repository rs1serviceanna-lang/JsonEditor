# JsonEditor App

A professional, high-performance Qt-based JSON editor designed for real-time interaction with the Metax ecosystem. This application allows users to fetch, edit, and synchronize JSON data securely over HTTPS with WebSocket support for live updates.

## Features

-   **Real-time Synchronization**: Powered by Qt WebSockets for instantaneous data updates.
-   **Secure Communication**: Full support for SSL/TLS (HTTPS) to ensure data integrity and privacy.
-   **Dynamic UI**: Responsive window positioning and sizing via command-line arguments.
-   **UUID-based Operations**: Load and manage data entries using unique identifiers.
-   **Integrated Server Logic**: Includes a stable REST API implementation for seamless local development.

## Project Structure

-   `JsonEditor.pro`: The Qt project configuration file.
-   `main.cpp`: Entry point with complex signal handling and command-line parsing.
-   `JsonEditorDialog.cpp/h`: Core logic and user interface implementation.
-   `build.sh`: Automated script for environment detection and compilation.
-   `JsonEditor.sh`: A comprehensive launcher that initializes both the local Metax server and the application.
-   `rest_api_stable.mjs`: Node.js implementation of the backend communication layer.

## Prerequisites

-   **Qt 5.15+** (Core, Gui, Widgets, Network, WebSockets modules)
-   **Node.js 16+** (For the internal server component)
-   **GCC/G++** with C++11 support
-   **OpenSSL** for HTTPS support

## Getting Started

### 1. Build the Application

Use the provided build script to compile the project. It automatically detects your Qt installation and generates the necessary binary inside the folder.

```bash
./build.sh
```

### 2. Launch the Application

The easiest way to start the editor along with a local Metax server is to use the launcher script:

```bash
./JsonEditor.sh
```

### 3. Manual Arguments

You can also run the binary directly with custom parameters:

```bash
./JsonEditor --server "https://your-server:5001" --uuid "your-uuid-here" --width 1024 --height 768
```

#### Available Options:
-   `--server <url>`: Set the Metax server URL (Default: `https://localhost:5001`).
-   `--uuid <uuid>`: Load a specific data entry on startup.
-   `--width`, `--height`: Set initial window dimensions.
-   `--x`, `--y`: Set initial window coordinates.

## Signal Handling

The application includes advanced UNIX signal handling. Sending a `SIGUSR1` to the running process will trigger a safe disconnection from the server, useful for automation and testing scenarios.

---
*Developed as part of the Metax Ecosystem.*
