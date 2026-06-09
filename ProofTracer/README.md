# ProofTracer

This package traces Lean tactics into `trace.jsonl` entries with:

- `preState`: goals and local context before the tactic
- `tactic`: the tactic text that was evaluated
- `postState`: goals and local context after the tactic

There are two parts:

- [ProofTracer/ProofTrace.lean](/Users/glebsokolovski/Desktop/UNI/lean-visualiser/ProofTracer/ProofTracer/ProofTrace.lean:1) defines the `trace_step` tactic.
- [instrument_lean.py](/Users/glebsokolovski/Desktop/UNI/lean-visualiser/ProofTracer/instrument_lean.py:1) rewrites ordinary Lean proofs by inserting `trace_step` before tactics inside `by` blocks.

## Python rewrite pipeline

From the `ProofTracer` directory:

```bash
lake build
python3 extract_trace.py TestInput.lean
```

That does:

1. Read `TestInput.lean`
2. Insert `import ProofTracer.ProofTrace`, `open ProofTrace`, and `trace_step ...`
3. Write `InstrumentedInput.lean`
4. Run `lake env lean InstrumentedInput.lean`
5. Produce `trace.jsonl`

If you only want the rewritten Lean file without running Lean:

```bash
python3 instrument_lean.py TestInput.lean InstrumentedInput.lean
```

## What the Python instrumenter handles

- Top-level `:= by` proofs
- Nested `have ... := by` and similar subproofs
- One-line proofs like `by simp`
- Bullet lines like `· exact h`

## Current limitations

This is still a text rewriter, not a Lean parser. It is reliable for indentation-based tactic scripts, but it will miss or mis-handle some shapes:

- tactics hidden inside complex syntax combinators
- proofs written primarily as terms instead of tactic lines
- unusual formatting where indentation does not reflect tactic nesting

If you need full coverage, the robust solution is to instrument at the syntax/elaboration level in Lean rather than rewriting source text in Python.
