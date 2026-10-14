import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export enum PermissionLevel {
  READ_ONLY = 'READ_ONLY',
  MUTATING = 'MUTATING',
  ADMIN = 'ADMIN'
}

export interface SessionContext {
  owner?: string;
  repo?: string;
  branch?: string;
  workspaceId?: string;
  sandboxDir?: string;
  cwd?: string;
  env?: Record<string, string>;
  enabledCategories: Set<ToolCategory>;
  resumedContext?: { fromPriorSession: true; idleMs: number };
}

const sessionContexts = new Map<string, SessionContext>();

const sessionAuthKey = new Map<string, string>();
const lastKnownContextByAuth = new Map<string, { owner?: string; repo?: string; branch?: string; sandboxDir?: string; cwd?: string; env?: Record<string, string>; lastUsed: number }>();

const MIN_AUTH_CONTEXT_TTL_MS = 5 * 60 * 1000;
const MAX_AUTH_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_AUTH_CONTEXT_TTL_MS = 60 * 60 * 1000;
function resolveConfiguredTtl(): number {
  const raw = Number(process.env.AUTH_CONTEXT_TTL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_AUTH_CONTEXT_TTL_MS;
  return Math.min(MAX_AUTH_CONTEXT_TTL_MS, Math.max(MIN_AUTH_CONTEXT_TTL_MS, raw));
}
const AUTH_CONTEXT_TTL_MS = resolveConfiguredTtl();

const AUTH_CONTEXT_PRUNE_INTERVAL_MS = 10 * 60 * 1000;
const authContextPruneTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of lastKnownContextByAuth) {
    if (now - bucket.lastUsed > AUTH_CONTEXT_TTL_MS) lastKnownContextByAuth.delete(key);
  }
}, AUTH_CONTEXT_PRUNE_INTERVAL_MS);
authContextPruneTimer.unref();

function hashAuth(token: string): string {
  return crypto.createHash('sha256').update(token || 'anonymous').digest('hex').slice(0, 16);
}

export function computeAuthKey(githubToken: string): string {
  return hashAuth(githubToken);
}

export function registerSessionAuth(sessionId: string, githubToken: string): void {
  sessionAuthKey.set(sessionId, hashAuth(githubToken));
}

export function getAuthKeyForSession(sessionId: string): string {
  return sessionAuthKey.get(sessionId) || 'anonymous';
}

function authBucket(sessionId: string) {
  const key = sessionAuthKey.get(sessionId) || 'anonymous';
  let bucket = lastKnownContextByAuth.get(key);
  if (bucket && Date.now() - bucket.lastUsed > AUTH_CONTEXT_TTL_MS) {
    bucket = undefined;
  }
  if (!bucket) { bucket = { lastUsed: Date.now() }; lastKnownContextByAuth.set(key, bucket); }
  else { bucket.lastUsed = Date.now(); }
  return bucket;
}

export function getSessionContext(sessionId: string): SessionContext {
  if (!sessionContexts.has(sessionId)) {
    const enableAll = process.env.ENABLE_ALL_TOOLS === 'true';

    const enableIssuesPrs = enableAll ||
      process.env.ENABLE_GITHUB_ISSUES_PRS === 'true' ||
      process.env.ENABLE_GITHUB_ISSUES_PRS_TOOLS === 'true';

    const enableAdmin = enableAll ||
      process.env.ENABLE_GITHUB_ADMIN === 'true' ||
      process.env.ENABLE_GITHUB_ADMIN_TOOLS === 'true';

    const enableRender = enableAll ||
      process.env.ENABLE_RENDER === 'true' ||
      process.env.ENABLE_RENDER_TOOLS === 'true';

    const enableSandbox = enableAll || (
      process.env.ENABLE_SANDBOX !== 'false' &&
      process.env.ENABLE_SANDBOX_TOOLS !== 'false' &&
      process.env.DISABLE_SANDBOX !== 'true' &&
      process.env.DISABLE_SANDBOX_TOOLS !== 'true'
    );

    const enableFiles = enableAll || process.env.ENABLE_FILE_SHARING !== 'false';

    const initial: ToolCategory[] = ['core'];
    if (enableIssuesPrs) initial.push('github_issues_prs');
    if (enableAdmin) initial.push('github_admin');
    if (enableRender) initial.push('render');
    if (enableSandbox) initial.push('sandbox');
    if (enableFiles) initial.push('files');

    const key = sessionAuthKey.get(sessionId) || 'anonymous';
    const priorRaw = lastKnownContextByAuth.get(key);
    const idleMs = priorRaw ? Date.now() - priorRaw.lastUsed : undefined;
    const hadLiveData = !!priorRaw && idleMs! <= AUTH_CONTEXT_TTL_MS && (priorRaw.owner || priorRaw.repo || priorRaw.branch || priorRaw.sandboxDir);

    const known = authBucket(sessionId);
    sessionContexts.set(sessionId, {
      branch: known.branch || 'main',
      owner: known.owner,
      repo: known.repo,
      sandboxDir: known.sandboxDir,
      cwd: known.cwd,
      env: known.env,
      enabledCategories: new Set(initial),
      ...(hadLiveData ? { resumedContext: { fromPriorSession: true, idleMs: idleMs! } } : {})
    });
  }
  return sessionContexts.get(sessionId)!;
}

