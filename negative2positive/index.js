export default class LibRaw {
	constructor() {
		this.worker = new Worker(new URL('./worker.js', import.meta.url), {type:"module"});
		this.waitForWorker = false;
		this.worker.onmessage = ({data}) => {
			if(this.waitForWorker) {
				let {"return": ret, "throw": thr} = this.waitForWorker;
				this.waitForWorker = false;
				if(data?.error) {
					thr(data.error);
				} else {
					ret(data?.out);
				}
			}
		};
	}
	
	async runFn(fn, ...args) {
		let prom = new Promise((res, err)=>{
			this.waitForWorker = {
				error: err,
				return: res,
			};
		});
		this.worker.postMessage({fn, args}, args.map(a=>{
			if([ArrayBuffer, Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array].some(b=>a instanceof b)) { // Transfer buffer
				return a.buffer;
			}
		}).filter(a=>a));
		return await prom;
	}
	/**
	 * Open/parse the RAW data with optional settings
	 */
	async open(buffer, settings) {
		return await this.runFn('open', buffer, settings);
	}

	/**
	 * Retrieve metadata
	 */
	async metadata(fullOutput) {
		let metadata = await this.runFn('metadata', !!fullOutput);
		// Example: convert numeric thumb_format to a string
		if (metadata?.hasOwnProperty('thumb_format')) {
			metadata.thumb_format = [
				'unknown',
				'jpeg',
				'bitmap',
				'bitmap16',
				'layer',
				'rollei',
				'h265'
			][metadata.thumb_format] || 'unknown';
		}
		// Trim desc if present
		if (metadata?.hasOwnProperty('desc')) {
			metadata.desc = String(metadata.desc).trim();
		}
		if (metadata?.hasOwnProperty('timestamp')) {
			metadata.timestamp = new Date(metadata.timestamp);
		}
		return metadata;
	}

	/**
	 * Retrieve processed image data (synchronously from the perspective of C++,
	 * but we've already awaited the module & instance.)
	 */
	async imageData() {
		return await this.runFn('imageData');
	}
}