//! PTP (ISO 15740) containers and datasets for tethered capture, and the
//! vendor dialects on top of them. Nothing here touches a device: the
//! transports (`macos.rs`) carry these bytes, and the unit tests below run on
//! every platform. Protocol facts and how they were measured:
//! `docs/tethered-capture.md`.

/// Standard operation codes used here.
pub mod op {
    pub const GET_DEVICE_INFO: u16 = 0x1001;
    pub const GET_OBJECT_HANDLES: u16 = 0x1007;
    pub const GET_OBJECT_INFO: u16 = 0x1008;
    pub const GET_OBJECT: u16 = 0x1009;
    pub const DELETE_OBJECT: u16 = 0x100B;
    pub const INITIATE_CAPTURE: u16 = 0x100E;
    pub const GET_DEVICE_PROP_DESC: u16 = 0x1014;
    pub const GET_DEVICE_PROP_VALUE: u16 = 0x1015;
    pub const SET_DEVICE_PROP_VALUE: u16 = 0x1016;
    pub const TERMINATE_OPEN_CAPTURE: u16 = 0x1018;
    pub const INITIATE_OPEN_CAPTURE: u16 = 0x101C;
}

/// Response codes this layer tells apart.
pub mod rc {
    pub const OK: u16 = 0x2001;
    pub const OPERATION_NOT_SUPPORTED: u16 = 0x2005;
    pub const INVALID_OBJECT_HANDLE: u16 = 0x2009;
    pub const ACCESS_DENIED: u16 = 0x200F;
    pub const DEVICE_BUSY: u16 = 0x2019;
    /// PTP 1.1: the stream the frame was asked from is not enabled (yet).
    pub const NO_STREAM_ENABLED: u16 = 0x2022;
}

/// Event codes this layer acts on.
pub mod ev {
    pub const OBJECT_ADDED: u16 = 0x4002;
}

/// Device properties.
pub mod prop {
    pub const EXPOSURE_INDEX: u16 = 0x500F;
    pub const EXPOSURE_BIAS_COMPENSATION: u16 = 0x5010;
    /// PTP 1.1: which of the camera's streams are on.
    pub const ENABLED_STREAMS: u16 = 0x5021;
}

/// Object format of a folder.
pub const FORMAT_ASSOCIATION: u16 = 0x3001;

const CONTAINER_COMMAND: u16 = 1;
const CONTAINER_RESPONSE: u16 = 3;
const CONTAINER_EVENT: u16 = 4;
const CONTAINER_HEADER: usize = 12;

/// A command container: length, type 1, code, transaction id, parameters.
pub fn command(code: u16, transaction: u32, parameters: &[u32]) -> Vec<u8> {
    let parameters = &parameters[..parameters.len().min(5)];
    let mut out = Vec::with_capacity(CONTAINER_HEADER + 4 * parameters.len());
    out.extend_from_slice(&((CONTAINER_HEADER + 4 * parameters.len()) as u32).to_le_bytes());
    out.extend_from_slice(&CONTAINER_COMMAND.to_le_bytes());
    out.extend_from_slice(&code.to_le_bytes());
    out.extend_from_slice(&transaction.to_le_bytes());
    for parameter in parameters {
        out.extend_from_slice(&parameter.to_le_bytes());
    }
    out
}

/// A response or event container, parsed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Container {
    pub code: u16,
    pub transaction: u32,
    pub parameters: Vec<u32>,
}

fn container(bytes: &[u8], kind: u16) -> Option<Container> {
    if bytes.len() < CONTAINER_HEADER {
        return None;
    }
    let length = u32::from_le_bytes(bytes[0..4].try_into().ok()?) as usize;
    if u16::from_le_bytes(bytes[4..6].try_into().ok()?) != kind || length < CONTAINER_HEADER || length > bytes.len() {
        return None;
    }
    let parameters = bytes[CONTAINER_HEADER..length]
        .chunks_exact(4)
        .take(5)
        .map(|chunk| u32::from_le_bytes(chunk.try_into().unwrap()))
        .collect();
    Some(Container {
        code: u16::from_le_bytes(bytes[6..8].try_into().ok()?),
        transaction: u32::from_le_bytes(bytes[8..12].try_into().ok()?),
        parameters,
    })
}

/// A response container (type 3), or None for anything else.
pub fn response(bytes: &[u8]) -> Option<Container> {
    container(bytes, CONTAINER_RESPONSE)
}

/// An event container (type 4), or None for anything else.
pub fn event(bytes: &[u8]) -> Option<Container> {
    container(bytes, CONTAINER_EVENT)
}