export function updateSessionContext(sessionId: string, patch: Partial<SessionContext>): SessionContext {
  const current = getSessionContext(sessionId);
  if (patch.cwd !== undefined) patch.cwd = validateSandboxCwd(sessionId, patch.cwd);
  if (patch.env !== undefined) patch.env = validateUserEnv(patch.env);
  Object.assign(current, patch);
  const known = authBucket(sessionId);
  if ('owner' in patch) known.owner = patch.owner;
  if ('repo' in patch) known.repo = patch.repo;
  if ('branch' in patch) known.branch = patch.branch;
  if ('sandboxDir' in patch) known.sandboxDir = patch.sandboxDir;
  if ('cwd' in patch) known.cwd = patch.cwd;
  if ('env' in patch) known.env = patch.env;
  return current;
}

export function deleteSessionContext(sessionId: string): void {
  sessionContexts.delete(sessionId);
  sessionAuthKey.delete(sessionId);
}

export const TOOL_PERMISSIONS: Record<string, PermissionLevel> = {
  'set_active_context': PermissionLevel.READ_ONLY,
  'get_me': PermissionLevel.READ_ONLY,
  'get_file_contents': PermissionLevel.READ_ONLY,
  'str_replace_editor': PermissionLevel.MUTATING,
  'create_or_update_file': PermissionLevel.MUTATING,
  'delete_file': PermissionLevel.MUTATING,
  'grep': PermissionLevel.READ_ONLY,
  'view_file_outline': PermissionLevel.READ_ONLY,
  'list_branches': PermissionLevel.READ_ONLY,
  'create_branch': PermissionLevel.MUTATING,
  'delete_branch': PermissionLevel.MUTATING,
  'push_files': PermissionLevel.MUTATING,
  'create_pull_request': PermissionLevel.MUTATING,
  'get_commit': PermissionLevel.READ_ONLY,
  'search_code': PermissionLevel.READ_ONLY,
  'search_commits': PermissionLevel.READ_ONLY,
  'search_repositories': PermissionLevel.READ_ONLY,
  'git_tree': PermissionLevel.READ_ONLY,
  'patch_contents': PermissionLevel.MUTATING,
  'sandbox_status': PermissionLevel.READ_ONLY,
  'sandbox_file': PermissionLevel.MUTATING,

  'sandbox_store': PermissionLevel.MUTATING,

  'list_issues': PermissionLevel.READ_ONLY,
  'list_pull_requests': PermissionLevel.READ_ONLY,
  'issue_read': PermissionLevel.READ_ONLY,
  'issue_write': PermissionLevel.MUTATING,
  'sub_issue_write': PermissionLevel.MUTATING,
  'add_issue_comment': PermissionLevel.MUTATING,
  'pull_request_read': PermissionLevel.READ_ONLY,
  'pull_request_review_write': PermissionLevel.MUTATING,
  'add_comment_to_pending_review': PermissionLevel.MUTATING,
  'add_reply_to_pull_request_comment': PermissionLevel.MUTATING,
  'update_pull_request': PermissionLevel.MUTATING,
  'update_pull_request_branch': PermissionLevel.MUTATING,
  'merge_pull_request': PermissionLevel.MUTATING,
  'search_issues': PermissionLevel.READ_ONLY,
  'search_pull_requests': PermissionLevel.READ_ONLY,

  'get_label': PermissionLevel.READ_ONLY,
  'get_release': PermissionLevel.READ_ONLY,
  'get_tag': PermissionLevel.READ_ONLY,
  'get_team_members': PermissionLevel.READ_ONLY,
  'get_teams': PermissionLevel.READ_ONLY,
  'list_commits': PermissionLevel.READ_ONLY,
  'list_issue_fields': PermissionLevel.READ_ONLY,
  'list_issue_types': PermissionLevel.READ_ONLY,
  'list_releases': PermissionLevel.READ_ONLY,
  'list_repository_collaborators': PermissionLevel.READ_ONLY,
  'list_tags': PermissionLevel.READ_ONLY,
  'search_users': PermissionLevel.READ_ONLY,
  'run_secret_scanning': PermissionLevel.READ_ONLY,
  'create_repository': PermissionLevel.MUTATING,
  'fork_repository': PermissionLevel.MUTATING,
  'request_copilot_review': PermissionLevel.MUTATING,
  'assign_copilot_to_issue': PermissionLevel.MUTATING,

  'list_workspaces': PermissionLevel.READ_ONLY,
  'select_workspace': PermissionLevel.MUTATING,
  'get_selected_workspace': PermissionLevel.READ_ONLY,
  'list_services': PermissionLevel.READ_ONLY,
  'get_service': PermissionLevel.READ_ONLY,
  'create_web_service': PermissionLevel.MUTATING,
  'create_static_site': PermissionLevel.MUTATING,
  'create_cron_job': PermissionLevel.MUTATING,
  'restart_service': PermissionLevel.MUTATING,
  'delete_service': PermissionLevel.MUTATING,
  'list_deploys': PermissionLevel.READ_ONLY,
  'get_deploy': PermissionLevel.READ_ONLY,
  'trigger_deploy': PermissionLevel.MUTATING,
  'cancel_deploy': PermissionLevel.MUTATING,
  'list_logs': PermissionLevel.READ_ONLY,
  'list_log_label_values': PermissionLevel.READ_ONLY,
  'get_metrics': PermissionLevel.READ_ONLY,
  'list_env_vars': PermissionLevel.READ_ONLY,
  'update_env_vars': PermissionLevel.MUTATING,
  'delete_env_var': PermissionLevel.MUTATING,
  'query_render_postgres': PermissionLevel.READ_ONLY,

  'sandbox_exec': PermissionLevel.MUTATING,
  'sandbox_run': PermissionLevel.MUTATING,
  'sandbox_install': PermissionLevel.MUTATING,
  'sandbox_ps': PermissionLevel.READ_ONLY,
  'sandbox_output': PermissionLevel.READ_ONLY,
  'sandbox_reset': PermissionLevel.MUTATING,
  'git_clone': PermissionLevel.MUTATING,
  'git_checkout': PermissionLevel.MUTATING,
  'git_pull': PermissionLevel.MUTATING,
  'git_status': PermissionLevel.READ_ONLY,
  'git_diff': PermissionLevel.READ_ONLY,
  'git_commit_push': PermissionLevel.MUTATING
};

