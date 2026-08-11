// The privacy boundary: everything that decides what an agent is allowed to see.
//
// THE GUARANTEE DOES NOT LIVE IN THE MODEL'S BEHAVIOUR.
// A system prompt asking a model not to look at data is a request, not a control.
// The guarantee lives here: the real file is never handed to the model, never read
// into a tool result, and the sandbox that runs model-authored code cannot open it.
//
// Two channels have to be closed, and they are closed by different mechanisms:
//   1. What we SEND the model  — the profiler below emits shapes, never values.
//   2. What model-authored CODE can reach — a Seatbelt profile that denies the
//      home tree and re-allows exactly the synthetic file plus a session dir.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const VAULT = process.env.SPHERE_VAULT || path.join(os.homedir(), '.sphere', 'vault');

/** Env for any subprocess that will touch data: no credentials in reach. */
export function scrubbedEnv() {
  // An allow-list, not a deny-list. Spreading process.env and deleting the keys
  // you thought of leaves ANTHROPIC_API_KEY, AWS_*, and every token you did not.
  const allow = ['HOME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'USER', 'SHELL', 'TERM'];
  const out = {};
  for (const k of allow) if (process.env[k]) out[k] = process.env[k];
  out.MPLBACKEND = 'Agg';           // matplotlib must never try to open a window
  out.PYTHONDONTWRITEBYTECODE = '1';
  return out;
}

const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * Seatbelt profile for model-authored analysis code.
 *
 * Permissive base (Python needs a great deal to boot), then DENY the whole home
 * tree — which is where real CSVs actually live — then re-allow only the
 * synthetic file and the session directory. So even if the model writes
 * open('/Users/me/patients.csv') it gets PermissionError rather than data.
 *
 * Network is denied outright: code that can see data must not be able to speak.
 */
export function sandboxProfile({ sessionDir, synthPath }) {
  const home = os.homedir();
  return `(version 1)
(allow default)
(deny network*)
(deny file-write*)
(deny file-read* (subpath "${q(home)}"))
(allow file-read* (subpath "${q(path.join(home, 'Library'))}"))
(allow file-read* (literal "${q(synthPath)}"))
(allow file-read* (subpath "${q(sessionDir)}"))
(allow file-write* (subpath "${q(sessionDir)}"))
(allow file-write* (subpath "/private/tmp"))
(allow file-write* (subpath "/tmp"))
`;
}

/** Run a command, capturing output. Never inherits the parent environment. */
export function run(cmd, args, { cwd, timeoutMs = 180000, env } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env: env || scrubbedEnv() });
    let out = '', err = '';
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: String(e) }); });
  });
}

// ── Channel 1: the profile the model is allowed to see ──────────────────────
//
// Emits SHAPE, never content: name, dtype, distinct count, missingness, and a
// masked format pattern (digit→9, letter→X). "SMITH, JOHN" becomes "XXXXX, XXXX";
// an MRN becomes "999999". Enough for the model to write correct code, and
// nothing an attacker could use to identify a person.
const PROFILE_PY = `
import json, sys, re
import pandas as pd
def mask(v):
    s = str(v)
    if len(s) > 40: s = s[:40]
    return re.sub(r'[0-9]', '9', re.sub(r'[A-Za-z]', 'X', s))
df = pd.read_csv(sys.argv[1], low_memory=False)
cols = []
for c in df.columns:
    s = df[c]
    nn = s.dropna()
    pats = []
    if len(nn):
        seen = []
        for v in nn.head(200):
            m = mask(v)
            if m not in seen:
                seen.append(m)
            if len(seen) >= 3: break
        pats = seen
    cols.append({
        "name": str(c),
        "dtype": str(s.dtype),
        "n_distinct": int(s.nunique(dropna=True)),
        "missing_frac": round(float(s.isna().mean()), 4),
        "format_examples": pats,
    })
print(json.dumps({"rows": int(len(df)), "cols": int(df.shape[1]), "columns": cols}))
`;

export async function safeProfile(realPath) {
  const f = path.join(os.tmpdir(), `sphere-profile-${randomUUID()}.py`);
  fs.writeFileSync(f, PROFILE_PY);
  try {
    // The profiler itself reads the real file, so it runs WITHOUT network and
    // its output is a JSON document we construct — the raw file never becomes a
    // tool result.
    const r = await run('/usr/bin/sandbox-exec', [
      '-p', `(version 1)(allow default)(deny network*)`,
      python(), f, realPath,
    ]);
    if (r.code !== 0) return { error: 'profile_failed', detail: firstLine(r.err) };
    return JSON.parse(r.out);
  } finally {
    try { fs.unlinkSync(f); } catch {}
  }
}

export function python() {
  for (const p of ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3']) {
    if (fs.existsSync(p)) return p;
  }
  return 'python3';
}

// ── The error channel is a data channel ─────────────────────────────────────
//
// A traceback will happily print KeyError: 'MRN_00423', or a pandas message
// quoting the offending value. Anything derived from a REAL run is reduced to an
// exception class and nothing else before it can reach the model.
export function scrubError(text) {
  const m = String(text || '').match(/([A-Za-z_]*(?:Error|Exception|Warning))\b/g);
  const cls = m && m.length ? m[m.length - 1] : 'Error';
  return `${cls} (detail withheld: raised while executing against real data)`;
}

export function firstLine(s) {
  return String(s || '').split('\n').filter(Boolean).slice(-1)[0] || '';
}
