import { useSyncExternalStore } from "react"
import type { AgentProposal, AgentSelection } from "./api.ts"
import { getToken, runAgent } from "./api.ts"
import type { ElementAnchor } from "./inky/window.tsx"

// Inky's conversation, held outside the component that shows it.
//
// It used to live in the panel's own useState, so it died whenever the panel
// did: closing the dock, opening the full AI screen, or following one of Inky's
// own "take me there" links to look at an image all unmounted it, and the
// person came back to a blank "Hi, I'm Inky". A conversation is the person's,
// not the panel's. So it lives here, survives a remount, keeps streaming while
// nothing is mounted to show it, and is mirrored to sessionStorage so a reload
// does not end it either.
//
// sessionStorage rather than localStorage on purpose: a proposal can carry what
// someone pasted into the chat (a client secret for a social app), and that
// should end with the tab rather than sit on disk. It is also per sign-in — see
// `owner` — so one person's conversation is never shown to the next.

export type Turn = {
  id: string
  role: "you" | "agent"
  text: string
  targetLabel?: string
  tools: { id: string; name: string }[]
}
export type Decision = "applied" | "dismissed"
export type InkyContext = { screen: string; type?: string; entryId?: string; selection?: AgentSelection }

type State = {
  // The tail of the session token it belongs to. A new sign-in is a new person
  // as far as this is concerned.
  readonly owner: string
  readonly turns: Turn[]
  // What the model is sent back each turn. Opaque to the browser.
  readonly history: unknown[]
  readonly proposals: AgentProposal[]
  readonly decided: Record<string, Decision>
  readonly draft: string
  readonly running: boolean
  readonly target: AgentSelection | null
}

const KEY = "inkling.inky.v1"
const MAX_TURNS = 80
const MAX_BYTES = 2_500_000

export const marker = (): string => Math.random().toString(36).slice(2, 10)

const ownerNow = (): string => getToken()?.slice(-16) ?? ""

const blank = (): State => ({
  owner: ownerNow(),
  turns: [],
  history: [],
  proposals: [],
  decided: {},
  draft: "",
  running: false,
  target: null,
})

const read = (): State => {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return blank()
    const saved = JSON.parse(raw) as Partial<State>
    if (saved.owner !== ownerNow() || !Array.isArray(saved.turns)) return blank()

    const turns = saved.turns
    // A reload mid-answer leaves an agent turn nothing will ever finish. Say so
    // rather than showing an empty bubble above a spinner that never stops.
    const last = turns[turns.length - 1]
    if (saved.running && last && last.role === "agent" && last.text === "" && last.tools.length === 0) {
      turns[turns.length - 1] = { ...last, text: "That was interrupted before I could answer. Send it again." }
    }
    return {
      owner: saved.owner,
      turns,
      history: Array.isArray(saved.history) ? saved.history : [],
      proposals: Array.isArray(saved.proposals) ? saved.proposals : [],
      decided: saved.decided && typeof saved.decided === "object" ? saved.decided : {},
      draft: typeof saved.draft === "string" ? saved.draft : "",
      running: false,
      target: null,
    }
  } catch {
    return blank()
  }
}

let state: State = read()
const listeners = new Set<() => void>()

// Deltas arrive many times a second; writing a few hundred kilobytes to storage
// on each one would be the slowest part of an answer.
let pending: ReturnType<typeof setTimeout> | null = null

const persist = (): void => {
  pending = null
  try {
    let turns = state.turns.slice(-MAX_TURNS)
    let body = JSON.stringify({ ...state, turns })
    // Over budget: the transcript the model is sent is the bulk of it, and the
    // visible conversation matters more than the model's memory of it.
    if (body.length > MAX_BYTES) body = JSON.stringify({ ...state, turns, history: [] })
    if (body.length > MAX_BYTES) {
      turns = turns.slice(-20)
      body = JSON.stringify({ ...state, turns, history: [], proposals: [] })
    }
    sessionStorage.setItem(KEY, body)
  } catch {
    // Storage full or blocked: the conversation still works, it just will not
    // survive a reload.
  }
}

const schedule = (): void => {
  if (pending === null) pending = setTimeout(persist, 400)
}

