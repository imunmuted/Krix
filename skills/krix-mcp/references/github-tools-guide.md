# Krix MCP GitHub Tools Guide (Core & Agentic Operations)

This reference guide provides comprehensive documentation for the **17 Core Agentic GitHub Tools** in Krix MCP. These tools execute directly against GitHub repositories, enabling context establishment, repository navigation, AST symbol extraction, high-performance regex searching, surgical code replacements, atomic multi-file commits, and branch/PR workflows.

---

## Tool Index

1. [`set_active_context`](#1-set_active_context)
2. [`get_me`](#2-get_me)
3. [`search_repositories`](#3-search_repositories)
4. [`list_branches`](#4-list_branches)
5. [`create_branch`](#5-create_branch)
6. [`delete_branch`](#6-delete_branch)
7. [`git_tree`](#7-git_tree)
8. [`view_file_outline`](#8-view_file_outline)
9. [`grep`](#9-grep)
10. [`search_code`](#10-search_code)
11. [`get_file_contents`](#11-get_file_contents)
12. [`str_replace_editor`](#12-str_replace_editor)
13. [`patch_contents`](#13-patch_contents)
14. [`create_or_update_file`](#14-create_or_update_file)
15. [`delete_file`](#15-delete_file)
16. [`push_files`](#16-push_files)
17. [`create_pull_request`](#17-create_pull_request)

---

## 1. `set_active_context`

### Purpose & Overview
Sets session-level default configuration for repository metadata (`owner`, `repo`, `branch`) and local sandbox configuration (`cwd`, `env`). Subsequent tool calls automatically inherit these context parameters without requiring explicit arguments every time.

### Schema & Parameters
- `owner` (string, optional): Default repository owner (username or org).
- `repo` (string, optional): Default repository name.
- `branch` (string, optional): Default target branch (e.g. `main`, `dev`, `feature/xyz`).
- `cwd` (string, optional): Default working directory path for sandbox execution.
- `env` (object, optional): Persistent environment variables merged into sandbox execution sessions.

### Usage Example
```json
{
  "owner": "octocat",
  "repo": "hello-world",
  "branch": "main",
  "cwd": "hello-world",
  "env": {
    "NODE_ENV": "development"
  }
}
```

### Best Practices & Rules
- Call `set_active_context` as the very first step when starting work on a repository.
- Avoid repeating `owner` and `repo` in subsequent tool calls once the context is established.

---

## 2. `get_me`

### Purpose & Overview
Retrieves authenticated GitHub user profile metadata (username, ID, avatar, scopes, name).

### Schema & Parameters
- Takes no parameters (`{}`).

### Usage Example
```json
{}
```

---

## 3. `search_repositories`

### Purpose & Overview
Searches GitHub repositories for the authenticated user or organization with regex filtering, exact match ranking, and pagination.

### Schema & Parameters
- `query` (string, required): Repository search query or keyword.
- `owner` (string, optional): Filter repositories by specific user or org.
- `page` (number, optional, default: 1): Page number.
- `perPage` (number, optional, default: 10): Results per page (max 100).
- `exact` (boolean, optional, default: false): When true, returns only the single exact match.
- `regexFilter` (string, optional): Regex pattern to filter repository names.

### Usage Example
```json
{
  "query": "krix",
  "exact": true
}
```

---

## 4. `list_branches`

### Purpose & Overview
Lists branches in the active or specified repository.

### Schema & Parameters
- `owner` (string, optional): Repository owner (falls back to active context).
- `repo` (string, optional): Repository name (falls back to active context).

### Usage Example
```json
{}
```

---

## 5. `create_branch`

### Purpose & Overview
Creates a new remote branch in the repository pointing to a specified commit SHA or base branch ref.

### Schema & Parameters
- `branch` (string, required): Name of the new branch to create.
- `fromBranch` (string, optional): Source branch to branch from (e.g. `main`).
- `refSha` (string, optional): Specific commit SHA to point the branch to.
- `owner` (string, optional): Repository owner.
- `repo` (string, optional): Repository name.

### Usage Example
```json
{
  "branch": "feature/fix-auth",
  "fromBranch": "main"
}
```

---

## 6. `delete_branch`

### Purpose & Overview
Deletes a remote branch from the repository.

### Schema & Parameters
- `branch` (string, required): Branch name to delete.
- `owner` (string, optional): Repository owner.
- `repo` (string, optional): Repository name.

### Usage Example
```json
{
  "branch": "feature/fix-auth"
}
```

---

## 7. `git_tree`

### Purpose & Overview
Recursively inspects the file tree of a repository commit or branch. Supports path substring filtering (`q`), depth offsets, and limit windowing for token efficiency.

### Schema & Parameters
- `path` (string, optional): Target sub-path or prefix directory.
- `recursive` (boolean, optional, default: true): Whether to recursively traverse directory subtrees.
- `tree_sha` (string, optional): Tree SHA or branch name (defaults to active branch).
- `offset` (number, optional, default: 0): Index offset for paginating large trees.
- `limit` (number, optional, default: 200): Maximum entries to return.
- `q` (string, optional): Substring filter for file paths.
- `owner` (string, optional): Repository owner.
- `repo` (string, optional): Repository name.
- `branch` (string, optional): Branch name.

### Usage Example
```json
{
  "recursive": true,
  "q": "src/",
  "limit": 50
}
```

---

## 8. `view_file_outline`

### Purpose & Overview
Extracts high-level AST symbol structures (classes, interfaces, functions, methods, exported constants) from source files (TypeScript, JavaScript, Python, Go, Java, Rust, C/C++). Allows understanding file architecture without reading hundreds of lines of code.

### Schema & Parameters
- `path` (string, required): Repository-relative path to the source file.
- `owner` (string, optional): Repository owner.
- `repo` (string, optional): Repository name.
- `branch` (string, optional): Branch name.

### Usage Example
```json
{
  "path": "src/security.ts"
}
```

---

## 9. `grep`

### Purpose & Overview
High-performance regex/substring pattern search across repository files. Supports file extension filtering, path globs, context lines (`before`/`after`), case sensitivity, and result windowing.

### Schema & Parameters
- `pattern` (string, required): Regex or substring pattern to search for.
- `path` (string, optional): Directory sub-path to restrict the search.
- `glob` (string, optional): Glob pattern (e.g. `**/*.tsx`).
- `type` (string, optional): File extension filter (e.g. `ts`, `py`, `json`).
- `ignoreCase` (boolean, optional, default: true): Case insensitive search.
- `maxResults` (number, optional, default: 30): Max search results.
- `context` (number, optional, default: 2): Lines of context before and after each match.
- `owner` (string, optional): Repository owner.
- `repo` (string, optional): Repository name.
- `branch` (string, optional): Branch name.

### Usage Example
```json
{
  "pattern": "sandbox_store",
  "type": "ts",
  "context": 3
}
```

---

## 10. `search_code`

### Purpose & Overview
Searches code across GitHub repositories using GitHub's native code search syntax.

### Schema & Parameters
- `query` (string, required): GitHub code search query string.
- `owner` (string, optional): Repository owner.
- `repo` (string, optional): Repository name.
- `page` (number, optional, default: 1): Results page.
- `perPage` (number, optional, default: 10): Results per page (max 100).

### Usage Example
```json
{
  "query": "registerTool filename:sandboxTools.ts"
}
```

---

## 11. `get_file_contents`

### Purpose & Overview
Fetches remote file contents with line-number prefixes. Supports token-efficient windowing (`startLine` to `endLine`) to inspect specific functions or sections without consuming context on entire files.

### Schema & Parameters
- `path` (string, required): Repository-relative path to the file.
- `startLine` (number, optional, default: 1): 1-indexed starting line number.
- `endLine` (number, optional): 1-indexed ending line number (max 500 lines per call).
- `owner` (string, optional): Repository owner.
- `repo` (string, optional): Repository name.
- `branch` (string, optional): Branch name.

### Usage Example
```json
{
  "path": "src/security.ts",
  "startLine": 160,
  "endLine": 200
}
```

### Best Practices & Rules
- Always provide `startLine` and `endLine` when reading large files.
- Prefixes lines with `<line>: ` for easy referencing when preparing surgical replacements.

---

## 12. `str_replace_editor`

### Purpose & Overview
Performs exact string block replacement in a remote file and commits the change. If the `old_str` does not match, it calculates **Levenshtein Distance Similarity** and returns line-numbered context hints showing the closest matching lines with similarity percentages. Supports Base64 for binary or tricky character sequences.

### Schema & Parameters
- `path` (string, required): Repository-relative path to the file.
- `old_str` (string, optional): Exact string chunk to find and replace.
- `new_str` (string, optional): Replacement string chunk.
- `old_str_b64` (string, optional): Base64-encoded `old_str`.
- `new_str_b64` (string, optional): Base64-encoded `new_str`.
- `message` (string, optional): Git commit message.
- `owner` (string, optional): Repository owner.
- `repo` (string, optional): Repository name.
- `branch` (string, optional): Target branch.

### Usage Example
```json
{
  "path": "src/fileShare.ts",
  "old_str": "reg('sandbox_files', {",
  "new_str": "reg('sandbox_store', {",
  "message": "refactor: rename sandbox_files tool to sandbox_store"
}
```

### Best Practices & Rules
- Include 2-3 unique lines of surrounding context inside `old_str` to guarantee a unique match.
- Use `old_str_b64` and `new_str_b64` when dealing with multi-line blocks containing tricky escaping or special characters.

---

## 13. `patch_contents`

### Purpose & Overview
Replaces a specific 1-indexed line number range (`startLine` to `endLine`) with new content in a remote file and commits the changes. Eliminates string-matching fragility for dense refactors.

### Schema & Parameters
- `path` (string, required): Repository-relative path to the file.
- `startLine` (number, required): 1-indexed start line (inclusive).
- `endLine` (number, required): 1-indexed end line (inclusive).
- `newContent` (string, required): New text content to insert in place of the line range.
- `message` (string, optional): Git commit message.
- `owner` (string, optional): Repository owner.
- `repo` (string, optional): Repository name.
- `branch` (string, optional): Target branch.

### Usage Example
```json
{
  "path": "src/security.ts",
  "startLine": 170,
  "endLine": 170,
  "newContent": "  'sandbox_store': PermissionLevel.MUTATING,",
  "message": "fix: update sandbox_store permission level"
}
```

---

## 14. `create_or_update_file`

### Purpose & Overview
Creates a new file or completely replaces the content of an existing file in the remote repository. Supports plain UTF-8 text or Base64 encoding.

### Schema & Parameters
- `path` (string, required): File path in repository.
- `content` (string, optional): UTF-8 text content.
- `content_b64` (string, optional): Base64-encoded file content (for binaries, images, or large files).
- `message` (string, optional): Git commit message.
- `sha` (string, optional): Blob SHA of existing file (required if updating an existing file to guard against race conditions).
- `branch` (string, optional): Target branch.
- `owner` (string, optional): Repository owner.
- `repo` (string, optional): Repository name.

### Usage Example
```json
{
  "path": "docs/architecture.md",
  "content": "# Architecture Overview\n...",
  "message": "docs: add initial architecture document"
}
```

---

## 15. `delete_file`

### Purpose & Overview
Deletes a file from the remote repository branch.

### Schema & Parameters
- `path` (string, required): File path to delete.
- `message` (string, optional): Git commit message.
- `sha` (string, optional): Blob SHA of the file to verify prior state.
- `branch` (string, optional): Target branch.
- `owner` (string, optional): Repository owner.
- `repo` (string, optional): Repository name.

### Usage Example
```json
{
  "path": "legacy-config.json",
  "message": "chore: remove deprecated legacy configuration"
}
```

---

## 16. `push_files`

### Purpose & Overview
Commits and pushes multiple file modifications, creations, and deletions in a single atomic commit. Ensures multi-file refactors do not break the repository between commits.

### Schema & Parameters
- `files` (array of objects, required): List of file operations:
  - `path` (string, required): File path.
  - `content` (string, optional): Plain UTF-8 text content.
  - `content_b64` (string, optional): Base64 file content.
  - `delete` (boolean, optional): Set to `true` to delete the file.
- `message` (string, required): Git commit message for the batch commit.
- `branch` (string, optional): Target branch.
- `owner` (string, optional): Repository owner.
- `repo` (string, optional): Repository name.

### Usage Example
```json
{
  "message": "refactor: update sandbox store tool definitions and types",
  "files": [
    {
      "path": "src/fileShare.ts",
      "content": "..."
    },
    {
      "path": "src/security.ts",
      "content": "..."
    }
  ]
}
```

### Best Practices & Rules
- Always use `push_files` when updating multiple dependent files simultaneously (e.g. updating an interface and its implementation).

---

## 17. `create_pull_request`

### Purpose & Overview
Opens a new GitHub Pull Request between a head branch and base branch.

### Schema & Parameters
- `title` (string, required): Pull Request title.
- `head` (string, required): Name of branch containing changes.
- `base` (string, optional, default: `main`): Branch to merge into.
- `body` (string, optional): Pull Request description (Markdown).
- `draft` (boolean, optional, default: false): Create as draft PR.
- `owner` (string, optional): Repository owner.
- `repo` (string, optional): Repository name.

### Usage Example
```json
{
  "title": "feat: rename sandbox_files to sandbox_store and overhaul documentation",
  "head": "gem",
  "base": "main",
  "body": "## Summary\n- Renamed `sandbox_files` to `sandbox_store` to resolve naming ambiguity with `sandbox_file`.\n- Refactored skill directory, references, and README."
}
```
