# Krix 

**Krix** (built for a single owner's personal use, not as a public service) is a production-grade Model Context Protocol (MCP) server that empowers AI agents with complete control over **GitHub Repositories**, **Render Cloud Infrastructure**, and an **Isolated Execution Sandbox** with persistent bash shells, language runtimes, and local Git CLI tools over a unified HTTP transport.

Engineered for **LLM token conservation**, **multi-tenant identity isolation**, and **zero-trust security**, Krix combines 80+ tools behind a lazy-loading architecture with payload compression, credential scrubbing, and automated memory cleanup.

---

## 🚀 Key Features & Innovations

### 1. Token-Efficient Toolset Categories
To conserve token budget, Krix starts with a lightweight default suite (**Core + Sandbox + File Sharing**). Larger categories are switched on per deployment with environment flags (there is no runtime `load_toolset` tool):

```bash
ENABLE_GITHUB_ISSUES_PRS=true   # Issues, PRs, Reviews, Comments
ENABLE_GITHUB_ADMIN=true        # Releases, Tags, Collaborators, Copilot
ENABLE_RENDER=true              # Render Cloud Services, Deploys, Logs, Postgres
ENABLE_ALL_TOOLS=true           # Everything
ENABLE_FILE_SHARING=false       # Turn the file-sharing tools off
```

### 2. Isolated Multi-Tenant Execution Sandbox
- **Identity-Scoped File System**: Sandboxes are isolated under `/tmp/krix_sbx_${authKey}/` where `authKey` is a SHA-256 hash of the caller's GitHub token. User data never leaks across sessions or accounts.
- **Persistent Shell State**: Keeps long-lived `bash` sessions per `(authKey, sessionId)` pair. `cd`, `export`, and venv activations persist between tool calls.
- **Race-Guarded Concurrency**: In-flight shell creation is promise-guarded to prevent concurrent requests from spawning orphan processes.
- **Safe Environment**: Automatically pins `HOME` to `/tmp/krix_home/` with pre-created cache directories, preventing `npm` and `pip` `ENOENT` failures in containerized environments.
- **Context-Aware Reset (`sandbox_reset`)**: Wipes scratch files, persistent shells, and background processes while safely preserving active Git context (`owner`, `repo`, `branch`).

### 2a. Files: `sandbox_files` (share / list / delete / download)
One tool moves files between the sandbox, the internet and you:

- `download` — fetch a file from an http(s) URL into the sandbox (private/internal addresses are refused, redirects are re-checked, DNS is pinned, size-capped by `DOWNLOAD_MAX_MB`). Plain `curl`/`wget` also work in the shell.
- `share` — upload a sandbox file (or small inline content) to **MongoDB GridFS** and get a private `downloadUrl` to hand to the user.
- `list` — your active shared files (id, name, size, expiry).
- `delete` — delete a shared file by `id` (or `all: true`), killing its link.

Every shared file is **auto-deleted after 48 hours** (`FILE_TTL_HOURS`, 1–48). Links are 256-bit random tokens (only the hash is stored), always served as attachments with `nosniff` + a sandboxing CSP, and HTML/SVG/JS never render. Setup: set `MONGODB_URI` (see `.env.example`). Downloads use TCP only — no ICMP/ping access is needed.

### 3. Surgical Code Editing & Structural Search
- **`str_replace_editor`**: Performs exact string block replacement. On match failure, it calculates **Levenshtein Distance Similarity** and returns a line-numbered context hint showing the closest matching code lines with similarity percentages. Supports Base64 (`old_str_b64`, `new_str_b64`).
- **`patch_contents`**: Enables direct line-range edits (`startLine` to `endLine`) without requiring string matching.
- **`get_file_contents`**: Line-windowed file reader (100 lines default, 500 max) with line number prefixes and a 100KB payload threshold.
- **`grep`**: High-performance pattern search with regex, file extension filtering (`type: "ts"`), path globs, context lines, and case sensitivity.
- **`view_file_outline`**: Extracts high-level AST symbol structures (classes, methods, functions, exports).

### 4. Security Model
- **OS-level sandbox isolation**: sandboxed code, git commands and sandbox file operations run as an unprivileged user (`SANDBOX_UID`/`SANDBOX_GID`; set by the provided `Dockerfile`). The server's secrets (`MCP_API_KEY`, GitHub/Render tokens, `MONGODB_URI`) are removed from every child environment, and the sandbox user cannot read `/proc/<server>/environ` or the server's code. In production the sandbox **fails closed** if isolation is not active (`SANDBOX_REQUIRE_ISOLATION`).
- **No shell injection**: git, install and run tools use argument vectors (never shell strings); branch / owner / repo / package names are validated; the persistent shell receives commands base64-encoded.
- **GitHub credentials are scoped**: passed to git only as an in-memory config entry limited to `https://github.com/`, never on a command line or in `.git/config`; remotes are explicit URLs and `url.*.insteadOf` rewrites in a tampered repo config are detected and refused.
- **Path safety**: `sanitizePath` uses real path-relative checks (no `/tmp` bypass, no prefix confusion), symlink escapes are rejected, and `cwd`/`env` set via `set_active_context` are validated (loader/shell hooks like `LD_PRELOAD`, `BASH_ENV` are blocked).
- **HTTP hardening**: constant-time API-key comparison, authentication *before* body parsing, failed-auth lockout, global + per-route rate limits, session cap and identity binding, security headers, request/body timeouts, generic error messages, graceful shutdown. The server refuses to start without `MCP_API_KEY`.
- **Output scrubbing**: configured secrets (exact values), runtime tokens, GitHub/Render/Mongo/Bearer/Basic credentials and private keys are redacted from all tool output and logs.
- **Honest tool annotations**: only genuinely destructive or code-executing tools carry `destructiveHint`; additive tools (create branch/issue/PR, …) do not. Hints are advisory — all enforcement is server-side.
- **Guardrails (not a boundary)**: `COMMAND_RESTRICTION_LEVEL` / `NETWORK_RESTRICTION_LEVEL` pattern checks catch accidents and obvious SSRF targets, but string matching cannot stop a determined user. For hard egress control use container/network policy.
- **ReDoS Defense**: VM-sandboxed regular expression execution (`safeRegexTest`) with a 200ms hard timeout.
- **Automatic Lifecycle Sweeps**: 10-min idle session teardown, 15-min output cache TTL, 10-min process table TTL (200KB output cap per process), 48h file expiry.

**Known limits**: all sandbox users share one OS uid, so treat everyone holding the same `MCP_API_KEY` as one trust domain. `?api_key=` URL authentication stays enabled by default for client compatibility — set `ALLOW_QUERY_API_KEY=false` once your client can send headers.

---

## 🛠️ Tool Categories & Matrix

### Core Agentic Tools (`core` — Always Enabled)
| Tool Name | Type | Description |
| :--- | :--- | :--- |
| `set_active_context` | `READ_ONLY` | Sets default `owner`, `repo`, and `branch`. Persists across session resets per auth key. |
| `get_me` | `READ_ONLY` | Retrieves authenticated GitHub user profile information. |
| `get_file_contents` | `READ_ONLY` | Reads windowed line ranges of a file (100 default, 500 max lines). |
| `str_replace_editor` | `MUTATING` | Surgically replaces code blocks with Levenshtein similarity context feedback on match errors. |
| `patch_contents` | `MUTATING` | Replaces specified line ranges directly by 1-indexed line numbers. |
| `create_or_update_file` | `MUTATING` | Creates or updates files via plain text or Base64 (`content_b64`). |
| `delete_file` | `MUTATING` | Deletes a file from a repository branch. |
| `grep` | `READ_ONLY` | Pattern search supporting regex, file extension filters, globs, and context windowing. |
| `view_file_outline` | `READ_ONLY` | Extracts high-level AST symbol outlines (classes, functions, exports). |
| `git_tree` | `READ_ONLY` | Recursively indexes file tree structures with `tree_sha`, `offset`, `limit`, and path search `q`. |
| `list_branches` | `READ_ONLY` | Lists branches in the active repository. |
| `create_branch` | `MUTATING` | Creates a new branch from a specified ref/commit SHA. |
| `delete_branch` | `MUTATING` | Deletes a branch from the repository. |
| `push_files` | `MUTATING` | Batch commits and pushes multiple files in a single operation. |
| `create_pull_request` | `MUTATING` | Opens a new pull request between head and base branches. |
| `search_code` | `READ_ONLY` | Searches code across GitHub repositories. |
| `search_repositories` | `READ_ONLY` | Searches GitHub repositories (`exact: true` returns single best match). |
| `sandbox_status` | `READ_ONLY` | Inspects sandbox memory, runtimes (Node, Python, Go, Git), active repo/branch, and shell state. |

---

### Execution Sandbox & Local Git (`sandbox` — Enabled by Default)
| Tool Name | Type | Description |
| :--- | :--- | :--- |
| `sandbox_exec` | `MUTATING` | Executes shell commands in a persistent bash shell or isolated process with backgrounding support (`background: true`). |
| `sandbox_run` | `MUTATING` | Runs inline code snippets across supported runtimes (`py`, `js`, `ts`, `sh`, `go`, `java`, `cpp`, `c`, `rs`, `rb`, `php`). |
| `sandbox_install` | `MUTATING` | Installs dependencies via `npm` or `pip` targeting isolated sandbox directories. |
| `sandbox_ps` | `READ_ONLY` | Lists, inspects output, or terminates background processes. |
| `sandbox_output` | `READ_ONLY` | Reads paginated stdout/stderr for truncated shell execution results. |
| `sandbox_reset` | `MUTATING` | Cleans scratch files, kills persistent shells and background jobs while preserving active Git context. |
| `git_clone` | `MUTATING` | Clones a repository into the sandbox working directory. |
| `git_checkout` | `MUTATING` | Switches or creates local branches in the cloned repository. |
| `git_pull` | `MUTATING` | Performs fast-forward pull on the active sandbox branch. |
| `git_status` | `READ_ONLY` | Inspects working tree status and untracked files in the sandbox. |
| `git_diff` | `READ_ONLY` | Generates staged or unstaged git diff output. |
| `git_commit_push` | `MUTATING` | Stages, commits, and pushes changes from the sandbox repository. |

---

### Files (`files` — Enabled by Default, sharing needs `MONGODB_URI`)
| Tool Name | Type | Description |
| :--- | :--- | :--- |
| `sandbox_files` | `MUTATING` | `action: share \| list \| delete \| download` — share sandbox files via a private 48h link (MongoDB), list/delete your shared files, or download a URL into the sandbox. |

---

### GitHub Issues & Pull Requests (`github_issues_prs` — Lazy Loaded)
Enable via `ENABLE_GITHUB_ISSUES_PRS=true`:

| Tool Name | Type | Description |
| :--- | :--- | :--- |
| `list_issues` | `READ_ONLY` | Lists repository issues filtered by state, labels, assignee, or creator. |
| `issue_read` | `READ_ONLY` | Reads detailed issue title, body, comments, and state. |
| `issue_write` | `MUTATING` | Creates a new issue or updates an existing issue. |
| `sub_issue_write` | `MUTATING` | Attaches a sub-issue to a parent issue. |
| `add_issue_comment` | `MUTATING` | Adds a comment to an issue or pull request. |
| `list_pull_requests` | `READ_ONLY` | Lists pull requests filtered by state, head, base, or branch. |
| `pull_request_read` | `READ_ONLY` | Fetches pull request mergeability status and details. |
| `update_pull_request` | `MUTATING` | Updates PR title, body, or state (`open`/`closed`). |
| `update_pull_request_branch` | `MUTATING` | Merges base branch updates into the PR head branch. |
| `merge_pull_request` | `MUTATING` | Merges a pull request into its base branch. |
| `pull_request_review_write` | `MUTATING` | Submits a PR review (`APPROVE`, `REQUEST_CHANGES`, `COMMENT`). |
| `add_comment_to_pending_review` | `MUTATING` | Adds a line-specific diff comment to a pending review. |
| `add_reply_to_pull_request_comment` | `MUTATING` | Replies to an existing review comment thread. |
| `search_issues` | `READ_ONLY` | Searches issues across GitHub repositories. |
| `search_pull_requests` | `READ_ONLY` | Searches pull requests across GitHub repositories. |

---

### GitHub Extended & Admin (`github_admin` — Lazy Loaded)
Enable via `ENABLE_GITHUB_ADMIN=true`:

| Tool Name | Type | Description |
| :--- | :--- | :--- |
| `get_commit` | `READ_ONLY` | Retrieves commit details by SHA. |
| `search_commits` | `READ_ONLY` | Searches commit messages across GitHub. |
| `get_label` | `READ_ONLY` | Fetches details for an issue label. |
| `get_release` | `READ_ONLY` | Fetches release details by tag or published release. |
| `get_tag` | `READ_ONLY` | Fetches git tag object details by SHA. |
| `get_teams` | `READ_ONLY` | Lists teams in an organization. |
| `get_team_members` | `READ_ONLY` | Lists members of an organization team. |
| `list_commits` | `READ_ONLY` | Lists commits filtered by author, path, or date range. |
| `list_releases` | `READ_ONLY` | Lists published releases for a repository. |
| `list_tags` | `READ_ONLY` | Lists repository git tags. |
| `list_issue_fields` | `READ_ONLY` | Lists repository issue labels and custom fields. |
| `list_issue_types` | `READ_ONLY` | Lists organization issue types (`Bug`, `Feature`, `Task`). |
| `list_repository_collaborators` | `READ_ONLY` | Lists collaborators and their permission levels. |
| `search_users` | `READ_ONLY` | Searches GitHub users by query. |
| `create_repository` | `MUTATING` | Creates a new GitHub repository. |
| `fork_repository` | `MUTATING` | Forks a repository to the authenticated account. |
| `run_secret_scanning` | `READ_ONLY` | Runs secret scanning alert checks on a repository. |
| `request_copilot_review` | `MUTATING` | Requests an automated GitHub Copilot PR review. |
| `assign_copilot_to_issue` | `MUTATING` | Assigns GitHub Copilot coding agent to solve an issue. |

---

### Render Cloud API (`render` — Lazy Loaded)
Enable via `ENABLE_RENDER=true`:

| Tool Name | Type | Description |
| :--- | :--- | :--- |
| `list_workspaces` | `READ_ONLY` | Lists available Render workspace accounts. |
| `select_workspace` | `MUTATING` | Sets active Render workspace target for the session. |
| `get_selected_workspace` | `READ_ONLY` | Displays currently selected Render workspace ID. |
| `list_services` | `READ_ONLY` | Lists deployed services (web, static sites, background workers, cron). |
| `get_service` | `READ_ONLY` | Fetches details and status for a service. |
| `create_web_service` | `MUTATING` | Provisions a new Render web service from a GitHub repository. |
| `create_static_site` | `MUTATING` | Provisions a new Render static site. |
| `create_cron_job` | `MUTATING` | Provisions a scheduled cron job service. |
| `restart_service` | `MUTATING` | Triggers service restart or clear-cache restart. |
| `delete_service` | `MUTATING` | Deletes a Render service instance. |
| `list_deploys` | `READ_ONLY` | Lists recent deployment history for a service. |
| `get_deploy` | `READ_ONLY` | Fetches deployment status, build logs, and commit info. |
| `trigger_deploy` | `MUTATING` | Triggers a new manual deploy. |
| `cancel_deploy` | `MUTATING` | Cancels an in-progress deployment. |
| `list_logs` | `READ_ONLY` | Retrieves runtime application logs with server-side filtering (`level`, `text`, `startTime`/`endTime`). |
| `list_log_label_values` | `READ_ONLY` | Lists streaming log label values. |
| `get_metrics` | `READ_ONLY` | Fetches CPU, memory, and bandwidth utilization metrics. |
| `list_env_vars` | `READ_ONLY` | Lists environment variables for a service. |
| `update_env_vars` | `MUTATING` | Sets or updates key-value environment variables. |
| `delete_env_var` | `MUTATING` | Removes an environment variable from a service. |
| `query_render_postgres` | `READ_ONLY` | Inspects status and database details for Render Managed Postgres. |

---

## ⚙️ Configuration & Environment

Create a `.env` file in the root directory:

```env
# Server Authentication Key (REQUIRED - the server will not start without it). openssl rand -hex 32
MCP_API_KEY=your_mcp_secret_key_here

# File sharing (MongoDB GridFS). Files auto-delete after FILE_TTL_HOURS (1-48, default 48)
MONGODB_URI=mongodb+srv://user:password@cluster.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB=krix
FILE_TTL_HOURS=48
PUBLIC_BASE_URL=https://your-krix-host.example.com

# Default GitHub Access Token (Fallback if x-github-token header omitted)
GITHUB_PERSONAL_ACCESS_TOKEN=ghp_your_github_token_here

# Default Render API Key (Fallback if x-render-token header omitted)
RENDER_API_KEY=rnd_your_render_api_key_here

# Enable All Tools by Default (Optional: set to 'true' to disable lazy loading)
ENABLE_ALL_TOOLS=false

# Category-specific Tool Flags (Disabled by default, set to 'true' to enable)
ENABLE_GITHUB_ISSUES_PRS=false
ENABLE_GITHUB_ADMIN=false
ENABLE_RENDER=false

# Sandbox & Local Git Tools Flag (Enabled by default, set to 'false' to disable)
ENABLE_SANDBOX=true

# Security Restriction Levels: low | medium | high (default: low)
COMMAND_RESTRICTION_LEVEL=low
NETWORK_RESTRICTION_LEVEL=low

# Auth Context Persistence TTL in ms (default: 3600000 / 1h)
AUTH_CONTEXT_TTL_MS=3600000

# HTTP Server Port
PORT=3000
```

### System Runtimes (Sandbox)
The Execution Sandbox utilizes installed system binaries on the host system or Docker container:

| Language | Binary | Ubuntu / Debian Package |
| :--- | :--- | :--- |
| Git ops | `git` | `git` |
| Node.js / TS | `node`, `npx` | `nodejs` |
| Python | `python3` | `python3`, `python3-pip` |
| Go | `go` | `golang-go` |
| Java | `java`, `javac` | `default-jdk-headless` |
| C / C++ | `gcc`, `g++` | `g++` |

The included **single-stage `Dockerfile`** installs all runtimes in one build layer, ensuring no missing OS dependencies when deploying to cloud platforms such as Render.

---

## 📦 Getting Started

### 1. Installation
```bash
# Clone repository
git clone https://github.com/imanki-t/Krix.git
cd Krix

# Install dependencies
npm install
```

### 2. Build & Run
```bash
# Build TypeScript
npm run build

# Start production server (default port 3000)
npm start

# Run development mode with hot reload
npm run dev
```

---

## 🔌 MCP Client Integration

### Streamable HTTP Endpoint (`/mcp`)
Connect MCP clients (Antigravity, Claude Desktop, Cursor, or Custom SDKs) via Streamable HTTP:

```json
{
  "mcpServers": {
    "krix": {
      "url": "http://localhost:3000/mcp",
      "headers": {
        "x-api-key": "your_mcp_secret_key_here",
        "x-github-token": "ghp_your_personal_github_token",
        "x-render-token": "rnd_your_render_api_key"
      }
    }
  }
}
```

---

## 🧠 Krix MCP Skill for AI Agents

The repository includes a complete agentic workflow skill in [`skills/krix-mcp/SKILL.md`](skills/krix-mcp/SKILL.md) and detailed reference documentation under [`skills/krix-mcp/references/`](skills/krix-mcp/references/):

- [`agentic-tools-guide.md`](skills/krix-mcp/references/agentic-tools-guide.md): 17 Agentic Remote GitHub tools
- [`sandbox-tools-guide.md`](skills/krix-mcp/references/sandbox-tools-guide.md): 14 Sandbox execution and local Git CLI tools
- [`workflows-and-best-practices.md`](skills/krix-mcp/references/workflows-and-best-practices.md): Multi-tool workflow patterns and safety directives
- [`render-tools-guide.md`](skills/krix-mcp/references/render-tools-guide.md): 21 Render cloud infrastructure tools
- [`github-extended-tools-guide.md`](skills/krix-mcp/references/github-extended-tools-guide.md): 32 Extended GitHub tools (Issues, PRs, Reviews, Teams, Admin)

AI agents can import this skill to automatically direct and coordinate agentic coding, GitHub operations, surgical edits, sandbox execution, and Render cloud management using Krix MCP tools.

---

## 🏗️ System Architecture Overview

```
                         ┌─────────────────────────────────────────┐
                         │               MCP Client                │
                         │   (Antigravity / Claude / Cursor)       │
                         └───────────────────┬─────────────────────┘
                                             │ HTTP POST /mcp
                                             ▼
                         ┌─────────────────────────────────────────┐
                         │             Krix MCP Server             │
                         │          (Express / SDK @ :3000)        │
                         └─────┬─────────────────┬───────────┬─────┘
                               │                 │           │
            ┌──────────────────▼──┐   ┌──────────▼─────┐  ┌──▼──────────────────┐
            │ Core + Sandbox Tools│   │ Security Layer │  │ Dynamic Toolset     │
            │ (Enabled by Default)│   │ & Trimmers     │  │ Categories          │
            └─────────────────────┘   └────────────────┘  └─────────────────────┘
                                                              │ ENABLE_* flags
                                        ┌─────────────────────┼─────────────────────┐
                                        ▼                     ▼                     ▼
                               ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
                               │github_issues_prs│   │     render      │   │   github_admin  │
                               │   Workflows     │   │   Management    │   │  Extended Ops   │
                               └─────────────────┘   └─────────────────┘   └─────────────────┘
```

---

## 📄 License

MIT License © [imanki-t](https://github.com/imanki-t)
