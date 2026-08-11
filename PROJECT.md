# SPHERE MCP — project goal, plan, and current state

Written 2026-08-11 as a handover. If you are picking this up: read *The idea* and
*Where it stands*, then run the tests. They are the fastest way to understand what
the boundary actually does, because they attack it.

---

## The idea

An AI agent is very good at writing analysis code and very bad at being allowed
near patient data. Today the answer in a hospital or a pharma company is "no" —
so the researcher either doesn't use the agent, or copies data somewhere it
shouldn't be.

This project makes the answer "yes, under these conditions":

> The model develops the analysis against a **synthetic twin**, deploys the finished
> code to the **real data**, and the *user* sees the real results. The model does not.

The model never receives an individual record, and that is enforced by the tool
surface and an OS sandbox — not by asking it nicely in a prompt.

It runs as an **MCP server**, so it works with Claude Desktop, Claude Code, Codex
CLI and Cursor without SPHERE having to own the chat interface or pick a model.

### Why this shape

- **A prompt is not a control.** A system message telling a model not to look at
  data is a request. The guarantee has to live in code that decides which bytes
  the model can receive and which files its code can open.
- **The user is the data controller, not the model.** Asymmetric visibility —
  the human sees everything, the model sees an approved subset — is the correct
  power structure, and it is what makes an attestation meaningful.
- **Model-agnostic beats model-bundled.** Riding whatever agent the researcher
  already uses is a much larger market than asking them to switch.

---

## Where it stands (Phase 1 — working)

End-to-end loop, tested against a real dataset:

```
sphere_open  → format-redacted profile (shapes only, no cell values)
sphere_twin  → certified synthetic twin + fidelity/privacy scores
sphere_run   → analysis against the twin, full results to the model
sphere_deploy→ same code against real data; results to the USER, not the model
sphere_simulate → debug a real-data discrepancy by perturbing the twin
sphere_status→ audit ledger of everything that crossed into the model's context
```

**Verified by attacking it**, not by exercising it — `node test/boundary.test.mjs`:
reading the real CSV by path and via pandas, listing the home directory, opening a
socket, harvesting credentials, and writing outside the session directory are all
blocked; reading the twin is allowed.

### Three bugs the testing found, worth knowing about

1. **Exit on stdin end truncated in-flight responses.** Claude Desktop holds stdin
   open, so this would have hidden indefinitely and only appeared under a
   different client.
2. **Concurrent tool calls raced on shared session state** — `sphere_run` arrived
   before `sphere_twin` finished. Tool calls are serialized now.
3. **`sphere_deploy` discarded stdout**, so a printed table vanished for *everyone*,
   breaking the core promise in the one direction that matters. The user now gets
   `real-output.txt`.

### Two testing traps that produced false results

Both cost real time and will catch you too:

- **"Did it error?" is the wrong criterion.** A denied *file read* raises; a denied
  *directory listing* returns empty; a scrubbed environment yields an empty key
  list. One criterion for all three reported two leaks that did not exist.
- **A traceback echoes the offending source line.** Asserting `!/CONNECTED/` on the
  output fails when the *code* contains `print('CONNECTED')`. Never assert on a
  success sentinel that appears in the source.

---

## The plan from here

### Phase 2 — the discrepancy ladder
The return path from real data is currently **closed**, not gated. That is the
right default: in the common case the model receives *nothing* derived from real
data. When the user says "these results look wrong", the model should:

1. hypothesise a cause and use `sphere_simulate` to reproduce it on the twin
   (already built — this is the primary tool and needs the most work);
2. if that fails, request **level 1** — structural diff only: row counts, column
   sets, dtypes, missingness, number of groups. Non-disclosive;
3. escalate further only with explicit user action.

Teach the model the ladder exists and to start at the bottom, or it will default
to "please show me the output".

### Phase 3 — the SDC gate
Statistical Disclosure Control: the discipline of deciding whether an *aggregate*
leaks an individual. Needed the moment any real result flows back to the model.

Design notes:
- Make egress explicit — nothing leaves the sandbox unless code calls
  `sphere.publish(obj)`. Then you are applying rules to structured objects, not
  scanning arbitrary stdout and PNGs. This is the single highest-value change.
- Floor rules that no human click can override: no min/max, no raw row dumps,
  no n=1 cells.
- **Grow the gate from the approval log.** What users approve or reject tells you
  which rules to write first; you do not have to design SDC up front.
- Prior art worth reading: the Five Safes framework, and how trusted research
  environments (ONS SRS, OpenSAFELY, HDR UK) do output checking — currently with
  humans, which is the bottleneck this could remove.

### Phase 4 — the monitor
Live view of what entered the model's context, what ran where, what was blocked,
and how many real-data runs happened; exports a signed attestation. For a DPO or
an IRB, this artifact is arguably the product.

### Phase 5 — Linux
The sandbox is macOS Seatbelt. Any institutional deployment is Linux, so this
needs bubblewrap, a container, or a separate OS user. **On the critical path for
the enterprise story**, not a nice-to-have.

---

## Known limits (do not overclaim)

- **No SDC gate yet.** Nothing real flows back today, which is why the current
  claim holds. It stops holding the moment Phase 2 opens a return path.
- **Other tools bypass everything.** This server controls only its own tools. If
  the client also has shell or filesystem access to the real file, the boundary is
  a convention. Claude Desktop has no filesystem tool by default, which is why it
  is the best first target. Claude Code needs a deny rule; institutions need a
  separate OS user or container.
- **Column names reach the model.** Alias them if a name is itself sensitive.
- **macOS only.**
- **A twin is not automatically non-disclosive.** Evaluate each one; extreme values
  deserve particular attention before sharing a twin.

---

## Architecture

```
src/boundary.js   the controls: sandbox profile, scrubbed env, safe profiler,
                  error scrubbing. Everything that decides what may be seen.
src/server.js     MCP over stdio (newline-delimited JSON-RPC 2.0), the six tools,
                  session state, the audit ledger.
test/             attacks, with per-mechanism pass criteria.
```

Zero runtime dependencies, deliberately: MCP stdio is simple enough to implement
directly, and a local privacy boundary is the wrong place to add a supply chain.

Twin generation and scoring shell out to the SPHERE CLI (`SPHERE_CLI`), so the
synthesis method stays in its own sealed binary and is not part of this repo.

### Where to start reading
`src/boundary.js` first — it is short, and it is where the guarantee lives.
Then `test/boundary.test.mjs`, which tells you what is actually enforced rather
than what is intended.
