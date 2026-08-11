#!/usr/bin/env node
// SPHERE MCP server — the privacy boundary, exposed as tools any MCP client can call.
//
// WHAT THIS IS FOR
// An agent (Claude Desktop, Claude Code, Codex) gets a dataset it must analyse but
// must never read. It calls these tools instead of opening the file. It receives a
// format-redacted profile and a certified synthetic twin, develops the analysis
// against the twin, and deploys to the real data — where the USER sees the results
// and the model, by default, does not.
//
// Phase 1 scope: everything up to and including deploy, with the return path from
// real data CLOSED. The discrepancy ladder and the SDC gate come later; the shape
// here is built so they slot onto the same edge.
//
// MCP over stdio is newline-delimited JSON-RPC 2.0 — implemented directly rather
// than pulling in an SDK, because a local privacy boundary is the wrong place to
// add a dependency tree.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { VAULT, scrubbedEnv, sandboxProfile, run, safeProfile, python, scrubError, firstLine } from './boundary.js';

const CLI = process.env.SPHERE_CLI ||
  'sphere';   // set SPHERE_CLI to an absolute path if the CLI is not on PATH

// ── session state (one dataset at a time keeps the mental model honest) ─────
const S = {
  realPath: null,       // never sent to the model
  synthPath: null,      // the model may read this
  dir: null,
  profile: null,
  scores: null,
  ledger: [],           // every crossing, for the attestation
};

const log = (kind, detail) => S.ledger.push({ at: new Date().toISOString(), kind, detail });

