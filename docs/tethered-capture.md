# Tethered capture

A camera on one USB cable: its live view in the live loupe, the shutter from
the app, and the RAW imported and converted as it arrives. No vendor SDK, no
Wi-Fi, nothing for the user to install.

## Where it works

Leica M11 series: measured. Sony and Fujifilm cameras: beta, see their section
below.

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

The listing also holds back every PTP command, even when the session itself
opens at once: with `ptpcamerad` freshly started on the same camera, each
command went unanswered for 66 to 100 s and then took 0.1 s (2026-11-14). A
connection made in that window used to fail at the 5 s command timeout, which
is what "often cannot connect" was after plugging in or waking the camera. So
the first command of a connection waits three minutes (`FIRST_ANSWER`), and
after four seconds the scan screen says the Mac is reading the card. To see it
again without touching the cable: `kill -9 $(pgrep -x ptpcamerad)`.

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

## Sony and Fujifilm dialects (beta, not measured)

Every Sony camera (vendor 0x054C) and every Fujifilm camera (vendor 0x04CB) is
offered, since each brand shares one protocol across its bodies; what a body
cannot do it says at connection. They are driven from published protocol notes: libgphoto2
(`camlibs/ptp2/library.c`, `ptp.c`, `ptp-pack.c`) and, for Fujifilm, libfuji.
**Nothing below was run on a camera by this app** (shipped 2026-11-14 at the
owner's request, labelled Beta in the UI, `Dialect::measured`). The first
session with a real body should expect to correct it.

Sony, camera set to *PC Remote* (otherwise `sony-pc-remote`):
- Connect: `0x9201` with 1, then 2; `0x9202(0x12C, 1)` lists properties and
  controls; `0x9201` with 3; property `0xD25A` = 1 through `0x9205`.
- Live view: GetObject `0xFFFFC002`; the payload starts with the JPEG's offset
  and size. AccessDenied or InvalidObjectHandle means "ask again".
- Shutter: controls `0xD2C1` then `0xD2C2` = 2 through `0x9207`, held until
  `0xD213` reports focus (a second at most), then both = 1.
- The file: property `0xD215` in the `0x9209` blob reaches 0x8000 or more;
  GetObjectInfo and GetObject on `0xFFFFC001`. *Still image save destination*
  must include the PC.

Fujifilm, camera set to *USB tether shooting auto* (otherwise
`fuji-tether-mode`: property `0xD16E` is not 5, or no InitiateCapture):
- Live view: InitiateOpenCapture(0, 0); each frame is GetObjectInfo, GetObject
  and DeleteObject on the pseudo object `0x80000001`; TerminateOpenCapture with
  the transaction of the InitiateOpenCapture ends it. A capture ends it too and
  the next frame request starts it again.
- Shutter: `0xD207` = 2, `0xD208` = 0x0200 + InitiateCapture, wait while
  `0xD209` is 1 (3 is "no focus": `0xD208` = 4 + InitiateCapture cancels),
  `0xD208` = 0x0304 + InitiateCapture, `0xD207` = 1.
- The file: GetObjectHandles(0xFFFFFFFF, 0, 0) lists what waits in the camera.
  The handles present at connection are remembered and never fetched, so a
  body that turns out to list its card does not copy the card.

Both: no event announces a file, so the camera is asked once a second while
the live view runs and every 0.4 s for 40 s after a shutter press. Exposure
settings are not offered (each vendor encodes them its own way). The only
DeleteObject sent is the Fujifilm live view frame; no photo is deleted.

Wireless was looked at and not built: Sony's PC Remote over Wi-Fi sits behind
its access authentication, and Fujifilm's wireless tether has the camera call
a server on the computer (port 51560 in libfuji) before the same commands run
over TCP. Neither can be written responsibly without the cameras at hand.

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
- Sony and Fujifilm measured on real bodies (their dialects are beta), then
  Nikon and Canon; exposure settings for Sony and Fujifilm; wireless.
