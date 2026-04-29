# User Generator + TUG

`user-generator` now has two compatible entry paths:

- `user-generator setup` (or just `user-generator`) opens the existing onboarding UI for provider/backend/repo/environment defaults.
- `tug` is the external, fail-closed CLI that indexes, transforms, validates, and executes sandboxed tests against a local automation repo clone.

## Quickstart (fresh clone)

```bash
git clone https://github.com/amiaddvir52/user-generator.git
cd user-generator
npm start
```

`npm start` will:

1. Run `npm ci` only when `node_modules` is missing.
2. Build the project.
3. Launch setup mode (`node dist/cli/main.js setup`).

If you prefer manual steps:

```bash
npm install
npm run build
npm run start:app
```

Troubleshooting:

- If you see `ENOENT: no such file or directory, open '.../package.json'`, make sure you are running commands from the repo root (`.../user-generator`) and not its parent folder.

## Setup flow (phase-1 foundation)

```bash
user-generator setup
```

Use onboarding to persist:

- AI provider + backend
- automation repo path
- preferred environment

The CLI uses these values as defaults, with this precedence:

1. CLI flags
2. environment variables (`TUG_*`)
3. saved onboarding config

## TUG commands

```bash
tug validate --repo <path> [--strict] [--json]
tug index --repo <path> [--reindex] [--json]
tug explain --repo <path> "<prompt>" [--top <n>] [--json]
tug explain-teardowns --repo <path> [--json]
tug dry-run --repo <path> --spec <file> --test "<title>" [--yes] [--keep-sandbox] [--json]
tug run --repo <path> "<prompt>" [--execution-mode <full|fast>] [--no-auto-fallback] [--yes] [--trust-unknown] [--output <file>] [--export-env] [--json]
tug gc [--max-age-days <n>] [--json]
```

## Dry-run-first workflow

1. Validate repo coupling and compatibility:

   ```bash
   tug validate --repo ~/dev/cloud-automation --strict
   ```

2. Build index + teardown map:

   ```bash
   tug index --repo ~/dev/cloud-automation
   ```

3. Explain candidate selection:

   ```bash
   tug explain --repo ~/dev/cloud-automation "US account with on-demand contract"
   ```

4. Run transform-only preview:

   ```bash
   tug dry-run --repo ~/dev/cloud-automation --spec e2e-automation/sm-ui-refresh/tests/account.spec.ts --test "creates account"
   ```

5. Execute:

   ```bash
   tug run --repo ~/dev/cloud-automation "US account with on-demand contract"
   ```

## Safety model

- Fail-closed by default.
- Unknown fingerprints are blocked unless `--trust-unknown` is set.
- `--strict` blocks dirty working tree execution.
- Transforms are performed in-memory and emitted into an external sandbox.
- Validation gates run before execution (`tsc --noEmit`, Playwright `--list`).

## Execution modes

- UI user generation defaults to `executionMode=fast` with automatic fallback to `full`.
- Fast mode adds an early credential probe and can short-circuit long assertion paths when credentials are already available after setup hooks.
- If fast mode completes without complete primary credentials (`email` + `password`) and fallback is enabled, TUG reruns once in `full` mode.
- CLI defaults to `full`; opt into fast mode with `--execution-mode fast`.

## Outputs and artifacts

- Result JSON can be emitted with `--json` and persisted with `--output <file>` (mode `0600`).
- `--export-env` prints `export TUG_*` lines for extracted credential keys.
- Saved onboarding config + run history are written to OS-level config paths (outside this repo), such as:
  - macOS: `~/Library/Application Support/user-generator`
  - Linux: `~/.config/user-generator`
  - Windows: `%APPDATA%\\user-generator`
- Sandboxes are created under cache:
  - macOS/Linux: `$XDG_CACHE_HOME` or `~/.cache/test-user-generator/runs`
  - Windows: `%LOCALAPPDATA%\test-user-generator\runs`
- Use `tug gc` to clean old sandboxes.

## Setup cache controls

- Sandbox Playwright setup uses a guarded disk cache under:
  - macOS/Linux: `~/.cache/test-user-generator/setup-cache`
  - Windows: `%LOCALAPPDATA%\\test-user-generator\\setup-cache`
- Controls:
  - `TUG_SETUP_CACHE_ENABLED=0` disables cache usage.
  - `TUG_SETUP_CACHE_TTL_MS=<ms>` overrides cache TTL (default: `3600000`).
- Validation cache controls:
  - `TUG_VALIDATION_CACHE_ENABLED=0` disables validation cache usage.
  - `TUG_VALIDATION_CACHE_TTL_MS=<ms>` overrides validation cache TTL (default: `600000`).

## Reason codes

On failure, the CLI emits a reason code (`Reason: <CODE>` in text mode, `reason` in JSON mode), for example:

- `FINGERPRINT_UNKNOWN`
- `TEARDOWN_HOOK_HAS_UNKNOWN_CALL`
- `TEARDOWN_IDENTITY_UNSURE`
- `VALIDATION_FAILED`
- `CREDENTIAL_MARKER_MISSING`