function ensureDir() {
  if (!S.dir) {
    S.dir = path.join(VAULT, `session-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(S.dir, { recursive: true });
  }
  return S.dir;
}

// ── tools ───────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'sphere_open',
    description:
      'Register a sensitive CSV with SPHERE. Returns a format-redacted profile: column names, dtypes, distinct counts, missingness, and MASKED format patterns (digits→9, letters→X). No cell values are returned, ever. Use this INSTEAD of reading the file — you will not be given the real data, and you do not need it.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path to the real CSV.' } },
      required: ['path'],
    },
  },
  {
    name: 'sphere_twin',
    description:
      'Generate a certified SPHERE synthetic twin of the registered dataset, and return its fidelity and privacy scores plus the twin CSV path. The twin is safe for you to read and analyse directly. Develop the entire analysis against it.',
    inputSchema: {
      type: 'object',
      properties: { seed: { type: 'integer', description: 'Optional RNG seed for reproducibility.' } },
    },
  },
  {
    name: 'sphere_run',
    description:
      'Run Python against the SYNTHETIC twin and return stdout plus any figures written. The code runs sandboxed with no network and no access to the real data. The twin CSV path is in the environment variable SPHERE_CSV. Iterate here until the analysis is correct.',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'Python source to execute.' } },
      required: ['code'],
    },
  },
  {
    name: 'sphere_deploy',
    description:
      'Run the SAME code against the REAL data. Results are shown to the USER only — you receive nothing but whether it succeeded, the row/column count, and the names of outputs produced. This is intended and correct: you do not need the real results to have done your job. If the user reports that the results look wrong, use sphere_simulate to reproduce the problem on the twin rather than asking to see real values.',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'Python source to execute against real data.' } },
      required: ['code'],
    },
  },
  {
    name: 'sphere_simulate',
    description:
      'Debug a real-data discrepancy WITHOUT seeing real data. Perturbs the twin to inject a hypothesised condition (extra category, added missingness, a column read as string, a small group) and re-runs your code, so you can find out whether that condition reproduces the symptom the user described.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Python source to execute against the perturbed twin.' },
        perturbation: {
          type: 'string',
          enum: ['add_missing', 'add_category', 'as_string', 'tiny_group', 'shuffle_dtypes'],
          description: 'The condition to inject into the twin before running.',
        },
        column: { type: 'string', description: 'Column to perturb (optional; defaults to a sensible choice).' },
      },
      required: ['code', 'perturbation'],
    },
  },
  {
    name: 'sphere_status',
    description:
      'What SPHERE currently holds and, importantly, an audit ledger of every piece of information that has crossed the boundary into your context so far.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ── handlers ────────────────────────────────────────────────────────────────
const ok = (text) => ({ content: [{ type: 'text', text }] });
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

async function sphere_open({ path: p }) {
  if (!p || !fs.existsSync(p)) return fail(`No file at ${p}`);
  S.realPath = path.resolve(p);
  S.synthPath = null;
  S.scores = null;
  ensureDir();
  const prof = await safeProfile(S.realPath);
  if (prof.error) return fail(`Could not profile the file: ${prof.detail}`);
  S.profile = prof;
  log('profile', `${prof.rows} rows x ${prof.cols} cols — shapes only, no values`);
  return ok(
    `Registered. ${prof.rows} rows x ${prof.cols} columns.\n\n` +
      `This profile contains NO cell values — format_examples are masked (digits→9, letters→X).\n\n` +
      JSON.stringify(prof.columns, null, 2) +
      `\n\nNext: call sphere_twin to get a synthetic twin you can actually analyse.`,
  );
}

async function sphere_twin({ seed }) {
  if (!S.realPath) return fail('Nothing registered. Call sphere_open first.');
  const dir = ensureDir();
  const synth = path.join(dir, 'twin.csv');
  if (!CLI || (CLI !== 'sphere' && !fs.existsSync(CLI))) {
    return fail(
      `The SPHERE CLI was not found at "${CLI}". Set SPHERE_CLI to its absolute path ` +
        `(in the mcpServers env block for your client), or put "sphere" on PATH.`,
    );
  }
  const gen = await run(process.execPath, [
    CLI, 'generate', S.realPath, '-o', synth, '--json', ...(seed != null ? ['--seed', String(seed)] : []),
  ]);
  if (gen.code !== 0 || !fs.existsSync(synth)) {
    return fail(`Twin generation failed: ${firstLine(gen.err) || firstLine(gen.out)}`);
  }
  S.synthPath = synth;
  const ev = await run(process.execPath, [CLI, 'evaluate', S.realPath, synth, '--json']);
  let scores = null;
  try { scores = JSON.parse(ev.out); } catch { /* evaluate is advisory here */ }
  S.scores = scores;
  log('twin', 'synthetic twin released to the model');
  const fid = scores?.fidelity?.composite, priv = scores?.privacy?.composite;
  return ok(
    `Twin ready: ${synth}\n` +
      (fid != null ? `Fidelity ${Number(fid).toFixed(1)}/100` : 'Fidelity n/a') +
      (priv != null ? ` · Privacy ${Number(priv).toFixed(1)}/100\n` : '\n') +
      `\nThis file is synthetic and safe to read directly. Develop your analysis with sphere_run, ` +
      `then call sphere_deploy to run the finished code on the real data.`,
  );
}

function writeScript(dir, code) {
  const f = path.join(dir, `cell-${randomUUID().slice(0, 8)}.py`);
  fs.writeFileSync(f, code);
  return f;
}

function newFigures(dir, before) {
  return fs.readdirSync(dir).filter((f) => /\.(png|jpg|jpeg|svg|pdf)$/i.test(f) && !before.has(f));
}

async function execIn(dir, csvPath, code) {
  const script = writeScript(dir, code);
  const before = new Set(fs.readdirSync(dir));
  const prof = path.join(dir, 'sandbox.sb');
  fs.writeFileSync(prof, sandboxProfile({ sessionDir: dir, synthPath: csvPath }));
  const env = { ...scrubbedEnv(), SPHERE_CSV: csvPath };
  const r = await run('/usr/bin/sandbox-exec', ['-f', prof, python(), script], { cwd: dir, env });
  return { ...r, figures: newFigures(dir, before) };
}

async function sphere_run({ code }) {
  if (!S.synthPath) return fail('No twin yet. Call sphere_twin first.');
  const r = await execIn(ensureDir(), S.synthPath, code);
  log('run', 'code executed against the twin (synthetic)');
  const figs = r.figures.length ? `\n\nFigures written: ${r.figures.join(', ')}` : '';
  if (r.code !== 0) return fail(`Exited ${r.code}\n\nSTDERR:\n${r.err.slice(-4000)}${figs}`);
  return ok(`${r.out.slice(-8000) || '(no stdout)'}${figs}`);
}

async function sphere_deploy({ code }) {
  if (!S.realPath) return fail('Nothing registered. Call sphere_open first.');
  const dir = ensureDir();
  // ⚠️ The staged real file MUST NOT live under the session dir.
  // sphere_run's sandbox allows reading the whole session dir (it needs to, for
  // scripts and figures), so staging real.csv there put the real data inside the
  // one directory the twin sandbox can read. Serializing tool calls removes the
  // timing window, but a boundary that depends on scheduling is not a boundary.
  // It gets its own directory, which only the deploy profile is told about.
  const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-real-'));
  const staged = path.join(realDir, 'real.csv');
  fs.copyFileSync(S.realPath, staged);
  const outDir = path.join(realDir, 'output');
  fs.mkdirSync(outDir, { recursive: true });
  let realStdout = null;
  try {
    const r = await execIn(outDir, staged, code);
    realStdout = (r.out || '') + (r.err ? `\n--- stderr ---\n${r.err}` : '');
    log('deploy', 'code executed against REAL data — results withheld from the model');
    if (r.code !== 0) {
      // ⚠️ The traceback is derived from real data and may quote a real value.
      // Reduce it to an exception class; the user sees the full error locally.
      return fail(
        `The run FAILED on real data.\n\n${scrubError(r.err)}\n\n` +
          `The full error is visible to the user, not to you. To debug, form a hypothesis about ` +
          `how the real data differs from the twin and test it with sphere_simulate.`,
      );
    }
    return ok(
      `Completed on real data.\n` +
        `The user's results are in ${dir}: real-output.txt` +
        (r.figures.length ? ` and ${r.figures.map((f) => 'real-' + f).join(', ')}` : '') + `\n\n` +
        `Results are deliberately not returned to you. Ask the user whether they look sensible. ` +
        `If not, use sphere_simulate rather than requesting real values.`,
    );
  } finally {
    // Shred the staged copy; the user's outputs survive, copied to the session dir.
    // ⚠️ stdout MUST be written out too. The model is denied the real results by
    // design — but the USER is entitled to them, and an earlier version discarded
    // stdout entirely, so a printed table or p-value vanished for everyone. Only
    // figures survived, which made the whole "you see it, the model doesn't"
    // promise false in the one direction that matters.
    try {
      for (const f of fs.readdirSync(outDir)) {
        if (f.endsWith('.py') || f === 'sandbox.sb') continue;
        fs.copyFileSync(path.join(outDir, f), path.join(dir, `real-${f}`));
      }
    } catch {}
    try {
      if (realStdout != null) {
        fs.writeFileSync(path.join(dir, 'real-output.txt'), realStdout);
      }
    } catch {}
    try { fs.rmSync(realDir, { recursive: true, force: true }); } catch {}
  }
}

