---
name: krix-mcp
description: Unified Model Context Protocol (MCP) gateway skill for agentic coding, repository navigation, AST structural inspection, surgical code editing, isolated sandbox execution, cloud infrastructure management on Render, and GitHub MCP integrations. Activate whenever performing coding, software engineering, repository operations, debugging, reviewing PRs, executing commands in sandbox, managing Render cloud services, or sharing artifacts.
---

# Krix MCP Skill

A comprehensive workflow guide for agentic coding, repository navigation, high-performance surgical code editing, isolated containerized execution, cloud infrastructure automation on Render, and GitHub MCP integrations using the Krix MCP server.

---

## Summary & Core Purpose

Krix MCP is a unified, high-efficiency Model Context Protocol gateway built specifically for autonomous agentic software engineering. It combines:
1. **Core Agentic GitHub Operations**: Repository tree indexing, AST symbol outline extraction, high-performance regex search, surgical string replacement with similarity hints, line-range patching, and atomic multi-file commits.
2. **Render Cloud Infrastructure**: Complete automation of web services, static sites, scheduled cron jobs, deployments, application logs, metrics, and PostgreSQL databases.
3. **Execution Sandbox, Local Git & Sandbox Store**: An isolated multi-tenant execution environment featuring persistent bash shells, 11 language runtimes, package installation, background process tracking, local Git CLI operations, and **Sandbox Store** for 48-hour cloud file sharing and web downloads.
4. **GitHub MCP Integration**: Standard GitHub MCP tools for managing Issues, Pull Requests, reviews, comments, branches, tags, releases, teams, secret scanning, and Copilot assignments.

---

## Mandatory Activation Triggers

MANDATORY DIRECTIVE: Activate and follow this skill automatically whenever the user mentions terms or requests actions including:

- **Direct File Manipulation & Refactoring**: "edit that file", "fix this file", "patch this code", "update the file", "refactor this function/class".
- **Code Review & Audits**: "give a review", "review this PR", "review my code", "check for bugs", "audit repository".
- **General Software Engineering**: Writing code, debugging runtime errors, running test suites, executing build commands, installing dependencies.
- **GitHub & Repository Management**: Managing branches, creating PRs, merging PRs, managing issues, inspecting git diffs, cloning repositories, inspecting git commit history.
- **Cloud Infrastructure & Deployments**: Deploying to Render, managing web services/static sites, restarting services, inspecting deployment logs, querying Render PostgreSQL.
- **File Sharing & Artifact Downloads**: Sharing sandbox output files with the user, downloading assets from URLs into the sandbox workspace.

---

## ⚠️ Important Distinction: `sandbox_file` vs `sandbox_store`

To prevent any confusion between similarly named tools:

- **`sandbox_file`** (**Local Filesystem Operations**): Performs safe, binary-proof file operations (`read`, `write`, `append`, `edit`, `delete`) on files inside the local sandbox container. Use this to read or modify source files in the sandbox workspace without risking shell escaping or quoting bugs.
- **`sandbox_store`** (**Cloud File Sharing & Web Downloads**): Moves files between the sandbox, the web, and the user via actions `share`, `list`, `delete`, and `download`. Use `share` to upload files to MongoDB GridFS and get a private 48-hour expiring download URL to hand to the user, and `download` to fetch external files from HTTP/HTTPS URLs into the sandbox.

---

## Tool Categories Overview (87 Tools Total)

The Krix MCP server provides 87 specialized tools categorized across 4 operational domains:

```
┌────────────────────────────────────────────────────────────────────────┐
│                               Krix MCP                                 │
└───────┬─────────────────┬────────────────────┬──────────────────┬──────┘
        │                 │                    │                  │
        ▼                 ▼                    ▼                  ▼
┌───────────────┐ ┌───────────────┐  ┌───────────────────┐  ┌────────────────┐
│  Core GitHub  │ │  Render Cloud │  │ Execution Sandbox │  │   GitHub MCP   │
│  (17 Tools)   │ │  (21 Tools)   │  │    & Store (15)   │  │ Extended (34)  │
└───────────────┘ └───────────────┘  └───────────────────┘  └────────────────┘
```

### 1. Core Agentic GitHub Tools (17 Tools)
Operate directly against remote GitHub repositories for high-performance discovery, AST extraction, surgical editing, and atomic commits:
- **Context & Identity**: `set_active_context`, `get_me`
- **Discovery & Navigation**: `search_repositories`, `list_branches`, `create_branch`, `delete_branch`, `git_tree`, `view_file_outline`, `grep`, `search_code`, `get_file_contents`
- **Surgical Editing & PRs**: `str_replace_editor`, `patch_contents`, `create_or_update_file`, `delete_file`, `push_files`, `create_pull_request`

### 2. Render Cloud Infrastructure Tools (21 Tools)
Manage full cloud lifecycle on Render:
- **Workspaces**: `list_workspaces`, `select_workspace`, `get_selected_workspace`
- **Services & Deploys**: `list_services`, `get_service`, `create_web_service`, `create_static_site`, `create_cron_job`, `restart_service`, `delete_service`, `list_deploys`, `get_deploy`, `trigger_deploy`, `cancel_deploy`
- **Observability & Databases**: `list_logs`, `list_log_label_values`, `get_metrics`, `list_env_vars`, `update_env_vars`, `delete_env_var`, `query_render_postgres`

