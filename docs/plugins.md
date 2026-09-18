# Build and install an Inkling plugin

Inkling already includes a plugin system. Plugins can add content types,
settings, admin panels, routes, database migrations, and hooks. Eight plugins
ship with Inkling; an operator enables them under **Advanced setup → Plugins**.
Their screens appear under **More tools**.

## Define a plugin

Import the public API from `inkling/plugins`. It exports `definePlugin`, the
`Plugin`, `PluginContext`, setting and panel types, and route guards. Install
Inkling and Atlas as dependencies of the project that contains your plugin.
Use the Atlas version pinned by your Inkling release.

```ts
import { get, json, pipeline } from "atlas/server"
import { can, definePlugin, requireAuth, requireCan } from "inkling/plugins"

export default definePlugin({
  name: "hello",
  version: "1.0.0",
  label: "Hello",
  settings: [{ key: "greeting", label: "Greeting", type: "text", default: "Hello" }],
  panels: [{ id: "settings", label: "Settings", kind: "settings" }],
  routes: ctx => {
    const read = pipeline(requireAuth(ctx.db), requireCan(can.readContent, "read content"))
    return [
      get("/greet", read(async c =>
        json(c, 200, { message: await ctx.getSetting("greeting", "Hello") }),
      )),
    ]
  },
})
```

The name must contain lowercase letters and digits, start with a letter, and
match its directory. The default export or a named `plugin` export is loaded.

The example answers at `/ext/hello/greet`, requires a signed-in account with
content-read permission, and offers an editable greeting in its Settings panel.
Plugin routes are **not automatically authenticated**. Apply the guards for the
audience: `requireAuth` plus `requireCan` for staff, or `requireApiKey` for a
published-content integration. `auth(c)` reads the identity after authentication;
`can` contains Inkling's role predicates. Public routes need their own input
validation and rate limiting.

## Install it

In a standalone Inkling checkout, put the file at `plugins/hello/index.ts`.
A plugin installed from another package can use a wrapper there:

```ts
export { default } from "your-plugin-package"
```

For an embedded site, create a plugin directory in the **host project** and
pass its absolute path:

```ts
import { createInkling } from "inkling"

const inkling = await createInkling({
  adminBase: "/admin",
  pluginDir: `${import.meta.dir}/plugins`,
})
```

The directory contains one subdirectory per plugin. `pluginDir` replaces the
bundled directory; it does not merge with it. Keep any plugins the site still
needs in the selected directory, including their migrations. Without an
explicit directory, Inkling loads the plugins shipped inside its own package.
Relative `pluginDir` and `PLUGIN_DIR` values resolve against the Inkling package,
not the host project's working directory.

After adding a file to a running install, restart it or call
`POST /api/plugins/reload` with an account allowed to manage plugins. Then open
**Advanced setup → Plugins** and press **Enable**. Enabling and disabling a
known plugin take effect without restarting. Changes to already imported code
need a process restart; rescanning is not a code hot-reload mechanism.

This is a trusted server-code extension system. There is no upload-from-browser
installer or marketplace. The operator installs the code; site managers switch
its features on and off.

## Settings and screens

Settings are scoped to the plugin. Use `ctx.getSetting`, `ctx.setSetting`, and
`ctx.allSettings`. Declare credentials as `type: "secret"`: Inkling seals them
at rest, masks them in API responses, and gives the plugin plaintext. A blank
secret field preserves the current value; `null` explicitly removes it.

Panels are declarative, using `settings`, `collection`, `table`, `stats`,
`connections`, or `guide`. A plugin does not inject React into the admin bundle.
Use a `guide` for setup steps and `connections` for account authorization.
All panel endpoints still need appropriate authentication guards.

## Hooks, migrations, and lifecycle

- `register(ctx)` attaches notification handlers with `ctx.on` or transformations
  with `ctx.filter`. Notification failures are logged; failing filters preserve
  the input. The registry clears plugin hooks before registering them again.
- `requires` lists plugins that must be enabled first. Disable is refused while
  an enabled plugin still depends on this one.
- `migrations/<version>/up.sql` and `down.sql` live inside the scanned plugin
  directory. Their migration names are scoped as `plugin:<name>/<version>`.
- `install(ctx)` runs when enabling a version that differs from the recorded
  installed version, after migrations and declared content are provisioned.
- Disable stops routes and hooks and hides plugin panels while retaining data.
  It does not delete the plugin's content types or unpublish existing content.
- Uninstall is destructive: it invokes `uninstall`, rolls back plugin migrations,
  and removes owned content types, taxonomies, settings, and the registry row.
  It requires a disabled plugin and an explicit name confirmation in the API.

File uploads currently use Inkling's local-disk or S3-compatible storage driver.
Plugins can observe `media.afterUpload` and `media.afterDelete`; these are
notifications, not storage replacement hooks. No Stohr integration ships in
this release.

See the [plugin tutorial](https://wess.io/inkling/tutorials/#plugin),
[architecture](https://raw.githubusercontent.com/wess/inkling/main/docs/ARCHITECTURE.md),
and [bundled examples](https://github.com/wess/inkling/tree/main/plugins).
