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

## ⚠️ Key Clarification: `sandbox_file` vs `sandbox_store`

To prevent any confusion between similarly named tools:

| Feature / Purpose | `sandbox_file` (Local Filesystem) | `sandbox_store` (Cloud Sharing & Web Fetch) |
| :--- | :--- | :--- |
| **Primary Scope** | Local sandbox disk operations | Cloud file sharing & external URL downloads |
| **Actions** | `read`, `write`, `append`, `edit`, `delete` | `share`, `list`, `delete`, `download` |
| **Storage Backend** | Local sandbox container directory | MongoDB GridFS (for sharing) / Local disk (for downloads) |
| **User Interaction** | Internal file reading & editing for agent | Generates private 48-hour download links for the user |
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
Inspects the local sandbox container health, installed system runtimes (Node.js, Python, Go, Rust, Java, GCC, Ruby, PHP), memory and disk usage, active cloned repository path, active branch, and persistent shell status.

### Schema & Parameters
- Takes no parameters (`{}`).

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
Moves files between the sandbox, the web, and the user. Acts as the file sharing and artifact delivery gateway:
- **`share`**: Uploads a file from the sandbox (or small inline content) to **MongoDB GridFS** and produces an expiring, private download link to hand to the user.
- **`list`**: Lists all active shared files, file sizes, and expiration timestamps.
- **`delete`**: Deletes a shared file link immediately by ID (or `all: true`).
- **`download`**: Downloads a file from an external HTTP/HTTPS URL into the sandbox filesystem.

### Expiration & Quotas
- Shared files automatically expire and are purged after at most **48 hours** (`FILE_TTL_HOURS`).
- Upload limit: 25 MB per file (`FILE_MAX_MB`). Inline content up to 10 MB.
- Download limit: 50 MB (`DOWNLOAD_MAX_MB`).

### Schema & Parameters
- `action` (enum, required): `share` | `list` | `delete` | `download`.
- `sandboxPath` (string, optional): Path of a file in the sandbox to share.
- `dir` (string, optional): Directory relative to which paths are resolved.
- `filename` (string, optional): Download file name (required for inline content; target save name for download).
- `content` (string, optional): Inline UTF-8 text to share as a file.
- `content_b64` (string, optional): Inline Base64 content to share as a binary file.
- `ttlHours` (number, optional, min: 1, max: 48): Hours until link expiration (default: 48).
- `id` (string, optional): 24-character hex ID of the shared file to delete.
- `all` (boolean, optional): Set to `true` to delete all files shared by the user.
- `url` (string, optional): External HTTP/HTTPS URL to fetch into the sandbox.

### Usage Examples

#### Sharing a Sandbox File with the User
```json
{
  "action": "share",
  "sandboxPath": "reports/summary.pdf",
  "ttlHours": 24
}
```
*Response returns `downloadUrl` — present this link to the user.*

#### Downloading a Remote Asset into the Sandbox
```json
{
  "action": "download",
  "url": "https://example.com/data.csv",
  "filename": "raw_data.csv"
}
```

#### Listing Active Shared Files
```json
{
  "action": "list"
}
```

#### Deleting a Shared File Link
```json
{
  "action": "delete",
  "id": "670c123456789abcdef01234"
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
