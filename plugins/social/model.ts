import type { PluginContentType, PluginTaxonomy } from "../../src/plugins/define.ts"
import { NETWORK_OPTIONS } from "./networks.ts"

// The content model. Four types and one taxonomy, declared here so ./index.ts
// stays about behaviour.
//
// These are ordinary content types rather than plugin-owned tables, which is
// the whole reason the plugin is small: entries already have an editor, a
// revision history, search, soft-delete, and a permissions model. What the
// plugin adds is the *reading* of them — a queue, a calendar, and a report —
// plus the one thing entries genuinely cannot hold, which is a time series of
// results (see ./migrations).

// Where a post is in the workflow. Deliberately a data field named `stage`
// rather than the entry's own `status`: an entry is published when the plan is
// visible to the client, which is a different question from whether the post
// has gone out.
export const STAGES = [
  { value: "idea", label: "Idea" },
  { value: "draft", label: "Drafting" },
  { value: "review", label: "Needs review" },
  { value: "approved", label: "Approved" },
  { value: "scheduled", label: "Scheduled" },
  { value: "posted", label: "Posted" },
  { value: "archived", label: "Archived" },
] as const

export const STAGE_LABELS: Record<string, string> = Object.fromEntries(STAGES.map(stage => [stage.value, stage.label]))

// Stages that describe work still to come. Everything the queue, the calendar,
// and the "awaiting approval" tile counts is drawn from this set.
export const OPEN_STAGES = ["idea", "draft", "review", "approved", "scheduled"]

export const taxonomies: readonly PluginTaxonomy[] = [
  { name: "contentpillar", label: "Content pillars", hierarchical: false },
]

const client: PluginContentType = {
  name: "socialclient",
  label: "Client",
  pluralLabel: "Clients",
  description: "A brand you post for.",
  icon: "briefcase",
  sortOrder: 10,
  fields: [
    { key: "logo", type: "media", label: "Logo" },
    { key: "handle", type: "text", label: "Primary handle", help: "Without the @." },
    { key: "industry", type: "text", label: "Industry" },
    {
      key: "standing",
      type: "select",
      label: "Standing",
      default: "active",
      options: [
        { value: "prospect", label: "Prospect" },
        { value: "onboarding", label: "Onboarding" },
        { value: "active", label: "Active" },
        { value: "paused", label: "Paused" },
        { value: "former", label: "Former" },
      ],
    },
    { key: "startedOn", type: "date", label: "Started on" },
    {
      key: "postsPerWeek",
      type: "number",
      label: "Posts per week",
      min: 0,
      default: 5,
      help: "The cadence you sold them. The report measures against it.",
    },
    { key: "retainer", type: "number", label: "Monthly retainer", min: 0 },
    { key: "contactName", type: "text", label: "Main contact" },
    { key: "contactEmail", type: "email", label: "Contact email" },
    { key: "contactPhone", type: "text", label: "Contact phone" },
    { key: "brandColor", type: "color", label: "Brand color" },
    { key: "voice", type: "textarea", label: "Voice", help: "How they sound. Read this before drafting." },
    { key: "audience", type: "textarea", label: "Audience" },
    {
      key: "goals",
      type: "list",
      label: "Goals",
      fields: [
        { key: "goal", type: "text", label: "Goal", required: true },
        { key: "metric", type: "text", label: "Measured by" },
        { key: "target", type: "text", label: "Target" },
      ],
    },
    {
      key: "links",
      type: "list",
      label: "Links",
      help: "Brand kit, shared drive, ad account — anywhere you keep going back to.",
      fields: [
        { key: "label", type: "text", label: "Label", required: true },
        { key: "url", type: "url", label: "URL", required: true },
      ],
    },
    { key: "notes", type: "textarea", label: "Notes" },
  ],
}