/// A transport hands back two buffers for one transaction, the data phase and
/// the response container, and ImageCaptureCore does not say which is which:
/// the one that parses as a response is the response.
pub fn split_transaction<'a>(first: &'a [u8], second: &'a [u8]) -> (Option<Container>, &'a [u8]) {
    // A data phase is never mistaken for a response by length alone: a
    // response is at most 32 bytes and says so in its own length field.
    let as_response = |bytes: &[u8]| if bytes.len() <= 32 { response(bytes) } else { None };
    if let Some(parsed) = as_response(second) {
        return (Some(parsed), first);
    }
    if let Some(parsed) = as_response(first) {
        return (Some(parsed), second);
    }
    (None, if first.len() >= second.len() { first } else { second })
}

/// Little-endian reader over a dataset; reads past the end yield zeros and
/// set `truncated`, so a short dataset never panics.
pub struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
    pub truncated: bool,
}

impl<'a> Reader<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0, truncated: false }
    }
    fn take(&mut self, count: usize) -> &'a [u8] {
        let end = self.offset.saturating_add(count);
        if end > self.bytes.len() {
            self.truncated = true;
            self.offset = self.bytes.len();
            return &[];
        }
        let slice = &self.bytes[self.offset..end];
        self.offset = end;
        slice
    }
    pub fn u8(&mut self) -> u8 {
        self.take(1).first().copied().unwrap_or(0)
    }
    pub fn u16(&mut self) -> u16 {
        self.take(2).try_into().map(u16::from_le_bytes).unwrap_or(0)
    }
    pub fn u32(&mut self) -> u32 {
        self.take(4).try_into().map(u32::from_le_bytes).unwrap_or(0)
    }
    /// A PTP string: a count of UTF-16 code units (with the terminator), then the units.
    pub fn string(&mut self) -> String {
        let count = self.u8() as usize;
        let units: Vec<u16> = (0..count).map(|_| self.u16()).collect();
        String::from_utf16_lossy(&units).trim_end_matches('\0').to_string()
    }
    pub fn skip(&mut self, count: usize) {
        self.take(count);
    }
    pub fn remaining(&self) -> usize {
        self.bytes.len() - self.offset
    }
    /// The next u16 without consuming it.
    pub fn peek16(&self) -> Option<u16> {
        self.bytes.get(self.offset..self.offset + 2).map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]))
    }
    /// A PTP array of u32 (object handles): a u32 count, then the values.
    pub fn array32(&mut self) -> Vec<u32> {
        let count = (self.u32() as usize).min(65_536);
        (0..count).map(|_| self.u32()).collect()
    }
    /// A PTP array of u16: a u32 count, then the values.
    pub fn array16(&mut self) -> Vec<u16> {
        let count = (self.u32() as usize).min(4096);
        (0..count).map(|_| self.u16()).collect()
    }
}

/// What a camera says about itself (GetDeviceInfo).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeviceInfo {
    pub vendor_extension: u32,
    pub operations: Vec<u16>,
    pub events: Vec<u16>,
    pub properties: Vec<u16>,
    pub manufacturer: String,
    pub model: String,
    pub firmware: String,
    pub serial: String,
}

impl DeviceInfo {
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        let mut reader = Reader::new(bytes);
        reader.u16(); // standard version
        let vendor_extension = reader.u32();
        reader.u16(); // vendor extension version
        reader.string(); // vendor extension description
        reader.u16(); // functional mode
        let operations = reader.array16();
        let events = reader.array16();
        let properties = reader.array16();
        reader.array16(); // capture formats
        reader.array16(); // image formats
        let manufacturer = reader.string();
        let model = reader.string();
        let firmware = reader.string();
        // The lists are the part every caller needs; a camera that cuts the
        // trailing strings short still has a usable DeviceInfo.
        if reader.truncated && operations.is_empty() {
            return None;
        }
        let serial = reader.string();
        Some(Self { vendor_extension, operations, events, properties, manufacturer, model, firmware, serial })
    }
    pub fn supports(&self, operation: u16) -> bool {
        self.operations.contains(&operation)
    }
}

/// The start of an ObjectInfo dataset: what a captured file is and how large.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectInfo {
    pub storage: u32,
    pub format: u16,
    pub size: u32,
    pub filename: String,
}

impl ObjectInfo {
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        let mut reader = Reader::new(bytes);
        let storage = reader.u32();
        let format = reader.u16();
        reader.u16(); // protection status
        let size = reader.u32();
        // thumb format, thumb size, thumb width, thumb height, width, height,
        // depth, parent, association type, association description, sequence
        reader.u16();
        for _ in 0..3 {
            reader.u32();
        }
        for _ in 0..4 {
            reader.u32();
        }
        reader.u16();
        reader.u32();
        reader.u32();
        let filename = reader.string();
        if reader.truncated {
            return None;
        }
        Some(Self { storage, format, size, filename })
    }
}

/// A device property as the camera describes it (GetDevicePropDesc), for the
/// integer types exposure settings use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PropDesc {
    pub property: u16,
    /// Size of a value in bytes (1, 2 or 4) and whether it is signed.
    pub size: usize,
    pub signed: bool,
    pub settable: bool,
    pub current: i64,
    /// The values the camera accepts when it lists them; empty for a range.
    pub options: Vec<i64>,
}

