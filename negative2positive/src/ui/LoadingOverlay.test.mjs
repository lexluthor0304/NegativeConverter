// Standalone Node test for LoadingOverlay.js - run with:
// node negative2positive/src/ui/LoadingOverlay.test.mjs
//
// show({ immediate: true }) (#245) marks the overlay so its fade-in is
// skipped (app.css: `transition: none`), and hide() drops the mark so the
// fade-out is unchanged. A plain show() never adds it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...names) { names.forEach(name => this.set.add(name)); }
  remove(...names) { names.forEach(name => this.set.delete(name)); }
  contains(name) { return this.set.has(name); }
  toggle(name, force) { const on = force ?? !this.set.has(name); if (on) this.set.add(name); else this.set.delete(name); return on; }
}
class FakeElement {
  constructor(tag) { this.tag = tag; this.children = []; this.classList = new FakeClassList(); this.style = {}; this.attributes = {}; this.textContent = ''; this.dataset = {}; }
  set className(value) { this.classList = new FakeClassList(); String(value).split(/\s+/).filter(Boolean).forEach(name => this.classList.add(name)); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  removeChild(child) { this.children = this.children.filter(c => c !== child); child.parentNode = null; }
  remove() { this.parentNode?.removeChild(this); }
  addEventListener() {}
  removeEventListener() {}
  set innerHTML(value) { this._html = value; }
}
globalThis.document = { body: new FakeElement('body'), createElement: tag => new FakeElement(tag) };

const { LoadingOverlay } = await import('./LoadingOverlay.js');
const overlay = new LoadingOverlay();

await overlay.show({ title: 'Detecting', indeterminate: true, immediate: true });
const node = overlay._overlay;
assert.ok(node.classList.contains('visible'));
assert.ok(node.classList.contains('loading-overlay-immediate'), 'immediate skips the fade-in');
// A later show of the same visible overlay (the conversion taking over) keeps it opaque.
await overlay.show({ title: 'Converting' });
assert.ok(node.classList.contains('loading-overlay-immediate'));
overlay.hide();
assert.ok(!node.classList.contains('visible'));
assert.ok(!node.classList.contains('loading-overlay-immediate'), 'hide() restores the fade-out');
await overlay.show({ title: 'Converting' });
assert.ok(!node.classList.contains('loading-overlay-immediate'), 'a plain show() fades in as before');
overlay.hide();

// The rule wins over Studio's steps() timing and only while visible.
const css = readFileSync(new URL('../styles/app.css', import.meta.url), 'utf8');
assert.match(css, /\.loading-overlay\.visible\.loading-overlay-immediate\s*\{\s*transition:\s*none;/);

console.log('LoadingOverlay tests passed');