### 3. Execution Sandbox, Local Git & Sandbox Store (15 Tools)
Containerized execution environment with persistent shells, 11 runtimes, local Git CLI, and artifact sharing:
- **Execution & Process Management**: `sandbox_status`, `sandbox_run`, `sandbox_exec`, `sandbox_install`, `sandbox_ps`, `sandbox_output`, `sandbox_file`, `sandbox_reset`
- **Sandbox Store (Sharing & Downloads)**: `sandbox_store` (`share`, `list`, `delete`, `download`)
- **Local Git Synchronization**: `git_clone`, `git_checkout`, `git_pull`, `git_status`, `git_diff`, `git_commit_push`

### 4. Extended GitHub MCP Tools (34 Tools)
Conform to standard GitHub MCP conventions for issue management, PR reviews, releases, and Copilot workflows:
- **Issues**: `list_issues`, `issue_read`, `issue_write`, `sub_issue_write`, `add_issue_comment`, `search_issues`
- **Pull Requests & Reviews**: `list_pull_requests`, `pull_request_read`, `update_pull_request`, `update_pull_request_branch`, `merge_pull_request`, `pull_request_review_write`, `add_comment_to_pending_review`, `add_reply_to_pull_request_comment`, `search_pull_requests`
- **Git Metadata & Releases**: `get_commit`, `search_commits`, `list_commits`, `get_label`, `list_issue_fields`, `list_issue_types`, `get_release`, `list_releases`, `get_tag`, `list_tags`
- **Teams, Security & Copilot**: `get_teams`, `get_team_members`, `list_repository_collaborators`, `search_users`, `create_repository`, `fork_repository`, `run_secret_scanning`, `request_copilot_review`, `assign_copilot_to_issue`

---

## 📚 Detailed Reference Guides (3 References + 1 Additional GitHub MCP Reference)

Exhaustive documentation, full input/output schemas, and usage examples are organized into 4 dedicated reference guides:

1. **Core GitHub Tools Reference**:
   - File: [`skills/krix-mcp/references/github-tools-guide.md`](references/github-tools-guide.md)
   - Scope: Complete parameter schemas and examples for all 17 Core Agentic GitHub tools (AST outline, grep, surgical replacement, line patching, atomic commits).

2. **Render Cloud Infrastructure Reference**:
   - File: [`skills/krix-mcp/references/render-tools-guide.md`](references/render-tools-guide.md)
   - Scope: Complete parameter schemas and examples for all 21 Render cloud management tools (workspaces, services, deploys, logs, metrics, postgres).

3. **Sandbox Tools & Sandbox Store Reference**:
   - File: [`skills/krix-mcp/references/sandbox-tools-guide.md`](references/sandbox-tools-guide.md)
   - Scope: Complete parameter schemas and examples for all 15 Sandbox tools, persistent bash shell behavior, 11 runtimes, `sandbox_file` vs `sandbox_store`, outbound network capabilities, and local Git CLI tools.

4. **Additional GitHub MCP Tools Reference**:
   - File: [`skills/krix-mcp/references/github-mcp-tools-guide.md`](references/github-mcp-tools-guide.md)
   - Scope: Complete parameter schemas and examples for all 34 Extended GitHub MCP tools (Issues, PRs, line-level code reviews, branches, releases, tags, collaborators, secret scanning, and Copilot).

---

## Core Execution Directives & Best Practices

1. **Context Anchor**: Execute `set_active_context` at the start of every session to establish default `owner`, `repo`, `branch`, and sandbox working directory.
2. **Surgical Precision**: Always prefer `str_replace_editor` or `patch_contents` over whole-file overwrites (`create_or_update_file`) to eliminate accidental code truncation.
3. **Atomic Multi-File Commits**: Use `push_files` when updating multiple dependent files simultaneously so the repository remains in a buildable state on every commit.
4. **Token-Efficient Line Windowing**: Always provide `startLine` and `endLine` when calling `get_file_contents` to inspect only the relevant code section.
5. **Accurate Network Understanding**: The sandbox **has outbound internet connectivity**. It can install packages from official registries (`npm`, `pip`), fetch remote assets with `sandbox_store` (`action: "download"`), and clone remote repositories. Outbound requests are protected by server-side security checks that block private/internal IP access.
6. **Use GitHub MCP**: For all standard GitHub issue triage, PR review discussions, line-level review comments, release queries, and repository administration, use the GitHub MCP tools documented in [`github-mcp-tools-guide.md`](references/github-mcp-tools-guide.md).
7. **Artifact Delivery**: When generating code, reports, images, or zip archives inside the sandbox that the user needs, use `sandbox_store` (`action: "share"`, `sandboxPath: "..."`) and **always provide the resulting download URL directly to the user in your response**.
