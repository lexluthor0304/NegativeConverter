// Camera tethering probe (macOS, ImageCaptureCore). Research tool for the
// tethered-capture work: it lists the cameras on USB, prints each one's PTP
// DeviceInfo (vendor extension, operations, events), then logs every PTP
// event and every file the camera reports while you press the shutter, and
// downloads the files it reports.
//
//   swiftc -O scripts/tether/camera-probe.swift -o /tmp/camera-probe
//   /tmp/camera-probe [download-dir] [seconds]
//
// Nothing leaves the machine. Stop it with Ctrl-C.
import Foundation
import ImageCaptureCore

let arguments = CommandLine.arguments
let downloadDir = URL(fileURLWithPath: arguments.count > 1 ? arguments[1] : NSTemporaryDirectory()).appendingPathComponent("camera-probe")
let seconds = arguments.count > 2 ? Double(arguments[2]) ?? 0 : 0
try? FileManager.default.createDirectory(at: downloadDir, withIntermediateDirectories: true)

func log(_ text: String) {
  let stamp = String(format: "%8.3f", ProcessInfo.processInfo.systemUptime.truncatingRemainder(dividingBy: 100000))
  print("[\(stamp)] \(text)")
  fflush(stdout)
}
func hex(_ data: Data, limit: Int = 64) -> String {
  data.prefix(limit).map { String(format: "%02x", $0) }.joined(separator: " ") + (data.count > limit ? " … (\(data.count) bytes)" : "")
}

// Little-endian reader for PTP datasets.
struct Reader {
  let data: Data
  var offset = 0
  mutating func u8() -> UInt8 { defer { offset += 1 }; return offset < data.count ? data[data.startIndex + offset] : 0 }
  mutating func u16() -> UInt16 { UInt16(u8()) | UInt16(u8()) << 8 }
  mutating func u32() -> UInt32 { UInt32(u16()) | UInt32(u16()) << 16 }
  mutating func string() -> String {
    let count = Int(u8())
    var units: [UInt16] = []
    for _ in 0..<count { units.append(u16()) }
    return String(utf16CodeUnits: units, count: units.count).trimmingCharacters(in: CharacterSet(charactersIn: "\0"))
  }
  mutating func array16() -> [UInt16] { let count = Int(u32()); return (0..<min(count, 4096)).map { _ in u16() } }
}
func codes(_ values: [UInt16]) -> String { values.map { String(format: "%04x", $0) }.joined(separator: " ") }

func ptpCommand(code: UInt16, transaction: UInt32, parameters: [UInt32] = []) -> Data {
  var data = Data()
  func put<T: FixedWidthInteger>(_ value: T) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
  put(UInt32(12 + 4 * parameters.count)); put(UInt16(1)); put(code); put(transaction)
  parameters.forEach { put($0) }
  return data
}

final class Probe: NSObject, ICDeviceBrowserDelegate, ICCameraDeviceDelegate {
  let browser = ICDeviceBrowser()
  var cameras: [ICCameraDevice] = []
  var transaction: UInt32 = 1

  func start() {
    browser.delegate = self
    // Local, shared, Bonjour, Bluetooth and remote locations: some bodies do not show under "local" alone.
    browser.browsedDeviceTypeMask = ICDeviceTypeMask(rawValue: ICDeviceTypeMask.camera.rawValue | 0x0000FF00)!
    DispatchQueue.main.asyncAfter(deadline: .now() + 4) { log("browser: browsing \(self.browser.isBrowsing) | devices \((self.browser.devices ?? []).map { $0.name ?? "?" })") }
    browser.start()
    log("looking for cameras on USB (set the camera's USB mode to PTP / PC Remote) …")
  }

