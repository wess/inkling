import { decodeObject } from "../../json/index.ts"
import type { Attachment } from "../media.ts"
import type { Json, PublishContext, Published } from "./index.ts"
import { bearer, nested, readJson, str } from "./index.ts"

// LinkedIn, through the UGC Posts API on a member token.
//
// Media is a three-step registration: ask for an upload slot, PUT the bytes to
// the URL it hands back, then reference the *asset urn* it gave you in the post
// — the bytes and the post are never in the same request. Images and video use
// different recipes for the same dance, which is the only reason there are two
// functions below rather than one.
//
// The header block is not decoration. LinkedIn's API is Rest.li, and without
// the protocol version it answers a perfectly valid request with a 426.

const API = "https://api.linkedin.com"

const headers = (token: string): Record<string, string> => ({
  ...bearer(token),
  "x-restli-protocol-version": "2.0.0",
  "linkedin-version": "202411",
})

type Slot = { readonly asset: string; readonly upload: string }

const register = async (token: string, owner: string, recipe: string): Promise<Slot> => {
  const payload = await readJson(
    await fetch(`${API}/v2/assets?action=registerUpload`, {
      method: "POST",
      headers: { ...headers(token), "content-type": "application/json" },
      body: JSON.stringify({
        registerUploadRequest: {
          owner,
          recipes: [`urn:li:digitalmediaRecipe:${recipe}`],
          serviceRelationships: [{ relationshipType: "OWNER", identifier: "urn:li:userGeneratedContent" }],
        },
      }),
    }),
  )

  const value = nested(payload, "value")
  const asset = str(value, "asset")
  // The mechanism is keyed by its own fully-qualified class name, which is how
  // Rest.li spells a union. There is exactly one for this recipe.
  const mechanism = nested(
    nested(value, "uploadMechanism"),
    "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest",
  )
  const upload = str(mechanism, "uploadUrl")

  if (!asset || !upload) throw new Error("LinkedIn did not open an upload slot")
  return { asset, upload }
}

const upload = async (token: string, owner: string, item: Attachment): Promise<string> => {
  const slot = await register(token, owner, item.isVideo ? "feedshare-video" : "feedshare-image")
  const blob = await item.bytes()

  const response = await fetch(slot.upload, {
    method: "PUT",
    headers: { ...bearer(token), "content-type": item.mime },
    body: blob,
  })
  if (!response.ok) {
    throw new Error(`LinkedIn refused the upload (${response.status}): ${(await response.text()).slice(0, 300)}`)
  }

  return slot.asset
}

export const publish = async (context: PublishContext): Promise<Published> => {
  const meta = decodeObject(context.account.meta)
  const owner = str(meta, "urn") ?? (context.account.account_id ? `urn:li:person:${context.account.account_id}` : null)
  if (!owner) throw new Error("This connection has no LinkedIn member on it. Reconnect the account.")

  const video = context.media.find(item => item.isVideo)
  const images = context.media.filter(item => item.isImage)

  const assets: Json[] = []
  if (video) {
    assets.push({ status: "READY", media: await upload(context.token, owner, video) })
  } else {
    for (const image of images) {
      assets.push({
        status: "READY",
        media: await upload(context.token, owner, image),
        ...(image.alt ? { description: { text: image.alt.slice(0, 200) } } : {}),
      })
    }
  }

  // LinkedIn has no link field on a share with media, so a URL rides in the
  // text — which is what the 3,000-character count already measured.
  const text = [context.caption, context.link].filter(part => part && part.trim() !== "").join("\n\n")
  const category = video ? "VIDEO" : images.length > 0 ? "IMAGE" : "NONE"

  const response = await fetch(`${API}/v2/ugcPosts`, {
    method: "POST",
    headers: { ...headers(context.token), "content-type": "application/json" },
    body: JSON.stringify({
      author: owner,
      lifecycleState: "PUBLISHED",
      visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text },
          shareMediaCategory: category,
          ...(assets.length > 0 ? { media: assets } : {}),
        },
      },
    }),
  })

  // The created urn comes back in a header, and only sometimes in the body.
  const header = response.headers.get("x-restli-id")
  const payload = await readJson(response)
  const urn = header ?? str(payload, "id")
  if (!urn) throw new Error("LinkedIn accepted the post but returned no id")

  return { remoteId: urn, url: `https://www.linkedin.com/feed/update/${urn}` }
}
