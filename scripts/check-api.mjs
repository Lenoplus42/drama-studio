import assert from 'node:assert/strict';
import {generateScene, audioBytes} from '../web/api.js';
const url = process.argv[2] ?? 'http://127.0.0.1:8765';
const health = await (await fetch(`${url}/health`)).json();
assert.equal(health.ready, true);
let chunks = 0, seconds = 0, ended = false;
for await (const event of generateScene(url, [{speaker: 0, text: '你好，我们的接口已经连通了。'}])) {
  if (event.type === 'start') {
    assert.equal(event.version, 1);
    assert.equal(event.backend, health.backend);
    assert.equal(event.sample_rate, 44100);
  } else if (event.type === 'audio') {
    assert.equal(event.index, chunks++);
    const bytes = Buffer.from(audioBytes(event));
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
    assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
    assert.equal(bytes.readUInt32LE(24), 44100);
    assert.equal(bytes.readUInt32LE(40), bytes.length - 44);
    seconds += event.duration_seconds;
  } else if (event.type === 'done') {
    assert.equal(event.chunks, chunks);
    assert.ok(Math.abs(event.duration_seconds - seconds) < 1e-6);
    assert.equal(event.truncated, false);
    ended = true;
  } else assert.fail(`Unknown event: ${event.type}`);
}
assert.ok(ended && chunks > 0);
const bad = await fetch(`${url}/v1/scene/audio`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lines:[{speaker:9,text:'bad'}]})});
assert.equal(bad.status, 422);
console.log(JSON.stringify({backend:health.backend, chunks, seconds, invalid_request_status:bad.status}));
