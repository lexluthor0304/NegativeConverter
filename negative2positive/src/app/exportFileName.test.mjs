import assert from 'node:assert/strict';
import { exportNameStem } from './exportFileName.js';
assert.equal(exportNameStem('scan.tif', { filmEdge: { shortName: 'Portra 400' }, frameMetadata: { frameNumber: '3A' } }, { rollName: 'Tokyo' }), 'Tokyo_03A_Portra_400_converted');
assert.equal(exportNameStem('scan.tif', {}, { stock: 'Gold' }, 4), 'scan_04_Gold_converted');
assert.equal(exportNameStem('scan.tif'), 'scan_converted');
assert.ok(!exportNameStem('scan.tif', {}, { stock: '../Gold', rollName: '../test' }, 1).includes('/'));
console.log('export names: typed/automatic frame numbers, fallback and safe stock text passed');