const set = (change: Partial<State> | ((current: State) => Partial<State>)): void => {
  state = { ...state, ...(typeof change === "function" ? change(state) : change) }
  schedule()
  for (const listener of listeners) listener()
}

if (typeof window !== "undefined") {
  const flush = () => {
    if (pending !== null) clearTimeout(pending)
    persist()
  }
  window.addEventListener("pagehide", flush)
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush())
}

const snapshot = (): State => {
  // Signed out and in as someone else, with no reload between: start clean.
  if (state.owner !== ownerNow()) state = blank()
  return state
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const useInky = (): State => useSyncExternalStore(subscribe, snapshot)

// The same state without a component, for the places that are not one.
export const readInky = snapshot

export const setDraft = (draft: string): void => set({ draft })

export const selectTarget = (target: AgentSelection | null): void => set({ target })
export const askTarget = (target: AgentSelection, anchor?: ElementAnchor, restore?: () => void): void => {
  selectTarget(target)
  window.dispatchEvent(new CustomEvent("inkling:ask", { detail: { target, anchor, restore } }))
}

export const activityLabel = (name: string): string => {
  if (name.startsWith("propose_")) return "Preparing a change"
  const labels: Record<string, string> = {
    get_entry: "Reading a page",
    list_entries: "Finding pages",
    list_content_types: "Checking page controls",
    list_media: "Finding images",
    get_site_settings: "Reading website details",
    list_menus: "Reading navigation",
    get_visual_pages: "Checking page sections",
    open_screen: "Opening the editor",
  }
  return labels[name] ?? "Checking your website"
}

export const decide = (id: string, decision: Decision): void =>
  set(current => ({ decided: { ...current.decided, [id]: decision } }))

export const newConversation = (): void => {
  if (state.running) return
  set({ ...blank(), target: state.target })
}

// What the running stream needs from whatever is on screen. It is the *latest*
// mounted panel's, looked up when an event arrives rather than captured when
// the question was sent — the panel that asked may be gone by then.
export type Bridge = {
  readonly toast: (message: string, bad?: boolean) => void
  readonly onProposal: (proposal: AgentProposal) => void
}

let bridge: Bridge | null = null

export const attach = (next: Bridge): (() => void) => {
  bridge = next
  return () => {
    if (bridge === next) bridge = null
  }
}

export const send = async (context: InkyContext | undefined): Promise<void> => {
  const message = snapshot().draft.trim()
  if (!message || state.running) return

  set(current => ({
    draft: "",
    running: true,
    turns: [
      ...current.turns,
      { id: marker(), role: "you", text: message, targetLabel: context?.selection?.label, tools: [] },
      { id: marker(), role: "agent", text: "", tools: [] },
    ],
  }))

  // The last turn is always the agent's, so every event folds into it.
  const onto = (change: (turn: Turn) => Turn) =>
    set(current => ({
      turns: current.turns.map((turn, index) => (index === current.turns.length - 1 ? change(turn) : turn)),
    }))

  // keep failures in the conversation after the toast disappears.
  const complain = (text: string) => {
    bridge?.toast(text, true)
    onto(turn => ({ ...turn, text: `${turn.text}${turn.text ? "\n\n" : ""}${text}` }))
  }

  const history = state.history
  try {
    const outcomes = state.proposals
      .filter(proposal => state.decided[proposal.id])
      .slice(-20)
      .map(proposal => `${state.decided[proposal.id]}: ${proposal.summary}`)
      .join("\n")
      .slice(0, 4000)
    await runAgent({ message, history, outcomes, ...context }, event => {
      switch (event.type) {
        case "text":
          onto(turn => ({ ...turn, text: turn.text + event.text }))
          break
        case "tool":
          onto(turn => ({ ...turn, tools: [...turn.tools, { id: marker(), name: event.name }] }))
          break
        case "proposal":
          set(current => ({ proposals: [...current.proposals, event.proposal] }))
          bridge?.onProposal(event.proposal)
          break
        case "done":
          set({ history: event.history })
          break
        case "error":
          complain(event.message)
          break
      }
    })
  } catch (error) {
    complain(error instanceof Error ? error.message : "Something went wrong")
  } finally {
    set({ running: false })
  }
}