const CLOSED_WORLD_TOOLS = new Set([
  'set_active_context', 'sandbox_status', 'sandbox_ps', 'sandbox_reset', 'sandbox_output', 'sandbox_file',
  'git_status', 'git_diff'
]);

// Tools that can irreversibly destroy or overwrite data or infrastructure, or run arbitrary code.
// Everything else that mutates is purely additive or git-versioned (recoverable), so MCP clients
// are told it is not destructive. These hints are advisory only — they never replace server-side checks.
const DESTRUCTIVE_TOOLS = new Set([
  'delete_file', 'delete_branch', 'merge_pull_request', 'push_files', 'create_or_update_file',
  'str_replace_editor', 'patch_contents',
  'delete_service', 'delete_env_var', 'update_env_vars', 'restart_service', 'trigger_deploy', 'cancel_deploy',
  'sandbox_exec', 'sandbox_run', 'sandbox_install', 'sandbox_reset', 'sandbox_file',
  'git_commit_push', 'git_checkout', 'git_pull',
  'sandbox_store'
]);

const IDEMPOTENT_WRITE_TOOLS = new Set(['set_active_context', 'select_workspace', 'sandbox_reset']);

export function getToolAnnotations(toolName: string) {
  const isReadOnly = TOOL_PERMISSIONS[toolName] === PermissionLevel.READ_ONLY;
  return {
    title: toolName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    readOnlyHint: isReadOnly,
    destructiveHint: !isReadOnly && DESTRUCTIVE_TOOLS.has(toolName),
    idempotentHint: isReadOnly || IDEMPOTENT_WRITE_TOOLS.has(toolName),
    openWorldHint: !CLOSED_WORLD_TOOLS.has(toolName)
  };
}