  // One PTP transaction; the dataset and the response arrive in either buffer.
  func send(_ camera: ICCameraDevice, _ label: String, _ code: UInt16, _ parameters: [UInt32] = [], out: Data? = nil, then: @escaping (_ responseCode: UInt16, _ data: Data) -> Void) {
    transaction += 1
    camera.requestSendPTPCommand(ptpCommand(code: code, transaction: transaction, parameters: parameters), outData: out) { a, b, error in
      let isResponse: (Data) -> Bool = { $0.count >= 12 && $0.count <= 32 && $0[$0.startIndex + 4] == 3 && $0[$0.startIndex + 5] == 0 }
      let response = isResponse(b) ? b : (isResponse(a) ? a : Data())
      let data = isResponse(b) ? a : (isResponse(a) ? b : (a.count >= b.count ? a : b))
      var reader = Reader(data: response); _ = reader.u32(); _ = reader.u16()
      let responseCode = response.isEmpty ? 0 : reader.u16()
      log("\(label) [\(String(format: "%04x", code)) \(parameters.map { String(format: "%x", $0) })] → \(error.map { "ERROR \($0.localizedDescription)" } ?? String(format: "%04x", responseCode)) | \(data.count) bytes\(data.isEmpty ? "" : ": " + hex(data, limit: 48)) | response \(hex(response, limit: 32))")
      then(responseCode, data)
    }
  }
  func u32(_ value: UInt32) -> Data { withUnsafeBytes(of: value.littleEndian) { Data($0) } }
  var frames = 0
  // Whether the exposure properties take a write: read, write a test value, read it back, restore.
  func setProperties(_ camera: ICCameraDevice) {
    log("— property write probe —")
    func bytes(_ value: Int32, _ size: Int) -> Data { withUnsafeBytes(of: value.littleEndian) { Data($0.prefix(size)) } }
    // (name, property, bytes of the value, test value)
    var tests: [(String, UInt32, Int, Int32)] = [("ISO", 0x500f, 4, 400), ("shutter 1/60", 0xd03b, 4, 1536), ("exposure compensation +1", 0x5010, 2, 1000)]
    send(camera, "LEOpenSession", 0x9005, [0xff55]) { code, _ in
      guard code == 0x2001 else { return }
      func next() {
        guard !tests.isEmpty else { log("— property write probe done —"); return }
        let (name, property, size, value) = tests.removeFirst()
        self.send(camera, "\(name): read", 0x1015, [property]) { _, original in
        self.send(camera, "\(name): write \(value)", 0x1016, [property], out: bytes(value, size)) { _, _ in
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
        self.send(camera, "\(name): read back", 0x1015, [property]) { _, now in
          log("   \(name): \(now == bytes(value, size) ? "TOOK" : "DID NOT TAKE") (was \(hex(original)), now \(hex(now)))")
        self.send(camera, "\(name): restore", 0x1016, [property], out: original) { _, _ in
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
        self.send(camera, "\(name): after restore", 0x1015, [property]) { _, restored in
          log("   \(name): restored \(restored == original ? "ok" : "NOT RESTORED: \(hex(restored))")")
          next()
        } } } } } } }
      }
      next()
    }
  }
  // Read-only: the descriptions of the exposure properties inside the Leica session
  // (type, whether it can be set, current value, allowed values).
  func properties(_ camera: ICCameraDevice) {
    log("— property probe —")
    send(camera, "LEOpenSession", 0x9005, [0xff55]) { code, _ in
      guard code == 0x2001 else { return }
      var codes: [UInt16] = [0x500f, 0xd03b, 0xd60f, 0x5005, 0xd004, 0x500e, 0x5010, 0x500b, 0x5013]
      func next() {
        guard !codes.isEmpty else { log("— property probe done —"); return }
        let property = codes.removeFirst()
        self.send(camera, "PropDesc \(String(format: "%04x", property))", 0x1014, [UInt32(property)]) { _, data in
          log("   full: \(hex(data, limit: 400))")
          next()
        }
      }
      next()
    }
  }
  var objectAdded: ((UInt32) -> Void)?
  // One tethered shot the way Lightroom's Leica tether takes it: the Leica session, external shooting on,
  // the standard InitiateCapture, then for the object the camera announces: transfer ready, info, a first
  // piece (how soon a preview could show) and the whole file.
  func capture(_ camera: ICCameraDevice) {
    log("— capture probe —")
    let finish = {
      self.send(camera, "ExternalShootingDisable", 0x1016, [0xd018], out: Data([0, 0, 0, 0])) { _, _ in log("— capture probe done —") }
    }
    send(camera, "LEOpenSession", 0x9005, [0xff55]) { openCode, _ in
      guard openCode == 0x2001 else { log("the Leica session did not open; nothing else is sent"); return }
      self.send(camera, "ExternalShootingEnable", 0x1016, [0xd018], out: Data([1, 0, 0, 0])) { _, _ in
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
        let pressed = ProcessInfo.processInfo.systemUptime
        let since = { String(format: "%.2f s after the shutter command", ProcessInfo.processInfo.systemUptime - pressed) }
        var handled = false
        self.objectAdded = { handle in
          guard !handled else { return }
          handled = true
          log("object 0x\(String(handle, radix: 16)) announced \(since())")
          self.send(camera, "LERequestObjectTransferReady", 0x9007) { _, _ in
          self.send(camera, "GetObjectInfo", 0x1008, [handle]) { _, info in
            var reader = Reader(data: info); _ = reader.u32(); let format = reader.u16(); _ = reader.u16(); let size = reader.u32()
            log("  format 0x\(String(format, radix: 16)) | \(size) bytes")
          self.send(camera, "GetPartialObject first 512 KiB", 0x101b, [handle, 0, 524288]) { _, part in
            log("  first piece: \(part.count) bytes \(since())")
          let started = ProcessInfo.processInfo.systemUptime
          self.send(camera, "GetObject", 0x1009, [handle]) { code, object in
            let took = ProcessInfo.processInfo.systemUptime - started
            let url = downloadDir.appendingPathComponent("capture.dng")
            if object.count > 1_000_000 { try? object.write(to: url) }
            log(String(format: "  whole file: %d bytes in %.2f s (%.0f MB/s), %@ → %@", object.count, took, Double(object.count) / 1_000_000 / max(took, 0.001), since(), url.path))
            finish()
          } } } }
        }
        self.send(camera, "InitiateCapture", 0x100e, [0, 0]) { _, _ in }
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { if !handled { log("no object announced within 15 s"); handled = true; finish() } }
      } }
    }
  }
  // Live view the way the Lightroom tether plug-in asks for it (opcodes from libgphoto2's ptp.h):
  // read the stream properties, open the Leica session, enable the stream, read frames, then put everything back.
  func liveView(_ camera: ICCameraDevice) {
    log("— live view probe (the sequence Lightroom Classic's Leica tether sends) —")
    func grab(_ remaining: Int, _ after: @escaping () -> Void) {
      if remaining == 0 { after(); return }
      let started = ProcessInfo.processInfo.systemUptime
      self.send(camera, "GetLiveViewImage", 0x9025) { code, data in
        if let start = data.range(of: Data([0xff, 0xd8, 0xff])) {
          self.frames += 1
          let url = downloadDir.appendingPathComponent("liveview-\(self.frames).jpg")
          try? data[start.lowerBound...].write(to: url)
          log(String(format: "  FRAME %d: JPEG %d bytes after a %d-byte header, %.0f ms", self.frames, data.count - start.lowerBound, start.lowerBound, (ProcessInfo.processInfo.systemUptime - started) * 1000))
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + (code == 0x2001 ? 0.02 : 0.25)) { grab(remaining - 1, after) }
      }
    }
    send(camera, "LEOpenSession", 0x9005, [0xff55]) { openCode, _ in
      guard openCode == 0x2001 else { log("the Leica session did not open; nothing else is sent"); return }
      self.send(camera, "GetDeviceInfo after open", 0x1001) { _, info in
        var reader = Reader(data: info); _ = reader.u16(); _ = reader.u32(); _ = reader.u16(); _ = reader.string(); _ = reader.u16()
        let operations = reader.array16()
        log("  operations now (\(operations.count)); vendor: \(codes(operations.filter { $0 >= 0x9000 }))")
      // The camera answers DeviceBusy (0x2019) while it settles after the session opens.
      func start(_ tries: Int, _ then: @escaping () -> Void) {
        self.send(camera, "StartLiveView", 0x901c, [0]) { code, _ in
          if code == 0x2001 || tries == 0 { then(); return }
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { start(tries - 1, then) }
        }
      }
      self.send(camera, "ExternalShootingEnable", 0x1016, [0xd018], out: Data([1, 0, 0, 0])) { _, _ in
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
      start(6) {
      // The stream only takes once the camera's own live view runs: ask again until the value reads back.
      func enable(_ tries: Int, _ then: @escaping () -> Void) {
        self.send(camera, "SetEnabledStreamOn", 0x1016, [0x5021], out: Data([0x01, 0x00, 0x02, 0x00])) { _, _ in
        self.send(camera, "KeepCameraAlive", 0x901d) { _, _ in
        self.send(camera, "SupportedStreams", 0x1015, [0x5020]) { _, _ in
        self.send(camera, "EnabledStreams", 0x1015, [0x5021]) { _, value in
          if value.contains(where: { $0 != 0 }) || tries == 0 { then(); return }
          DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { enable(tries - 1, then) }
        } } } }
      }
      enable(6) {
      self.send(camera, "noop", 0x1015, [0x5001]) { _, _ in
      self.send(camera, "noop", 0x1015, [0x5001]) { _, _ in
      self.send(camera, "noop", 0x1015, [0x5001]) { _, _ in
      grab(12) {
        self.send(camera, "StopLiveView", 0x901c, [1]) { _, _ in
        self.send(camera, "SetEnabledStreamOff", 0x1016, [0x5021], out: Data([0, 0, 0, 0])) { _, _ in
        self.send(camera, "ExternalShootingDisable", 0x1016, [0xd018], out: Data([0, 0, 0, 0])) { _, _ in
        self.send(camera, "LECloseSession", 0x9006) { _, _ in log("— live view probe done: \(self.frames) frame(s) saved to \(downloadDir.path) —") } } } }
      } } } } } } } } }
    }
  }

  // ICDeviceBrowserDelegate
  func deviceBrowser(_ browser: ICDeviceBrowser, didAdd device: ICDevice, moreComing: Bool) {
    log("found: \(device.name ?? "?") | transport \(device.transportType ?? "?") | vendor 0x\(String(device.usbVendorID, radix: 16)) product 0x\(String(device.usbProductID, radix: 16)) | serial \(device.serialNumberString ?? "-")")
    guard let camera = device as? ICCameraDevice else { return }
    cameras.append(camera)
    camera.delegate = self
    camera.requestOpenSession()
  }
  func deviceBrowser(_ browser: ICDeviceBrowser, didRemove device: ICDevice, moreGoing: Bool) {
    log("removed: \(device.name ?? "?")")
    cameras.removeAll { $0 === device }
  }

  // ICDeviceDelegate
  func device(_ device: ICDevice, didOpenSessionWithError error: Error?) {
    log("session open: \(device.name ?? "?") \(error.map { "ERROR \($0.localizedDescription)" } ?? "ok")")
    guard error == nil, let camera = device as? ICCameraDevice else { return }
    log("capabilities: \(camera.capabilities.sorted().joined(separator: ", "))")
    log("tethered capture enabled: \(camera.tetheredCaptureEnabled) | ptpEventHandler available: \(camera.responds(to: #selector(setter: ICCameraDevice.ptpEventHandler)))")
    camera.ptpEventHandler = { data in
      log("PTP event (handler): \(hex(data))")
      var reader = Reader(data: data); _ = reader.u32(); _ = reader.u16()
      let code = reader.u16(); _ = reader.u32(); let parameter = reader.u32()
      if code == 0x4002 { self.objectAdded?(parameter) }
    }
    if arguments.count > 3, arguments[3] == "setprops" { DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.setProperties(camera) } }
    if arguments.count > 3, arguments[3] == "props" { DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.properties(camera) } }
    if arguments.count > 3, arguments[3] == "capture" { DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.capture(camera) } }
    // GetDeviceInfo (0x1001): what the camera says it can do.
    transaction += 1
    camera.requestSendPTPCommand(ptpCommand(code: 0x1001, transaction: transaction), outData: nil) { response, inData, error in
      if let error = error { log("GetDeviceInfo ERROR \(error.localizedDescription)"); return }
      // The dataset arrives in whichever buffer the system fills; the other holds the 12-byte response.
      let dataset = inData.count > response.count ? inData : response
      log("GetDeviceInfo: response \(response.count) bytes, data \(inData.count) bytes")
      var reader = Reader(data: dataset)
      let standard = reader.u16(), extensionId = reader.u32(), extensionVersion = reader.u16()
      let extensionDescription = reader.string()
      _ = reader.u16()
      let operations = reader.array16(), events = reader.array16(), properties = reader.array16()
      let captureFormats = reader.array16(), imageFormats = reader.array16()
      let manufacturer = reader.string(), model = reader.string(), version = reader.string()
      log("  standard \(standard) | vendor extension 0x\(String(extensionId, radix: 16)) v\(extensionVersion) \"\(extensionDescription)\"")
      log("  \(manufacturer) | \(model) | firmware \(version)")
      log("  operations (\(operations.count)): \(codes(operations))")
      log("  events (\(events.count)): \(codes(events))")
      log("  device properties (\(properties.count)): \(codes(properties))")
      log("  capture formats: \(codes(captureFormats)) | image formats: \(codes(imageFormats))")
      self.vendorProperties = properties.filter { $0 >= 0xd000 }
      log("  standard InitiateCapture (100e): \(operations.contains(0x100e)) | ObjectAdded event (4002): \(events.contains(0x4002)) | CaptureComplete (400d): \(events.contains(0x400d))")
    }
    if arguments.count > 3, arguments[3] == "liveview" { DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.liveView(camera) } }
    if camera.capabilities.contains("ICCameraDeviceCanTakePicture") {
      log("the camera offers remote capture through the system; enabling tethered capture")
      camera.requestEnableTethering()
    }
  }
  func device(_ device: ICDevice, didCloseSessionWithError error: Error?) { log("session closed: \(device.name ?? "?") \(error?.localizedDescription ?? "")") }
  func didRemove(_ device: ICDevice) { log("device removed: \(device.name ?? "?")") }
  func device(_ device: ICDevice, didEncounterError error: Error?) { log("device error: \(error?.localizedDescription ?? "?")") }

  // ICCameraDeviceDelegate
  func deviceDidBecomeReady(withCompleteContentCatalog device: ICCameraDevice) {
    log("catalog ready: \(device.mediaFiles?.count ?? 0) files on the camera. Now press the shutter a few times.")
    // Read-only: what each vendor property is (GetDevicePropDesc 0x1014).
    for code in vendorProperties {
      transaction += 1
      device.requestSendPTPCommand(ptpCommand(code: 0x1014, transaction: transaction, parameters: [UInt32(code)]), outData: nil) { response, inData, error in
        let dataset = inData.count > response.count ? inData : response
        log("property \(String(format: "%04x", code)): \(error?.localizedDescription ?? hex(dataset, limit: 40))")
      }
    }
    // "shoot" as the third argument: release the shutter over USB, twice.
    guard arguments.count > 3, arguments[3] == "shoot" else { return }
    // The standard InitiateCapture (0x100e), storage 0 and format 0 = the camera's choice: the response code says why a body refuses.
    for delay in [3.0, 10.0] {
      DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
        self.transaction += 1
        log("InitiateCapture →")
        device.requestSendPTPCommand(ptpCommand(code: 0x100e, transaction: self.transaction, parameters: [0, 0]), outData: nil) { response, inData, error in
          log("InitiateCapture ← \(error?.localizedDescription ?? "no error") | a: \(hex(response)) | b: \(hex(inData))")
        }
      }
    }
    // GetStorageIDs (0x1004) and GetDevicePropValue of battery (0x5001): is anything readable at all in this mode.
    for (code, parameters) in [(UInt16(0x1004), [UInt32]()), (UInt16(0x1015), [UInt32(0x5001)]), (UInt16(0x1015), [UInt32(0x5013)])] {
      transaction += 1
      device.requestSendPTPCommand(ptpCommand(code: code, transaction: transaction, parameters: parameters), outData: nil) { response, inData, error in
        log("op \(String(format: "%04x", code)) \(parameters.map { String(format: "%04x", $0) }) ← a: \(hex(response)) | b: \(hex(inData))")
      }
    }
  }
  var vendorProperties: [UInt16] = []
  func cameraDevice(_ camera: ICCameraDevice, didAdd items: [ICCameraItem]) {
    for item in items {
      guard let file = item as? ICCameraFile else { continue }
      // The initial catalog arrives through here too; only files that appear after it are new shots.
      let fresh = camera.contentCatalogPercentCompleted >= 100
      guard fresh else { continue }
      log("NEW FILE: \(file.name ?? "?") | \(file.uti ?? "?") | \(file.fileSize) bytes | raw \(file.isRaw)")
      let started = ProcessInfo.processInfo.systemUptime
      file.requestDownload(options: [.downloadsDirectoryURL: downloadDir, .overwrite: true]) { name, error in
        let took = ProcessInfo.processInfo.systemUptime - started
        log(error.map { "download ERROR \(file.name ?? "?"): \($0.localizedDescription)" } ?? String(format: "downloaded %@ in %.2f s → %@", name ?? "?", took, downloadDir.path))
      }
    }
  }
  func cameraDevice(_ camera: ICCameraDevice, didRemove items: [ICCameraItem]) { log("removed \(items.count) item(s)") }
  func cameraDevice(_ camera: ICCameraDevice, didReceiveThumbnail thumbnail: CGImage?, for item: ICCameraItem, error: Error?) {}
  func cameraDevice(_ camera: ICCameraDevice, didReceiveMetadata metadata: [AnyHashable: Any]?, for item: ICCameraItem, error: Error?) {}
  func cameraDevice(_ camera: ICCameraDevice, didRenameItems items: [ICCameraItem]) {}
  func cameraDeviceDidChangeCapability(_ camera: ICCameraDevice) { log("capabilities changed: \(camera.capabilities.sorted().joined(separator: ", "))") }
  func cameraDevice(_ camera: ICCameraDevice, didReceivePTPEvent eventData: Data) { log("PTP event: \(hex(eventData))") }
  func cameraDeviceDidRemoveAccessRestriction(_ device: ICDevice) { log("access restriction removed") }
  func cameraDeviceDidEnableAccessRestriction(_ device: ICDevice) { log("access restricted: unlock the camera / allow the connection") }
}

let probe = Probe()
probe.start()
if seconds > 0 { DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { log("done"); exit(0) } }
RunLoop.main.run()
