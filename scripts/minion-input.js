const fs = require('node:fs');
const path = require('node:path');

function checkText(text, file) {
  const clean = text.replace(/^\uFEFF/, '');
  if (/^\s*version https:\/\/git-lfs\.github\.com\/spec\/v1(?:\r?\n|$)/.test(clean)) {
    const relative = path.relative(path.resolve(__dirname, '..'), file).replace(/\\/g, '/');
    const error = new Error(`Git LFSの実体が未取得です: ${file}\nこれは学習データではなく参照ファイルです。\nローカルの実体を復元: git lfs checkout "${relative}"\n実体がローカルにない場合: git lfs pull --include="${relative}"`);
    error.code = 'MINION_LFS_POINTER';
    throw error;
  }
  return clean;
}

function preflight(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(512);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (!length) throw Error(`データファイルが空です: ${file}`);
    checkText(buffer.subarray(0, length).toString('utf8'), file);
  } finally { fs.closeSync(fd); }
}

function parseJSON(text, file, line = null) {
  const clean = checkText(text, file);
  try { return JSON.parse(clean); }
  catch (cause) {
    const error = new Error(`JSONを読み込めません: ${file}${line === null ? '' : ':' + line}\n${cause.message}`, { cause });
    error.code = 'MINION_INVALID_JSON'; throw error;
  }
}

function readJSON(file) { preflight(file); return parseJSON(fs.readFileSync(file, 'utf8'), file); }

module.exports = { preflight, parseJSON, readJSON };