export type ToolCategory = 'core' | 'github_issues_prs' | 'github_admin' | 'render' | 'sandbox' | 'files';

export const TOOL_CATEGORY: Record<string, ToolCategory> = {
  set_active_context: 'core',
  get_me: 'core',
  get_file_contents: 'core',
  str_replace_editor: 'core',
  create_or_update_file: 'core',
  delete_file: 'core',
  grep: 'core',
  view_file_outline: 'core',
  list_branches: 'core',
  create_branch: 'core',
  delete_branch: 'core',
  push_files: 'core',
  create_pull_request: 'core',
  search_code: 'core',
  search_repositories: 'core',
  git_tree: 'core',
  patch_contents: 'core',
  sandbox_status: 'core',

  list_issues: 'github_issues_prs',
  list_pull_requests: 'github_issues_prs',
  issue_read: 'github_issues_prs',
  issue_write: 'github_issues_prs',
  sub_issue_write: 'github_issues_prs',
  add_issue_comment: 'github_issues_prs',
  pull_request_read: 'github_issues_prs',
  pull_request_review_write: 'github_issues_prs',
  add_comment_to_pending_review: 'github_issues_prs',
  add_reply_to_pull_request_comment: 'github_issues_prs',
  update_pull_request: 'github_issues_prs',
  update_pull_request_branch: 'github_issues_prs',
  merge_pull_request: 'github_issues_prs',
  search_issues: 'github_issues_prs',
  search_pull_requests: 'github_issues_prs',

  get_commit: 'github_admin',
  search_commits: 'github_admin',
  get_label: 'github_admin',
  get_release: 'github_admin',
  get_tag: 'github_admin',
  get_teams: 'github_admin',
  get_team_members: 'github_admin',
  list_commits: 'github_admin',
  list_releases: 'github_admin',
  list_tags: 'github_admin',
  list_issue_fields: 'github_admin',
  list_issue_types: 'github_admin',
  list_repository_collaborators: 'github_admin',
  search_users: 'github_admin',
  create_repository: 'github_admin',
  fork_repository: 'github_admin',
  run_secret_scanning: 'github_admin',
  request_copilot_review: 'github_admin',
  assign_copilot_to_issue: 'github_admin',

  list_workspaces: 'render',
  select_workspace: 'render',
  get_selected_workspace: 'render',
  list_services: 'render',
  get_service: 'render',
  create_web_service: 'render',
  create_static_site: 'render',
  create_cron_job: 'render',
  restart_service: 'render',
  delete_service: 'render',
  list_deploys: 'render',
  get_deploy: 'render',
  trigger_deploy: 'render',
  cancel_deploy: 'render',
  list_logs: 'render',
  list_log_label_values: 'render',
  get_metrics: 'render',
  list_env_vars: 'render',
  update_env_vars: 'render',
  delete_env_var: 'render',
  query_render_postgres: 'render',

  sandbox_exec: 'sandbox',
  sandbox_run: 'sandbox',
  sandbox_install: 'sandbox',
  sandbox_ps: 'sandbox',
  sandbox_reset: 'sandbox',
  git_clone: 'sandbox',
  git_checkout: 'sandbox',
  git_pull: 'sandbox',
  git_status: 'sandbox',
  git_diff: 'sandbox',
  git_commit_push: 'sandbox',
  sandbox_output: 'sandbox',
  sandbox_file: 'sandbox',

  sandbox_store: 'files'
};

export function makeRegistrar(server: any, registry: Record<string, any>) {
  const defaultIcons = server?.server?._serverInfo?.icons || server?.serverInfo?.icons;
  return (name: string, config: any, handler: any) => {
    if (defaultIcons && defaultIcons.length && !config.icons) {
      config.icons = defaultIcons;
    }
    registry[name] = server.registerTool(name, config, handler);
    return registry[name];
  };
}

