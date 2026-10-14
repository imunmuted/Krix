# Krix Files Guide (`sandbox_files`)

One tool, four actions. Files shared with `share` live in MongoDB GridFS behind an unguessable download link that expires automatically (**max 48 hours**).

| action | what it does |
| :--- | :--- |
| `download` | Fetch an http(s) `url` into the sandbox (optional `filename`, `dir`). Private/internal addresses are refused. |
| `share` | Upload a sandbox file (`sandboxPath`) or small inline content (`content`/`content_b64` + `filename`). Returns `downloadUrl`, `id`, `expiresAt`. |
| `list` | Your active shared files (id, name, size, expiry). Links are not shown again. |
| `delete` | Delete by `id`, or `all: true`. Kills the link immediately. |

## Typical workflow
1. `sandbox_files({ action: "download", url: "https://example.com/photo.jpg" })` (or create a file with `sandbox_run`).
2. Process it: `sandbox_exec({ command: "convert photo.jpg photo.png" })`, `zip -r bundle.zip dir/`, `unzip a.zip -d out/`, or generate code.
3. `sandbox_files({ action: "share", sandboxPath: "photo.png" })`.
4. **Give the `downloadUrl` to the user in your reply.**
5. Optional: `sandbox_files({ action: "delete", id })`.

## Limits
- Share: 25 MB per file (`FILE_MAX_MB`), per-owner file/byte quota, 20 uploads/min, inline content up to 10 MB. Provide exactly one of `sandboxPath` / `content` / `content_b64`.
- Download: `DOWNLOAD_MAX_MB` (50 MB default), 90 s total, up to 5 redirects. No ICMP is involved; it is plain HTTP(S).
- HTML/SVG/JS files download as opaque files by design. If `MONGODB_URI` is unset, share/list/delete return a "not configured" error (download still works).