impl PropDesc {
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        let mut reader = Reader::new(bytes);
        let property = reader.u16();
        let (size, signed) = match reader.u16() {
            0x0001 => (1, true),
            0x0002 => (1, false),
            0x0003 => (2, true),
            0x0004 => (2, false),
            0x0005 => (4, true),
            0x0006 => (4, false),
            _ => return None,
        };
        let value = |reader: &mut Reader| -> i64 {
            match (size, signed) {
                (1, true) => reader.u8() as i8 as i64,
                (1, false) => reader.u8() as i64,
                (2, true) => reader.u16() as i16 as i64,
                (2, false) => reader.u16() as i64,
                (_, true) => reader.u32() as i32 as i64,
                (_, false) => reader.u32() as i64,
            }
        };
        let settable = reader.u8() == 1;
        value(&mut reader); // factory default
        let current = value(&mut reader);
        if reader.truncated {
            return None;
        }
        // Form 2 is an enumeration: a u16 count and the values. A range (1) lists nothing.
        let options = if reader.u8() == 2 {
            let count = (reader.u16() as usize).min(1024);
            (0..count).map(|_| value(&mut reader)).collect()
        } else {
            Vec::new()
        };
        if reader.truncated {
            return None;
        }
        Some(Self { property, size, signed, settable, current, options })
    }
    /// The bytes of a value of this property's type.
    pub fn encode(&self, value: i64) -> Vec<u8> {
        (value as i32).to_le_bytes()[..self.size].to_vec()
    }
}

/// Leica cameras (USB vendor 0x1A98). A body advertises standard operations
/// only until its Leica session is open; live view and the transfer handshake
/// are behind it. Sequences as Leica's own tether clients send them.
pub mod leica {
    pub const USB_VENDOR: u16 = 0x1A98;

    /// Whether a Leica that names itself `name` is of the M11 series ("LEICA
    /// M11", "LEICA M11-P", "LEICA M11 Monochrom", "LEICA M11-D"), on which
    /// the dialect was measured. Every other Leica is offered as beta: one
    /// that has no Leica session says so when the connection is made.
    pub fn measured_model(name: &str) -> bool {
        name.split_whitespace().any(|word| {
            let word = word.to_ascii_uppercase();
            word.strip_prefix("M11").is_some_and(|rest| !rest.starts_with(|next: char| next.is_ascii_alphanumeric()))
        })
    }

    pub const OPEN_SESSION: u16 = 0x9005;
    /// The session's one parameter; any other value is answered GeneralError.
    pub const OPEN_SESSION_KEY: u32 = 0xFF55;
    pub const REQUEST_OBJECT_TRANSFER_READY: u16 = 0x9007;
    pub const CONTROL_LIVE_VIEW: u16 = 0x901C;
    pub const LIVE_VIEW_START: u32 = 0;
    pub const LIVE_VIEW_STOP: u32 = 1;
    pub const KEEP_SESSION_ACTIVE: u16 = 0x901D;
    pub const GET_STREAM_DATA: u16 = 0x9025;

    /// Tethered ("external") shooting: captures are offered to the host.
    pub const PROP_EXTERNAL_SHOOTING: u16 = 0xD018;
    /// Shutter speed: 256 x log2(1 / seconds), so 1536 is 1/64 s.
    pub const PROP_SHUTTER_SPEED: u16 = 0xD03B;
    /// EnabledStreams value for the live view stream (MJPEG).
    pub const STREAM_LIVE_VIEW: u32 = 0x0002_0001;

    /// Where the JPEG starts in a GetStreamData payload. The frame header
    /// carries its own length at byte 16 (2016 on the M11 family); bytes that
    /// look like a JPEG start occur inside the header, so searching for the
    /// marker is wrong.
    ///
    /// Other Leica bodies use other header lengths (their tether clients keep
    /// a table of them); those are tried when byte 16 does not lead to a JPEG.
    pub fn live_view_jpeg(frame: &[u8]) -> Option<&[u8]> {
        const KNOWN_HEADERS: [usize; 6] = [2016, 180, 2036, 10420, 11060, 27316];
        let stated = frame.get(16..20).and_then(|bytes| bytes.try_into().ok()).map(u32::from_le_bytes).map(|length| length as usize);
        stated.into_iter().chain(KNOWN_HEADERS).find_map(|header| {
            let jpeg = frame.get(header..)?;
            let starts = jpeg.len() > 4 && jpeg[0] == 0xFF && jpeg[1] == 0xD8 && jpeg[2] == 0xFF;
            (starts && jpeg.ends_with(&[0xFF, 0xD9])).then_some(jpeg)
        })
    }
}

/// Which vendor's sequences a camera is driven with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    Leica,
    Sony,
    Fuji,
}