export function compressResponseData(data: any, maxChars: number = 2500): any {
  if (data === null || data === undefined) return '';

  if (typeof data === 'string') {
    let clean = sanitizeOutput(data);
    if (clean.length > maxChars) {
      clean = clean.slice(0, maxChars) + `\n... [Truncated ${clean.length - maxChars} chars for token optimization]`;
    }
    return clean;
  }

  if (Array.isArray(data)) {
    const compressedList = data.slice(0, 15).map(item => compressResponseData(item, 300));
    let result: any[] = compressedList;
    if (data.length > 15) {
      result.push({ _meta: `Showing 15 of ${data.length} total entries.` });
    }
    return result;
  }

  if (typeof data === 'object') {
    const compressedObj: Record<string, any> = {};
    const keysToOmit = new Set(['node_id', 'gravatar_id', 'url', 'html_url', 'followers_url', 'following_url', 'gists_url', 'starred_url', 'subscriptions_url', 'organizations_url', 'repos_url', 'events_url', 'received_events_url', 'site_admin', 'authorizations_url']);

    for (const [key, value] of Object.entries(data)) {
      if (keysToOmit.has(key) || value === null || value === undefined || value === '') continue;
      compressedObj[key] = typeof value === 'object' ? compressResponseData(value, 500) : value;
    }
    return sanitizeOutput(compressedObj);
  }

  return data;
}

export function formatOptimizedResponse(data: any, maxChars?: number) {
  const compressed = compressResponseData(data, maxChars);
  const text = typeof compressed === 'string' ? compressed : JSON.stringify(compressed);
  return { content: [{ type: 'text' as const, text }] };
}

export function formatImageResponse(data: Buffer | string, mimeType: string, meta?: any) {
  const b64 = Buffer.isBuffer(data) ? data.toString('base64') : data;
  const blocks: any[] = [{ type: 'image' as const, data: b64, mimeType }];
  if (meta !== undefined) {
    const text = typeof meta === 'string' ? meta : JSON.stringify(compressResponseData(meta, 3000));
    blocks.unshift({ type: 'text' as const, text: sanitizeOutput(text) });
  }
  return { content: blocks };
}

export function formatError(error: any) {
  const message = error?.message || String(error);
  return {
    isError: true,
    content: [{ type: 'text' as const, text: `Error: ${sanitizeOutput(message)}` }]
  };
}

// Names of environment variables whose *values* must never appear in any tool output or log line.
const SECRET_ENV_NAMES = [
  'MCP_API_KEY', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'GITHUB_PAT', 'RENDER_API_KEY', 'RENDER_PAT',
  'MONGODB_URI', 'MONGO_URL', 'MONGODB_PASSWORD'
];
const dynamicSecrets = new Set<string>();

/** Register a runtime secret (e.g. a per-request GitHub token) so it is scrubbed from every output. */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 8) dynamicSecrets.add(value);
  if (dynamicSecrets.size > 500) dynamicSecrets.delete(dynamicSecrets.values().next().value as string);
}

function knownSecretValues(): string[] {
  const out: string[] = [];
  for (const name of SECRET_ENV_NAMES) {
    const v = process.env[name];
    if (v && v.length >= 8) out.push(v);
  }
  for (const v of dynamicSecrets) out.push(v);
  // Also catch credentials embedded in a connection string (mongodb://user:pass@host).
  const uri = process.env.MONGODB_URI;
  if (uri) {
    const m = uri.match(/^[a-z0-9+.\-]+:\/\/([^:@/\s]+):([^@/\s]+)@/i);
    if (m) { out.push(m[2]); try { out.push(decodeURIComponent(m[2])); } catch {} }
  }
  return out.sort((a, b) => b.length - a.length);
}

