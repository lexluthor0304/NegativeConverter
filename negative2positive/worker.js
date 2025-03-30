import LibRawModule from './libraw.js';

let ready;
let LibRawClass;
let raw;

async function initLibRaw() {
	ready = (async ()=>{
		const module = await LibRawModule();
		LibRawClass = module.LibRaw;
		raw = new LibRawClass();
	})();
}

initLibRaw();

self.onmessage = async (event) => {
  const { fn, args } = event.data;
  try {
	await ready;
    let out = raw[fn](...args);
    self.postMessage({out},  (Array.isArray(out)?out:(typeof out=='object'?Object.values(out):[])).map(a=>{
		if([ArrayBuffer, Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array].some(b=>a instanceof b)) { // Transfer buffer
			return a.buffer;
		}
	}).filter(a=>a));
  } catch (err) {
    self.postMessage({ error: err.message });
  }
};