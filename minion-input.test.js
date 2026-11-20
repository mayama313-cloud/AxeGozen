const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { preflight, parseJSON, readJSON } = require('./scripts/minion-input');

test('LFS pointers are reported with file names and recovery commands for JSON and JSONL', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minion-input-'));
  t.after(() => { for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file)); fs.rmdirSync(dir); });
  for (const extension of ['json', 'jsonl']) {
    const file = path.join(dir, 'teacher.' + extension);
    fs.writeFileSync(file, 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 1000\n');
    assert.throws(() => preflight(file), e => e.code === 'MINION_LFS_POINTER' && e.message.includes(file) && e.message.includes('git lfs checkout') && e.message.includes('git lfs pull'));
    assert.throws(() => readJSON(file), { code: 'MINION_LFS_POINTER' });
    assert.throws(() => parseJSON(fs.readFileSync(file, 'utf8').split('\n')[0], file, 1), { code: 'MINION_LFS_POINTER' });
  }
});

test('JSON errors include the path and JSONL line, while UTF-8 BOMs are accepted', () => {
  assert.throws(() => parseJSON('broken', 'data.jsonl', 14), e => e.code === 'MINION_INVALID_JSON' && e.message.includes('data.jsonl:14'));
  assert.deepEqual(parseJSON('\uFEFF{"ok":true}', 'data.json'), { ok: true });
});
