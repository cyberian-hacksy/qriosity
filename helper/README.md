# Beam Me Up ARQ Helper

This helper runs on the receiver machine. It exposes a local WebSocket for the
receiver browser and advertises a BLE GATT notify characteristic for the sender
browser.

## Install

For normal use, run a packaged helper executable built for the receiver
machine's operating system. The helper still listens only on localhost and
advertises the same BLE GATT service.

## Build a packaged helper

Build on the same platform you want to run on; PyInstaller does not
cross-compile.

macOS/Linux:

```bash
python3 -m venv .venv
./.venv/bin/python -m pip install --upgrade pip
./.venv/bin/python -m pip install -r helper/requirements-build.txt
./.venv/bin/python helper/build.py
```

Windows PowerShell:

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r .\helper\requirements-build.txt
.\.venv\Scripts\python.exe .\helper\build.py
```

On Windows, `bless` depends on a GitHub-hosted SetupAPI wrapper. Install
Git for Windows first if pip reports that `git` is not available. Running the
helper may also require an Administrator PowerShell because the WinRT backend
can update the local Bluetooth adapter name.

If `helper/build.py` reports that `PyInstaller` is missing, install the build
requirements into the same virtual environment:

```powershell
.\.venv\Scripts\python.exe -m pip install -r .\helper\requirements-build.txt
```

## Run

Packaged helper:

```text
helper/dist/BeamMeUp-Helper
helper/dist/BeamMeUp-Helper.exe
```

Development mode:

macOS/Linux:

```bash
./.venv/bin/python helper/server.py
```

Windows PowerShell:

```powershell
.\.venv\Scripts\python.exe .\helper\server.py
```

Expected output includes:

```text
Advertising BeamMeUp-ARQ
WebSocket bridge listening on ws://127.0.0.1:8787
```

## Web origin approval

The WebSocket bridge trusts local pages automatically: clients with no
`Origin` header, `file://` pages (`Origin: null`), and pages served from
`http://localhost` or `http://127.0.0.1`. The first time a page from any
other origin connects (for example a GitHub Pages deployment of the
receiver), the helper asks in its terminal:

```text
Allow WebSocket connections from https://example.github.io? [y/N]
```

Answering `y` stores the origin in `~/.beammeup/arq-origins.json` so it is
never asked again. Answering `n`, or 60 seconds of silence, rejects that
connection without remembering anything. If the helper has no usable stdin
(double-clicked from a file manager, or backgrounded), unknown origins are
rejected; run the helper from a terminal once to approve a new origin, or
add it to the JSON file by hand.

When the HDMI-UVC receiver screen opens, the browser checks the localhost
helper automatically. If the helper is running, it connects and shows
`Helper connected`. If it is not running, it shows `Start BeamMeUp Helper`;
start the packaged helper and press `Retry helper`.

## Sender-side device chooser

The sender's Bluetooth chooser is filtered to devices advertising the
`BeamMeUp` name prefix or the ARQ service UUID, so the helper is normally the
only entry. Within one browser session, reconnecting reuses the already-granted
device without showing the chooser at all.

On Windows the helper's chooser entry shows the PC's name, not `BeamMeUp-ARQ`:
WinRT advertises under the system Bluetooth adapter name, and renaming it
would change the PC's Bluetooth identity systemwide (and needs Administrator
rights), so the helper leaves it alone. The entry still appears because the
chooser matches the advertised ARQ service UUID.

To skip the chooser across page reloads and browser restarts too, enable two
Chrome flags on the sender machine (both experimental, optional):

```text
chrome://flags/#enable-experimental-web-platform-features   (getDevices API)
chrome://flags/#enable-web-bluetooth-new-permissions-backend (persistent grants)
```

With those set, the Connect button reconnects straight to the previously
granted helper whenever it is advertising, and only falls back to the chooser
when none is reachable.

The receiver browser sends already-fragmented ARQ messages to the WebSocket.
The helper forwards each binary WebSocket message unchanged as one BLE
notification on service `0000fff0-0000-1000-8000-00805f9b34fb`,
characteristic `0000fff1-0000-1000-8000-00805f9b34fb`.

Chrome Web Bluetooth does not expose the negotiated MTU. Keep the browser-side
fragment MTU conservative until the Phase-0 spike confirms the largest reliable
notification size on the target rig.
