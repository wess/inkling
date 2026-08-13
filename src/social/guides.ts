// How to actually get the credentials each network's settings row is asking for.
//
// This exists because the fields are the easy part. Every one of these networks
// hides the two values behind a console built for people who write software for
// a living, calls them different things, and puts the thing you need behind a
// review queue nobody warned you about. An operator who has never registered an
// OAuth app has no way to guess any of it, and "see the developer docs" sends
// them to a page written for someone else.
//
// So the register is plain words, short sentences, and the actual names of the
// actual buttons. It says what a thing *is* before it says what to do with it,
// it says how long each one really takes, and it names the trap each network
// sets — because every one of these has exactly one step that everybody gets
// wrong, and it is never the step the docs emphasise.
//
// Kept out of ./networks.ts on purpose: that file is a terse catalog read on
// every request, and this is prose read once.

export type GuideStep = {
  readonly title: string
  readonly body: string
}

export type Guide = {
  // One sentence, in the words of someone who has not done this before.
  readonly summary: string
  // Honest, including the part that is waiting rather than working.
  readonly time: string
  readonly steps: readonly GuideStep[]
  // The thing that goes wrong. One line each, and each one is a real failure
  // somebody has hit rather than a general caution.
  readonly gotchas: readonly string[]
}

// Said once, above every guide, because it is the same for all nine and it is
// the question underneath all the others.
export const PREAMBLE = [
  "You are about to create a “developer app”. Think of it as a name badge for Inkling. The network will not let a stranger post on your behalf, but it will let a badge it has issued do it — once you say yes.",
  "Every app has two values: a **client ID** (public, like a username) and a **client secret** (private, like a password). You copy both into the form here.",
  "You also give the network a **redirect URI** — the address it sends your browser back to when you say yes. It is on the form, ready to copy. It must match to the character.",
  "None of this posts anything yet. Setting up the app just makes the “Connect” button work; you still choose the account afterwards on the Accounts screen.",
].join("\n\n")

