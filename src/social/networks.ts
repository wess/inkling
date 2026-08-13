// The networks Inkling can post to, and everything that differs between them
// that is not a line of code: what a caption may be, what media is allowed,
// which OAuth endpoints to use, the handful of fields each one has that no
// other one does, and what an operator has to do at that network's end before
// any of it works.
//
// A network belongs here when it can be *published* to, not when it can be
// authorized. A connect button leading to a screen where nothing sends is the
// failure this file exists to prevent. Adding one is a publisher in
// ./publishers plus an entry below, in that order.

export type NetworkOption = {
  readonly key: string
  readonly label: string
  readonly type: "text" | "textarea" | "select" | "boolean"
  readonly choices?: readonly { readonly value: string; readonly label: string }[]
  readonly fallback?: string | boolean
  readonly help?: string
}

export type MediaRule = {
  // How many images may ride along. 0 means the network takes none.
  readonly images: number
  readonly video: boolean
  // A network that will not accept a text-only post: a video host, or a pinboard.
  readonly requiresMedia: false | "video" | "image" | "any"
  // Whether an image alongside a video means something. Everywhere but Pinterest
  // it does not, and sending both is a late, confusing refusal — Pinterest's
  // video pin *needs* a still, and will not generate one.
  readonly coverImage?: true
}

export type NetworkOAuth = {
  readonly authorizeUrl: string
  readonly tokenUrl: string
  readonly scopes: readonly string[]
  // Extra authorize-time parameters this network insists on.
  readonly extra?: Record<string, string>
}

export type Network = {
  readonly value: string
  readonly label: string
  // What the network truncates a caption to. Enforced when a post is saved with
  // that network selected, because unlike a planning view this is copy about to
  // be sent — a caption cut in half by the network is worse than a save that
  // says so.
  readonly limit: number
  readonly media: MediaRule
  readonly oauth: NetworkOAuth
  readonly options: readonly NetworkOption[]
  // Whether this network fetches media from your site rather than being handed
  // the bytes. The ones that do cannot work from an install whose PUBLIC_URL is
  // not reachable, and that is worth saying before someone tries.
  readonly fetchesMedia: boolean
  // Shown on the settings screen, next to the fields. Every one of these needs a
  // developer app and the awkward part differs for each.
  readonly help: string
  // Where the app is registered. A link, because nobody finds these by guessing.
  readonly console: string
}