export function sanitizeOutput(data: any, depth: number = 0): any {
  if (data === null || data === undefined) return data;
  if (depth > 20) return '[TRUNCATED]';
  if (typeof data === 'string') {
    let s = data;
    for (const secret of knownSecretValues()) {
      if (s.includes(secret)) s = s.split(secret).join('[REDACTED]');
    }
    return s
      .replace(/\b(gh[pousr]_)[A-Za-z0-9]{20,}/g, '$1****')
      .replace(/\b(github_pat_)[A-Za-z0-9_]{20,}/g, '$1****')
      .replace(/\b(rnd_)[A-Za-z0-9]{16,}/g, '$1****')
      .replace(/\b(sk-ant-|sk-)[A-Za-z0-9_\-]{20,}/g, '$1****')
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA****')
      .replace(/\b(mongodb(?:\+srv)?:\/\/)[^\s'"@/]+:[^\s'"@/]+@/gi, '$1[REDACTED]@')
      .replace(/(Authorization:\s*(?:Basic|Bearer|Token)\s+)[A-Za-z0-9._~+\/=\-]+/gi, '$1[REDACTED]')
      .replace(/(Bearer\s+)[A-Za-z0-9._~+\/=\-]+/gi, '$1[REDACTED]')
      .replace(/(x-api-key:\s*)[A-Za-z0-9._\-]+/gi, '$1[REDACTED]')
      .replace(/([?&](?:api_key|apikey|access_token|token)=)[^&\s'"]+/gi, '$1[REDACTED]')
      .replace(/-----BEGIN ([A-Z ]*)PRIVATE KEY-----[\s\S]+?-----END \1PRIVATE KEY-----/g, '[REDACTED_KEY]');
  }
  if (typeof data === 'object') {
    const copy: any = Array.isArray(data) ? [] : {};
    for (const key of Object.keys(data)) {
      const lower = key.toLowerCase();
      if (lower.includes('token') || lower.includes('secret') || lower.includes('password') || lower.includes('apikey') || lower.includes('api_key')) {
        copy[key] = '[REDACTED]';
      } else {
        copy[key] = sanitizeOutput(data[key], depth + 1);
      }
    }
    return copy;
  }
  return data;
}

/** Constant-time string comparison that does not leak length or content through timing. */
export function safeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

/**
 * Lexically resolve `inputPath` under `rootDir` and refuse anything that escapes it.
 * Uses path.relative (not startsWith), so `/tmp/root` can never match `/tmp/root-evil`.
 */
export function sanitizePath(inputPath: string, rootDir: string = process.cwd()): string {
  if (typeof inputPath !== 'string' || inputPath.length === 0 || inputPath.length > 4096 || inputPath.includes('\0')) {
    throw new Error('Security Violation: invalid path.');
  }
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, inputPath);
  const rel = path.relative(root, resolved);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`Security Violation: Path '${inputPath}' escapes sandbox boundary.`);
  }
  return resolved;
}

/** Root directory of the sandbox that belongs to a session's authenticated identity. */
export function sandboxRootPath(sessionId: string): string {
  return path.join(os.tmpdir(), `krix_sbx_${getAuthKeyForSession(sessionId)}`);
}

function validateSandboxCwd(sessionId: string, cwd: string): string {
  if (cwd === '') return cwd;
  return sanitizePath(cwd, sandboxRootPath(sessionId));
}

const BLOCKED_USER_ENV = new Set([
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'LD_DEBUG', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
  'BASH_ENV', 'ENV', 'PROMPT_COMMAND', 'PS4', 'IFS', 'SHELLOPTS', 'BASHOPTS', 'CDPATH', 'GLOBIGNORE',
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'PWD',
  'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_EXTERNAL_DIFF', 'GIT_PROXY_COMMAND', 'GIT_EXEC_PATH', 'GIT_TEMPLATE_DIR',
  'NODE_PATH', 'PYTHONSTARTUP', 'PYTHONHOME', 'RUBYOPT', 'RUBYLIB', 'PERL5OPT', 'PERL5LIB', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS'
]);
const MAX_USER_ENV_VARS = 64;

/** Validate user-supplied sandbox environment variables (names, sizes, and a deny-list of loader/shell hooks). */
export function validateUserEnv(env: Record<string, string>): Record<string, string> {
  const entries = Object.entries(env || {});
  if (entries.length > MAX_USER_ENV_VARS) throw new Error(`Too many env vars (max ${MAX_USER_ENV_VARS}).`);
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(k)) throw new Error(`Invalid env var name '${k.slice(0, 40)}'.`);
    const upper = k.toUpperCase();
    if (BLOCKED_USER_ENV.has(upper) || upper.startsWith('GIT_CONFIG') || upper.startsWith('BASH_FUNC_') || upper.startsWith('KRIX_') || SECRET_ENV_NAMES.includes(upper)) {
      throw new Error(`Env var '${k}' is not allowed.`);
    }
    if (typeof v !== 'string' || v.length > 8192 || v.includes('\0')) throw new Error(`Invalid value for env var '${k}'.`);
    out[k] = v;
  }
  return out;
}