export const GUIDES: Readonly<Record<string, Guide>> = {
  x: {
    summary:
      "You make an app in X's developer portal, turn on the setting that lets people log in with it, and copy two values back here.",
    time: "About 15 minutes. The free tier is enough to post.",
    steps: [
      {
        title: "Sign up for the developer portal",
        body: "Go to developer.x.com and sign in with the X account you want to post from. It asks what you are building — a sentence like “scheduling posts for my own business” is fine. Pick the Free plan.",
      },
      {
        title: "Make a project, then an app inside it",
        body: "X nests one inside the other. Make the project, name it anything, and it will walk you into making an app straight after. Names are for you; nobody else sees them.",
      },
      {
        title: "Turn on user authentication",
        body: "On the app's Settings tab find “User authentication settings” and press Set up. This is the step everyone misses, and without it the two values you need are never created.",
      },
      {
        title: "Fill in that form",
        body: "App permissions: Read and write. Type of App: Web App, Automated App or Bot — this matters, because it is the only choice that gives you a secret. Callback URI: paste the redirect URI from this page. Website URL: your site.",
      },
      {
        title: "Copy the two values",
        body: "Saving shows you a Client ID and a Client Secret. The secret is shown once. Copy both into the form here now — if you lose the secret you can regenerate it, but the old one stops working.",
      },
    ],
    gotchas: [
      "“API Key” and “API Secret” are a different, older pair of values further down the same page. You want Client ID and Client Secret, from the user authentication section.",
      "If you picked “Native App” you will not be given a secret. Change the app type to Web App and save again.",
      "Read-only permissions look fine until the first post, which fails with a message about an unsupported operation. It means read and write was not selected.",
    ],
  },

  facebook: {
    summary:
      "You make an app on Facebook's developer site, add the Pages product to it, and copy two values back here.",
    time: "About 20 minutes to post to your own Page. Weeks if you need to post to a Page you do not manage.",
    steps: [
      {
        title: "Turn your Facebook account into a developer account",
        body: "Go to developers.facebook.com and press Get Started. It is free, and it asks you to confirm your phone number. Your normal Facebook account becomes a developer account; nothing about your profile changes.",
      },
      {
        title: "Create an app",
        body: "My Apps → Create App. When it asks what you want your app to do, choose “Other”, then app type “Business”. It will ask to link a Business portfolio — pick the one that owns your Page, or make one.",
      },
      {
        title: "Add the Facebook Login product",
        body: "On the app dashboard find Facebook Login and press Set up. Choose Web. It will ask for your site URL — put your site in and continue. You can skip the code samples it shows you; Inkling is the code.",
      },
      {
        title: "Add the redirect URI",
        body: "Facebook Login → Settings. In “Valid OAuth Redirect URIs”, paste the redirect URI from this page and save. This box is the single most common reason a connection fails.",
      },
      {
        title: "Copy the two values",
        body: "App settings → Basic. “App ID” is the client ID. “App secret” is the client secret — press Show and enter your password. Copy both into the form here.",
      },
      {
        title: "Connect the account",
        body: "Save here, then go to Accounts and press Connect. Facebook will ask which Page you are granting access to — say yes to the Page you want to post to.",
      },
    ],
    gotchas: [
      "Inkling posts to a Page, not to your personal profile. Facebook has had no way to post to a profile for years. If you have no Page, make one first — it takes two minutes.",
      "While the app is in Development mode it can only post to Pages that you personally manage. That is usually all you need. Posting on behalf of other people's Pages needs App Review, which takes weeks.",
      "The app secret is hidden behind a Show button and your password. It is not the App ID, and it is not the “Client token” further down that page.",
    ],
  },

  instagram: {
    summary:
      "Instagram has no app of its own for this. You use a Facebook app, and Instagram has to be a Business account attached to a Facebook Page.",
    time: "About 30 minutes, most of it converting the Instagram account if it is not already a Business one.",
    steps: [
      {
        title: "Make the Instagram account a Business or Creator account",
        body: "In the Instagram phone app: Settings → Account type and tools → Switch to professional account. A personal account cannot be posted to by any software, by anybody, ever. This is not an Inkling limitation.",
      },
      {
        title: "Connect it to a Facebook Page",
        body: "Still in the Instagram app: Settings → Sharing and remixes → link a Facebook Page, or do it from the Page's own settings. Instagram publishing works *through* the Page, so this link is what makes everything else possible.",
      },
      {
        title: "Make a Facebook app",
        body: "Exactly as for Facebook: developers.facebook.com → My Apps → Create App → Other → Business. If you already made one for Facebook, use that same app — you do not need two.",
      },
      {
        title: "Add Facebook Login and the redirect URI",
        body: "Add the Facebook Login product, choose Web, then Facebook Login → Settings and paste the redirect URI from this page into “Valid OAuth Redirect URIs”.",
      },
      {
        title: "Copy the two values",
        body: "App settings → Basic. App ID and App secret, the same pair Facebook uses. Paste them here.",
      },
    ],
    gotchas: [
      "If Connect says “no Instagram Business account is linked to that Page”, the link in step 2 did not take. Check it from the Facebook Page's settings rather than from the phone app — the phone app sometimes reports success without saving.",
      "Instagram will not take a post with no picture or video. There is no such thing as a text-only Instagram post.",
      "A single video becomes a Reel. Instagram removed every other kind of video post, so there is no setting for this.",
    ],
  },

  threads: {
    summary: "Threads has its own app type, separate from Facebook's, even though the account is the same.",
    time: "About 15 minutes.",
    steps: [
      {
        title: "Go to the Meta developer site",
        body: "developers.facebook.com → My Apps → Create App. When it asks what you want your app to do, choose the Threads option — it is a distinct app type and picking the wrong one means the Threads settings never appear.",
      },
      {
        title: "Add the Threads API product",
        body: "On the dashboard, add “Threads API” and press Set up. This is what creates the values you need; a Facebook app without it will not work for Threads.",
      },
      {
        title: "Add the redirect URI",
        body: "In the Threads API settings, find the redirect callback field and paste the redirect URI from this page.",
      },
      {
        title: "Copy the two values",
        body: "The Threads app has its own “Threads App ID” and “Threads App Secret” — not the Facebook ones from the same dashboard. Copy those two here.",
      },
      {
        title: "Add yourself as a tester",
        body: "App roles → Roles → add the Threads account you want to post from. Accept the invitation from that account's Threads settings. Until you do, connecting will refuse.",
      },
    ],
    gotchas: [
      "The Threads app ID and the Facebook app ID sit near each other on the same dashboard and are different numbers. Using the Facebook one fails with a message about an invalid client.",
      "A Threads post is capped at 500 characters. Inkling counts this for you as you type.",
      "The tester invitation in step 5 has to be accepted from the Threads app on your phone, not from the developer site.",
    ],
  },

  linkedin: {
    summary:
      "You make an app, attach it to a LinkedIn Page, and then add two “products” to it — the products are what unlock posting.",
    time: "About 20 minutes, plus a day or two if your Page needs verifying.",
    steps: [
      {
        title: "You need a LinkedIn Page",
        body: "Not a personal profile — a Page, the kind a company has. Making one is free and takes a few minutes. LinkedIn will not let an app exist without one to attach it to.",
      },
      {
        title: "Create the app",
        body: "linkedin.com/developers → Create app. It asks for the Page from step 1 and a logo. Then it asks you to verify that you really do control that Page: it gives you a link, you open it as the Page admin, and you press a button.",
      },
      {
        title: "Add two products",
        body: "On the Products tab, request “Sign In with LinkedIn using OpenID Connect” and “Share on LinkedIn”. Both are granted instantly. This is the step that matters — without them the scopes are refused and the connection fails with a message about permissions.",
      },
      {
        title: "Add the redirect URI",
        body: "Auth tab → “Authorized redirect URLs for your app” → paste the redirect URI from this page.",
      },
      {
        title: "Copy the two values",
        body: "Still on the Auth tab: Client ID and Primary Client Secret. Both are shown in full. Paste them here.",
      },
    ],
    gotchas: [
      "Inkling posts as the person who connects, not as the Page. Posting as a Page needs a different LinkedIn product with a review process behind it.",
      "If Connect fails with “unauthorized_scope_error”, one of the two products in step 3 was not added. That is almost always the cause.",
      "The Page verification link expires. If it has, generate a new one from the app's Settings tab.",
    ],
  },

  tiktok: {
    summary:
      "You make an app, ask for permission to post videos, and wait for TikTok to look at it. Until they do, posts are visible only to you.",
    time: "About 20 minutes to set up. Two weeks or more before posts can be public.",
    steps: [
      {
        title: "Register as a developer",
        body: "developers.tiktok.com → Manage apps → Connect an app. Sign in with the TikTok account you want to post from.",
      },
      {
        title: "Fill in the app details",
        body: "Name, description, icon, and your website. Take this seriously — a human reads it later when deciding whether to let you post publicly, and a thin description is the usual reason for a rejection.",
      },
      {
        title: "Add the Content Posting API",
        body: "In the app, add the “Content Posting API” product and turn on “Direct Post”. Without Direct Post, an upload lands in the account's drafts instead of being published.",
      },
      {
        title: "Add the redirect URI",
        body: "In the login kit settings, paste the redirect URI from this page.",
      },
      {
        title: "Copy the two values",
        body: "TikTok calls them “Client key” and “Client secret”. The client key goes in the Client ID box here — it is the same thing under a different name.",
      },
      {
        title: "Apply for review when you are ready",
        body: "Submit the app for audit from the same dashboard. Until it passes, leave the post's visibility on “Only me”.",
      },
    ],
    gotchas: [
      "Before the audit, TikTok refuses any post that is not private, with an error about the app rather than the post. That is why Inkling defaults TikTok posts to “Only me”.",
      "“Client key”, not “client ID”. TikTok is the only network that names it that way, and it is the same value.",
      "You also have to verify your website's domain with TikTok before some features work — there is a step for it in the app settings that hands you a file or a meta tag.",
    ],
  },

  youtube: {
    summary:
      "You make a project in Google Cloud, switch on the YouTube API, and create a login credential. It sounds heavier than it is.",
    time: "About 25 minutes. No review needed if only you use it.",
    steps: [
      {
        title: "Make a Google Cloud project",
        body: "console.cloud.google.com → the project dropdown at the top → New Project. Name it anything. It is free and does not need a credit card for this.",
      },
      {
        title: "Switch on the YouTube API",
        body: "APIs & Services → Library → search “YouTube Data API v3” → Enable. This is a switch, not an application; it takes one click.",
      },
      {
        title: "Fill in the consent screen",
        body: "APIs & Services → OAuth consent screen. Choose External. Fill in app name, your email, and a developer email. Under Scopes you can skip ahead. Under Test users, add the Google account that owns the YouTube channel.",
      },
      {
        title: "Create the credential",
        body: "Credentials → Create Credentials → OAuth client ID → Application type: Web application. Under “Authorized redirect URIs”, paste the redirect URI from this page. Press Create.",
      },
      {
        title: "Copy the two values",
        body: "A box appears with Client ID and Client secret. Copy both here. You can reopen it later from the Credentials list.",
      },
    ],
    gotchas: [
      "Leave the app in Testing mode and add yourself as a test user. Publishing it to “In production” triggers a Google verification review you do not need.",
      "In Testing mode the connection expires after seven days and has to be reconnected. That is Google's rule for unverified apps, and Inkling will tell you when it happens.",
      "A brand-new YouTube account cannot upload until you verify a phone number on youtube.com. Uploads fail with a message about the account, not the app.",
      "Google gives a new upload a daily quota that is generous for scheduling but small for bulk — a few videos a day is fine, a hundred is not.",
    ],
  },

  pinterest: {
    summary:
      "You make an app, and Pinterest gives you limited access straight away that is enough to post to your own boards.",
    time: "About 15 minutes for your own boards. Longer if you need more.",
    steps: [
      {
        title: "Use a business account",
        body: "Pinterest's developer site needs one. Converting a personal account is free and instant, from Pinterest's own settings.",
      },
      {
        title: "Create the app",
        body: "developers.pinterest.com → My apps → Create app. It asks what you are building and how you will use the API. Answer plainly — “scheduling pins to my own boards” is a real answer.",
      },
      {
        title: "Add the redirect URI",
        body: "In the app's settings, paste the redirect URI from this page into the redirect URIs box.",
      },
      {
        title: "Copy the two values",
        body: "The app page shows an App ID and an App secret token. App ID goes in Client ID; the secret token goes in Client secret.",
      },
      {
        title: "Make sure you have a board",
        body: "A pin has to land on a board. Inkling picks the first board on the account when you connect, so create the one you want before connecting.",
      },
    ],
    gotchas: [
      "Trial access only lets you pin to boards on your own account. That is usually the whole requirement. Standard access, for other people's accounts, needs an application.",
      "A video pin needs a still image as its cover, and Pinterest will not make one for you. Add a picture to the post alongside the video.",
      "Pinterest calls the secret an “app secret token”. It is the client secret.",
    ],
  },

  googlebusiness: {
    summary:
      "Same Google Cloud project idea as YouTube, but the API has to be granted to you by hand, and that part takes days.",
    time: "About 30 minutes of work, then several days of waiting for Google.",
    steps: [
      {
        title: "Make or reuse a Google Cloud project",
        body: "console.cloud.google.com → New Project. If you already made one for YouTube you can use that.",
      },
      {
        title: "Ask for access to the Business Profile APIs",
        body: "These are not enabled by a switch. Fill in Google's Business Profile API access request form — search for “Business Profile APIs request access”. You describe what you are building and wait. This is the long step, so do it first.",
      },
      {
        title: "Enable the APIs once you are approved",
        body: "APIs & Services → Library → enable “My Business Account Management API”, “My Business Business Information API”, and “My Business Q&A API”. They only appear in the list after approval.",
      },
      {
        title: "Fill in the consent screen",
        body: "APIs & Services → OAuth consent screen. External, your details, and add the Google account that manages the business listing as a test user.",
      },
      {
        title: "Create the credential",
        body: "Credentials → Create Credentials → OAuth client ID → Web application. Paste the redirect URI from this page into Authorized redirect URIs.",
      },
      {
        title: "Copy the two values",
        body: "Client ID and Client secret, as with YouTube. Paste them here.",
      },
    ],
    gotchas: [
      "Skipping step 2 is the usual mistake. Without it the APIs simply are not in the library to enable, and it looks like they have been discontinued.",
      "A post goes to one location. If the business has several, Inkling uses the first one on the account — reconnect to change which.",
      "Google Business posts take one photo and no video, and they expire from the profile after a week unless they are an event or an offer.",
    ],
  },
}

export const guideFor = (network: string): Guide | null => GUIDES[network] ?? null