impl Dialect {
    /// The dialect for a camera on USB, or None for a body this app does not drive.
    pub fn of(usb_vendor: u16, name: &str) -> Option<Self> {
        match usb_vendor {
            leica::USB_VENDOR => Some(Self::Leica),
            sony::USB_VENDOR if sony::supported_model(name) => Some(Self::Sony),
            fuji::USB_VENDOR if fuji::supported_model(name) => Some(Self::Fuji),
            _ => None,
        }
    }
    /// Whether this camera was measured on the real body: the Leica M11
    /// series. Other Leica bodies share its session and commands but were not
    /// tried; Sony and Fujifilm follow the published protocol notes of
    /// libgphoto2 and libfuji. All of those are offered as beta.
    pub fn measured(usb_vendor: u16, name: &str) -> bool {
        usb_vendor == leica::USB_VENDOR && leica::measured_model(name)
    }
}

/// Sony cameras in "PC Remote" (USB vendor 0x054C). The camera hides its
/// controls behind a three-step connect; the state of everything, including
/// "a captured file waits in memory", comes in one blob of property
/// descriptions. Sequences after libgphoto2 (camlibs/ptp2); not yet measured
/// on a camera by this app.
pub mod sony {
    use super::Reader;

    pub const USB_VENDOR: u16 = 0x054C;

    /// Every Sony camera is offered: the protocol is the same across the
    /// Alpha, ZV and RX bodies, and one that has no PC Remote says so when
    /// the connection is made (it does not list the connect operation).
    pub fn supported_model(_name: &str) -> bool {
        true
    }

    pub const CONNECT: u16 = 0x9201;
    pub const GET_EXT_DEVICE_INFO: u16 = 0x9202;
    /// The newest protocol asked for; a body answers with the one it speaks.
    pub const PROTOCOL: u32 = 0x012C;
    pub const SET_PROPERTY: u16 = 0x9205;
    /// "Control" values: buttons that are pressed (2) and released (1).
    pub const CONTROL: u16 = 0x9207;
    pub const GET_ALL_PROPERTIES: u16 = 0x9209;

    /// Who decides the settings: 1 is the application.
    pub const PROP_PRIORITY: u16 = 0xD25A;
    pub const PROP_FOCUS_FOUND: u16 = 0xD213;
    /// 0x8000 and up: that many captured files wait at `CAPTURED_OBJECT`.
    pub const PROP_OBJECT_IN_MEMORY: u16 = 0xD215;
    pub const OBJECT_READY: i64 = 0x8000;
    pub const BUTTON_HALF_PRESS: u16 = 0xD2C1;
    pub const BUTTON_RELEASE: u16 = 0xD2C2;
    pub const PRESS: u16 = 2;
    pub const LET_GO: u16 = 1;

    pub const CAPTURED_OBJECT: u32 = 0xFFFF_C001;
    pub const LIVE_VIEW_OBJECT: u32 = 0xFFFF_C002;

    /// The codes GetExtDeviceInfo lists: properties, then controls.
    pub fn ext_device_info(bytes: &[u8]) -> Vec<u16> {
        let mut reader = Reader::new(bytes);
        reader.u16(); // protocol version
        let mut codes = reader.array16();
        codes.extend(reader.array16());
        if reader.truncated { Vec::new() } else { codes }
    }

    fn value_size(reader: &mut Reader, kind: u16) -> Option<usize> {
        Some(match kind {
            0x0001 | 0x0002 => 1,
            0x0003 | 0x0004 => 2,
            0x0005 | 0x0006 => 4,
            0x0007 | 0x0008 => 8,
            0x0009 | 0x000A => 16,
            0xFFFF => 2 * reader.u8() as usize,
            0x4001..=0x400A => {
                let element = [1, 1, 2, 2, 4, 4, 8, 8, 16, 16][(kind & 0xF) as usize - 1];
                element * (reader.u32() as usize).min(1 << 20)
            }
            _ => return None,
        })
    }

    /// The current value of one property in a GetAllProperties blob, for the
    /// integer types up to 32 bits. Each entry: code, type, two flag bytes,
    /// default, current, then a range or an enumeration (newer bodies send a
    /// second enumeration after the first).
    pub fn current_value(blob: &[u8], property: u16) -> Option<i64> {
        let mut reader = Reader::new(blob);
        reader.skip(8); // entry count, zero
        while reader.remaining() >= 6 {
            let code = reader.u16();
            let kind = reader.u16();
            reader.skip(2);
            let size = value_size(&mut reader, kind)?;
            reader.skip(size); // default
            let current = if code == property {
                Some(match kind {
                    0x0001 => reader.u8() as i8 as i64,
                    0x0002 => reader.u8() as i64,
                    0x0003 => reader.u16() as i16 as i64,
                    0x0004 => reader.u16() as i64,
                    0x0005 => reader.u32() as i32 as i64,
                    0x0006 => reader.u32() as i64,
                    _ => return None,
                })
            } else {
                let size = value_size(&mut reader, kind)?;
                reader.skip(size);
                None
            };
            if reader.truncated {
                return None;
            }
            if current.is_some() {
                return current;
            }
            let list = |reader: &mut Reader| -> Option<()> {
                for _ in 0..reader.u16() {
                    let size = value_size(reader, kind)?;
                    reader.skip(size);
                }
                Some(())
            };
            match reader.u8() {
                1 => {
                    for _ in 0..3 {
                        let size = value_size(&mut reader, kind)?;
                        reader.skip(size);
                    }
                }
                2 => {
                    list(&mut reader)?;
                    // A count where the next property code (0x5xxx, 0xDxxx) would be.
                    if reader.peek16().is_some_and(|next| next < 0x200) {
                        list(&mut reader)?;
                    }
                }
                _ => {}
            }
        }
        None
    }

