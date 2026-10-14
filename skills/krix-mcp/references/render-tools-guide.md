# Krix MCP Render Tools Guide (Cloud Infrastructure Management)

This reference guide provides exhaustive documentation for all **21 Render Tools** in Krix MCP. These tools manage cloud resources on Render directly via the Render REST API, including workspaces, web services, static sites, scheduled cron jobs, deployments, application log streams, performance metrics, environment variables, and PostgreSQL queries.

---

## Tool Index

### A. Workspace Management
1. [`list_workspaces`](#1-list_workspaces)
2. [`select_workspace`](#2-select_workspace)
3. [`get_selected_workspace`](#3-get_selected_workspace)

### B. Service Management & Deployments
4. [`list_services`](#4-list_services)
5. [`get_service`](#5-get_service)
6. [`create_web_service`](#6-create_web_service)
7. [`create_static_site`](#7-create_static_site)
8. [`create_cron_job`](#8-create_cron_job)
9. [`restart_service`](#9-restart_service)
10. [`delete_service`](#10-delete_service)
11. [`list_deploys`](#11-list_deploys)
12. [`get_deploy`](#12-get_deploy)
13. [`trigger_deploy`](#13-trigger_deploy)
14. [`cancel_deploy`](#14-cancel_deploy)

### C. Logs, Metrics & PostgreSQL
15. [`list_logs`](#15-list_logs)
16. [`list_log_label_values`](#16-list_log_label_values)
17. [`get_metrics`](#17-get_metrics)
18. [`list_env_vars`](#18-list_env_vars)
19. [`update_env_vars`](#19-update_env_vars)
20. [`delete_env_var`](#20-delete_env_var)
21. [`query_render_postgres`](#21-query_render_postgres)

---

## 1. `list_workspaces`

### Purpose & Overview
Lists all available Render workspaces (personal accounts and team organizations) associated with the API key or token.

### Schema & Parameters
- Takes no parameters (`{}`).

### Usage Example
```json
{}
```

---

## 2. `select_workspace`

### Purpose & Overview
Selects and pins an active Render workspace target for the current session. Subsequent service queries and creation requests operate inside this workspace.

### Schema & Parameters
- `ownerID` (string, required): The ID of the Render workspace/owner.

### Usage Example
```json
{
  "ownerID": "tea-c9a1b2c3d4e5f6g7h8"
}
```

---

## 3. `get_selected_workspace`

### Purpose & Overview
Retrieves metadata for the currently active/selected Render workspace in the session.

### Schema & Parameters
- Takes no parameters (`{}`).

### Usage Example
```json
{}
```

---

## 4. `list_services`

### Purpose & Overview
Lists all services (web services, static sites, background workers, cron jobs) in the active workspace.

### Schema & Parameters
- `includePreviews` (boolean, optional, default: false): Whether to include preview environment services.

### Usage Example
```json
{
  "includePreviews": false
}
```

---

## 5. `get_service`

### Purpose & Overview
Retrieves detailed configuration, status, runtime URL, and repository bindings for a specific Render service.

### Schema & Parameters
- `serviceId` (string, required): Render service ID (e.g. `srv-c123456789`).

### Usage Example
```json
{
  "serviceId": "srv-c123456789"
}
```

---

## 6. `create_web_service`

### Purpose & Overview
Provisions a new web service on Render connected to a Git repository.

### Schema & Parameters
- `name` (string, required): Display name of the service.
- `runtime` (enum, required): `node` | `python` | `go` | `rust` | `ruby` | `elixir` | `docker`.
- `repo` (string, required): Repository URL (e.g. `https://github.com/org/repo`).
- `branch` (string, optional, default: `main`): Git branch to track.
- `buildCommand` (string, required): Build command (e.g. `npm run build`).
- `startCommand` (string, required): Command to start application (e.g. `npm start`).
- `plan` (enum, optional): `free` | `starter` | `standard` | `pro` | `pro_max` | `pro_plus` | `pro_ultra`.
- `region` (enum, optional): `oregon` | `frankfurt` | `singapore` | `ohio` | `virginia`.
- `autoDeploy` (enum, optional): `yes` | `no`.
- `envVars` (array of objects, optional): Initial environment variables `[ { "key": "NODE_ENV", "value": "production" } ]`.

### Usage Example
```json
{
  "name": "api-gateway",
  "runtime": "node",
  "repo": "https://github.com/imanki-t/krix",
  "branch": "main",
  "buildCommand": "npm install && npm run build",
  "startCommand": "npm start",
  "plan": "starter",
  "region": "oregon",
  "autoDeploy": "yes",
  "envVars": [
    { "key": "NODE_ENV", "value": "production" }
  ]
}
```

---

## 7. `create_static_site`

### Purpose & Overview
Provisions a new static site service on Render.

### Schema & Parameters
- `name` (string, required): Display name.
- `repo` (string, required): Repository URL.
- `branch` (string, optional): Git branch.
- `buildCommand` (string, required): Build command (e.g. `npm run build`).
- `publishPath` (string, optional, default: `public`): Directory containing built static assets (e.g. `dist`, `build`, `public`).
- `autoDeploy` (enum, optional): `yes` | `no`.
- `envVars` (array of objects, optional): Environment variables.

### Usage Example
```json
{
  "name": "docs-site",
  "repo": "https://github.com/imanki-t/krix-docs",
  "buildCommand": "npm run build",
  "publishPath": "dist"
}
```

---

## 8. `create_cron_job`

### Purpose & Overview
Provisions a scheduled cron job service on Render.

### Schema & Parameters
- `name` (string, required): Display name.
- `runtime` (enum, required): `node` | `python` | `go` | `rust` | `ruby` | `elixir` | `docker`.
- `schedule` (string, required): Cron schedule expression (e.g. `0 0 * * *` for daily midnight).
- `command` (string, required): Shell command executed when triggered.
- `repo` (string, required): Git repository URL.
- `branch` (string, optional): Git branch.
- `buildCommand` (string, optional): Build command before job execution.
- `autoDeploy` (enum, optional): `yes` | `no`.

### Usage Example
```json
{
  "name": "nightly-cleanup",
  "runtime": "node",
  "schedule": "0 2 * * *",
  "command": "node scripts/cleanup.js",
  "repo": "https://github.com/org/repo"
}
```

---

## 9. `restart_service`

### Purpose & Overview
Restarts a Render service, optionally re-pulling or restarting processes.

### Schema & Parameters
- `serviceId` (string, required): Render service ID.

### Usage Example
```json
{
  "serviceId": "srv-c123456789"
}
```

---

## 10. `delete_service`

### Purpose & Overview
Permanently deletes a Render service.

### Schema & Parameters
- `serviceId` (string, required): Render service ID to terminate.

### Usage Example
```json
{
  "serviceId": "srv-c123456789"
}
```

---

## 11. `list_deploys`

### Purpose & Overview
Lists recent deployments for a specified service with pagination limits.

### Schema & Parameters
- `serviceId` (string, required): Render service ID.
- `limit` (number, optional, default: 5): Maximum deployments to retrieve.

### Usage Example
```json
{
  "serviceId": "srv-c123456789",
  "limit": 10
}
```

---

## 12. `get_deploy`

### Purpose & Overview
Retrieves status, build logs, and commit info for a specific deployment.

### Schema & Parameters
- `serviceId` (string, required): Render service ID.
- `deployId` (string, required): Render deployment ID.

### Usage Example
```json
{
  "serviceId": "srv-c123456789",
  "deployId": "dep-d987654321"
}
```

---

## 13. `trigger_deploy`

### Purpose & Overview
Triggers a manual deployment for a service, optionally clearing build caches.

### Schema & Parameters
- `serviceId` (string, required): Render service ID.
- `clearCache` (enum, optional, default: `do_not_clear`): `clear` | `do_not_clear`.

### Usage Example
```json
{
  "serviceId": "srv-c123456789",
  "clearCache": "clear"
}
```

---

## 14. `cancel_deploy`

### Purpose & Overview
Cancels an in-progress deployment.

### Schema & Parameters
- `serviceId` (string, required): Render service ID.
- `deployId` (string, required): In-progress deployment ID.

### Usage Example
```json
{
  "serviceId": "srv-c123456789",
  "deployId": "dep-d987654321"
}
```

---

## 15. `list_logs`

### Purpose & Overview
Streams and searches service logs with server-side filtering by severity level, substring text, time ranges, and instances.

### Schema & Parameters
- `resource` (array of strings, required): Service ID array (e.g. `["srv-c123456789"]`).
- `text` (array of strings, optional): Substring filter patterns.
- `level` (array of strings, optional): Log severity levels (e.g. `["error"]`, `["info", "warn"]`).
- `startTime` (string, optional): ISO-8601 start timestamp.
- `endTime` (string, optional): ISO-8601 end timestamp.
- `direction` (enum, optional): `forward` | `backward`.
- `limit` (number, optional, default: 15): Number of log entries.

### Usage Example
```json
{
  "resource": ["srv-c123456789"],
  "level": ["error"],
  "limit": 25
}
```

---

## 16. `list_log_label_values`

### Purpose & Overview
Lists available label values for log streams (e.g. instance IDs or host labels).

### Schema & Parameters
- `resource` (array of strings, required): Service ID array.
- `label` (string, required): Target label name.

### Usage Example
```json
{
  "resource": ["srv-c123456789"],
  "label": "instance"
}
```

---

## 17. `get_metrics`

### Purpose & Overview
Retrieves CPU utilization, memory consumption, and bandwidth metrics for a service.

### Schema & Parameters
- `serviceId` (string, required): Render service ID.

### Usage Example
```json
{
  "serviceId": "srv-c123456789"
}
```

---

## 18. `list_env_vars`

### Purpose & Overview
Lists environment variables configured for a specific Render service.

### Schema & Parameters
- `serviceId` (string, required): Render service ID.

### Usage Example
```json
{
  "serviceId": "srv-c123456789"
}
```

---

## 19. `update_env_vars`

### Purpose & Overview
Sets or modifies environment variables for a service. Triggers an automatic re-deploy if enabled.

### Schema & Parameters
- `serviceId` (string, required): Render service ID.
- `envVars` (array of objects, required): Array of key-value pairs `[ { "key": "KEY", "value": "VALUE" } ]`.

### Usage Example
```json
{
  "serviceId": "srv-c123456789",
  "envVars": [
    { "key": "LOG_LEVEL", "value": "debug" }
  ]
}
```

---

## 20. `delete_env_var`

### Purpose & Overview
Deletes a specific environment variable by key from a service.

### Schema & Parameters
- `serviceId` (string, required): Render service ID.
- `key` (string, required): Name of environment variable to delete.

### Usage Example
```json
{
  "serviceId": "srv-c123456789",
  "key": "OLD_TOKEN"
}
```

---

## 21. `query_render_postgres`

### Purpose & Overview
Inspects managed PostgreSQL database details or executes administrative database queries.

### Schema & Parameters
- `postgresId` (string, required): Render PostgreSQL database ID (e.g. `dpg-c123456789`).
- `query` (string, required): SQL query string to execute.

### Usage Example
```json
{
  "postgresId": "dpg-c123456789",
  "query": "SELECT count(*) FROM users;"
}
```
