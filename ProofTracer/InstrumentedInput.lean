import Mathlib.Data.Nat.GCD.Basic
import Mathlib.Data.Int.Order.Basic
import Mathlib.Tactic
import ProofTracer.ProofTrace

open ProofTrace

-- Helper: if 2 ∣ n^2 then 2 ∣ n (for natural numbers)
theorem two_dvd_of_sq {n : ℕ} (h : 2 ∣ n ^ 2) : 2 ∣ n := by
  trace_step have h2 : Nat.Prime 2 := Nat.prime_iff.mpr ⟨by norm_num, by omega⟩
  trace_step exact (h2.dvd_of_dvd_pow h)

-- Main theorem: √2 is irrational
-- Equivalently: there are no coprime integers p, q with p^2 = 2 * q^2
theorem sqrt2_irrational (p q : ℤ) (hq : q ≠ 0)
    (hcop : Int.gcd p q = 1)
    (heq : p ^ 2 = 2 * q ^ 2) : False := by
  -- Step 1: 2 ∣ p^2
  have hdvd_p2 : (2 : ℤ) ∣ p ^ 2 := ⟨q ^ 2, by linarith⟩
  -- Step 2: 2 ∣ p (since 2 is prime)
  have hprime2 : Prime (2 : ℤ) := Int.prime_iff.mpr ⟨by trace_step norm_num, by
    trace_step intro a b hab
    trace_step have := Int.eq_one_or_self_of_prime 2 (by norm_num) a
    trace_step tauto⟩
  have hdvd_p : (2 : ℤ) ∣ p := hprime2.dvd_of_dvd_pow hdvd_p2
  -- Step 3: write p = 2k
  obtain ⟨k, hk⟩ := hdvd_p
  -- Step 4: substitute into equation → 2 ∣ q^2
  have hdvd_q2 : (2 : ℤ) ∣ q ^ 2 := by
    trace_step use 2 * k ^ 2
    trace_step rw [hk] at heq
    trace_step ring_nf at heq ⊢
    trace_step linarith
  -- Step 5: 2 ∣ q
  have hdvd_q : (2 : ℤ) ∣ q := hprime2.dvd_of_dvd_pow hdvd_q2
  -- Step 6: contradiction with gcd(p,q) = 1
  have : (2 : ℕ) ∣ Int.gcd p q := by
    trace_step apply Int.dvd_gcd
    ·  trace_step exact_mod_cast hdvd_p
    ·  trace_step exact_mod_cast hdvd_q
  rw [hcop] at this
  exact absurd this (by norm_num)
