# Tethered capture

A camera on one USB cable: its live view in the live loupe, the shutter from
the app, and the RAW imported and converted as it arrives. No vendor SDK, no
Wi-Fi, nothing for the user to install.

## Where it works

| | State |
|---|---|
| macOS desktop app, Leica M11 (firmware 2.6.4) | measured on the camera, 2026-11-13 |
| The rest of the M11 series (M11-P, M11 Monochrom, M11-D) | offered: same dialect by Leica's own tether clients; not measured here |
| Other Leica bodies (SL3, Q3 …) | not offered until measured |
| Sony, Nikon, Canon, Fujifilm | not implemented; each needs its dialect measured on a body |
| Windows, Linux, iPad | no transport yet (WPD, libusb, ImageCaptureCore on iPadOS) |
| Web | not possible: the operating system owns the camera's USB interface |

The feature ships for the Leica M11 series only, and says so wherever it is
offered. `Camera.supported` is a Leica (USB vendor `0x1A98`) that names itself
an M11 (`ptp::leica::supported_model`); every other camera answers
"unsupported" rather than being guessed at. The page offers the feature from the shell's `tether` capability
(`platform.js`), never from the user agent.

## Shape

```
page: live loupe ── tetherCamera.js ── invoke('tether_frame' | 'tether_capture' | …)
shell: tether/mod.rs   sessions, live view, capture, fetch       (per dialect)
       tether/ptp.rs   PTP containers and datasets, Leica dialect (no I/O, unit tested)
       tether/macos.rs ImageCaptureCore: find cameras, carry PTP transactions
```

- **Live view** is pulled: the page asks for a frame, the shell asks the
  camera, the JPEG goes back as raw bytes. Each frame is drawn onto a canvas
  whose `captureStream()` is the loupe's video, so the loupe converts a
  tethered camera exactly as it converts a webcam.
- **Photos** go to the active watch folder, written beside their final name
  and renamed, and are imported by the watch folder like any other arrival
  (`import_folder.rs`). The folder is the one the user picked, so this works
  in the App Store sandbox and the RAW files are the user's.
- A capture is fetched on the camera's `ObjectAdded` event, whether the app or
  the camera's own shutter button released it.
- One transaction at a time (`Inner::busy`); a page reload releases the
  camera (`tether::release`).

ImageCaptureCore hands cameras only to an app bundle with an identifier: a
bare executable (`tauri dev`, a command-line tool) sees none. Test with
`npx tauri build --debug --bundles app`. In the App Store sandbox it lists no
camera without `com.apple.security.device.usb` (`Entitlements.mas.plist`):
measured with a sandboxed build, with and without the entitlement. Listing
and opening a camera asks the user for nothing.

The system lists the card's files before it reports the session open, and
shares the camera with whatever else attached to it (Google Drive and Preview
did on the test Mac): 17 s for 748 files. `macos::open` waits a minute.

## The scan screen

The live loupe in its scan mode (`openScan`, `data-mode="scan"`):

- **Entries.** The welcome screen and the menu always offer it where the
  shell has the `tether` capability, with "Leica M11 only for now"; the header
  button shows while a supported camera is plugged in (`tether-cameras`).
- **Phases** (`setScanPhase`): `waiting` (no camera: the steps to connect one,
  and it starts by itself when one is plugged in), `connecting`, `live`,
  `failed` (the reason and Try again).
- **The rail** holds this sitting's photos, the newest first and largest; a
  shot on its way is a placeholder until its import. A photo opens in the
  editor on a click and is discarded (Trash) with its ×. The folder the
  photos go to is named there and can be changed, which reconnects.
- Space releases the shutter. A transfer that fails says the photo is still
  on the card (`tether-error`).

## PTP in two lines

A transaction is a command container (length, type 1, code, transaction id,
up to five u32 parameters), an optional data phase, and a response container
(type 3, a response code). Events are type 4. Little-endian throughout.

## Leica dialect

Until its Leica session is open the M11 advertises 28 standard operations and
no way to see through the lens. Opening the session raises that to 59.

| Step | Operation | Parameters / data |
|---|---|---|
| Open the Leica session | `0x9005` | `0xFF55`; anything else is answered GeneralError (`0x2002`) |
| Tethered shooting on / off | `0x1016` SetDevicePropValue, property `0xD018` | u32 `1` / `0` |
| Start live view | `0x901C` | `0`; answered DeviceBusy (`0x2019`) for about a second after the session opens: ask again |
| Enable the stream | `0x1016`, property `0x5021` | u32 `0x00020001`; takes only once the camera's live view runs: write, read back, repeat |
| Keep the session active | `0x901D` | none; every couple of seconds during live view |
| One live view frame | `0x9025` | none; NoStreamEnabled (`0x2022`) until the stream is on |
| Stop live view | `0x901C`, then property `0x5021` = `0` | `1` |
| Release the shutter | `0x100E` InitiateCapture | `0, 0` |
| Before fetching a capture | `0x9007` | none |
| Fetch | `0x1008` GetObjectInfo, `0x1009` GetObject | the handle from `ObjectAdded` (`0x4002`) |

A live view frame is a header and a JPEG. The header's length is the u32 at
byte 16 (2016 on the M11); byte patterns that look like a JPEG start occur
inside the header, so the JPEG must not be searched for.

Sending `0x9025` without the Leica session made the camera drop off USB and
stop answering until it was power-cycled. The order above is fixed in
`tether/mod.rs` for that reason.

### Measured on the M11 (USB 2, 480 Mb/s)

| | |
|---|---|
| Live view | 1536×1024 MJPEG, about 74 KB a frame, 11–20 ms per request: about 75 requests a second answered, each with different bytes; the scan screen presents 57 converted frames a second (2026-11-14) |
| Shutter command → `ObjectAdded` | 2.3 s |
| First 512 KiB of the DNG (GetPartialObject `0x101B`) | 2.6 s after the command |
| Whole 67.9 MB DNG | 2.1 s to transfer (33 MB/s), 4.7 s after the command |

### Where the facts come from

The camera's own answers (`scripts/tether/camera-probe.swift`), the operation
names in the M11 firmware's debug strings, libgphoto2's `ptp.h` (operation
codes read from Leica's Lightroom tether plug-in), and the command table of
Lightroom Classic's built-in Leica tether for the parameters and their order.
Only protocol facts were taken: codes, parameters, order. Leica does not
document them, so a firmware update can change them.

## The probe

`scripts/tether/camera-probe.swift` is the research tool these numbers came
from. It must run from an app bundle:

```bash
swiftc -O scripts/tether/camera-probe.swift -o CameraProbe.app/Contents/MacOS/camera-probe
# with an Info.plist naming CFBundleIdentifier and CFBundleExecutable, then
open -W -n CameraProbe.app --stdout probe.out --args <output dir> <seconds> [liveview|capture]
```

With no mode it lists the cameras and their DeviceInfo and logs events while
you press the shutter; `liveview` and `capture` run the Leica sequences above.

## Not done yet

- A preview from the first 512 KiB of the DNG while the rest transfers.
- Leaving tethered shooting on app quit (the page-reload path releases the
  camera; a quit relies on the camera resetting when the session drops).
- Windows (WPD passes vendor commands through), Linux (libusb; gvfs must let
  go of the camera), iPadOS.
- Sony (A7R V first: the current-generation dialect), Nikon, Canon, Fujifilm.
