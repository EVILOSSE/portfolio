import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp, buildPayload, normalizeVideo, MODEL } from '../server.mjs';

test('settings are forwarded and the model cannot be overridden', () => {
  const payload = buildPayload({ prompt: 'A bird takes flight.', duration: 8, resolution: '720p', ratio: '9:16', seed: 0, audio: false, cameraFixed: true, negativePrompt: 'text', extra: { watermark: false } });
  assert.equal(payload.model, MODEL);
  assert.equal(payload.seconds, '8');
  assert.equal(payload.size, '720x1280');
  assert.equal(payload.seed, 0);
  assert.equal(payload.generate_audio, false);
  assert.equal(payload.metadata.camera_fixed, true);
  assert.equal(payload.metadata.negative_prompt, 'text');
  assert.equal(payload.metadata.watermark, false);
  assert.throws(() => buildPayload({ prompt: 'x', extra: { model: 'different' } }), /cannot override/);
  assert.throws(() => buildPayload({ prompt: 'x', duration: 100 }), /Duration/);
  assert.throws(() => buildPayload({ prompt: 'x', extra: 'not-json' }), /valid JSON/);
  assert.equal(buildPayload({ prompt: 'x', duration: 30 }).seconds, '30');
  assert.throws(() => buildPayload({ prompt: 'x', duration: 31 }), /Duration/);
  assert.equal(buildPayload({ prompt: 'x'.repeat(2500) }).prompt.length, 2500);
  assert.throws(() => buildPayload({ prompt: 'x'.repeat(2501) }), /Remove 1 characters/);
});

test('image, video and audio assets use typed content and roles', () => {
  const payload = buildPayload({ prompt: 'Use my assets.', duration: 30, assets: [
    { name: 'image.png', type: 'image', role: 'first_frame', data: 'data:image/png;base64,aGVsbG8=' },
    { name: 'clip.mp4', type: 'video', role: 'reference', data: 'data:video/mp4;base64,aGVsbG8=' },
    { name: 'sound.mp3', type: 'audio', role: 'reference', data: 'data:audio/mpeg;base64,aGVsbG8=' },
  ] });
  assert.equal(payload.content.length, 4);
  assert.equal(payload.content[1].type, 'image_url');
  assert.equal(payload.content[1].role, 'first_frame');
  assert.equal(payload.content[2].role, 'reference_video');
  assert.equal(payload.content[3].role, 'reference_audio');
  assert.equal(payload.metadata.content, payload.content);
  assert.equal(payload.image, 'data:image/png;base64,aGVsbG8=');
  assert.throws(() => buildPayload({ prompt: 'x', assets: [{ type: 'image', data: 'data:text/html;base64,aGVsbG8=' }] }), /Use PNG/);
});

test('task formats normalize to the same completion and preserve history', () => {
  const result = normalizeVideo({ data: { task_id: 'task-1', status: 'SUCCESS', progress: '100%', url: 'https://example.com/video.mp4' } }, { prompt: 'A bird', createdAt: '2026-11-16' });
  assert.equal(result.id, 'task-1');
  assert.equal(result.status, 'completed');
  assert.equal(result.progress, 100);
  assert.equal(result.prompt, 'A bird');
  assert.equal(result.url, 'https://example.com/video.mp4');
});

test('proxy creates, polls, streams, persists, rejects foreign origins, and never serves secrets', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'seedance-test-'));
  const calls = [];
  const relay = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-secret');
    const buffers = [];
    for await (const chunk of req) buffers.push(chunk);
    calls.push({ method: req.method, url: req.url, body: Buffer.concat(buffers).toString() });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: MODEL }] }));
    if (req.method === 'POST') return res.end(JSON.stringify({ id: 'task-1', status: 'queued', progress: 0 }));
    if (req.url.endsWith('/content')) { res.setHeader('Content-Type', 'video/mp4'); return res.end('test-mp4-bytes'); }
    return res.end(JSON.stringify({ data: { task_id: 'task-1', status: 'SUCCESS', progress: '100%' } }));
  });
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
  let app;
  try {
    app = await createApp({ baseUrl: `http://127.0.0.1:${relay.address().port}/v1`, apiKey: 'test-secret', dataDir });
    await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
    let base = `http://127.0.0.1:${app.address().port}`;
    const config = await (await fetch(base + '/api/config')).text();
    assert.ok(!config.includes('test-secret'));
    assert.equal((await fetch(base + '/.env')).status, 404);
    assert.equal((await fetch(base + '/server.mjs')).status, 404);
    assert.equal((await fetch(base + '/api/videos', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://foreign.example' }, body: '{}' })).status, 403);
    assert.equal((await fetch(base + '/api/videos', { method: 'POST', body: '{}' })).status, 415);
    assert.equal((await (await fetch(base + '/api/connection')).json()).available, true);
    const create = await fetch(base + '/api/videos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'A bird takes flight.', duration: 5, ratio: '16:9', resolution: '720p', audio: false }) });
    assert.equal(create.status, 201);
    assert.equal((await create.json()).status, 'queued');
    assert.equal(JSON.parse(calls.find(call => call.method === 'POST').body).generate_audio, false);
    const completed = await (await fetch(base + '/api/videos/task-1')).json();
    assert.equal(completed.status, 'completed');
    const content = await fetch(base + '/api/videos/task-1/content?download=1');
    assert.equal(content.headers.get('content-type'), 'video/mp4');
    assert.match(content.headers.get('content-disposition'), /attachment/);
    assert.equal(await content.text(), 'test-mp4-bytes');
    await new Promise(resolve => app.close(resolve));
    app = await createApp({ baseUrl: `http://127.0.0.1:${relay.address().port}/v1`, apiKey: 'test-secret', dataDir });
    await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${app.address().port}`;
    const history = await (await fetch(base + '/api/videos')).json();
    assert.equal(history.length, 1);
    assert.equal(history[0].prompt, 'A bird takes flight.');
  } finally {
    if (app?.listening) await new Promise(resolve => app.close(resolve));
    await new Promise(resolve => relay.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
