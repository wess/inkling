---
name: inklingsitereview
description: Review a connected Inkling website before a demo or publication for missing content, hero artwork, navigation, and publishing status. Use for a read-only content readiness check.
---

# Review an Inkling website

Keep this workflow read-only unless the user separately requests a fix.
Call `get_connection`, `list_types`, `get_shared_areas`, and `get_visual_pages`.
Inspect the relevant pages with `list_entries` and `get_entry`, and menus with
`list_menus` and `get_menu`. Paginate when the review covers a whole collection.

Check required fields, missing headings or buttons, unexpected draft or scheduled
status, empty shared details, broken internal menu destinations, and references
to unavailable or unpublished content. Check hero artwork against its selected
mode. On Warren, inspect the selected book IDs and their covers, not just whether
the array is nonempty. Confirm layout IDs belong to the registered manifest.

Separate missing content from intentional empty values. Do not invent an email,
book release date, image description, price, or destination to fill a gap.
Use browsing tools, when available, to check public links and appearance. MCP
records alone do not prove responsive layout, image loading, or visual quality.

Report blockers first, naming the page or shared source and the smallest useful
fix. Then list the checks that passed and any checks you could not perform.
Do not create entries, edit settings, or publish anything during the review.