    /// The JPEG in a live view object: the payload starts with the picture's
    /// offset and size.
    pub fn live_view_jpeg(payload: &[u8]) -> Option<&[u8]> {
        let word = |at: usize| payload.get(at..at + 4).map(|bytes| u32::from_le_bytes(bytes.try_into().unwrap()) as usize);
        let (offset, size) = (word(0)?, word(4)?);
        let jpeg = payload.get(offset..offset.checked_add(size)?).or_else(|| payload.get(offset..))?;
        (jpeg.len() > 4 && jpeg[0] == 0xFF && jpeg[1] == 0xD8).then_some(jpeg)
    }
}

/// Fujifilm bodies in "USB tether shooting" (USB vendor 0x04CB). Captures
/// wait in the camera's memory as objects until the host fetches them; the
/// live view is a pseudo object that is read and deleted per frame. Sequences
/// after libgphoto2 (camlibs/ptp2) and libfuji; not yet measured on a camera
/// by this app.
pub mod fuji {
    pub const USB_VENDOR: u16 = 0x04CB;

    /// Every Fujifilm camera is offered: the GFX and X bodies share the
    /// protocol, and one that has no tether shooting mode, or is not in it,
    /// says so when the connection is made.
    pub fn supported_model(_name: &str) -> bool {
        true
    }

    /// 5 while the camera is in a tether shooting mode; a card reader has no such property.
    pub const PROP_USB_MODE: u16 = 0xD16E;
    pub const USB_MODE_TETHER: u16 = 5;
    pub const PROP_PC_MODE: u16 = 0xD38C;
    /// Who releases the shutter: 1 the camera's button, 2 the host.
    pub const PROP_PRIORITY: u16 = 0xD207;
    pub const PRIORITY_CAMERA: u16 = 1;
    pub const PRIORITY_HOST: u16 = 2;
    /// What the next InitiateCapture does.
    pub const PROP_ACTION: u16 = 0xD208;
    pub const ACTION_FOCUS: u16 = 0x0200;
    pub const ACTION_SHOOT: u16 = 0x0304;
    pub const ACTION_CANCEL: u16 = 0x0004;
    /// 1 while focusing, 2 ready, 3 failed.
    pub const PROP_FOCUS_STATUS: u16 = 0xD209;
    pub const FOCUS_BUSY: u16 = 1;
    pub const FOCUS_FAILED: u16 = 3;
    /// Reading it clears the camera's list of changed properties.
    pub const PROP_EVENTS: u16 = 0xD212;

    pub const LIVE_VIEW_OBJECT: u32 = 0x8000_0001;
    pub const ALL_STORAGES: u32 = 0xFFFF_FFFF;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_m11_series_counts_as_measured() {
        for name in ["LEICA M11", "Leica M11-P", "LEICA M11 Monochrom", "LEICA M11-D", "M11"] {
            assert!(leica::measured_model(name), "{name}");
        }
        for name in ["LEICA SL3", "LEICA Q3", "LEICA M10-R", "LEICA M110", "LEICA M11X", ""] {
            assert!(!leica::measured_model(name), "{name}");
        }
    }

    #[test]
    fn each_camera_gets_its_dialect() {
        assert_eq!(Dialect::of(0x1A98, "LEICA M11"), Some(Dialect::Leica));
        assert_eq!(Dialect::of(0x1A98, "LEICA SL3"), Some(Dialect::Leica));
        // Sony and Fujifilm: the whole brand; the connection finds out what a body can do.
        for name in ["ILCE-7RM5", "ILCE-7M4", "ILCE-1", "ZV-E10", "DSC-RX100M7", ""] {
            assert_eq!(Dialect::of(0x054C, name), Some(Dialect::Sony), "{name}");
        }
        for name in ["GFX 50S", "GFX100S", "FUJIFILM GFX100RF", "X-T5", "X-H2S", ""] {
            assert_eq!(Dialect::of(0x04CB, name), Some(Dialect::Fuji), "{name}");
        }
        // Another vendor is not driven, whatever it calls itself.
        assert_eq!(Dialect::of(0x04A9, "ILCE-7RM5"), None);
        // Only the M11 series was measured; everything else is beta.
        assert!(Dialect::measured(0x1A98, "LEICA M11-P"));
        for (vendor, name) in [(0x1A98, "LEICA SL3"), (0x1A98, "LEICA Q3"), (0x054C, "ILCE-7RM5"), (0x04CB, "GFX100S"), (0x054C, "M11")] {
            assert!(!Dialect::measured(vendor, name), "{name}");
        }
    }

