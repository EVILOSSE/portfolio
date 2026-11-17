# AI Video Workspace

A local workspace that collects a video prompt, image/video/audio references and generation settings, submits a task to a video API through a Node.js proxy, tracks status and supports playback and download.

Zakaria defined the workflow and visual requirements and directed the AI-assisted implementation. It brings API-driven generation into one interface. No commercial time savings or client results are claimed.

[Download complete source and tests](video-workspace-source.zip)

The archive contains `server.mjs`, the browser UI, `package.json`, lockfile, README and `tests/proxy.test.mjs`. It contains no API keys, `.env`, generation history or uploaded assets. The separately viewable [server](video-server.mjs) and [test file](video-proxy.test.mjs) correspond to files in that archive; run tests from the archive's layout.

## Verification — 17 November 2026

`npm test`: 4 tests passed, 0 failed.

- Validates generation settings and prevents advanced fields from overriding the model or credential fields.
- Builds typed image/video/audio references with explicit roles.
- Normalizes different task status formats while preserving history.
- Exercises create, poll, stream and persistence across a server restart against a local test relay; rejects foreign origins and does not serve secret files.

The local UI displayed a connected relay during review. No paid generation was created as part of this review. Provider settings and output quality depend on the configured relay and model. This is a reproducible integration sample, not a publicly hosted paid inference service.

## Run

Use Node.js 22+, extract the archive, then run `npm test` and `npm start`. For real generation, supply your own `RELAY_BASE_URL` and `RELAY_API_KEY` in a local `.env`; never add that file to a public repository. The server binds to `127.0.0.1`.
