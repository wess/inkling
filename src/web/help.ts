// What every control on this screen actually means, for the person using it.
//
// The reader here is not the person who built the site. They were handed a
// login and a job to do, and they are looking at a field called "API field
// name" wondering whether they are allowed to touch it. That is who this file
// is written for, and it is why the writing avoids the words the codebase uses
// happily elsewhere: no "schema", no "endpoint", no "serialize", unless the
// word is the thing being explained and is explained on the spot.
//
// It lives in one file rather than beside each control on purpose. Help text is
// prose, and prose needs a consistent voice, a single place to review it, and
// somewhere to translate it from later. Scattering it through an 8,000-line
// screen file gets none of those.
//
// Each entry has the same shape, because the same three questions come up every
// time somebody stalls on a field:
//
//   what     — what this is, in a sentence they would say out loud
//   example  — one concrete case, because an example teaches faster than a rule
//   careful  — what it affects elsewhere, or what cannot be undone
//
// `careful` is the one that earns its place. Most confusion in a CMS is not
// "what does this box do" but "what happens to everything else if I change it",
// and that is exactly what nobody writes down.

export type HelpEntry = {
  readonly title: string
  readonly what: string
  readonly example?: string
  readonly careful?: string
}

const ENTRIES = {
  // ─── writing and publishing ───────────────────────────────────────────────

  "entry.title": {
    title: "Title",
    what: "The name of this piece of content. It is what you will see in lists here, and usually what appears as the heading on your website.",
    example: 'A blog post called "Five things to do with a glut of tomatoes".',
  },

  "entry.slug": {
    title: "Web address",
    what: "The last part of this page's address on your website — the bit after the last slash. It is made from the title automatically, and you can change it.",
    example: 'A post titled "Our new opening hours" gets the address /our-new-opening-hours.',
    careful:
      "Changing it after the page is live breaks any link anyone has already shared or bookmarked, and search engines have to find the page again. If you do change it, ask whoever looks after the site to set up a redirect.",
  },

  "entry.status": {
    title: "Draft, in review, published, archived",
    what: "Where this content is up to. Draft means only people signed in here can see it. In review means you would like somebody to check it. Published means it is live on the website. Archived means it is off the site but kept.",
    careful:
      "Publishing is the moment it becomes public. Everything before that is private to this admin, so a half-finished draft is safe to leave.",
  },

  "entry.author": {
    title: "Credited to",
    what: "Who the website shows as the author of this page.",
    example: "A post written up by an assistant can still be credited to the person who said it.",
    careful:
      "This is separate from who last edited it. The history records that, and changing the credit here does not change the history.",
  },

  "entry.schedule": {
    title: "Publish at",
    what: "Set a date and time and this goes live on its own, without anybody being at a computer.",
    example: "A sale that should appear at 9am on Friday.",
    careful:
      "If the content no longer fits its content type by the time the moment arrives — a required field was removed, say — it comes back to review instead of going out broken.",
  },

  "entry.locale": {
    title: "Language",
    what: "Which language version of the page this is.",
    example: "The English and the Spanish version of the same page.",
    careful:
      "Two pages can share the same web address if their language differs, which is how a translated page keeps the same shape of URL.",
  },

  "entry.sortOrder": {
    title: "Display order",
    what: "Where this sits when your website shows a hand-ordered list. Lower numbers come first.",
    example: "Team members ordered 1, 2, 3 rather than alphabetically or by date.",
    careful:
      "Only matters if the website actually asks for content in this order. If your list is sorted by date, changing this does nothing.",
  },

  "entry.revisions": {
    title: "History",
    what: "Every saved version of this content, oldest to newest, with who saved it. You can look at an old version and put it back.",
    careful: "Restoring an old version does not delete the newer ones — it adds the old text back as a new version.",
  },

  // ─── media ────────────────────────────────────────────────────────────────

  "media.alt": {
    title: "Alt text",
    what: "What the picture shows, written for someone who cannot see it — a blind visitor using a screen reader, or anyone whose images failed to load.",
    example: 'For a photo of a potter at work: "a potter trimming a bowl on a wheel" — not "IMG_4021".',
    careful:
      "Describe what is in the picture, not the file. If the image is purely decorative and says nothing, it is fine to leave this empty.",
  },

  "media.caption": {
    title: "Caption",
    what: "Words shown next to the picture on the website, if your site displays captions.",
    careful: "Different from alt text: a caption is for everybody, alt text is for people who cannot see the image.",
  },

  "media.folder": {
    title: "Folder",
    what: "A way of grouping uploads so you can find them again. Nothing about the website changes — this is for you.",
    example: 'Folders like "products", "team photos", "2026 campaign".',
  },

  "media.url": {
    title: "URL",
    what: "The direct web address of this file. Paste it anywhere you need to point at the picture itself.",
    careful:
      "It stays working as long as the file is here. Deleting the file breaks every page using this address, including anywhere outside this site you pasted it.",
  },

  // ─── how content is shaped ────────────────────────────────────────────────

  "types.what": {
    title: "Content types",
    what: "The shapes your content can take — what a post, a product, or a landing page is made of. A content type is a list of fields; an entry is one filled-in copy of that shape.",
    example:
      'A "Product" type might have a name, a price, some photos, and a description. Each product you add is an entry.',
    careful:
      "Everything follows from these: the editing screens people see, what your website receives, and what is checked when somebody saves.",
  },

  "type.name": {
    title: "API name",
    what: "The name your website uses when it asks for this content. It is not shown to visitors.",
    example: "A type named post is asked for as /content/post.",
    careful:
      "It cannot be changed once entries exist, because every site reading it would stop finding anything. The label above it is the human name and can be changed whenever you like.",
  },

  "type.kind": {
    title: "Collection or single",
    what: "A collection holds many entries of the same shape. A single is one page that exists exactly once.",
    example: 'Blog posts are a collection. "About us" or the homepage settings are a single.',
  },

  "type.plural": {
    title: "Plural name",
    what: "What to call more than one of these. Used in menus and list headings here in the admin.",
    example:
      'One "Product", several "Products". One "Person", several "People" — which is why it is typed rather than guessed.',
  },

  "type.description": {
    title: "Description",
    what: "A note for whoever is choosing where to put something. Shown next to this type when somebody is picking.",
    example: '"Short news items for the homepage. Longer pieces go in Articles."',
  },

  "type.previewUrl": {
    title: "Live page URL",
    what: "Where content of this kind appears on your real website. Fill it in and the view button opens the actual page.",
    example: "https://example.com/blog/{slug} — the {slug} part is filled in for each entry.",
    careful: "Leave it empty and the view button has to guess, which is usually wrong.",
  },

  "field.key": {
    title: "API field name",
    what: "The name your website uses to read this one value. Not shown to visitors, and not the label people see when editing.",
    example: "A field labelled Hero image might be read as heroImage.",
    careful:
      "Write it as one run of words with capitals inside — heroImage, not hero_image or Hero Image. Renaming it after entries exist loses what those entries already hold, because the website looks for the old name and finds nothing.",
  },

  "field.type": {
    title: "What kind of value",
    what: "What sort of thing this field holds — a line of text, a date, a picture, a yes/no. This decides the editing control people get and what is allowed to be saved.",
    careful:
      "Changing the kind after entries exist can make what they already hold unreadable. Adding a new field is safe; changing an existing one deserves a second thought.",
  },

  "field.required": {
    title: "Required",
    what: "Nobody can save this content without filling this in.",
    careful:
      "Turning this on when entries already exist means the next person to edit an old entry has to fill it in before they can save, even if they only came to fix a typo.",
  },

  "field.localized": {
    title: "Translatable",
    what: "This value can be different in each language. Leave it off and every language shares one value.",
    example: "A headline is translatable. A product code is the same in every language.",
  },

  "field.pattern": {
    title: "Validation pattern",
    what: "A rule the value has to match before it can be saved, written as a regular expression — a compact way of describing an allowed format.",
    example: "A UK postcode, a product code that is always two letters and four digits.",
    careful:
      "Leave it empty unless you have a format in mind. A pattern that is slightly wrong blocks perfectly good content and the person hitting it usually cannot tell why.",
  },

  "field.min": {
    title: "Minimum",
    what: "The smallest this value is allowed to be — the lowest number, the fewest characters, or the fewest items, depending on the kind of field.",
  },

  "field.max": {
    title: "Maximum",
    what: "The largest this value is allowed to be — the highest number, the most characters, or the most items, depending on the kind of field.",
    example: "A summary capped at 160 characters so it fits in a search result.",
  },

  "field.helptext": {
    title: "Help text",
    what: "A note shown under this field while somebody is filling it in. Write it for whoever will be using the screen.",
    example: '"Keep this under 60 characters — it is what shows in search results."',
    careful: "It appears in full under the box rather than behind a question mark, so keep it to a line.",
  },

  "field.reference": {
    title: "Content to link to",
    what: "Which kind of content this field points at. Editing this entry then means picking a real entry of that kind, rather than typing its name again.",
    example:
      "A recipe with a Chef field pointing at your Team entries — change the chef's name once and every recipe follows.",
  },

  "field.list": {
    title: "Fields in each item",
    what: "A list holds several of the same little group of fields, and this is what one of those groups is made of.",
    example: "A Social links list where each item has a network name and a URL — one item per network.",
  },

  "field.options": {
    title: "Choices",
    what: "The list somebody picks from. One per line.",
    careful:
      "Removing a choice does not change entries that already use it — they keep the old value until somebody edits them.",
  },

  "field.default": {
    title: "Default value",
    what: "What this field starts as when somebody creates new content. They can change it.",
  },

  // ─── grouping ─────────────────────────────────────────────────────────────

  "taxonomy.what": {
    title: "Taxonomies",
    what: "Ways of grouping content that are not the content itself — topics, collections, seasons. You define the grouping once and attach entries to it while editing them.",
    example: 'A "Topics" grouping with terms like Recipes, News and Events, attached to posts.',
    careful: "Your website can then ask for everything in one group, which is how a topic page gets its list.",
  },

  "taxonomy.hierarchical": {
    title: "Can groups sit inside groups",
    what: "Turn this on and a group can have sub-groups.",
    example: "Categories like Food → Baking → Bread. Tags, by contrast, are usually a flat list.",
  },

  "term.parent": {
    title: "Sits inside",
    what: "Which larger group this one belongs to. Leave it empty for a top-level group.",
  },

  "menu.link": {
    title: "Link",
    what: "Where this menu item goes. A path starting with / stays on your site; a full address starting with https:// goes somewhere else.",
    example: "/shop for your own shop page. https://instagram.com/yourshop for your Instagram.",
    careful:
      "Typing shop without the slash is the usual mistake — it makes the link relative to whatever page the visitor is on, so it works on the homepage and breaks everywhere else.",
  },

  "menus.what": {
    title: "Menus",
    what: "Your website's navigation, edited here instead of in code. A menu is a named list of links, and the list can have links nested under other links.",
    example: 'A menu named "main" holding Home, Shop, About, Contact.',
    careful: "Your website asks for a menu by its name, so renaming one means the site stops finding it.",
  },

  // ─── the site itself ──────────────────────────────────────────────────────

  "settings.title": {
    title: "Site title",
    what: "The name of this website. Used wherever the site prints its own name, and usually in the browser tab.",
  },

  "settings.tagline": {
    title: "Tagline",
    what: "A short line under the name saying what the site is.",
    example: '"Small-batch pottery, made in Columbia."',
  },

  "settings.description": {
    title: "Description",
    what: "A sentence or two about the site. Search engines often show this under your name in results, and it is what gets shared when somebody posts a link.",
  },

  "settings.url": {
    title: "Public site URL",
    what: "The address visitors use, with https:// on the front.",
    careful:
      "Used to build absolute links — in emails, in sitemaps, in what social networks read. Getting it wrong makes those links point somewhere that does not exist.",
  },

  "settings.timezone": {
    title: "Timezone",
    what: "The clock that scheduled publishing runs on. Set it to where the people using this site are.",
    careful: 'Get it wrong and something set for "9am Friday" goes out at the wrong hour.',
  },

  "settings.locale": {
    title: "Default language",
    what: "The language content is in unless somebody says otherwise.",
  },

  "settings.socialImageId": {
    title: "Default social image",
    what: "The picture used when somebody shares a link to this site and the page has no picture of its own.",
    example: "Your logo on a plain background, wide rather than square — most networks crop a square badly.",
  },

  "settings.logoId": {
    title: "Logo",
    what: "Your logo, if the website is built to read it from here rather than having it baked in.",
    careful:
      "Whether it appears at all is up to whoever built the site — this stores it, the site decides where it goes.",
  },

  "settings.faviconId": {
    title: "Favicon",
    what: "The tiny icon in the browser tab, next to the page title. Square, and it has to read clearly at about the size of a full stop.",
  },

  // ─── people ───────────────────────────────────────────────────────────────

  "users.role": {
    title: "Role",
    what: "What this person is allowed to do. Author writes and edits their own drafts. Editor publishes anyone's. Admin also shapes the content model, the keys, and the people. Owner is all of that, and cannot be removed.",
    careful:
      "Give the smallest role that lets somebody do their job. It is easy to raise later and awkward to explain afterwards.",
  },

  "users.password": {
    title: "Password",
    what: "Their password for signing in here. They can change it themselves afterwards.",
    careful: "Send it to them some way other than the same email address the account uses.",
  },

  // ─── connecting other systems ─────────────────────────────────────────────

  "keys.what": {
    title: "Delivery keys",
    what: "How your websites read this content. A key is a long password a website holds so it can ask for pages.",
    careful:
      "A key only ever sees published content — never a draft, never anybody's email. The full key is shown once, when you create it, and only a scrambled copy is kept here, so if it is lost you make a new one rather than looking the old one up.",
  },

  "keys.scope": {
    title: "What this key can read",
    what: "Narrows a key to the kinds of content one site actually shows.",
    example: "A key for the marketing site that can read posts and products, and nothing else.",
    careful:
      "Worth doing even though a key already cannot see drafts: if that key leaks, the damage is bounded by this list.",
  },

  "keys.expires": {
    title: "Expires",
    what: "When this key stops working. Leave it empty and it does not expire.",
    careful:
      "A key on your own website usually should not expire — the site would simply stop showing content one day. A key you handed to somebody else usually should.",
  },

  "agentkeys.what": {
    title: "Agent keys",
    what: "How a program signs in — an automation, a build script, a tool acting for you. It works as you, but only for what you tick, only until it expires, and you can cut off one key without changing your password or signing anybody else out.",
  },

  "agentkeys.grants": {
    title: "What it is allowed to do",
    what: "Tick the least that gets the job done.",
    careful:
      "A key that can only read cannot be talked into deleting a page, whatever ends up in the content it reads. That matters most when the program on the other end is an AI.",
  },

  "agentkeys.expires": {
    title: "Expires",
    what: "When this key stops working. It has to have a date — a machine credential nobody ever revisits is one nobody notices has leaked.",
  },

  "webhooks.what": {
    title: "Webhooks",
    what: "Tell another system when something happens here. When you publish a page, we send a message to a web address you own so that system can react.",
    example: "Telling your website to rebuild when a post goes live.",
    careful:
      "Every message is signed, so the receiver can prove it came from this install and not from somebody who guessed the address.",
  },

  "webhooks.endpoint": {
    title: "Endpoint URL",
    what: "The web address we send the message to. It has to be a real address that is expecting us.",
    careful: "Ask whoever runs the receiving system for this — it is not something to guess.",
  },

  "webhooks.events": {
    title: "Events",
    what: "Which happenings send a message. Pick only the ones the other system cares about.",
  },

  "activity.what": {
    title: "Activity",
    what: "Who did what, and when — sign-ins, edits, publishing, media changes.",
    careful:
      "Kept whether or not the thing it describes still exists, so a deleted page still has a record of who deleted it.",
  },

  "trash.what": {
    title: "Trash",
    what: "Deleted content is kept here rather than thrown away, so a mistake is one click back.",
    careful: "Restoring puts an entry back exactly as it was, including its history.",
  },

  "plugins.what": {
    title: "Plugins",
    what: "Self-contained additions — extra kinds of content, extra screens, extra settings.",
    careful:
      "Turning one on takes effect immediately: nothing restarts and nothing has to be rebuilt. Turning it off stops it just as quickly.",
  },

  // ─── AI ───────────────────────────────────────────────────────────────────

  "ai.provider": {
    title: "Provider",
    what: "Whose AI answers, and whose bill it lands on. You bring an account with one of these companies; Inkling does not resell anything.",
    careful:
      "Every AI feature here — the writing tools, Inky, and the visitor chat bubble — runs on the provider you connect.",
  },

  "ai.key": {
    title: "API key",
    what: "The password for your account with that AI company. Create it on their website and paste it here.",
    careful:
      "It is encrypted before it is stored and never shown again. Anyone who gets hold of it can spend your money with that company, so treat it like a bank card.",
  },

  "ai.model": {
    title: "Model",
    what: "Which of that company's AI models to use. The suggestions are a starting point — you can type the name of a newer one.",
    careful:
      "Inky needs a model that can use tools; the writing tools do not. A cheaper model is usually fine for rewriting a paragraph.",
  },

  "ai.inky": {
    title: "Proposed changes",
    what: "Inky never saves anything itself. Everything it works out is queued here as a before-and-after for you to read, and it only happens when you press Apply.",
    example:
      'Ask for "a page about our new roastery, and put it in the menu" and you get two cards: the drafted page, and the menu item. Apply either, both, or neither.',
    careful:
      "Applying is the same save you would make by hand, so it is checked the same way, recorded in Activity under your name, and — for a page — leaves a version you can go back to. A card greyed out is one your role cannot make; ask an admin.",
  },

  "ai.reach": {
    title: "What Inky can change",
    what: "Your pages and what they say, the shape those pages take, your navigation, your categories, your files' descriptions, your site details, who has an account, your delivery keys and webhooks, your plugins, and your social setup. It can also take you to any screen here.",
    careful:
      "Four things need your own hands and Inky will take you to them instead: uploading a file, creating an account, pressing Connect on a social network, and pasting a client secret. It will never ask you to type a secret to it — paste those into the field on the Social settings screen.",
  },

  "ai.baseUrl": {
    title: "Base URL",
    what: "Where to reach the model, if it is not where that provider normally lives.",
    careful: "Leave it alone unless you are running the model yourself and know the address.",
  },

  // ─── social ───────────────────────────────────────────────────────────────

  "social.caption": {
    title: "Caption",
    what: "What every selected network gets, unless you give one of them its own wording below.",
  },
} as const satisfies Record<string, HelpEntry>

// Looks up help by a key built at runtime — a settings screen rendering fields
// from a list has no literal id to write. Returns undefined for anything not
// covered, so a new setting shows no `?` rather than an empty modal.
export const helpFor = (key: string): HelpId | undefined => (key in ENTRIES ? (key as HelpId) : undefined)

export type HelpId = keyof typeof ENTRIES

// Widened on the way out. `as const` above is what makes an id a checked
// literal rather than any old string; leaving the values narrowed too would
// mean an entry without an `example` has no such property to read, and every
// call site would have to prove it exists.
export const HELP: Record<HelpId, HelpEntry> = ENTRIES