    #[test]
    fn a_sony_property_blob_gives_current_values() {
        let mut blob = vec![3, 0, 0, 0, 0, 0, 0, 0];
        // A string property (skipped), then an enumeration with a second list, then the one asked for.
        blob.extend_from_slice(&[0x01, 0xD2, 0xFF, 0xFF, 0, 1, 1, 0x41, 0, 2, 0x42, 0, 0x43, 0, 0]);
        blob.extend_from_slice(&[0x1E, 0xD2, 0x06, 0x00, 1, 1]);
        blob.extend_from_slice(&100u32.to_le_bytes());
        blob.extend_from_slice(&400u32.to_le_bytes());
        blob.push(2);
        blob.extend_from_slice(&2u16.to_le_bytes());
        blob.extend_from_slice(&100u32.to_le_bytes());
        blob.extend_from_slice(&400u32.to_le_bytes());
        blob.extend_from_slice(&1u16.to_le_bytes());
        blob.extend_from_slice(&400u32.to_le_bytes());
        blob.extend_from_slice(&[0x15, 0xD2, 0x04, 0x00, 0, 2, 0, 0, 0x01, 0x80, 0]);
        assert_eq!(sony::current_value(&blob, 0xD21E), Some(400));
        assert_eq!(sony::current_value(&blob, sony::PROP_OBJECT_IN_MEMORY), Some(0x8001));
        assert_eq!(sony::current_value(&blob, sony::PROP_FOCUS_FOUND), None);
        // Cut inside an entry, or a type this reader cannot step over: no value, no panic.
        assert_eq!(sony::current_value(&blob[..blob.len() - 2], sony::PROP_OBJECT_IN_MEMORY), None);
        assert_eq!(sony::current_value(&[0; 8], 0xD215), None);
        assert_eq!(sony::current_value(&[0, 0, 0, 0, 0, 0, 0, 0, 0x15, 0xD2, 0x77, 0x00, 0, 0, 0, 0], 0xD215), None);
    }

    #[test]
    fn sony_lists_its_codes_and_wraps_its_live_view() {
        let mut info = 0x012Cu16.to_le_bytes().to_vec();
        info.extend(array16(&[0x5010, sony::PROP_OBJECT_IN_MEMORY]));
        info.extend(array16(&[sony::BUTTON_HALF_PRESS, sony::BUTTON_RELEASE]));
        assert_eq!(sony::ext_device_info(&info), [0x5010, 0xD215, 0xD2C1, 0xD2C2]);
        assert!(sony::ext_device_info(&info[..7]).is_empty());

        let jpeg = [0xFF, 0xD8, 0xFF, 0xDB, 1, 2, 0xFF, 0xD9];
        let mut payload = vec![0u8; 136];
        payload[0..4].copy_from_slice(&136u32.to_le_bytes());
        payload[4..8].copy_from_slice(&(jpeg.len() as u32).to_le_bytes());
        payload.extend_from_slice(&jpeg);
        payload.extend_from_slice(&[0; 5]); // padding after the picture
        assert_eq!(sony::live_view_jpeg(&payload), Some(&jpeg[..]));
        assert_eq!(sony::live_view_jpeg(&payload[..100]), None);
        assert_eq!(sony::live_view_jpeg(&[0; 16]), None);
        assert_eq!(sony::live_view_jpeg(&[]), None);
    }

    #[test]
    fn object_handles_are_read_as_a_list() {
        let mut bytes = 2u32.to_le_bytes().to_vec();
        bytes.extend_from_slice(&fuji::LIVE_VIEW_OBJECT.to_le_bytes());
        bytes.extend_from_slice(&7u32.to_le_bytes());
        let mut reader = Reader::new(&bytes);
        assert_eq!(reader.array32(), [fuji::LIVE_VIEW_OBJECT, 7]);
        assert!(!reader.truncated);
        let mut short = Reader::new(&bytes[..9]);
        short.array32();
        assert!(short.truncated);
    }

    fn string(text: &str) -> Vec<u8> {
        if text.is_empty() {
            return vec![0];
        }
        let units: Vec<u16> = text.encode_utf16().chain([0]).collect();
        let mut out = vec![units.len() as u8];
        units.iter().for_each(|unit| out.extend_from_slice(&unit.to_le_bytes()));
        out
    }
    fn array16(values: &[u16]) -> Vec<u8> {
        let mut out = (values.len() as u32).to_le_bytes().to_vec();
        values.iter().for_each(|value| out.extend_from_slice(&value.to_le_bytes()));
        out
    }

