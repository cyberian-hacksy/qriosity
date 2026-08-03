<img src="logo.png" alt="Beam Me Up" width="200">

# Beam Me Up

> *"Beam me up, Scotty!"*
>
> The iconic phrase from Star Trek that everyone knows - even though it was never actually said exactly that way in the original series. Captain Kirk would request transport back to the Enterprise, and Scotty would dematerialize him into a stream of light, sending his very atoms across the void of space.
>
> This app does something similar for your files. No network? No problem. Beam Me Up transforms your data into patterns of light that travel through the air from one device to another. Like a transporter, but for files - and without the risk of having your atoms scrambled.

Air-gapped file transfer between devices with zero network connectivity. Three transfer modes: QR codes, CIMBAR (color-coded visual data), and HDMI-UVC (direct capture-card link).

**Try it now:** [cyberian-hacksy.github.io/beammeup](https://cyberian-hacksy.github.io/beammeup/)

**100% Local & Private** - Nothing is uploaded to any server. All encoding, decoding, and file handling happens entirely in your browser. The app works offline after first load.

**Install it** - The hosted site is a PWA: open it once, add it to your home screen, and it keeps working with the network off — camera and all decoders included. That is the recommended way to run the receiver on a phone: opening the raw HTML file from local storage blocks camera access on iOS and Android (a browser rule about `file://` pages, not something the app can work around).

## How It Works

1. **Sender** device encodes a file into a continuous stream of visual patterns
2. **Receiver** device captures the stream via camera (or capture card) and reconstructs the file
3. Fountain codes provide redundancy - no acknowledgments needed, works even if some frames are missed

## Transfer Modes

| Mode | Speed | Notes |
|------|-------|-------|
| **QR Transfer** | up to ~700 kbps | Standard QR format (up to v40 frames at 30 fps), camera-based |
| **CIMBAR Transfer** | ~850 kbps | High-density color-coded format, camera-based |
| **HDMI-UVC Transfer** | up to ~20 MB/s | HDMI out → UVC capture card, optional Bluetooth ARQ back-channel |

All modes require this app on both sender and receiver devices.

## Features

- **Completely offline** - No server uploads, all processing happens locally in-browser
- **Air-gapped transfer** - No network or pairing required (Bluetooth is optional, for the HDMI-UVC ARQ back-channel)
- **Multiple transfer modes** - Choose speed vs compatibility trade-off
- **Raptor-Lite coding** - Fountain codes with XOR parity pre-coding for efficient transfer
- **Adaptive compression** - Payloads are gzipped when it shrinks them (already-compressed formats are skipped)
- **Single HTML file** - Download once, use offline forever
- **Hash verification** - SHA-256 of the original bytes, verified end-to-end
- **Screen wake lock** - The screen stays awake while a transfer runs
- **Cross-device** - Works between any devices with a screen and camera
- **Mobile-optimized** - Auto-starts camera, simple toggle for front/back cameras
- **Drag & drop** - Drop files directly onto the sender screen
- **Text snippets** - Paste text on the QR sender; the receiver shows it with a Copy button instead of downloading
- **Install as an app** - PWA with full offline support once installed
- **Large files** - Up to 64 MB via QR, 33 MB via CIMBAR, 1 GB via HDMI-UVC

## Usage

### Quick Start

1. Open `dist/index.html` in a browser on both devices
2. On the sending device: Select a transfer mode and drop or select a file
3. On the receiving device: Select the matching receive mode, camera starts automatically
4. Wait for transfer to complete, file downloads automatically

### QR Transfer

Best for: Small files, compatibility with other apps

1. Click "SEND" under QR Transfer
2. Drag a file onto the drop zone or click to select (max 64MB)
3. Adjust presets as needed:
   - **Data** - Block size (Light 150B - Insane 2938B; Ultra/Insane are BW-mode only)
   - **Size** - QR display size (Small 320px - XL 680px)
   - **Speed** - Frame rate (Slow 200ms - Ludicrous 16ms; Ludicrous needs a 120Hz sender screen)
4. Click "Start" to begin transmission

To send text instead of a file, switch the sender to **Text**, paste, and hit
"Send text" — the receiver shows the text with a Copy button.

### CIMBAR Transfer

Best for: Larger files, faster transfer when using this app on both ends

1. Click "SEND" under CIMBAR Transfer
2. Drop or select a file
3. Adjust size and speed presets
4. Click "Start" to begin high-speed transmission

### HDMI-UVC Transfer

Best for: Large files, by far the fastest mode

Instead of a camera, the receiver reads the sender's screen through an HDMI→USB
(UVC) capture card, which turns the optical link into a clean, high-bandwidth
channel.

1. Connect the sender's HDMI output to the receiver's capture card
2. Click "SEND" under HDMI-UVC Transfer, drop a file, press Start
3. On the receiver, select the capture card as the video source
4. Optional: run the Bluetooth ARQ back-channel (see `helper/`) so the sender
   can repair exactly the frames the receiver missed instead of re-looping

## Development

```bash
# Install dependencies
pnpm install

# Development server
pnpm dev

# Build single-file output
pnpm build

# Run the Node test suite (also runs in CI)
pnpm test

# Full browser suite (adds DOM/receiver tests)
# Visit http://localhost:5173/?test
```

## Technical Details

- **QR Encoding:** Raptor-Lite (LT fountain codes with XOR parity pre-coding)
  - Pre-coding: 3 layers of parity blocks (~3sqrt(K) blocks, 1-4% overhead)
  - Systematic phase: symbols 1-K' contain one intermediate block each
  - Fountain phase: 15% degree-1, 85% degree-3 (XOR of random blocks)
  - Two-phase decoder: belief propagation + parity recovery
- **QR frames:** Raw binary in byte mode (no base64) with a pinned mask pattern
  for fast generation; decoded by zxing-cpp WASM in a worker pool, with jsQR as
  fallback and for the color modes
- **Compression:** Adaptive gzip at file selection (skipped for already-compressed
  formats); SHA-256 stays on the original bytes, verified after decompression
- **CIMBAR:** Color-coded visual encoding using libcimbar
- **HDMI-UVC:** Luminance-modulated frames over a capture card, WASM decode
  kernels, optional Bluetooth ARQ back-channel for send-once + repair
- **Block size:** Configurable 150-2938 bytes for QR mode
- **Protocol:** 15-byte binary header with session ID, block count, symbol ID, flags, CRC32

## Limitations

- Max file size: 64 MB (QR), 33 MB (CIMBAR), 1 GB (HDMI-UVC)
- Camera modes require good lighting and steady positioning
- Browser tab must stay in the foreground during transfer (a screen wake lock
  is held automatically, but switching apps still pauses it)
- Transfer speed depends on camera quality, distance, and settings
- The densest QR presets (Ultra/Insane) need a close, steady, high-resolution
  camera - drop the Data preset if nothing decodes

## Acknowledgments

CIMBAR transfer mode is powered by [libcimbar](https://github.com/sz3/libcimbar) by [sz3](https://github.com/sz3), an experimental high-density barcode format for air-gapped data transfer. The libcimbar WASM module is licensed under the [Mozilla Public License 2.0](https://www.mozilla.org/en-US/MPL/2.0/).

QR decoding is powered by [zxing-cpp](https://github.com/zxing-cpp/zxing-cpp) via [zxing-wasm](https://github.com/Sec-ant/zxing-wasm), with [jsQR](https://github.com/cozmo/jsQR) as fallback and for the color modes. QR generation uses [node-qrcode](https://github.com/soldair/node-qrcode).

## License

MIT
