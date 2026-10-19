// Native capabilities come from the shell, never from a device's user agent
// or touchscreen. Browser-only ?shell=mobile|desktop previews the same UI.
export const WEB_CAPABILITIES = Object.freeze({
  nativeDialogs: false, watchFolder: false, updater: false, externalLinks: true, documentsExport: false
});
export const WEB_PLATFORM = Object.freeze({ shell: 'web', os: null, arch: null, mobile: false, capabilities: WEB_CAPABILITIES });
const MOBILE_OS = new Set(['ios', 'android']);
const DESKTOP_OS = new Set(['macos', 'windows', 'linux']);

const SHELL_SIMULATIONS = Object.freeze({
  mobile: { shell: 'tauri', os: 'ios', arch: 'aarch64', mobile: true, capabilities: { nativeDialogs: false, watchFolder: false, updater: false, externalLinks: true, documentsExport: true } },
  desktop: { shell: 'tauri', os: 'macos', arch: 'aarch64', mobile: false, capabilities: { nativeDialogs: true, watchFolder: true, updater: true, externalLinks: true, documentsExport: false } },
  web: WEB_PLATFORM
});

export function simulatedPlatform(search = '') {
  const wanted = new URLSearchParams(search).get('shell');
  return Object.hasOwn(SHELL_SIMULATIONS, wanted)
    ? { ...SHELL_SIMULATIONS[wanted], simulated: true } : null;
}

// An unanswered command must not enable desktop-only operations. Shared
// native I/O still uses the bridge; platform-specific controls stay hidden.
export function fallbackTauriPlatform() {
  return {
    shell: 'tauri', os: null, arch: null, mobile: false,
    capabilities: { ...WEB_CAPABILITIES }, fallback: true
  };
}

export function normalizePlatform(info) {
  if (!info || info.shell !== 'tauri' || (!MOBILE_OS.has(info.os) && !DESKTOP_OS.has(info.os))) return null;
  const mobile = MOBILE_OS.has(info.os);
  const capabilities = info.capabilities ?? {};
  return {
    shell: 'tauri', os: info.os,
    arch: typeof info.arch === 'string' ? info.arch : null,
    mobile,
    capabilities: {
      nativeDialogs: !mobile && capabilities.nativeDialogs === true,
      watchFolder: !mobile && capabilities.watchFolder === true,
      updater: !mobile && capabilities.updater === true,
      externalLinks: capabilities.externalLinks === true,
      documentsExport: mobile && capabilities.documentsExport === true
    }
  };
}

export function platformClasses(info) {
  const classes = [info.shell === 'tauri' ? 'shell-tauri' : 'shell-web'];
  if (info.shell === 'tauri') classes.push(info.fallback ? 'shell-unknown' : (info.mobile ? 'shell-mobile' : 'shell-desktop'));
  if (MOBILE_OS.has(info.os) || DESKTOP_OS.has(info.os)) classes.push(`os-${info.os}`);
  return classes;
}

export function applyPlatformClasses(info, root = globalThis.document?.documentElement) {
  if (!root) return;
  for (const name of [...root.classList].filter((c) => /^(shell|os)-/.test(c))) root.classList.remove(name);
  root.classList.add(...platformClasses(info));
}

export async function resolvePlatform({
  invoke = globalThis.window?.__TAURI__?.core?.invoke ?? null,
  search = globalThis.location?.search ?? '',
  timeoutMs = 1500
} = {}) {
  // A query parameter may preview layout in a browser but cannot change the
  // native app's platform, updater policy or export routing.
  if (typeof invoke !== 'function') return simulatedPlatform(search) ?? WEB_PLATFORM;
  let timer;
  try {
    const answer = await Promise.race([
      invoke('get_platform_info'),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('get_platform_info timed out')), timeoutMs); })
    ]);
    return normalizePlatform(answer) ?? fallbackTauriPlatform();
  } catch {
    return fallbackTauriPlatform();
  } finally {
    clearTimeout(timer);
  }
}