const PERTURB = {
  add_missing: (c) => `df.loc[df.sample(frac=0.25, random_state=1).index, ${c}] = None`,
  add_category: (c) => `df.loc[df.sample(n=max(1,int(len(df)*0.02)), random_state=1).index, ${c}] = "__UNSEEN__"`,
  as_string: (c) => `df[${c}] = df[${c}].astype(str)`,
  tiny_group: (c) => `df.loc[df.sample(n=1, random_state=1).index, ${c}] = "__RARE__"`,
  shuffle_dtypes: () => `df = df.astype({c: "object" for c in df.columns[:3]})`,
};

async function sphere_simulate({ code, perturbation, column }) {
  if (!S.synthPath) return fail('No twin yet. Call sphere_twin first.');
  const fn = PERTURB[perturbation];
  if (!fn) return fail(`Unknown perturbation. One of: ${Object.keys(PERTURB).join(', ')}`);
  const col = column ? JSON.stringify(column) : 'df.columns[0]';
  const dir = ensureDir();
  const perturbed = path.join(dir, 'twin-perturbed.csv');
  const prep = `
import pandas as pd, os
df = pd.read_csv(os.environ['SPHERE_CSV'], low_memory=False)
${fn(col)}
df.to_csv(${JSON.stringify(perturbed)}, index=False)
print("perturbed:", ${JSON.stringify(perturbation)})
`;
  const p = await execIn(dir, S.synthPath, prep);
  if (p.code !== 0) return fail(`Could not perturb the twin: ${p.err.slice(-1500)}`);
  const r = await execIn(dir, perturbed, code);
  log('simulate', `twin perturbed (${perturbation}) to reproduce a real-data symptom`);
  const figs = r.figures.length ? `\n\nFigures: ${r.figures.join(', ')}` : '';
  if (r.code !== 0) {
    return ok(
      `Perturbation "${perturbation}" REPRODUCED a failure on the twin — this is likely your bug.\n\n` +
        `STDERR:\n${r.err.slice(-4000)}${figs}`,
    );
  }
  return ok(`Perturbation "${perturbation}" ran cleanly (did not reproduce the symptom).\n\n${r.out.slice(-6000)}${figs}`);
}

