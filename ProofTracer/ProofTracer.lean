-- This module serves as the root of the `ProofTracer` library.
-- Import modules here that should be built as part of the library.
import ProofTracer.ProofTrace

open ProofTrace

example (p q : Prop) (hp : p) (hq : q) : p ∧ q := by
    trace_step constructor
    trace_step exact hp
    trace_step exact hq
