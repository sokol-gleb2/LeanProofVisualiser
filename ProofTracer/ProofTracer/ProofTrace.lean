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
    preState  : ProofStateSnapshot
    tactic    : String
    postState : ProofStateSnapshot
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

def evalAndTraceTactic (tac : Syntax) : TacticM ProofStep := do
    let pre ← captureState
    evalTactic tac
    let post ← captureState

    return {
        preState := pre
        tactic := toString tac
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
