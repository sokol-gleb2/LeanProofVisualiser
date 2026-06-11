import Lean

open Lean
open Lean.Elab
open Lean.Elab.Tactic
open Lean.Meta

namespace ProofTrace

structure Hypothesis where
    userName : Name
    type     : String
deriving Inhabited, Repr, ToJson, FromJson

structure GoalSnapshot where
    goalId  : String
    target  : String
    context : Array Hypothesis
deriving Inhabited, Repr, ToJson, FromJson

structure ProofStateSnapshot where
    goals : Array GoalSnapshot
deriving Inhabited, Repr, ToJson, FromJson

structure ProofStep where
    preState      : ProofStateSnapshot
    tactic        : String          -- raw syntax fallback
    tacticText    : String          -- readable tactic
    tacticKind    : String          -- e.g. "have", "rw", "exact"
    postState     : ProofStateSnapshot
deriving Inhabited, Repr, ToJson, FromJson

def exprToString (e : Expr) : MetaM String := do
    return toString (← ppExpr e)

def captureContext (goal : MVarId) : MetaM (Array Hypothesis) := do
    goal.withContext do
        let lctx ← getLCtx
        let mut hyps := #[]
        for decl in lctx do
            if !decl.isImplementationDetail then
                let typeStr ← exprToString decl.type
                hyps := hyps.push {
                    userName := decl.userName
                    type := typeStr
                }
        return hyps

def captureGoal (goal : MVarId) : MetaM GoalSnapshot := do
    goal.withContext do
        let target ← goal.getType
        let targetStr ← exprToString target
        let ctx ← captureContext goal
        return {
            goalId := toString goal.name
            target := targetStr
            context := ctx
        }

def captureState : TacticM ProofStateSnapshot := do
    let goals ← getGoals
    let goalSnapshots ← goals.mapM fun g =>
        liftMetaM <| captureGoal g
    return { goals := goalSnapshots.toArray }

def prettyTactic (tac : Syntax) : TacticM String := do
    let fmt ← PrettyPrinter.ppCategory `tacticSeq tac
    return fmt.pretty

def lastNamePart (n : Name) : String :=
    match n with
    | Name.str _ s => s
    | Name.num p _ => lastNamePart p
    | Name.anonymous => "unknown"

def nameStr (n : Name) : String :=
    toString n

def kindMatches (stx : Syntax) (needle : String) : Bool :=
    (nameStr stx.getKind).contains needle

mutual

partial def findFirstChildKind (stx : Syntax) : String :=
    match stx with
    | Syntax.node _ _ args =>
        let rec loop (i : Nat) : String :=
            if h : i < args.size then
                let r := findTacticKind args[i]
                if r == "unknown" then loop (i + 1) else r
            else
                "unknown"
        loop 0
    | _ => "unknown"

partial def findTacticKind (stx : Syntax) : String :=
    if kindMatches stx "tacticHave" then
        "have"
    else if kindMatches stx "tacticLet" then
        "let"
    else if kindMatches stx "rw" then
        "rw"
    else if kindMatches stx "exact" then
        "exact"
    else if kindMatches stx "apply" then
        "apply"
    else if kindMatches stx "use" then
        "use"
    else if kindMatches stx "simp" then
        "simp"
    else if kindMatches stx "ring_nf" then
        "ring_nf"
    else if kindMatches stx "norm_num" then
        "norm_num"
    else if kindMatches stx "constructor" then
        "constructor"
    else
        findFirstChildKind stx

end


def evalAndTraceTactic (tac : Syntax) : TacticM ProofStep := do
    let pre ← captureState

    let tacticText ← prettyTactic tac
    let tacticKind := findTacticKind tac
    let rawTactic := toString tac

    evalTactic tac

    let post ← captureState

    return {
        preState := pre
        tactic := rawTactic
        tacticText := tacticText
        tacticKind := tacticKind
        postState := post
    }

def appendJsonLine (path : System.FilePath) (step : ProofStep) : TacticM Unit := do
    let jsonText := Json.compress (toJson step)

    let oldContent ←
        if (← path.pathExists) then
            IO.FS.readFile path
        else
            pure ""

    IO.FS.writeFile path (oldContent ++ jsonText ++ "\n")

syntax "trace_step " tacticSeq : tactic

elab_rules : tactic
    | `(tactic| trace_step $tac:tacticSeq) => do
        let step ← evalAndTraceTactic tac
        appendJsonLine "trace.jsonl" step

end ProofTrace
