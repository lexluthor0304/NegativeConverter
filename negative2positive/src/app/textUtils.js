// Small pure text helpers shared across the app runtime.

/** Replace {key} placeholders in a template with the given values. */
export function interpolateText(template, replacements = {}) {
  let text = String(template || '');
  for (const [key, value] of Object.entries(replacements)) {
    text = text.replaceAll(`{${key}}`, String(value ?? ''));
  }
  return text;
}

/** Last path segment for compact UI display ("/a/b/c/" -> "c"). */
export function summarizePathForUi(path) {
  const normalized = String(path || '').replace(/[\\/]+$/, '');
  if (!normalized) return '';
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : normalized;
}
