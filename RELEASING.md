# Releasing Inkling, and rolling it to the sites

Inkling is consumed as a git dependency, so a release is a tag and a rollout is
a redeploy. Nothing is published to npm.

## The sites

| Site | URL | Admin | Repo | Host |
|---|---|---|---|---|
| apothecary | https://apothecary.wess.dev | `/admin` | `wess/apothecary` (private) | gohan |
| 803media | https://803media.wess.dev | `/studio` | `wess/803media` (private) | gohan |
| inkling | https://inkling.wess.dev | `/admin` | `inkling-site` (local) | gohan |
| warren | https://warren.wess.dev | `/admin` | `warrenpublishing` (local) | gohan |

`inkling.wess.dev` is the School — this project's own documentation, running on
this project. Its lessons are content in its Inkling, so a deploy that changes
them needs a seed afterwards:

```sh
ssh gohan 'sudo docker exec inkling bun run seed'
```

The seed is idempotent and deliberately *not* part of boot: it rewrites every
lesson, and doing that automatically would overwrite anything edited in the
admin since.

Each mounts Inkling in-process with `createInkling()` and pins it by tag. They
all run on the `gohan` droplet behind Caddy, deployed from the **devops** repo
(`~/Desktop/Dev/devops`), which is where the host and service runbooks live.

```sh
bun run sites          # health + deployed version for every site
bun run sites 803media # just one
```

Exits non-zero if anything is down or behind, so it can gate a deploy.

## Cutting a release

1. **Green first.** All four must be clean — there is no build step, so this is
   the whole verification path.

   ```sh
   bunx tsc --noEmit && bun test && bunx biome check . && bun run docs
   ```

2. **Version.** Bump `package.json` and add a `CHANGELOG.md` entry. From 1.0
   this is semver, and the public surface is the delivery API, `createInkling()`,
   the plugin interface, and the shape of a content type — breaking any of them
   takes a major. New surface is a minor; fixes alone are a patch.

3. **Commit and tag.** The tag is what sites pin, so it must exist before they
   can move.

   ```sh
   git commit -am "Release X.Y.Z"
   git tag -a vX.Y.Z -m "Release X.Y.Z"
   git push origin main && git push origin vX.Y.Z
   ```

Anything under `docs/` publishes to GitHub Pages on push — check
https://wess.io/inkling/ afterwards. The School at `inkling.wess.dev` is a
separate Inkling-powered surface and is seeded through its own deploy path.

## Rolling it to a site

One site at a time, verified before the next. They share a database server and a
967MB box; two simultaneous image builds is not worth finding out about.

1. **Pin it.** In the site's `package.json`:

   ```json
   "inkling": "github:wess/inkling#vX.Y.Z"
   ```

   ```sh
   bun install && bunx tsc --noEmit
   git commit -am "Pin Inkling to vX.Y.Z" && git push
   ```

2. **Deploy.** From the devops repo. The image runs its own `bun install`, so
   what ships is the tag — not this machine's working tree.

   ```sh
   cd ~/Desktop/Dev/devops
   bun run scripts/gohan.ts apothecary
   ```

3. **Verify.** `/health` only answers once migrations, plugins, and the admin
   bundle have all finished, which makes it a real end-to-end check.

   ```sh
   cd ~/Desktop/Dev/inkling && bun run sites apothecary
   ```

## Migrations run on deploy

`createInkling()` applies pending migrations before it binds the port. That
means **a deploy is a schema change**, and the boot log is the record of it:

```sh
ssh gohan 'cd /opt/apps/apothecary && sudo docker compose logs --tail 20 apothecary'
```

Exactly one instance per database, always. Two containers migrate against each
other. There is no advisory lock protecting this — the constraint is
operational, and `compose.yaml` says so too.

## Rolling back

Repin the site to the previous tag and redeploy. That reverts code, **not the
database**: a migration applied on the way up is still applied. Inkling's
migrations are additive, so an older build tolerates a newer schema — but check
the `down.sql` of anything applied since before relying on it.

```sh
# in the site repo
"inkling": "github:wess/inkling#vPREVIOUS"
bun install && git commit -am "Roll back Inkling to vPREVIOUS" && git push
cd ~/Desktop/Dev/devops && bun run scripts/gohan.ts apothecary
```

## Adding a site

1. Mount Inkling — see "Or mount it inside the site" in `README.md`. Pass Bun's
   `server` through to `inkling.fetch`, or every rate-limit bucket keys on an
   empty address.
2. Its own database and its own `SECRET`. Inkling is single-tenant; separate
   sites are separate databases, and a shared `SECRET` means one rotation
   invalidates both.
3. Deploy config in the devops repo under `deploy/gohan/<name>/`, a Caddy vhost,
   and a service page in `docs/services/`.
4. A line in `scripts/sites.ts` so it shows up in the fleet check.
