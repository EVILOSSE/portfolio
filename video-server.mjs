import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Readable } from 'node:stream';

const root = path.dirname(fileURLToPath(import.meta.url));
if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
export const MODEL = 'seedance-2.5-turbo';
const terminal = new Set(['completed', 'failed', 'cancelled']);
const dimensions = {
  '480p': { '16:9': [864, 480], '9:16': [480, 864], '1:1': [480, 480], '4:3': [640, 480], '3:4': [480, 640], '21:9': [1120, 480] },
  '720p': { '16:9': [1280, 720], '9:16': [720, 1280], '1:1': [720, 720], '4:3': [960, 720], '3:4': [720, 960], '21:9': [1680, 720] },
  '1080p': { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080], '4:3': [1440, 1080], '3:4': [1080, 1440], '21:9': [2520, 1080] },
};

export function buildPayload(input) {
  const prompt = String(input.prompt ?? '').trim();
  if (!prompt || prompt.length > 2500) throw new Error(prompt.length > 2500 ? `Prompt is ${prompt.length.toLocaleString()} characters. Remove ${(prompt.length - 2500).toLocaleString()} characters to meet the relay's 2,500-character limit.` : 'Enter a video prompt.');
  const duration = Number(input.duration ?? 5);
  if (!Number.isInteger(duration) || duration < 2 || duration > 30) throw new Error('Duration must be between 2 and 30 seconds.');
  const resolution = input.resolution ?? '720p';
  const ratio = input.ratio ?? '16:9';
  const size = dimensions[resolution]?.[ratio];
  if (!size) throw new Error('Choose a supported resolution and aspect ratio.');
  const seed = input.seed === '' || input.seed === undefined ? -1 : Number(input.seed);
  if (!Number.isInteger(seed) || seed < -1 || seed > 2147483647) throw new Error('Seed must be -1 (random) or an integer up to 2,147,483,647.');
  let extra = input.extra ?? {};
  if (typeof extra === 'string') {
    try { extra = JSON.parse(extra || '{}'); } catch { throw new Error('Advanced parameters must be valid JSON.'); }
  }
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('Advanced parameters must be a JSON object.');
  for (const key of ['model', 'prompt', 'Authorization', 'api_key', 'apiKey', 'headers', 'base_url']) {
    if (key in extra) throw new Error(`Advanced parameters cannot override ${key}.`);
  }
  const metadata = { ...extra, resolution, aspect_ratio: ratio, generate_audio: input.audio !== false, camera_fixed: input.cameraFixed === true, seed };
  if (input.negativePrompt?.trim()) metadata.negative_prompt = input.negativePrompt.trim();
  const payload = {
    ...extra, model: MODEL, prompt, seconds: String(duration), duration,
    size: size.join('x'), width: size[0], height: size[1],
    resolution, ratio, aspect_ratio: ratio, seed,
    generate_audio: metadata.generate_audio, camera_fixed: metadata.camera_fixed,
    metadata,
  };
  const assets = input.assets ?? [];
  if (!Array.isArray(assets) || assets.length > 15) throw new Error('Attach up to 15 assets.');
  if (assets.length) {
    let total = 0;
    const content = [{ type: 'text', text: prompt }];
    for (const asset of assets) {
      const { type, data, role = 'reference' } = asset;
      const mime = typeof data === 'string' ? data.match(/^data:([^;,]+);base64,/)?.[1] : undefined;
      const allowed = { image: ['image/png', 'image/jpeg', 'image/webp'], video: ['video/mp4', 'video/webm', 'video/quicktime'], audio: ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/webm', 'audio/flac', 'audio/x-flac'] };
      if (!allowed[type]?.includes(mime)) throw new Error('Use PNG, JPG, WebP images, MP4, WebM, MOV video, or MP3, WAV, OGG, M4A, AAC, FLAC audio.');
      if (!['reference', 'first_frame', 'last_frame'].includes(role) || (type !== 'image' && role !== 'reference')) throw new Error('Invalid asset role.');
      const bytes = Math.ceil((data.length - data.indexOf(',') - 1) * 0.75);
      if (bytes > (type === 'image' ? 10 : 20) * 1024 * 1024) throw new Error('Images can be up to 10 MB; video and audio up to 20 MB.');
      total += bytes;
      if (total > 40 * 1024 * 1024) throw new Error('Keep all attached assets under 40 MB in total.');
      content.push({ type: `${type}_url`, [`${type}_url`]: { url: data }, role: type === 'image' ? (role === 'reference' ? 'reference_image' : role) : `reference_${type}` });
    }
    payload.content = content;
    payload.metadata.content = content;
    const firstImage = assets.find(asset => asset.type === 'image');
    if (firstImage) { payload.image = firstImage.data; payload.input_reference = firstImage.data; }
  }
  if (input.image && !assets.length) {
    if (typeof input.image !== 'string' || !/^https:\/\/|^data:image\/(png|jpeg|webp);base64,/i.test(input.image)) throw new Error('Use an HTTPS image URL or a PNG, JPEG, or WebP upload.');
    if (input.image.length > 14_000_000) throw new Error('Reference image must be smaller than 10 MB.');
    payload.image = input.image;
    payload.input_reference = input.image;
  }
  return payload;
}

export function normalizeVideo(raw, prior = {}) {
  const item = raw?.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : raw;
  const status = String(item.status ?? item.state ?? prior.status ?? 'queued').toLowerCase();
  const statuses = { succeeded: 'completed', success: 'completed', done: 'completed', finished: 'completed', processing: 'in_progress', running: 'in_progress', pending: 'queued', submitted: 'queued', failure: 'failed', error: 'failed' };
  const url = item.url ?? item.video_url ?? item.output?.video_url ?? item.content?.video_url ?? item.metadata?.url ?? item.metadata?.video_url ?? item.output?.url;
  const candidate = item.id ?? item.task_id ?? item.taskId ?? prior.id;
  if (!candidate) throw new Error('The relay returned no video task ID.');
  return {
    ...prior, id: String(candidate), status: statuses[status] ?? status,
    progress: Math.max(0, Math.min(100, Number.parseFloat(item.progress ?? prior.progress ?? 0) || 0)),
    url: typeof url === 'string' && /^https:\/\//i.test(url) ? url : prior.url,
    error: item.error ? String(item.error.message ?? item.error) : undefined,
    updatedAt: new Date().toISOString(),
  };
}

export async function createApp({ baseUrl = process.env.RELAY_BASE_URL ?? 'https://codex-relay.codes/v1', apiKey = process.env.RELAY_API_KEY, dataDir = path.join(root, 'data') } = {}) {
  await mkdir(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'videos.json');
  let videos = [];
  try { videos = JSON.parse(await readFile(dbPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let saveQueue = Promise.resolve();
  const save = () => {
    const snapshot = JSON.stringify(videos, null, 2);
    saveQueue = saveQueue.catch(() => {}).then(() => writeFile(dbPath, snapshot));
    return saveQueue;
  };
  const redact = text => String(text).replaceAll(apiKey || '\0', '[redacted]').replace(/sk-[A-Za-z0-9_-]{12,}/g, '[redacted]');
  const upstream = async (route, init = {}) => {
    if (!apiKey) throw Object.assign(new Error('Set RELAY_API_KEY in the local .env file and restart the server.'), { status: 503 });
    let response;
    try {
      response = await fetch(baseUrl.replace(/\/$/, '') + route, {
        ...init, headers: { Authorization: `Bearer ${apiKey}`, ...init.headers }, signal: AbortSignal.timeout(180000),
      });
    } catch (error) {
      throw Object.assign(new Error(error.name === 'TimeoutError' ? 'The relay timed out. Check your relay dashboard before retrying to avoid a duplicate generation.' : `Could not reach the relay: ${redact(error.message)}`), { status: 502 });
    }
    if (!response.ok) {
      const body = await response.text();
      let parsed;
      try { parsed = JSON.parse(body); } catch {}
      const message = parsed?.error?.message ?? parsed?.message ?? body.slice(0, 600) ?? response.statusText;
      throw Object.assign(new Error(redact(message)), { status: response.status });
    }
    return response;
  };
  const json = (res, code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  const readJson = async req => {
    let bytes = 0;
    const chunks = [];
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 120_000_000) throw Object.assign(new Error('Request is too large. Keep all attached assets under 40 MB.'), { status: 413 }); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400 }); }
  };
  const pendingPolls = new Map();
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const host = req.headers.host || '';
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return json(res, 403, { error: 'Localhost access only.' });
      if (req.headers.origin && ![`http://localhost:${server.address().port}`, `http://127.0.0.1:${server.address().port}`].includes(req.headers.origin)) return json(res, 403, { error: 'Requests must come from this localhost app.' });
      if (!['GET', 'HEAD'].includes(req.method) && req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 415, { error: 'Use application/json.' });
      const url = new URL(req.url, `http://${host}`);
      if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { model: MODEL, baseUrl, configured: Boolean(apiKey), maxDuration: 30, maxPromptLength: 2500, assetTypes: ['image', 'video', 'audio'], resolutions: Object.keys(dimensions), ratios: Object.keys(dimensions['720p']) });
      if (req.method === 'GET' && url.pathname === '/api/connection') {
        const response = await upstream('/models');
        const data = await response.json();
        return json(res, 200, { connected: true, available: Boolean(data.data?.some(m => m.id === MODEL)), model: MODEL });
      }
      if (req.method === 'GET' && url.pathname === '/api/videos') return json(res, 200, videos);
      if (req.method === 'POST' && url.pathname === '/api/videos') {
        const input = await readJson(req);
        let payload;
        try { payload = buildPayload(input); } catch (error) { error.status = 400; throw error; }
        const response = await upstream('/videos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const raw = await response.json();
        const settings = { duration: payload.duration, resolution: payload.resolution, ratio: payload.ratio, seed: payload.seed, audio: payload.generate_audio, cameraFixed: payload.camera_fixed, negativePrompt: input.negativePrompt || '', extra: input.extra || '{}' };
        const video = normalizeVideo(raw, { prompt: payload.prompt, settings, createdAt: new Date().toISOString(), hasImage: Boolean(input.image || input.assets?.some(a => a.type === 'image')), assets: (input.assets || []).map(({ name, type, role }) => ({ name, type, role })) });
        videos.unshift(video);
        await save();
        return json(res, 201, video);
      }
      const match = url.pathname.match(/^\/api\/videos\/([^/]+)(\/content)?$/);
      if (match && req.method === 'GET') {
        const id = decodeURIComponent(match[1]);
        const video = videos.find(v => v.id === id);
        if (!video) return json(res, 404, { error: 'This video is not in your local history.' });
        if (match[2]) {
          const response = await upstream(`/videos/${encodeURIComponent(id)}/content`, { headers: req.headers.range ? { Range: req.headers.range } : {} });
          const headers = { 'Content-Type': response.headers.get('content-type') || 'video/mp4' };
          for (const key of ['content-length', 'content-range', 'accept-ranges']) if (response.headers.has(key)) headers[key] = response.headers.get(key);
          if (url.searchParams.has('download')) headers['Content-Disposition'] = `attachment; filename="seedance-${id.replace(/[^a-zA-Z0-9_-]/g, '')}.mp4"`;
          res.writeHead(response.status, headers);
          Readable.fromWeb(response.body).on('error', () => res.destroy()).pipe(res);
          return;
        }
        if (!terminal.has(video.status)) {
          if (!pendingPolls.has(id)) pendingPolls.set(id, (async () => {
            const response = await upstream(`/videos/${encodeURIComponent(id)}`);
            Object.assign(video, normalizeVideo(await response.json(), video));
            await save();
          })().finally(() => pendingPolls.delete(id)));
          await pendingPolls.get(id);
        }
        return json(res, 200, video);
      }
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      if (url.pathname.startsWith('/icons/') && /^\/icons\/[a-z0-9-]+\.svg$/.test(url.pathname)) files[url.pathname] = [url.pathname.slice(1), 'image/svg+xml'];
      const file = files[url.pathname];
      if (file && ['GET', 'HEAD'].includes(req.method)) {
        try {
          const content = await readFile(path.join(root, 'public', file[0]));
          res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8`, 'Cache-Control': 'no-cache' });
          return res.end(req.method === 'HEAD' ? undefined : content);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      json(res, 404, { error: 'Not found.' });
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, { error: redact(error.message || 'Something went wrong.') });
      else res.destroy();
    }
  });
  server.requestTimeout = 200000;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createApp();
  const port = Number(process.env.PORT || 3000);
  server.listen(port, '127.0.0.1', () => console.log(`Seedance is running at http://localhost:${port}`));
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is busy. Change PORT in .env.` : error.message); process.exit(1); });
}
