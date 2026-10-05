const names = ["inklingedit", "inklingcampaign", "inklingsitereview"] as const

const files = await Promise.all(
  names.map(async name => {
    const text = await Bun.file(new URL(`../../skills/${name}/SKILL.md`, import.meta.url)).text()
    const frontmatter = Bun.YAML.parse(text.split("---")[1] ?? "") as { name: string; description: string }
    const uri = `skill://inkling/${name}/SKILL.md`
    const digest = `sha256:${new Bun.CryptoHasher("sha256").update(text).digest("hex")}`
    return { name, text, uri, frontmatter, resources: [{ uri, digest }] }
  }),
)

export const skillCatalog = files.map(({ uri, frontmatter, resources }) => ({ uri, frontmatter, resources }))

export const skillResource = (uri: string): { uri: string; mimeType: string; text: string } | null => {
  const file = files.find(file => file.uri === uri)
  return file ? { uri: file.uri, mimeType: "text/markdown", text: file.text } : null
}

export const skillDownload = (name: string): string | null => files.find(file => file.name === name)?.text ?? null