    #[test]
    fn command_containers_match_the_wire() {
        // LEOpenSession(0xFF55) as the M11 accepted it.
        assert_eq!(
            command(leica::OPEN_SESSION, 0x18F0, &[leica::OPEN_SESSION_KEY]),
            [0x10, 0, 0, 0, 0x01, 0, 0x05, 0x90, 0xF0, 0x18, 0, 0, 0x55, 0xFF, 0, 0]
        );
        assert_eq!(command(op::GET_DEVICE_INFO, 1, &[]).len(), 12);
        // No more than five parameters fit a container.
        assert_eq!(command(0x1001, 1, &[0; 9]).len(), 12 + 20);
    }

    #[test]
    fn responses_and_events_parse_and_reject_each_other() {
        // "DeviceBusy" as the M11 answered StartLiveView right after the session opened.
        let busy = [0x0C, 0, 0, 0, 0x03, 0, 0x19, 0x20, 0xF7, 0x16, 0, 0];
        assert_eq!(response(&busy), Some(Container { code: rc::DEVICE_BUSY, transaction: 0x16F7, parameters: vec![] }));
        assert_eq!(event(&busy), None);
        // ObjectAdded with the new object's handle.
        let added = [0x10, 0, 0, 0, 0x04, 0, 0x02, 0x40, 0x0D, 0xF0, 0xAD, 0xBA, 0xF1, 0x84, 0xA4, 0x81];
        let parsed = event(&added).unwrap();
        assert_eq!((parsed.code, parsed.parameters.as_slice()), (ev::OBJECT_ADDED, &[0x81A4_84F1][..]));
        assert_eq!(response(&added), None);
        // Truncated or lying about its length.
        assert_eq!(response(&busy[..11]), None);
        assert_eq!(response(&[0x40, 0, 0, 0, 0x03, 0, 0x01, 0x20, 0, 0, 0, 0]), None);
    }

    #[test]
    fn the_response_is_found_in_either_buffer() {
        let ok = [0x0C, 0, 0, 0, 0x03, 0, 0x01, 0x20, 0x4C, 0x14, 0, 0];
        let data = [0x64u8];
        assert_eq!(split_transaction(&data, &ok), (response(&ok), &data[..]));
        assert_eq!(split_transaction(&ok, &data), (response(&ok), &data[..]));
        // No data phase.
        assert_eq!(split_transaction(&[], &ok), (response(&ok), &[][..]));
        // A device that vanished mid-transaction leaves no response.
        assert_eq!(split_transaction(&[], &[]).0, None);
        // A payload that happens to start like a response is too long to be one.
        let mut payload = ok.to_vec();
        payload.extend_from_slice(&[0; 64]);
        assert_eq!(split_transaction(&payload, &ok), (response(&ok), &payload[..]));
    }

    #[test]
    fn device_info_lists_what_the_camera_offers() {
        let mut bytes = vec![];
        bytes.extend_from_slice(&110u16.to_le_bytes());
        bytes.extend_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
        bytes.extend_from_slice(&110u16.to_le_bytes());
        bytes.extend(string(""));
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend(array16(&[0x1001, 0x100E, 0x101B, leica::GET_STREAM_DATA]));
        bytes.extend(array16(&[ev::OBJECT_ADDED, 0x400D]));
        bytes.extend(array16(&[prop::ENABLED_STREAMS]));
        bytes.extend(array16(&[0x3801]));
        bytes.extend(array16(&[0x3001, 0x3801]));
        bytes.extend(string("Leica Camera AG"));
        bytes.extend(string("LEICA M11"));
        bytes.extend(string("2.6.4"));
        bytes.extend(string("0000000005700283"));
        let info = DeviceInfo::parse(&bytes).unwrap();
        assert_eq!((info.manufacturer.as_str(), info.model.as_str(), info.firmware.as_str()), ("Leica Camera AG", "LEICA M11", "2.6.4"));
        assert!(info.supports(leica::GET_STREAM_DATA) && !info.supports(leica::CONTROL_LIVE_VIEW));
        assert_eq!(info.events, [ev::OBJECT_ADDED, 0x400D]);
        // Cut after the lists: still usable. Cut inside them: not a DeviceInfo.
        let cut = bytes.len() - string("0000000005700283").len() - 3;
        assert!(DeviceInfo::parse(&bytes[..cut]).is_some());
        assert_eq!(DeviceInfo::parse(&bytes[..6]), None);
        assert_eq!(DeviceInfo::parse(&[]), None);
    }