export const NETWORKS: readonly Network[] = [
  {
    value: "x",
    label: "X",
    limit: 280,
    media: { images: 4, video: true, requiresMedia: false },
    oauth: {
      authorizeUrl: "https://x.com/i/oauth2/authorize",
      tokenUrl: "https://api.x.com/2/oauth2/token",
      // media.write is what makes an image or a video possible; without it the
      // connection works and every post with an attachment fails at upload.
      scopes: ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"],
    },
    options: [
      {
        key: "replySettings",
        label: "Who can reply",
        type: "select",
        fallback: "everyone",
        choices: [
          { value: "everyone", label: "Everyone" },
          { value: "following", label: "Accounts you follow" },
          { value: "mentionedUsers", label: "Only accounts you mention" },
        ],
      },
    ],
    fetchesMedia: false,
    help: "An OAuth 2.0 app with a user-context client id. Type 'Web App' — a confidential client, so it has a secret.",
    console: "https://developer.x.com/en/portal/dashboard",
  },
  {
    value: "facebook",
    label: "Facebook",
    limit: 63_206,
    media: { images: 10, video: true, requiresMedia: false },
    oauth: {
      authorizeUrl: "https://www.facebook.com/v21.0/dialog/oauth",
      tokenUrl: "https://graph.facebook.com/v21.0/oauth/access_token",
      scopes: ["pages_manage_posts", "pages_read_engagement", "pages_show_list"],
    },
    options: [],
    fetchesMedia: true,
    help: "Posts to a Page, never a profile. The account you authorize must manage at least one Page.",
    console: "https://developers.facebook.com/apps",
  },
  {
    value: "instagram",
    label: "Instagram",
    limit: 2_200,
    media: { images: 10, video: true, requiresMedia: "any" },
    oauth: {
      authorizeUrl: "https://www.facebook.com/v21.0/dialog/oauth",
      tokenUrl: "https://graph.facebook.com/v21.0/oauth/access_token",
      scopes: [
        "instagram_basic",
        "instagram_content_publish",
        "pages_show_list",
        "pages_read_engagement",
        "business_management",
      ],
    },
    options: [],
    fetchesMedia: true,
    // The same app as Facebook, and the same authorization: Instagram publishing
    // goes through a Page. Worth saying, because the obvious move is to look for
    // an "Instagram app" that does not exist for this purpose.
    help: "Uses a Facebook app. Needs a Business or Creator account linked to a Page — Instagram has no posting API for personal accounts.",
    console: "https://developers.facebook.com/apps",
  },
  {
    value: "threads",
    label: "Threads",
    limit: 500,
    media: { images: 10, video: true, requiresMedia: false },
    oauth: {
      authorizeUrl: "https://threads.net/oauth/authorize",
      tokenUrl: "https://graph.threads.net/oauth/access_token",
      scopes: ["threads_basic", "threads_content_publish"],
    },
    options: [],
    fetchesMedia: true,
    help: "A Threads app, registered separately from Facebook's even though the account is the same.",
    console: "https://developers.facebook.com/apps",
  },
  {
    value: "linkedin",
    label: "LinkedIn",
    limit: 3_000,
    media: { images: 9, video: true, requiresMedia: false },
    oauth: {
      authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
      tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
      // openid and profile are what name the member; w_member_social is what
      // lets us post as them. LinkedIn refuses the post without the last one and
      // refuses to say who you are without the first two.
      scopes: ["openid", "profile", "w_member_social"],
    },
    options: [],
    fetchesMedia: false,
    help: "Add the 'Share on LinkedIn' and 'Sign In with LinkedIn using OpenID Connect' products to the app, or the scopes are refused.",
    console: "https://www.linkedin.com/developers/apps",
  },
  {
    value: "tiktok",
    label: "TikTok",
    limit: 2_200,
    media: { images: 0, video: true, requiresMedia: "video" },
    oauth: {
      authorizeUrl: "https://www.tiktok.com/v2/auth/authorize/",
      tokenUrl: "https://open.tiktokapis.com/v2/oauth/token/",
      scopes: ["user.info.basic", "video.publish"],
    },
    options: [
      {
        key: "privacy",
        label: "Who can see it",
        type: "select",
        // An app TikTok has not yet audited may only post privately, and it
        // refuses anything else with an error about the app rather than the
        // post. Defaulting to the one setting that always works means a first
        // post succeeds; widening it is a deliberate choice.
        fallback: "SELF_ONLY",
        choices: [
          { value: "SELF_ONLY", label: "Only me" },
          { value: "MUTUAL_FOLLOW_FRIENDS", label: "Friends" },
          { value: "FOLLOWER_OF_CREATOR", label: "Followers" },
          { value: "PUBLIC_TO_EVERYONE", label: "Everyone" },
        ],
        help: "An app TikTok has not audited yet may only post 'Only me'.",
      },
      { key: "disableComment", label: "Turn off comments", type: "boolean", fallback: false },
      { key: "disableDuet", label: "Turn off duets", type: "boolean", fallback: false },
      { key: "disableStitch", label: "Turn off stitches", type: "boolean", fallback: false },
    ],
    fetchesMedia: false,
    help: "Add the Content Posting API product and the video.publish scope. Until TikTok audits the app it may only post privately.",
    console: "https://developers.tiktok.com/apps",
  },
  {
    value: "youtube",
    label: "YouTube",
    limit: 5_000,
    media: { images: 0, video: true, requiresMedia: "video" },
    oauth: {
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"],
      // Google issues a refresh token only when both are asked for explicitly,
      // and only on the first consent — without these a connection works for an
      // hour and then quietly stops.
      extra: { access_type: "offline", prompt: "consent" },
    },
    options: [
      { key: "title", label: "Video title", type: "text", help: "Falls back to the post's title, then the caption." },
      {
        key: "privacy",
        label: "Visibility",
        type: "select",
        fallback: "private",
        choices: [
          { value: "private", label: "Private" },
          { value: "unlisted", label: "Unlisted" },
          { value: "public", label: "Public" },
        ],
      },
      { key: "tags", label: "Tags", type: "text", help: "Comma-separated." },
    ],
    fetchesMedia: false,
    help: "A Google Cloud project with the YouTube Data API v3 enabled, and an OAuth client of type 'Web application'.",
    console: "https://console.cloud.google.com/apis/credentials",
  },
  {
    value: "pinterest",
    label: "Pinterest",
    limit: 800,
    media: { images: 1, video: true, requiresMedia: "any", coverImage: true },
    oauth: {
      authorizeUrl: "https://www.pinterest.com/oauth/",
      tokenUrl: "https://api.pinterest.com/v5/oauth/token",
      scopes: ["boards:read", "pins:read", "pins:write", "user_accounts:read"],
    },
    options: [
      { key: "title", label: "Pin title", type: "text", help: "Falls back to the post's title." },
      { key: "boardId", label: "Board", type: "text", help: "Leave empty to use the first board on the account." },
    ],
    fetchesMedia: true,
    help: "A standard-access app. Trial access posts only to your own boards; production access needs review.",
    console: "https://developers.pinterest.com/apps",
  },
  {
    value: "googlebusiness",
    label: "Google Business",
    limit: 1_500,
    media: { images: 1, video: false, requiresMedia: false },
    oauth: {
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: ["https://www.googleapis.com/auth/business.manage"],
      extra: { access_type: "offline", prompt: "consent" },
    },
    options: [
      {
        key: "action",
        label: "Button",
        type: "select",
        fallback: "",
        choices: [
          { value: "", label: "None" },
          { value: "LEARN_MORE", label: "Learn more" },
          { value: "BOOK", label: "Book" },
          { value: "ORDER", label: "Order online" },
          { value: "SHOP", label: "Shop" },
          { value: "SIGN_UP", label: "Sign up" },
          { value: "CALL", label: "Call" },
        ],
        help: "Every button but Call needs the post's link set.",
      },
    ],
    fetchesMedia: true,
    help: "A Google Cloud project with the Business Profile APIs enabled — access is granted per project by application and can take days.",
    console: "https://console.cloud.google.com/apis/credentials",
  },
]

