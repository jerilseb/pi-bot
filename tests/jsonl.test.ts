import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeLine, JsonlDecoder } from '../src/channels/socket/jsonl.ts';

/**
 * The terminal UI's framing: one JSON record per line, split on LF alone.
 * A socket hands over whatever arrived, so a record may come in pieces, several
 * may come at once, and a character may be split between chunks.
 */

function decoder(options: { maxLineLength?: number } = {}) {
  const records: unknown[] = [];
  const errors: string[] = [];
  const decode = new JsonlDecoder(
    (record) => records.push(record),
    (error) => errors.push(error.message),
    options,
  );
  return { decode, records, errors };
}

const RECORDS = [
  { type: 'event', text: 'plain' },
  { type: 'event', text: 'line\nbreak and "quotes" and \\ backslash' },
  // Separators readline would split on, which are legal inside a JSON string.
  { type: 'event', text: 'para graph sep\r\nCRLF' },
  { type: 'event', text: 'emoji 🖥📱 and ünïcödé' },
  [1, 2, { nested: null }],
];

test('records survive being cut into chunks anywhere, bytes included', () => {
  const stream = Buffer.from(RECORDS.map((record) => encodeLine(record)).join(''));
  for (const size of [1, 2, 3, 7, 64, stream.length]) {
    const { decode, records, errors } = decoder();
    for (let at = 0; at < stream.length; at += size) decode.push(stream.subarray(at, at + size));
    decode.end();
    assert.deepEqual(records, RECORDS, `chunks of ${size} bytes`);
    assert.deepEqual(errors, []);
  }
});

test('several records in one chunk each arrive, in order', () => {
  const { decode, records } = decoder();
  decode.push('{"a":1}\n{"a":2}\n{"a":');
  assert.deepEqual(records, [{ a: 1 }, { a: 2 }]);
  decode.push('3}\n');
  assert.deepEqual(records, [{ a: 1 }, { a: 2 }, { a: 3 }]);
});

test('an encoded record is one line, whatever its strings hold', () => {
  for (const record of RECORDS) {
    const line = encodeLine(record);
    assert.equal(line.indexOf('\n'), line.length - 1);
  }
});

test('a last record without its LF still counts when the stream ends; blank lines are nothing', () => {
  const { decode, records, errors } = decoder();
  decode.push('\n\n{"last":true}');
  assert.deepEqual(records, []);
  decode.end();
  assert.deepEqual(records, [{ last: true }]);
  assert.deepEqual(errors, []);
});

test('a line that is not JSON is an error, and nothing after it is read', () => {
  const { decode, records, errors } = decoder();
  decode.push('{"ok":1}\nnot json\n{"ok":2}\n');
  decode.push('{"ok":3}\n');
  decode.end();
  assert.deepEqual(records, [{ ok: 1 }]);
  assert.deepEqual(errors, ['a line is not JSON']);
});

test('a line longer than the limit is an error, even before its LF arrives', () => {
  const { decode, records, errors } = decoder({ maxLineLength: 20 });
  decode.push('{"short":1}\n');
  decode.push('{"long":"');
  decode.push('x'.repeat(30));
  assert.deepEqual(records, [{ short: 1 }]);
  assert.deepEqual(errors, ['line too long']);
});

test('the replacer sees every value, as JSON.stringify gives it', () => {
  const line = encodeLine({ keep: 1, drop: 2 }, function (this: unknown, key, value) {
    return key === 'drop' ? undefined : value;
  });
  assert.equal(line, '{"keep":1}\n');
});
