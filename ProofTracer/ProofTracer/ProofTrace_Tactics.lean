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

structure ProofTrace where
    steps : Array ProofStep
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
    let goals ← goals.mapM fun g => liftMetaM <| captureGoal g
    return { goals := goals.toArray }


def evalAndTraceTactic (tacticString : String) : TacticM ProofStep := do
    let pre ← captureState

    let env ← getEnv
    let stx ←
        match Parser.runParserCategory env `tactic tacticString with
        | Except.ok stx => pure stx
        | Except.error err => throwError "Could not parse tactic:\n{tacticString}\n\n{err}"

    evalTactic stx

    let post ← captureState

    return {
        preState := pre
        tactic := tacticString
        postState := post
    }


def cleanLines (s : String) : Array String :=
    (s.splitOn "\n")
        |>.map (fun line => line.trimAscii.toString)
        |>.filter (fun line =>
            line != "" && !(line.startsWith "--"))
        |>.toArray


syntax "trace_file " str : tactic

elab_rules : tactic
    | `(tactic| trace_file $path:str) => do
        let path := path.getString

        let content ← IO.FS.readFile path
        let tactics := cleanLines content

        let mut steps : Array ProofStep := #[]

        for tac in tactics do
            let step ← evalAndTraceTactic tac
            steps := steps.push step

            logInfo m!"TACTIC: {tac}"
            logInfo m!"PRE:\n{reprStr step.preState}"
            logInfo m!"POST:\n{reprStr step.postState}"

        let trace : ProofTrace := { steps := steps }

        let json := Json.pretty (toJson trace)

        IO.FS.writeFile "trace.json" json

        logInfo m!"Trace written to trace.json"

end ProofTrace
