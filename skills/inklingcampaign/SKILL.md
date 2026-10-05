---
name: inklingcampaign
description: Prepare an Inkling homepage for a book release or seasonal campaign using existing catalog entries, covers, hero artwork, and website colors. Use when promoting releases on a connected publishing website.
---

# Prepare a release campaign

Call `get_connection`, `list_types`, and `get_visual_pages`. Identify the homepage
and read it with `get_entry`. Do not assume every site uses Warren's field names.
Find the named releases with `list_entries` or `search`. Confirm each book's ID,
publication status, availability, and cover. Distinguish formats or duplicate
titles using their actual fields; never guess which entry the user means.

For sites with Warren's campaign controls:

- `heroBackground` accepts `catalog`, `books`, `image`, or `solid`.
- `heroBooks` stores an array of book entry IDs, not slugs or expanded objects.
- `heroImage` stores a media ID from `list_media`.
- Selected releases use the current covers of published, available or preorder
  books. One cover can repeat. Books without artwork do not produce cover tiles.
- Selecting an image or solid color keeps the stored book selection for later.

Read `get_shared_areas` before changing website colors. On Warren these belong
to the shared house entry: `backgroundColor`, `darkBackgroundColor`, `textColor`,
and `accentColor`. Use six-digit hex colors; null restores the original. Keep
text readable and explain that shared colors apply across pages.

Prepare the exact fields and chosen titles for review when the user asks for a
proposal. When they request the update, save only those fields with `update_entry`.
Updating a published homepage is immediately live. Never publish catalog drafts
as a side effect of selecting a campaign, and never replace unrelated homepage
copy, buttons, figures, layout, or book selections.

Read the homepage and any changed shared source again after saving. Report the
selected mode and release titles, missing covers or unpublished entries, and
whether the change is live. Check the public page if a browsing tool is available;
otherwise say that stored values were verified and visual appearance was not.
