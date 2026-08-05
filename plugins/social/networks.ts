import type { FieldOption } from "../../src/fields/index.ts"

// The networks a post can go out on, in one place because four different things
// need the same list: the channel type's `network` select, the post type's
// `networks` multiselect, the per-network variant rows, and the report that
// groups results by network.

export type Network = {
  readonly value: string
  readonly label: string
  // What the network truncates a caption to. Shown as help text on the
  // composer rather than enforced — a caption is often written long and cut
  // down per network, and a hard limit would fight the way copy is drafted.
  readonly limit: number
}

export const NETWORKS: readonly Network[] = [
  { value: "instagram", label: "Instagram", limit: 2_200 },
  { value: "facebook", label: "Facebook", limit: 63_206 },
  { value: "tiktok", label: "TikTok", limit: 2_200 },
  { value: "linkedin", label: "LinkedIn", limit: 3_000 },
  { value: "x", label: "X", limit: 280 },
  { value: "youtube", label: "YouTube", limit: 5_000 },
  { value: "pinterest", label: "Pinterest", limit: 500 },
  { value: "threads", label: "Threads", limit: 500 },
  { value: "googlebusiness", label: "Google Business", limit: 1_500 },
  { value: "newsletter", label: "Newsletter", limit: 100_000 },
]

export const NETWORK_OPTIONS: readonly FieldOption[] = NETWORKS.map(({ value, label }) => ({ value, label }))

const BY_VALUE = new Map(NETWORKS.map(network => [network.value, network]))

export const networkLabel = (value: string): string => BY_VALUE.get(value)?.label ?? value

export const labelNetworks = (values: unknown): string =>
  Array.isArray(values) ? values.map(value => networkLabel(String(value))).join(" · ") : ""

// A caption that exceeds the shortest selected network's limit is the single
// mistake worth flagging on a table row — everything else about a draft is a
// judgement call, but this one is arithmetic.
export const overLimit = (networks: unknown, caption: string): string[] => {
  if (!Array.isArray(networks)) return []
  return networks
    .map(value => BY_VALUE.get(String(value)))
    .filter((network): network is Network => network !== undefined)
    .filter(network => caption.length > network.limit)
    .map(network => network.label)
}
