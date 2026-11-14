// Which camera a phone scan opens (the "Phone scan" screen, formerly the live
// loupe). Film is shot from a few centimetres, so a lens that focuses that
// close comes first:
//   1. a camera that calls itself macro (some Android phones list one);
//   2. the phone's combined back camera ("Back Triple Camera", "Back Dual Wide
//      Camera" on an iPhone), which switches to its macro lens by itself when
//      the subject is close, and stays on the main lens on a phone without one.
// Anything else leaves the choice to the browser's back camera.
//
// Labels are only readable once camera access was granted, and iOS writes them
// in the system language.
const FRONT = /front|facetime|user|selfie|前置|前面|フロント|インカメラ/i;
const MACRO = /macro|微距|マクロ/i;
const COMBINED = [/triple|三镜头|三鏡頭|トリプル/i, /dual wide|双广角|雙廣角|デュアル広角/i];

export function preferredScanCamera(devices) {
  const back = (devices || []).filter((device) => device?.kind === 'videoinput' && device.deviceId && device.label && !FRONT.test(device.label));
  for (const pattern of [MACRO, ...COMBINED]) {
    const match = back.find((device) => pattern.test(device.label));
    if (match) return match.deviceId;
  }
  return null;
}
