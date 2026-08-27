import type { Settings } from "./config.ts"

// The snippet. This is the whole of what most sites need from Google, and it
// needs no account connected, no Cloud project, and no permission from anyone:
// an id is pasted in, the tag comes out, the site is measured.
//
// It is generated rather than typed out by hand because the ids go in three
// places in the gtag version and two in the Tag Manager one, and a snippet with
// the id updated in three places out of four is the classic way to spend an
// afternoon looking at an empty realtime report.

export type Tag = {
  readonly kind: "gtm" | "gtag" | "none"
  // Goes in <head>, as high as it will go.
  readonly head: string
  // Immediately after <body>. Empty unless Tag Manager is in use.
  readonly body: string
  readonly ids: readonly string[]
}

export const MEASUREMENT = /^G-[A-Z0-9]{4,}$/
export const CONTAINER = /^GTM-[A-Z0-9]{4,}$/
export const CONVERSION = /^AW-\d{6,}$/

const gtm = (container: string): Tag => ({
  kind: "gtm",
  head: `<!-- Google Tag Manager -->
<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','${container}');</script>
<!-- End Google Tag Manager -->`,
  body: `<!-- Google Tag Manager (noscript) -->
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${container}"
height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
<!-- End Google Tag Manager (noscript) -->`,
  ids: [container],
})

const gtag = (ids: readonly string[]): Tag => ({
  kind: "gtag",
  head: `<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=${ids[0]}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
${ids.map(id => `  gtag('config', '${id}');`).join("\n")}
</script>
<!-- End Google tag -->`,
  body: "",
  ids,
})

// Tag Manager wins when both are set, and it is not a preference. A container
// almost always has the Analytics tag configured inside it, so emitting the
// gtag snippet as well is the single most common cause of every number on the
// site reading exactly double.
export const tagFor = (current: Settings): Tag => {
  if (CONTAINER.test(current.containerId)) return gtm(current.containerId)

  const ids = [
    ...(MEASUREMENT.test(current.measurementId) ? [current.measurementId] : []),
    ...(CONVERSION.test(current.adsConversionId) ? [current.adsConversionId] : []),
  ]
  if (ids.length === 0) return { kind: "none", head: "", body: "", ids: [] }
  return gtag(ids)
}

// What is wrong with what somebody pasted, in the words of what they pasted.
// Every one of these is a real mistake with a look-alike value behind it, and
// saying "invalid" to a value copied off Google's own screen helps nobody.
export const complaints = (current: Settings): string[] => {
  const said: string[] = []

  if (current.measurementId && !MEASUREMENT.test(current.measurementId)) {
    said.push(
      current.measurementId.startsWith("UA-")
        ? "That Measurement ID starts with **UA-**, which was Universal Analytics. Google turned it off in 2023 and it collects nothing. The replacement starts with **G-** and is in Admin → Data streams."
        : "A Measurement ID looks like **G-ABCD1234**. Admin → Data streams → your website, top right.",
    )
  }
  if (current.containerId && !CONTAINER.test(current.containerId)) {
    said.push("A Tag Manager container ID looks like **GTM-ABCD123**, and it is at the top of the Tag Manager screen.")
  }
  if (current.adsConversionId && !CONVERSION.test(current.adsConversionId)) {
    said.push(
      "A Google Ads conversion ID looks like **AW-123456789**. It is the tag id, not the conversion *label* and not the customer id.",
    )
  }
  if (CONTAINER.test(current.containerId) && MEASUREMENT.test(current.measurementId)) {
    said.push(
      "Both a container and a Measurement ID are set, so only the container is served — Analytics is almost always configured inside Tag Manager, and sending both is what makes every number read double. The Measurement ID is still used for reading reports back into Inkling.",
    )
  }

  return said
}
