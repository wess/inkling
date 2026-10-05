---
name: inklingedit
description: Edit or draft Inkling website content through a connected Inkling MCP server, including copy, shared contact details, and navigation. Use for requested website updates, not source-code development.
---

# Edit an Inkling website

Use the connected site's tools. Tool names may have a client-specific prefix.
If several sites are connected, identify the requested site before writing.

Call `get_connection` and `list_types` to learn the account, permissions, and
actual field definitions. Find the target with `list_entries` or `search`, then
read it with `get_entry`. Resolve ambiguous titles before changing anything.

For header, footer, colors, and navigation, call `get_shared_areas` first. Its
sources identify the real entry, menu, or settings fields. Shared updates affect
every page using the source. Read the existing menu before editing it; preserve
unrelated links. Upload new artwork through Inkling's Photos & files, then use
`list_media` to obtain its media ID. A filesystem path is not a media ID.

`update_entry` merges data fields; send only the requested changes. Use null to
clear an optional field. A list value replaces the whole list, so preserve rows
outside the request. Editing a published entry changes the live website
immediately. A request to draft or propose is not permission to update a live
entry: show the proposed change in the conversation, or create a new draft when
that is the requested outcome. Keep existing URLs unless the user asks to change
them. New entries remain drafts until `publish_entry` runs.

For layout requests, read `get_visual_pages` and the entry's `data.__layout`.
Only use registered section IDs. Preserve unrelated order, hidden IDs, and other
layout values. Respect fixed sections; unsupported new layouts need the site builder.

After a successful write, read the affected entry, menu, or settings again and
check the changed values. Report what changed and whether it is live or draft.
On a timeout or interrupted write, read the target before retrying: it may have
saved already. On a permission failure, explain the missing capability rather
than asking for a password or a broader credential.
