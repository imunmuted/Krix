# Krix MCP Sandbox Tools Guide (Execution, Local Git & Sandbox Store)

This reference guide provides exhaustive documentation for all **15 Sandbox Tools** in Krix MCP. These tools provide an isolated containerized environment for running code across 11 language runtimes, persistent bash shell sessions, background process lifecycle management, safe local file operations, cloud file sharing via **Sandbox Store**, and local Git repository synchronization.

---

## Tool Index

### A. Sandbox Execution & Process Management
1. [`sandbox_status`](#1-sandbox_status)
2. [`sandbox_run`](#2-sandbox_run)
3. [`sandbox_exec`](#3-sandbox_exec)
4. [`sandbox_install`](#4-sandbox_install)
5. [`sandbox_ps`](#5-sandbox_ps)
6. [`sandbox_output`](#6-sandbox_output)
7. [`sandbox_file`](#7-sandbox_file)
8. [`sandbox_reset`](#8-sandbox_reset)

### B. Sandbox Store (File Sharing & Web Downloads)
9. [`sandbox_store`](#9-sandbox_store)

### C. Local Git Synchronization
10. [`git_clone`](#10-git_clone)
11. [`git_checkout`](#11-git_checkout)
12. [`git_pull`](#12-git_pull)
13. [`git_status`](#13-git_status)
14. [`git_diff`](#14-git_diff)
15. [`git_commit_push`](#15-git_commit_push)

---

## 📥 Files the user uploaded from the web page

The user can drop files into the sandbox from the server's `/upload` page (temporary 10-minute session). They appear in the sandbox root under `web-uploads/<filename>`. When the user says they uploaded something, look there first (for example `sandbox_exec` with `ls -la web-uploads/`, then read with `sandbox_file`). Those files are deleted when the user's upload session ends (timer, button, or tab closed), so copy anything you need to keep elsewhere in the sandbox straight away.

---

## ⚠️ Key Clarification: `sandbox_file` vs `sandbox_store`

To prevent any confusion between similarly named tools:

| Feature / Purpose | `sandbox_file` (Local Filesystem) | `sandbox_store` (Cloud Sharing & Web Fetch) |
| :--- | :--- | :--- |
| **Primary Scope** | Local sandbox disk operations | Cloud file sharing & external URL downloads |
| **Actions** | `read`, `write`, `append`, `edit`, `delete` | `share`, `list`, `delete`, `download` |
| **Storage Backend** | Local sandbox container directory | MongoDB GridFS (for sharing) / Local disk (for downloads) |
| **User Interaction** | Internal file reading & editing for agent | Generates private 72-hour (or permanent) download links for the user |
| **When to Use** | When reading/writing source code, editing configuration, or inspecting local files safely without shell escaping | When fetching assets from the web into the sandbox, or giving processed output files to the user |

---

## 🌐 Network Capabilities & Security Guardrails

The execution sandbox **has active outbound network connectivity**. It can install packages from official package registries (`npm`, `pip`), fetch remote files via HTTP/HTTPS, and clone Git repositories.

Outbound access is governed by security restriction levels:
- **Private & Internal IP Blocking**: Access to internal network metadata endpoints (AWS/GCP metadata), localhost (`127.0.0.1`), and RFC 1918 private subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) is blocked to protect host infrastructure.
- **Protocol Guarding**: Non-HTTP protocols (`gopher://`, `dict://`, `file://`) are blocked under medium and high restriction levels.

---

## 1. `sandbox_status`

### Purpose & Overview
Inspects the local sandbox container health, installed system runtimes (Node.js, Python, Go, Rust, Java, GCC, Ruby, PHP), memory usage, **MongoDB connection & storage availability** (bytes/MB quota, available storage, file slots, and active/permanent file counts), active cloned repository path, active branch, and persistent shell status.

### Schema & Parameters
- Takes no parameters (`{}`).

### Response Fields
- `serverRssMB` (number): Node process resident memory in MB.
- `systemFreeMemMB` (number): Host system available free memory in MB.
- `runtimes` (object): Installed system compilers and interpreters versions (`node`, `python`, `git`, `go`, etc.).
- `isolation` (string): Linux isolation enforcement state (`enforced (unprivileged sandbox user)` or reason).
- `mongoDb` (object): Persistent storage backend status:
  - `configured` (boolean): Whether `MONGODB_URI` environment variable is set.
  - `connected` (boolean): Whether the MongoDB cluster responded to health/usage checks.
  - `database` (string): Connected database name (e.g. `krix`).
  - `storage` (object):
    - `availableMB` (number): Free quota available for storage in MB.
    - `usedMB` (number): Total storage consumed by user in MB.
    - `maxMB` (number): Storage ceiling (defaults to 200MB, configurable via `FILE_MAX_TOTAL_MB_PER_OWNER`).
    - `percentUsed` (string): Human-readable quota percentage used (e.g. `"2%"`).
    - `usedBytes` (number): Raw bytes stored.
    - `maxBytes` (number): Raw quota limit in bytes.
  - `files` (object):
    - `totalCount` (number): Total files currently stored.
    - `maxCount` (number): Maximum file count limit (default 50).
    - `availableSlots` (number): Remaining file slots before hitting count limit.
    - `permanentCount` (number): Files marked with `never: true` / permanent retention.
    - `expiredCount` (number): Expired files awaiting garbage collection sweeper.
  - `defaultTtlHours` (number): Default file retention window (72 hours).
- `repo` (string | undefined): Active GitHub repo (`owner/repo`) from context.
- `branch` (string | undefined): Active checked out branch name.
- `cloned` (boolean): Whether repository directory is cloned and ready in sandbox.
- `cwd` (string | undefined): Current relative working directory within the sandbox.
- `persistentShellAlive` (boolean): Whether background bash shell session is active.

### Usage Example
```json
{}
```

---

## 2. `sandbox_run`

### Purpose & Overview
Executes code snippets inline or runs script files directly across 11 programming language runtimes without requiring manual shell wrappers.

### Supported Languages
`py` (Python 3), `js` (Node.js), `ts` (TypeScript via tsx), `sh` (Bash), `go` (Go), `java` (OpenJDK), `cpp` (g++), `c` (gcc), `rust` (rustc), `ruby` (Ruby), `php` (PHP CLI).

### Schema & Parameters
- `code` (string, optional): Inline source code to execute.
- `lang` (enum, optional, default: `py`): `py` | `js` | `ts` | `sh` | `go` | `java` | `cpp` | `c` | `rust` | `ruby` | `php`.
- `filePath` (string, optional): Path to an existing source/script file in the sandbox.
- `args` (array of strings, optional): Command line arguments to pass to the script.
- `dir` (string, optional): Directory to execute the script in (defaults to sandbox working directory).

### Usage Example
```json
{
  "lang": "ts",
  "code": "console.log('Testing TypeScript runtime:', process.version);"
}
```

---

## 3. `sandbox_exec`

### Purpose & Overview
Executes bash shell commands as an unprivileged sandbox user (`sandbox`). Runs in a **persistent shell** by default, preserving shell state, `cd` working directories, environment variable exports, and virtual environment activations across calls. Supports detached background execution (`background: true`).

### Schema & Parameters
- `command` (string, required): Shell command line string.
- `timeoutMs` (number, optional): Execution timeout in milliseconds (default: 30000ms).
- `dir` (string, optional): Temporary working directory for this command.
- `background` (boolean, optional, default: false): When true, spawns as a background process and returns a `pid` for tracking with `sandbox_ps`.
- `persistent` (boolean, optional, default: true): When true, executes in the session's long-lived shell. Pass `false` for an isolated subshell.

### Usage Example
```json
{
  "command": "npm test"
}
```

---

## 4. `sandbox_install`

### Purpose & Overview
Installs dependencies via `npm` or `pip` directly into the sandbox environment.

### Schema & Parameters
- `packageManager` (enum, required): `npm` | `pip`.
- `packages` (array of strings, required): Package specifiers (e.g. `["lodash@^4.17.21"]` or `["requests==2.31.0"]`).
- `dir` (string, optional): Directory to run the installation in.

### Usage Example
```json
{
  "packageManager": "npm",
  "packages": ["zod@^3.22.0"]
}
```

---

## 5. `sandbox_ps`

### Purpose & Overview
Manages background processes spawned with `sandbox_exec(background: true)`. Enables listing active processes, checking CPU/memory/status, tailing recent stdout/stderr, and killing processes.

### Schema & Parameters
- `action` (enum, required): `list` | `kill` | `output` | `clear`.
- `pid` (number, optional): Process ID (required for `kill` and `output`).
- `tailLines` (number, optional, default: 50): Number of stdout/stderr lines to return for `output`.
- `full` (boolean, optional, default: false): Return full output buffer up to 200KB.

### Usage Example
```json
{
  "action": "output",
  "pid": 1420,
  "tailLines": 30
}
```

---

## 6. `sandbox_output`

### Purpose & Overview
Pages through stdout/stderr output that exceeded default response length limits in `sandbox_exec`, `sandbox_run`, or `sandbox_install`.

### Schema & Parameters
- `outputId` (string, required): The output ID returned in the truncation notice.
- `offset` (number, optional, default: 0): Character offset to resume reading from.
- `limit` (number, optional): Maximum characters to retrieve.

### Usage Example
```json
{
  "outputId": "out_9a8b7c6d5e",
  "offset": 10000,
  "limit": 10000
}
```

---

## 7. `sandbox_file`

### Purpose & Overview
Performs safe, binary-proof local file operations (`read`, `write`, `append`, `edit`, `delete`) on the sandbox filesystem. Recommended over raw shell commands (`cat`, `echo`, `sed`) to eliminate shell escaping issues and truncation risks.

### Schema & Parameters
- `action` (enum, required): `read` | `write` | `append` | `edit` | `delete`.
- `path` (string, required): Path of file inside the sandbox.
- `content` (string, optional): Content for `write` or `append`.
- `old_str` (string, optional): Required for `action: edit`. Exact substring to replace.
- `new_str` (string, optional): Required for `action: edit`. Replacement string.
- `dir` (string, optional): Base directory resolving relative paths.
- `offset` (number, optional): Character offset for paginating large reads.
- `limit` (number, optional): Maximum characters to return.

### Usage Example
```json
{
  "action": "edit",
  "path": "src/config.ts",
  "old_str": "export const PORT = 3000;",
  "new_str": "export const PORT = 8080;"
}
```

---

## 8. `sandbox_reset`

### Purpose & Overview
Cleans the sandbox state by wiping temporary scratch files, terminating persistent shells, and stopping background processes while preserving active GitHub context (`owner`, `repo`, `branch`).

### Schema & Parameters
- Takes no parameters (`{}`).

### Usage Example
```json
{}
```

---

## 9. `sandbox_store`

### Purpose & Overview
Unified storage, media viewing, and internet asset gateway:
- **`share`**: Uploads a sandbox file or inline content to **MongoDB GridFS** and produces a secure, private download link. Auto-expiry defaults to **72 hours** (`FILE_TTL_HOURS`), configurable up to 720 hours or set to **`never: true`** (permanent retention).
- **`list`**: Token-efficient search, filtering, and sorting of shared files with MongoDB quota telemetry (`usedMb`, `percentUsed`, `permanentFiles`, `expiredFiles`).
- **`delete`**: Removes files from MongoDB GridFS immediately. Supports single file `id`, batch deletion via `ids: [...]`, expired-only cleanup (`expiredOnly: true`), or name search pruning (`search: "..."`).
- **`download`**: Downloads any file, image, dataset, or package from across the internet into the sandbox using realistic browser headers. Supports `extractMedia: true` to discover downloadable links from webpages, and `view: true` to render downloaded images inline.
- **`view`**: Directly inspects files in the sandbox or MongoDB store. Returns native **MCP image content blocks** (`type: "image"`, base64) to display images directly inside the chat UI, or clean text for code and documents.

### Storage Quotas & Expiration Management
- Default expiry: **72 hours** (`FILE_TTL_HOURS=72`).
- Permanent files: Set `never: true` or `ttlHours: 0` to prevent automatic expiration.
- Quota enforcement: Bound by per-owner storage byte limits (`FILE_MAX_TOTAL_MB_PER_OWNER`, default 200MB) and file counts (`FILE_MAX_PER_OWNER`, default 50).
- If MongoDB storage is full: Use `action: "list", sortBy: "size"` to identify largest files, or `action: "delete", expiredOnly: true` / `ids: [...]` to free space immediately.

### Schema & Parameters
- `action` (enum, required): `share` | `list` | `delete` | `download` | `view`.
- `sandboxPath` (string, optional): Path of a file inside the sandbox (`share`/`view`).
- `dir` (string, optional): Sandbox base directory.
- `filename` (string, optional): File name for downloads or inline shares.
- `content` (string, optional): Inline UTF-8 text.
- `content_b64` (string, optional): Inline Base64 binary content.
- `ttlHours` (number, optional, min: 0, max: 720): Expiration hours (default 72; 0 for permanent).
- `never` (boolean, optional): Store permanently (never auto-deleted).
- `url` (string, optional): Web URL to download into sandbox.
- `extractMedia` (boolean, optional): When downloading a webpage, extracts and returns all image and media URLs.
- `view` (boolean, optional): When true and the file is an image, renders the image directly as an MCP content block.
- `search` (string, optional): Filter files by name substring or regex (`list`/`delete`).
- `status` (enum, optional, default: `active`): `active` | `expired` | `permanent` | `all` (`list`).
- `sortBy` (enum, optional, default: `createdAt`): `size` | `createdAt` | `expiresAt` | `name` (`list`).
- `sortOrder` (enum, optional, default: `desc`): `asc` | `desc` (`list`).
- `limit` (number, optional, default: 20): Results per page (`list`).
- `offset` (number, optional, default: 0): Results offset (`list`).
- `compact` (boolean, optional, default: true): Returns token-efficient lean summary (`list`).
- `id` (string, optional): 24-character hex ID of the file (`delete`/`view`).
- `ids` (array of strings, optional): Batch list of file IDs to delete (`delete`).
- `expiredOnly` (boolean, optional): Delete all expired files owned by the user (`delete`).
- `all` (boolean, optional): Delete all files owned by the user (`delete`).

### Usage Examples

#### 1. Sharing with 72h Default or Permanent Retain
```json
{
  "action": "share",
  "sandboxPath": "build/app-release.apk",
  "never": true
}
```

#### 2. Downloading Images & Web Assets with Direct Viewing
```json
{
  "action": "download",
  "url": "https://images.unsplash.com/photo-1579783902614-a3fb3927b675",
  "filename": "art.jpg",
  "view": true
}
```
*Downloads image into sandbox AND renders it inline in chat via native MCP image blocks.*

#### 3. Extracting Media Links from a Webpage
```json
{
  "action": "download",
  "url": "https://example.com/gallery",
  "extractMedia": true
}
```
*Returns all discovered image, video, and downloadable asset URLs found on the page.*

#### 4. Token-Efficient Search & Sorting by Size
```json
{
  "action": "list",
  "search": "model",
  "sortBy": "size",
  "sortOrder": "desc",
  "compact": true
}
```

#### 5. Batch Pruning and Cleaning Expired Files
```json
{
  "action": "delete",
  "expiredOnly": true
}
```

#### 6. Viewing an Existing Sandbox or Stored Image
```json
{
  "action": "view",
  "sandboxPath": "charts/performance.png"
}
```

---

## 10. `git_clone`

### Purpose & Overview
Clones the active or specified GitHub repository into the local sandbox environment. Automatically reuses existing clones or pulls the latest branch commits.

### Schema & Parameters
- `repoUrl` (string, optional): HTTPS repository URL (defaults to active context repository).
- `owner` (string, optional): Repository owner.
- `repo` (string, optional): Repository name.
- `directoryName` (string, optional): Target directory name inside the sandbox.
- `branch` (string, optional): Branch to clone (defaults to active branch or `main`).

### Usage Example
```json
{
  "branch": "main"
}
```

---

## 11. `git_checkout`

### Purpose & Overview
Switches branches or creates a new local branch in the cloned sandbox repository.

### Schema & Parameters
- `branch` (string, required): Target branch name.
- `create` (boolean, optional, default: false): Whether to create the branch (`git checkout -b`).
- `dir` (string, optional): Repository directory in sandbox.

### Usage Example
```json
{
  "branch": "feature/refactor-auth",
  "create": true
}
```

---

## 12. `git_pull`

### Purpose & Overview
Performs a fast-forward pull from origin for the current or specified branch in the local sandbox clone.

### Schema & Parameters
- `branch` (string, optional): Branch to pull.
- `dir` (string, optional): Repository directory.

### Usage Example
```json
{}
```

---

## 13. `git_status`

### Purpose & Overview
Returns a compact summary of modified, staged, untracked, and deleted files in the sandbox repository.

### Schema & Parameters
- `dir` (string, optional): Repository directory.

### Usage Example
```json
{}
```

---

## 14. `git_diff`

### Purpose & Overview
Displays unstaged or staged git diff output for code changes inside the sandbox repository.

### Schema & Parameters
- `staged` (boolean, optional, default: false): When true, shows staged changes (`git diff --staged`).
- `dir` (string, optional): Repository directory.

### Usage Example
```json
{
  "staged": false
}
```

---

## 15. `git_commit_push`

### Purpose & Overview
Stages all modifications, creates a commit with the specified message, and pushes to origin from the local sandbox repository.

### Schema & Parameters
- `message` (string, required): Git commit message.
- `branch` (string, optional): Branch to push to.
- `push` (boolean, optional, default: true): Whether to push to origin after committing.
- `dir` (string, optional): Repository directory.

### Usage Example
```json
{
  "message": "fix: update database connection pool timeout",
  "push": true
}
```
