export type CreationState = { step: "location" | "options" | "preview" | "preparation"; picking: boolean };
export type CreationAction = { type: "pick" } | { type: "return" } | { type: "step"; step: CreationState["step"] };
export function creationReducer(state: CreationState, action: CreationAction): CreationState {
  if (action.type === "step") return { step: action.step, picking: false };
  return { ...state, picking: action.type === "pick" };
}