async function sphere_status() {
  return ok(
    JSON.stringify(
      {
        registered: S.realPath ? path.basename(S.realPath) : null,
        real_path_visible_to_model: false,
        twin: S.synthPath || null,
        scores: S.scores ? { fidelity: S.scores.fidelity?.composite, privacy: S.scores.privacy?.composite } : null,
        boundary_ledger: S.ledger,
      },
      null,
      2,
    ),
  );
}

const IMPL = { sphere_open, sphere_twin, sphere_run, sphere_deploy, sphere_simulate, sphere_status };

// ── JSON-RPC over stdio ─────────────────────────────────────────────────────
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

// Tool calls run one at a time; see tools/call below.
let queue = Promise.resolve();

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'sphere', version: '0.1.0' },
      },
    });
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    const fn = IMPL[params?.name];
    if (!fn) return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown tool ${params?.name}` } });
    try {
      // SERIALIZED. Every tool mutates the shared session (which file is
      // registered, which twin is current), so two in flight at once means one
      // reads state the other has not written yet — sphere_run landing before
      // sphere_twin finished and reporting "no twin". Clients usually call in
      // sequence, but "usually" is not a concurrency model.
      const result = await (queue = queue.then(() => fn(params.arguments || {}), () => fn(params.arguments || {})));
      return send({ jsonrpc: '2.0', id, result });
    } catch (e) {
      // Never let a stack trace out — it may name a real path or a real value.
      return send({ jsonrpc: '2.0', id, result: fail(`sphere: ${scrubError(e && e.message)}`) });
    }
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } });
}

let buf = '';
// In-flight count, because a tool call is async and stdin can end first. Piping a
// file of requests (which is how this gets tested) closes stdin immediately, and
// exiting on 'end' truncated every pending response. Claude Desktop holds stdin
// open so it would have hidden there — right up until it did not.
let pending = 0;
let stdinEnded = false;
const maybeExit = () => { if (stdinEnded && pending === 0) process.exit(0); };

process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    pending++;
    Promise.resolve(handle(msg))
      .catch(() => {})
      .finally(() => { pending--; maybeExit(); });
  }
});
process.stdin.on('end', () => { stdinEnded = true; maybeExit(); });