const BY_VALUE = new Map(NETWORKS.map(network => [network.value, network]))

export const networkFor = (value: string): Network | null => BY_VALUE.get(value) ?? null

export const isNetwork = (value: string): boolean => BY_VALUE.has(value)

export const networkLabel = (value: string): string => BY_VALUE.get(value)?.label ?? value

// Every option key a network declares, with the value to use when the composer
// sent nothing. Publishers read through this rather than the raw JSON so a post
// saved before an option existed still publishes with that option's default.
export const withDefaults = (network: string, supplied: Record<string, unknown>): Record<string, unknown> => {
  const spec = BY_VALUE.get(network)
  if (!spec) return {}

  const out: Record<string, unknown> = {}
  for (const option of spec.options) {
    const value = supplied[option.key]
    if (option.type === "boolean") {
      out[option.key] = value === undefined ? (option.fallback ?? false) : value === true
      continue
    }
    const text = typeof value === "string" ? value.trim() : ""
    if (option.type === "select") {
      const allowed = (option.choices ?? []).some(choice => choice.value === text)
      out[option.key] = allowed ? text : String(option.fallback ?? option.choices?.[0]?.value ?? "")
      continue
    }
    out[option.key] = text || String(option.fallback ?? "")
  }
  return out
}

export type MediaShape = { readonly images: number; readonly videos: number }

const NEEDS: Record<string, string> = { video: "a video", image: "an image", any: "an image or a video" }

// What a network will refuse before it is asked, said in the words of the
// person who wrote the post. Returns an empty array when the post is legal.
//
// This is checked at save time rather than at publish time on purpose: a
// scheduled post that turns out to be unpostable at 6am on Saturday is a
// notification nobody reads, and every one of these is knowable now.
export const violations = (network: string, caption: string, media: MediaShape): string[] => {
  const spec = BY_VALUE.get(network)
  if (!spec) return [`${network} is not a network Inkling can post to`]

  const out: string[] = []
  const { images, videos } = media

  if (caption.length > spec.limit) {
    out.push(
      `${spec.label} allows ${spec.limit.toLocaleString()} characters and this is ${caption.length.toLocaleString()}`,
    )
  }

  if (videos > 1) out.push(`${spec.label} takes one video per post`)
  if (videos > 0 && !spec.media.video) out.push(`${spec.label} does not take video`)
  if (images > 0 && spec.media.images === 0) out.push(`${spec.label} does not take images`)
  if (images > spec.media.images && spec.media.images > 0) {
    out.push(`${spec.label} takes up to ${spec.media.images} image${spec.media.images === 1 ? "" : "s"}`)
  }
  // Only Pinterest means anything by both, and everywhere else the refusal
  // arrives late and describes the payload rather than the mistake.
  if (images > 0 && videos > 0 && !spec.media.coverImage) {
    out.push(`${spec.label} takes images or a video, not both`)
  }
  // And where both *are* meaningful, one of them is not optional.
  if (videos > 0 && images === 0 && spec.media.coverImage) {
    out.push(`A ${spec.label} video needs a cover image — ${spec.label} will not make one`)
  }

  const needs = spec.media.requiresMedia
  if (needs === "video" && videos === 0) out.push(`${spec.label} needs a video`)
  if (needs === "image" && images === 0) out.push(`${spec.label} needs an image`)
  if (needs === "any" && images + videos === 0) out.push(`${spec.label} needs ${NEEDS.any}`)

  if (!needs && caption.trim() === "" && images + videos === 0) {
    out.push(`${spec.label} needs a caption or something to show`)
  }

  return out
}
