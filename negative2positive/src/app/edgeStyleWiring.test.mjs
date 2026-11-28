// The edge-marking styles in main.js itself: the settings carry the style
// through the snapshot, the batch job and its resume; "auto" resolves per
// photo; choosing a style fills its values. Real main.js functions, extracted
// with vm (as brushWiring.test.mjs does) against stand-ins.
// node negative2positive/src/app/edgeStyleWiring.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { DEFAULT_SPROCKET_EDGE_MARKINGS, normalizeSprocketEdgeMarkings } from './sprocketFrame.js';
import * as styles from './edgeMarkingStyles.js';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('./i18n.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `runtime function exists: ${name}`);
  const end = source.indexOf('\n    }', match.index);
  return source.slice(match.index, end + '\n    }'.length);
}

const state = {
  sprocketEdge: null, rollMetadata: {}, frameMetadata: null, filmEdge: null, jpegQuality: 92,
  exportSprocketHolesEnabled: true, dustRemoval: { enabled: false, strength: 50, maxParticleSize: 10, ai: true }
};
const context = vm.createContext({
  state, currentLang: 'en', DEFAULT_SPROCKET_EDGE_MARKINGS, normalizeSprocketEdgeMarkings,
  frameNumberFor: () => null, Math, Number, String, Object,
  ...Object.fromEntries(['EDGE_STYLE_AUTO', 'EDGE_STYLE_CUSTOM', 'EDGE_STYLE_COLORS', 'applyEdgeMarkingStyle', 'edgeMarkingStyle', 'resolveAutoEdgeStyle'].map((name) => [name, styles[name]]))
});
vm.runInContext([
  'rgbaToHex', 'createSprocketEdgeSettings', 'autoEdgeResolution', 'resolveAutoEdgeMarkings',
  'getSprocketFrameComposeOptions', 'captureExportJobOptions', 'exportJobOptionsFor'
].map(functionSource).join('\n') + '\nthis.api = { createSprocketEdgeSettings, getSprocketFrameComposeOptions, captureExportJobOptions, exportJobOptionsFor };', context);
const { createSprocketEdgeSettings, getSprocketFrameComposeOptions, captureExportJobOptions, exportJobOptionsFor } = context.api;

// A new session starts on auto; old settings without a style are custom.
assert.match(source, /sprocketEdge: createSprocketEdgeSettings\(\{ style: EDGE_STYLE_AUTO \}\)/);
assert.equal(createSprocketEdgeSettings({ style: 'auto' }).style, 'auto');
const legacy = { ...DEFAULT_SPROCKET_EDGE_MARKINGS, textEnabled: true };
delete legacy.style;
assert.equal(createSprocketEdgeSettings(legacy).style, 'custom', 'a project saved before styles draws as before');
assert.equal(createSprocketEdgeSettings({ style: 'removed-style' }).style, 'custom');

// Choosing a style puts its values in; the settings round-trip through the
// photo snapshot and the batch job, and a job keeps the style it started with.
const chosen = createSprocketEdgeSettings(styles.applyEdgeMarkingStyle(createSprocketEdgeSettings({ style: 'auto' }), 'fujiSlide'));
assert.equal(chosen.style, 'fujiSlide');
assert.equal(chosen.text, 'FUJI RDPIII');
assert.equal(chosen.letteringColor, '#caa23c');
assert.deepEqual(createSprocketEdgeSettings(JSON.parse(JSON.stringify(chosen))), chosen, 'snapshot round-trip');
assert.match(source, /settings\.sprocketEdge = createSprocketEdgeSettings\(state\.sprocketEdge\);/);
assert.match(source, /state\.sprocketEdge = createSprocketEdgeSettings\(s\.sprocketEdge\);/);
state.sprocketEdge = chosen;
const job = captureExportJobOptions();
assert.equal(job.sprocketEdge.style, 'fujiSlide', 'the batch job carries the style');
state.sprocketEdge = createSprocketEdgeSettings({ style: 'kodakColor' });
assert.equal(exportJobOptionsFor({ options: JSON.parse(JSON.stringify(job)) }).sprocketEdge.style, 'fujiSlide', 'a resumed job keeps its own style');
assert.equal(exportJobOptionsFor({ options: { sprocketEdge: { text: 'OLD JOB' } } }).sprocketEdge.style, 'custom', 'a job recorded before styles stays custom');