const channel: PluginContentType = {
  name: "socialchannel",
  label: "Channel",
  pluralLabel: "Channels",
  description: "One account on one network.",
  icon: "at-sign",
  sortOrder: 11,
  fields: [
    { key: "client", type: "reference", label: "Client", of: "socialclient", required: true },
    { key: "network", type: "select", label: "Network", required: true, options: NETWORK_OPTIONS },
    { key: "handle", type: "text", label: "Handle", required: true },
    { key: "url", type: "url", label: "Profile URL" },
    { key: "followers", type: "number", label: "Followers", min: 0, help: "Last time you checked." },
    { key: "checkedOn", type: "date", label: "Follower count from" },
    { key: "active", type: "boolean", label: "Actively posting", default: true },
    { key: "notes", type: "textarea", label: "Notes", help: "Login quirks, who owns the account, posting rules." },
  ],
}

const campaign: PluginContentType = {
  name: "socialcampaign",
  label: "Campaign",
  pluralLabel: "Campaigns",
  description: "A run of posts with one objective.",
  icon: "target",
  sortOrder: 12,
  fields: [
    { key: "client", type: "reference", label: "Client", of: "socialclient", required: true },
    {
      key: "objective",
      type: "select",
      label: "Objective",
      default: "awareness",
      options: [
        { value: "awareness", label: "Awareness" },
        { value: "engagement", label: "Engagement" },
        { value: "leads", label: "Leads" },
        { value: "sales", label: "Sales" },
        { value: "launch", label: "Launch" },
        { value: "retention", label: "Retention" },
      ],
    },
    {
      key: "phase",
      type: "select",
      label: "Phase",
      default: "planning",
      options: [
        { value: "planning", label: "Planning" },
        { value: "live", label: "Live" },
        { value: "wrapped", label: "Wrapped" },
      ],
    },
    { key: "startsOn", type: "date", label: "Starts" },
    { key: "endsOn", type: "date", label: "Ends" },
    { key: "budget", type: "number", label: "Budget", min: 0 },
    { key: "summary", type: "textarea", label: "Summary" },
    {
      key: "kpis",
      type: "list",
      label: "What success looks like",
      fields: [
        { key: "metric", type: "text", label: "Metric", required: true },
        { key: "target", type: "text", label: "Target", required: true },
      ],
    },
  ],
}

const post: PluginContentType = {
  name: "socialpost",
  label: "Post",
  pluralLabel: "Posts",
  description: "One piece of content, on its way out.",
  icon: "send",
  sortOrder: 13,
  fields: [
    { key: "client", type: "reference", label: "Client", of: "socialclient", required: true },
    { key: "campaign", type: "reference", label: "Campaign", of: "socialcampaign" },
    { key: "stage", type: "select", label: "Stage", default: "draft", options: [...STAGES] },
    { key: "networks", type: "multiselect", label: "Networks", options: NETWORK_OPTIONS },
    {
      key: "format",
      type: "select",
      label: "Format",
      default: "single",
      options: [
        { value: "single", label: "Single image" },
        { value: "carousel", label: "Carousel" },
        { value: "reel", label: "Reel / short video" },
        { value: "story", label: "Story" },
        { value: "text", label: "Text only" },
        { value: "live", label: "Live" },
      ],
    },
    { key: "scheduledFor", type: "datetime", label: "Goes out", help: "Drives the calendar and the queue." },
    { key: "caption", type: "textarea", label: "Caption", help: "The master copy. Variants below override it." },
    {
      key: "variants",
      type: "list",
      label: "Per-network variants",
      help: "Only where a network needs different words. Anything not listed uses the caption above.",
      fields: [
        { key: "network", type: "select", label: "Network", required: true, options: NETWORK_OPTIONS },
        { key: "caption", type: "textarea", label: "Caption", required: true },
        { key: "firstComment", type: "textarea", label: "First comment" },
      ],
    },
    { key: "hashtags", type: "text", label: "Hashtags", help: "Space separated. The # is added for you." },
    { key: "cta", type: "text", label: "Call to action" },
    { key: "link", type: "url", label: "Link" },
    { key: "media", type: "gallery", label: "Assets" },
    { key: "assetBrief", type: "textarea", label: "Asset brief", help: "What still needs shooting or designing." },
    { key: "approvedBy", type: "text", label: "Approved by" },
    { key: "approvedOn", type: "datetime", label: "Approved on", help: "Stamped when the stage becomes Approved." },
    { key: "postedUrl", type: "url", label: "Live post URL" },
  ],
}

export const contentTypes: readonly PluginContentType[] = [client, channel, campaign, post]
