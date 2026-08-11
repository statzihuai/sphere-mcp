# sphere-mcp

The SPHERE privacy boundary, exposed as an MCP server. An agent analyses sensitive
data without ever receiving an individual record.

**Status: Phase 1.** The loop works end to end. The SDC gate and the disclosure
ladder are not built yet — see *Limits* below, and do not make claims beyond them.

## What it does

| Tool | The model receives |
|---|---|
| `sphere_open(path)` | A format-redacted profile: names, dtypes, distinct counts, missingness, masked patterns (`9`/`X`). **No cell values.** |
| `sphere_twin(seed?)` | A certified synthetic twin + fidelity/privacy scores. Safe to read. |
| `sphere_run(code)` | Full results — the twin is synthetic. |
| `sphere_deploy(code)` | Only *whether it worked*. Results go to the **user**, on disk. |
| `sphere_simulate(code, perturbation)` | Debugs a real-data discrepancy by perturbing the **twin** until it reproduces the symptom. |
| `sphere_status()` | An audit ledger of everything that crossed into the model's context. |

## Setup (Claude Desktop)

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sphere": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/absolute/path/to/sphere-mcp/src/server.js"],
      "env": {
        "SPHERE_CLI": "/absolute/path/to/sphere-cli/bin/sphere.js",
        "SPHERE_VAULT": "~/.sphere/vault"
      }
    }
  }
}
```

Restart Claude Desktop. Then:

> I have sensitive data at `/path/to/patients.csv`. Use SPHERE — I don't want you
> reading the real records. Profile it, make a twin, explore what's there, and
> when the analysis looks right, deploy it to the real data.

Results from the real run land in the session directory as `real-output.txt` and
`real-*.png`. **You** read them; the model does not.

## How the guarantee is enforced

Not by asking the model nicely. Two mechanisms:

1. **What we send** — the profiler emits shapes, never values. The real path is
   never returned to the model (`sphere_status` says so explicitly).
2. **What model-authored code can reach** — a macOS Seatbelt profile that denies
   the whole home tree and re-allows exactly the twin plus a session directory,
   with network denied outright and an allow-list environment carrying no
   credentials.

Verified by attacking it (`node test/boundary.test.mjs`):

```
ok  blocked  read the real CSV by absolute path
ok  blocked  read the real CSV via pandas
ok  blocked  list the home directory for other datasets
ok  blocked  open a network socket to exfiltrate
ok  blocked  harvest credentials from the environment
ok  blocked  write outside the session directory
ok  blocked  read a dataset OUTSIDE the home directory
ok  ALLOWED  read the twin (this is the point)
```

That second-to-last case is there because the first two versions of the sandbox
failed it. Denying `$HOME` misses data on `/tmp`, `/Volumes` or a lab mount; and
once denied, `/tmp` still resolved to `/private/tmp`, which Seatbelt matches
instead — so the rule looked right and never fired. Both forms of every path are
emitted now.

## Limits — read before claiming anything

- **No SDC gate yet.** `sphere_deploy` withholds results from the model entirely,
  so nothing real flows back today. The moment you add a return path, aggregate
  outputs can disclose individuals (n=1 group means, min/max, residuals, a
  scatter plot). Build the gate before you open that door.
- **A twin is not automatically non-disclosive.** Extreme values in particular
  deserve checking before you treat a twin as safe to share — a maximum is always
  some real individual's value, wherever it appears. Evaluate each twin on its own
  evidence rather than assuming the category is safe.
- **The deny list is a list.** The registered dataset is always denied, by
  resolved path and containing directory, along with the usual data locations
  (`$HOME`, `/Users`, `/Volumes`, `/mnt`, `/media`, `/srv`, `/data`, `/tmp`). A
  file outside all of those is readable. Denying everything and allow-listing
  instead is the better shape and was tried: `(deny file-read*)` also denies
  metadata, so the loader cannot resolve its own binary and Python dies with
  SIGABRT before `main()`. Worth revisiting with a pinned interpreter.
- **macOS only.** The sandbox is Seatbelt. Linux needs bubblewrap or a container,
  and Linux is what any institutional deployment will run.
- **Other tools bypass everything.** This server controls its own tools. If the
  same client also has shell or filesystem access to the real path, the boundary
  is a convention. In Claude Desktop that is usually fine (no filesystem tool by
  default). In Claude Code, add a deny rule; at institutional scale, put the data
  under a different OS user or in a container.
- **Column names reach the model.** Alias them if a name is itself sensitive.

## Testing

```bash
node test/boundary.test.mjs
```

The tests attack the server rather than exercising it, and each case declares what
"blocked" looks like for *that* mechanism — a denied read raises, a denied
directory lists empty, a scrubbed environment yields no keys. Do not collapse
these into "did it error?"; an earlier version did and reported two false leaks.
A traceback also echoes the offending source line, so never assert on a success
sentinel that appears in the code itself.