// The renderer gets the style through the compose options (and the preview
// cache key, which is the edge markings, changes with it).
assert.equal(getSprocketFrameComposeOptions(state, 0, chosen).edgeMarkings.style, 'fujiSlide');
assert.match(source, /JSON\.stringify\(\[width, height, composeOptions\.edgeMarkings,/);
// The contact sheet and the export compose through the same options.
assert.match(source, /const options = getSprocketFrameComposeOptions\(settingsForFile, i\);/);
assert.match(source, /const options = getSprocketFrameComposeOptions\(settings, position, job\?\.sprocketEdge\);/);

// Auto: an unrecognised film draws the border as before.
const auto = createSprocketEdgeSettings({ style: 'auto' });
assert.equal(getSprocketFrameComposeOptions(state, 0, auto).edgeMarkings.style, 'custom');
assert.equal(getSprocketFrameComposeOptions(state, 0, auto).edgeMarkings.text, DEFAULT_SPROCKET_EDGE_MARKINGS.text);
// The film edge read for the photo picks the brand, its text and its real DX number.
const strip = { filmEdge: { found: true, filmName: 'Kodak ULTRA MAX 400 Film GC400', dxNumber: '95-7' }, frameMetadata: null };
let edge = getSprocketFrameComposeOptions(strip, 0, auto).edgeMarkings;
assert.equal(edge.style, 'kodakColor');
assert.equal(edge.text, 'KODAK GC 400');
assert.equal(edge.letteringColor, styles.edgeMarkingStyle('kodakColor').letteringColor);
assert.deepEqual([edge.dx1, edge.dx2], [95, 7]);
// The number printed beside the photo on the film, when the reader saw it.
const read = { filmEdge: { ...strip.filmEdge, frames: [{ frameNumber: 30, halfFrame: true }, { frameNumber: 31, halfFrame: false }, { frameNumber: 31, halfFrame: true }] } };
assert.equal(getSprocketFrameComposeOptions(read, 0, auto).edgeMarkings.frameNumber, 31);
assert.equal(getSprocketFrameComposeOptions(read, 0, { ...auto, frameNumber: 5 }).edgeMarkings.frameNumber, 5, 'a number typed in the panel wins');
// Values the user typed win over the film's.
edge = getSprocketFrameComposeOptions(strip, 0, { ...auto, text: 'MY ROLL', letteringColor: '#00ff00' }).edgeMarkings;
assert.equal(edge.text, 'MY ROLL');
assert.equal(edge.letteringColor, '#00ff00');
// A batch resolves each photo on its own: two films in one roll draw two styles.
const hp5 = { filmEdge: { found: true, filmName: 'Ilford HP5 PLUS 400 HP5+ (black box)', dxNumber: '109-9' } };
assert.equal(getSprocketFrameComposeOptions(hp5, 1, auto).edgeMarkings.style, 'ilford');
assert.equal(getSprocketFrameComposeOptions(strip, 2, auto).edgeMarkings.style, 'kodakColor');
// A light code on a colour negative (a border drawn on a positive) is not applied.
const ownBorder = { filmEdge: { found: true, filmName: 'Kodak Gold Ultra 400 Film', dxNumber: '82-3', polarity: 'light', filmKind: 'color' } };
assert.equal(getSprocketFrameComposeOptions(ownBorder, 0, auto).edgeMarkings.style, 'custom');
// Without a film edge read, the roll's stock decides.
state.rollMetadata = { stock: 'Kodak Ektar 100' };
edge = getSprocketFrameComposeOptions(state, 0, auto).edgeMarkings;
assert.equal(edge.style, 'kodakColor');
assert.equal(edge.text, 'KODAK EKTAR 100');
state.rollMetadata = { stock: 'Fomapan 400' };
edge = getSprocketFrameComposeOptions(state, 0, auto).edgeMarkings;
assert.equal(edge.style, 'custom', 'a brand without a style draws as before');
assert.equal(edge.text, 'FOMAPAN 400', 'with the roll stock as its text, as before');
state.rollMetadata = {};

// The panel: one dropdown at the top of the edge section, the text field's
// suggestions, every option and string in all three languages.
const sectionStart = html.indexOf('id="sprocketEdgeSectionContent"');
assert.ok(html.indexOf('id="sprocketStyleSelect"', sectionStart) < html.indexOf('id="sprocketTextEnabledInput"', sectionStart));
assert.match(html, /id="sprocketTextInput"[^>]*list="sprocketTextSuggestions"/);
for (const id of styles.EDGE_STYLE_MENU) assert.match(html, new RegExp(`<option value="${id}"`), id);
for (const key of ['filmEdgeStyle', 'filmEdgeStyleAutoNone', ...Object.values(styles.EDGE_STYLE_LABEL_KEYS)]) {
  assert.equal(i18n.split(`        ${key}: `).length - 1, 3, `${key} in zh, en and ja`);
}
assert.match(source, /style: 'sprocketStyleSelect'/);

console.log('edgeStyleWiring.test.mjs passed');