    #[test]
    fn object_info_names_the_capture() {
        let mut bytes = vec![];
        bytes.extend_from_slice(&0x0002_0001u32.to_le_bytes());
        bytes.extend_from_slice(&0x3802u16.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&67_874_816u32.to_le_bytes());
        bytes.extend_from_slice(&0x3801u16.to_le_bytes());
        bytes.extend_from_slice(&[0; 12]);
        bytes.extend_from_slice(&[0; 16]);
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&[0; 8]);
        bytes.extend(string("L1002127.DNG"));
        let info = ObjectInfo::parse(&bytes).unwrap();
        assert_eq!((info.format, info.size, info.filename.as_str()), (0x3802, 67_874_816, "L1002127.DNG"));
        assert_eq!(ObjectInfo::parse(&bytes[..40]), None);
    }

    #[test]
    fn property_descriptions_as_the_m11_sent_them() {
        // ISO: UINT32, settable, on Auto (0), an enumeration of 31 values.
        let mut iso = vec![0x0F, 0x50, 0x06, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0x02, 0x1F, 0x00];
        let values: [u32; 31] = [0, 64, 80, 100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400, 8000, 10000, 12500, 16000, 20000, 25000, 32000, 40000, 50000];
        values.iter().for_each(|value| iso.extend_from_slice(&value.to_le_bytes()));
        let iso = PropDesc::parse(&iso).unwrap();
        assert_eq!((iso.property, iso.size, iso.signed, iso.settable, iso.current), (prop::EXPOSURE_INDEX, 4, false, true, 0));
        assert_eq!(iso.options.len(), 31);
        assert_eq!((iso.options[1], iso.options[30]), (64, 50000));
        assert_eq!(iso.encode(400), [0x90, 0x01, 0, 0]);
        // Shutter speed: INT32, settable, on the dial's A (0x3FFF), any value.
        let shutter = [0x3B, 0xD0, 0x05, 0x00, 0x01, 0x00, 0x08, 0, 0, 0xFF, 0x3F, 0, 0, 0x01, 0, 0, 0, 0x80, 0xFF, 0xFF, 0xFF, 0x7F, 0x01, 0, 0, 0];
        let shutter = PropDesc::parse(&shutter).unwrap();
        assert_eq!((shutter.property, shutter.signed, shutter.settable, shutter.current, shutter.options.len()), (leica::PROP_SHUTTER_SPEED, true, true, 0x3FFF, 0));
        assert_eq!(shutter.encode(-256), [0x00, 0xFF, 0xFF, 0xFF]);
        // Exposure compensation: INT16 thousandths of a stop, -3 to +3 in thirds.
        let mut bias = vec![0x10, 0x50, 0x03, 0x00, 0x01, 0, 0, 0, 0, 0x02, 0x13, 0x00];
        (-9i32..=9).for_each(|third| bias.extend_from_slice(&(((third * 1000) as f64 / 3.0).round() as i16).to_le_bytes()));
        let bias = PropDesc::parse(&bias).unwrap();
        assert_eq!((bias.size, bias.signed, bias.current, bias.options.len()), (2, true, 0, 19));
        assert_eq!((bias.options[0], bias.options[9], bias.options[18]), (-3000, 0, 3000));
        assert_eq!(bias.encode(-3000), [0x48, 0xF4]);
        // Cut short, or a type this layer does not read (a string, 0xFFFF).
        assert_eq!(PropDesc::parse(&[0x0F, 0x50, 0x06, 0x00, 0x01, 0, 0]), None);
        assert_eq!(PropDesc::parse(&[0x01, 0x50, 0xFF, 0xFF, 0x00, 0x00]), None);
    }

    #[test]
    fn a_live_view_frame_gives_its_jpeg_from_the_header_length() {
        let mut frame = vec![0u8; 2016];
        frame[0..2].copy_from_slice(&[0x02, 0x01]);
        frame[16..20].copy_from_slice(&2016u32.to_le_bytes());
        // A JPEG start inside the header, as real frames have: not the image.
        frame[352..355].copy_from_slice(&[0xFF, 0xD8, 0xFF]);
        let jpeg = [0xFF, 0xD8, 0xFF, 0xDB, 1, 2, 3, 0xFF, 0xD9];
        frame.extend_from_slice(&jpeg);
        assert_eq!(leica::live_view_jpeg(&frame), Some(&jpeg[..]));
        // Not a frame: too short, or cut before the JPEG ends.
        assert_eq!(leica::live_view_jpeg(&frame[..18]), None);
        // A header that states a length past the end: the known lengths still find the picture.
        let mut long = frame.clone();
        long[16..20].copy_from_slice(&90_000u32.to_le_bytes());
        assert_eq!(leica::live_view_jpeg(&long), Some(&jpeg[..]));
        let mut cut = frame.clone();
        cut.truncate(frame.len() - 1);
        assert_eq!(leica::live_view_jpeg(&cut), None);
        // A body whose header does not state its length: the known lengths are tried.
        let mut other = vec![0u8; 180];
        other.extend_from_slice(&jpeg);
        assert_eq!(leica::live_view_jpeg(&other), Some(&jpeg[..]));
    }
}
