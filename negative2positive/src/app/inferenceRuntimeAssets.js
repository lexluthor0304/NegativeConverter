// Static asset imports let Vite resolve the binaries in both worker/dev and
// packaged builds, including worktrees with a shared node_modules symlink.
import wasmUrl from '../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url';
import jsepUrl from '../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url';
export { wasmUrl, jsepUrl };
