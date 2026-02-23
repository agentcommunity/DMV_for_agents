// Test script for js/qr-encode.js
import { generateQRMatrix } from '../js/qr-encode.js';

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}`);
    failed++;
  }
}

function printQR(matrix, size) {
  // Use Unicode half-blocks for compact rendering
  // top half = row r, bottom half = row r+1
  for (let r = 0; r < size; r += 2) {
    let line = '  ';
    for (let c = 0; c < size; c++) {
      const top = matrix[r][c];
      const bot = (r + 1 < size) ? matrix[r + 1][c] : false;
      if (top && bot) line += '\u2588';      // full block
      else if (top && !bot) line += '\u2580'; // upper half
      else if (!top && bot) line += '\u2584'; // lower half
      else line += ' ';                        // empty
    }
    console.log(line);
  }
}

function checkFinderPattern(matrix, startRow, startCol, label) {
  // The 7x7 finder pattern:
  //  row 0: 1 1 1 1 1 1 1
  //  row 1: 1 0 0 0 0 0 1
  //  row 2: 1 0 1 1 1 0 1
  //  row 3: 1 0 1 1 1 0 1
  //  row 4: 1 0 1 1 1 0 1
  //  row 5: 1 0 0 0 0 0 1
  //  row 6: 1 1 1 1 1 1 1
  const expected = [
    [1,1,1,1,1,1,1],
    [1,0,0,0,0,0,1],
    [1,0,1,1,1,0,1],
    [1,0,1,1,1,0,1],
    [1,0,1,1,1,0,1],
    [1,0,0,0,0,0,1],
    [1,1,1,1,1,1,1],
  ];
  let match = true;
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const actual = matrix[startRow + r][startCol + c] ? 1 : 0;
      if (actual !== expected[r][c]) {
        match = false;
      }
    }
  }
  assert(match, `Finder pattern at ${label} (${startRow},${startCol})`);
}

// ─── Test 1: URL input (~55 chars) ─────────────────────────────────
console.log('\n=== Test 1: URL input ===');
const url = 'https://dmv.agentcommunity.org/c/AB12-CDE-3456/nexus-7';
console.log(`  Input: "${url}" (${url.length} chars)`);

const result1 = generateQRMatrix(url);
const { matrix: m1, size: s1 } = result1;

console.log(`  Size: ${s1}x${s1}`);

assert(typeof result1 === 'object' && result1 !== null, 'Returns an object');
assert(Array.isArray(m1), 'matrix is an array');
assert(typeof s1 === 'number', 'size is a number');
assert(s1 >= 21 && s1 <= 41, `Size ${s1} is in range 21-41 (versions 1-6)`);
assert(m1.length === s1, `Matrix has ${s1} rows`);
assert(m1[0].length === s1, `First row has ${s1} columns`);

// Derive version from size: size = 17 + 4*v => v = (size-17)/4
const version1 = (s1 - 17) / 4;
console.log(`  QR Version: ${version1}`);
assert(Number.isInteger(version1) && version1 >= 1 && version1 <= 6, `Version ${version1} is valid (1-6)`);

// Check finder patterns
checkFinderPattern(m1, 0, 0, 'top-left');
checkFinderPattern(m1, 0, s1 - 7, 'top-right');
checkFinderPattern(m1, s1 - 7, 0, 'bottom-left');

// Check all values are boolean
let allBool = true;
for (let r = 0; r < s1; r++) {
  for (let c = 0; c < s1; c++) {
    if (typeof m1[r][c] !== 'boolean') { allBool = false; break; }
  }
  if (!allBool) break;
}
assert(allBool, 'All matrix values are boolean');

console.log('\n  ASCII visualization:');
printQR(m1, s1);

// ─── Test 2: Short string ("HELLO") ───────────────────────────────
console.log('\n=== Test 2: Short string ===');
const short = 'HELLO';
console.log(`  Input: "${short}" (${short.length} chars)`);

const result2 = generateQRMatrix(short);
const { matrix: m2, size: s2 } = result2;

console.log(`  Size: ${s2}x${s2}`);

const version2 = (s2 - 17) / 4;
console.log(`  QR Version: ${version2}`);

assert(s2 === 21, `Short string produces version 1 (21x21), got ${s2}x${s2}`);

checkFinderPattern(m2, 0, 0, 'top-left');
checkFinderPattern(m2, 0, s2 - 7, 'top-right');
checkFinderPattern(m2, s2 - 7, 0, 'bottom-left');

console.log('\n  ASCII visualization:');
printQR(m2, s2);

// ─── Summary ──────────────────────────────────────────────────────
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
