# JsonEditor (with Metax)

This repository contains the Metax JSON editing ecosystem, consisting of a high-performance Qt client and a specialized Node.js metadata webserver.

## Project Components

### 1. [JsonEditor App](./JsonEditor%20App/)
A Qt-based desktop application for real-time JSON data manipulation.
- **Languages**: C++, Qt 5
- **Features**: Real-time sync, SSL support, Command-line control.

### 2. [Metax Zero Webserver](./metax_zero_webserver/)
A lightweight, secure metadata server that handles storage and synchronization.
- **Languages**: Node.js (MJS)
- **Features**: UUID-based storage, Contract-based metadata, WebSocket broadcasting.

## Quick Start

To build and run the entire environment:

1. **Build the Application**:
   ```bash
   cd "JsonEditor App"
   ./build.sh
   ```

2. **Run the Ecosystem**:
   ```bash
   cd "JsonEditor App"
   ./JsonEditor.sh
   ```
   *This script will start the webserver in the background and then launch the editor.*

## Design Philosphy

The ecosystem is designed around **UUID-linked storage**. Each data entry is split into a "Data file" and a "Contract file" (metadata). This separation allows for efficient streaming of large payloads (like video/audio) while maintaining a lightweight JSON structure for the editor.

---
*Developed for advanced data synchronization workflows.*