const SAFE_ENV_PASSTHROUGH = [
  'PATH', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'
];

/**
 * Minimal environment for child processes. Deliberately NOT `...process.env`: the server's
 * own secrets (MCP_API_KEY, GitHub/Render tokens, MONGODB_URI) must never reach user-driven code.
 */
export function scrubbedBaseEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of SAFE_ENV_PASSTHROUGH) {
    if (process.env[k] !== undefined) out[k] = process.env[k];
  }
  if (!out.PATH) out.PATH = '/usr/local/bin:/usr/bin:/bin';
  if (!out.LANG) out.LANG = 'C.UTF-8';
  return out;
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

export function assertValidOwnerRepo(owner: string, repo: string): void {
  if (!OWNER_RE.test(owner)) throw new Error('Invalid repository owner.');
  if (!REPO_RE.test(repo) || repo === '.' || repo === '..') throw new Error('Invalid repository name.');
}

/** Git ref/branch names used on a command line: no leading dash, no shell/ref metacharacters. */
export function assertValidRef(ref: string): void {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 255 ||
      ref.startsWith('-') || ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.') || ref.endsWith('.lock') ||
      ref.includes('..') || ref.includes('//') || ref.includes('@{') || /[\s~^:?*\[\\\x00-\x1f\x7f'"`$;&|<>(){}!#]/.test(ref)) {
    throw new Error('Invalid git ref/branch name.');
  }
}

const PKG_SPEC_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*(?:(?:@|==|>=|<=|~=|!=|>|<)[A-Za-z0-9._~^*+\-|<>=! ]{1,60})?(?:\[[A-Za-z0-9,_\-]{1,40}\])?$/;
export function assertValidPackageSpec(spec: string): void {
  if (typeof spec !== 'string' || spec.length === 0 || spec.length > 200 || spec.startsWith('-') || !PKG_SPEC_RE.test(spec) || /(?:^|[\s:/])(?:file|git\+?|https?|ssh|link):/i.test(spec)) {
    throw new Error(`Invalid or unsupported package spec '${String(spec).slice(0, 60)}'. Only registry package names (with an optional version) are allowed.`);
  }
}

export function getNetworkRestrictionLevel(): 'low' | 'medium' | 'high' {
  const level = (process.env.NETWORK_RESTRICTION_LEVEL || 'low').toLowerCase();
  if (level === 'high') return 'high';
  if (level === 'medium') return 'medium';
  return 'low';
}

export function getCommandRestrictionLevel(): 'low' | 'medium' | 'high' {
  const level = (process.env.COMMAND_RESTRICTION_LEVEL || 'low').toLowerCase();
  if (level === 'high') return 'high';
  if (level === 'medium') return 'medium';
  return 'low';
}

export function sanitizeNetworkInCommand(cmd: string): void {
  const netLevel = getNetworkRestrictionLevel();

  // Best-effort guardrail only: string matching cannot stop DNS tricks, redirects or encoded addresses.
  // Real egress control must come from the container / network policy (see SECURITY notes in README).
  const privateIpPatterns = [
    /169\.254\.\d{1,3}\.\d{1,3}/,
    /metadata\.google\.internal|metadata\.azure\.com|instance-data/i,
    /\b127\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
    /\b0\.0\.0\.0\b/,
    /\blocalhost\b/i,
    /\[::1?\]|(?<![:\w]):{2}1(?![:\w])|::ffff:/i,
    /\bfe80:|\bfd[0-9a-f]{2}:/i,
    /\b0x7f[0-9a-f]{6}\b|\b2130706433\b|\b0177\.0*\.0*\.0*1\b/i,
    /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
    /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/,
    /\b172\.(1[6-9]|2[0-9]|3[0-1])\.\d{1,3}\.\d{1,3}\b/,
    /\b192\.168\.\d{1,3}\.\d{1,3}\b/
  ];

  for (const pattern of privateIpPatterns) {
    if (pattern.test(cmd)) {
      throw new Error(`Security Alert: Access to internal or private IP address blocked under ${netLevel.toUpperCase()} network restriction level.`);
    }
  }

  if (netLevel === 'medium') {
    const rawIpPattern = /https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/i;
    if (rawIpPattern.test(cmd)) {
      throw new Error('Security Alert: Direct IP address URLs blocked under MEDIUM network restriction level.');
    }
    const suspiciousSchemes = /(gopher|dict|file|ftp):\/\//i;
    if (suspiciousSchemes.test(cmd)) {
      throw new Error('Security Alert: Non-HTTP network protocol blocked under MEDIUM network restriction level.');
    }
  }

  if (netLevel === 'high') {
    const urls = cmd.match(/https?:\/\/([^\s\/:\'\"]+)/gi);
    if (urls) {
      const allowedDomains = [
        'github.com',
        'githubusercontent.com',
        'npmjs.org',
        'npmjs.com',
        'pypi.org',
        'pythonhosted.org',
        'render.com',
        'google.com',
        'googleapis.com',
        'cloudflare.com',
        'crates.io',
        'deno.land',
        'maven.org',
        'debian.org',
        'ubuntu.com'
      ];
      for (const rawUrl of urls) {
        const domainMatch = rawUrl.match(/https?:\/\/([^\s\/:\'\"]+)/i);
        if (domainMatch && domainMatch[1]) {
          const host = domainMatch[1].toLowerCase();
          const isAllowed = allowedDomains.some(d => host === d || host.endsWith('.' + d));
          if (!isAllowed) {
            throw new Error(`Security Alert: Domain '${host}' is blocked under HIGH network restriction level.`);
          }
        }
      }
    }
  }
}

export function sanitizeCommand(cmd: string): void {
  const cmdLevel = getCommandRestrictionLevel();
  // Best-effort guardrails against accidents. They are NOT a security boundary — a determined
  // user can obfuscate any command. The real boundary is the unprivileged sandbox user + container.
  const lowPatterns = [
    /\brm\s+(?:-[a-z]+\s+)*-[a-z]*[rR][a-z]*\s+(?:-[a-z]+\s+)*(?:--no-preserve-root\s+)?(?:\/|~|\$HOME|\$\{HOME\})(?:\s|\/?\*|$)/,
    /\bmkfs/i,
    /\bdd\s+if=/i,
    />\s*\/dev\/(?:sd|nvme|vd|hd)/i,
    /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/
  ];
  const medPatterns = [
    ...lowPatterns,
    /shutdown/i,
    /reboot/i,
    /init\s+0/i,
    /chmod\s+-R\s+777\s+[\/]/i,
    /\/etc\/passwd/i,
    /\/etc\/shadow/i,
    /\/etc\/sudoers/i,
    /\/sbin\//i,
    /\/bin\/rm/i
  ];
  const highPatterns = [
    ...medPatterns,
    /\bsudo\b/i,
    /\bsu\b/i,
    /\bdoas\b/i,
    /\bnmap\b/i,
    /\bnc\s+-l/i,
    /\bnetcat\s+-l/i,
    /\bsocat\b/i,
    /\binsmod\b/i,
    /\bmodprobe\b/i,
    /\biptables\b/i
  ];

  const activePatterns = cmdLevel === 'high' ? highPatterns : (cmdLevel === 'medium' ? medPatterns : lowPatterns);
  for (const pattern of activePatterns) {
    if (pattern.test(cmd)) {
      throw new Error(`Security Alert: Command blocked under ${cmdLevel.toUpperCase()} command restriction level.`);
    }
  }

  sanitizeNetworkInCommand(cmd);
}

export function resolveInputString(plain?: string, b64?: string): string {
  if (b64) return Buffer.from(b64.replace(/\s+/g, ''), 'base64').toString('utf-8');
  return plain || '';
}

export function resolveInputBuffer(plain?: string, b64?: string): Buffer {
  if (b64) return Buffer.from(b64.replace(/\s+/g, ''), 'base64');
  return Buffer.from(plain || '', 'utf-8');
}

export function isBinaryBuffer(buf: Buffer): boolean {
  if (!buf || buf.length === 0) return false;
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0x00) return true;
  }
  return false;
}

export function safeRegexTest(pattern: string, flags: string, text: string, timeoutMs: number = 200): boolean {
  const context = { text, pattern, flags, result: false, error: null as any };
  try {
    const code = `
      try {
        const rx = new RegExp(pattern, flags);
        result = rx.test(text);
      } catch(e) {
        error = e;
      }
    `;
    vm.runInNewContext(code, context, { timeout: timeoutMs });
    if (context.error) throw context.error;
    return context.result;
  } catch (err: any) {
    if (err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      throw new Error('Security Error: Regex matching timed out.');
    }
    throw err;
  }
}
