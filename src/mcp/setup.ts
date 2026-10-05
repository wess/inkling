import type { Route } from "atlas/server"
import { get, putHeader, text } from "atlas/server"
import { config } from "../config/index.ts"
import { skillCatalog, skillDownload } from "./skills.ts"

const escapeHtml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

export const setupPage = (origin: string, adminBase = "/"): string => {
  const url = escapeHtml(new URL("/mcp", origin).href)
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect your desktop app · Inkling</title>
<style>
:root{color-scheme:light;--ink:#202b29;--muted:#52625c;--paper:#f5f4ed;--line:#ced5cb;--accent:#245e48}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.65 system-ui,sans-serif}
main{max-width:900px;margin:auto;padding:48px 24px 80px}a{color:var(--accent)}header{padding:20px 0 36px;border-bottom:1px solid var(--line)}
h1{font:clamp(38px,7vw,66px)/1.06 Georgia,serif;letter-spacing:-.03em;max-width:700px;margin:22px 0}
h2{font:32px/1.2 Georgia,serif;margin:0 0 20px}h3{font-size:20px;margin:24px 0 10px}p{margin:12px 0}li{padding:5px 0}
nav{display:flex;flex-wrap:wrap;gap:12px 24px;padding:24px 0}section{padding:36px 0;border-bottom:1px solid var(--line);scroll-margin-top:20px}
.eyebrow{font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}.intro{font-size:20px;max-width:680px;color:var(--muted)}
.connection,.prompt,.skill{background:#fff;border:1px solid var(--line);border-radius:12px;padding:20px;margin:20px 0}
label{display:block;font-weight:650;margin-bottom:8px}.urlrow{display:flex;gap:8px}input{min-width:0;flex:1;font:15px ui-monospace,monospace;padding:12px;border:1px solid var(--line);border-radius:6px;background:#fff;color:var(--ink)}
button,.download{display:inline-block;border:1px solid var(--accent);border-radius:6px;padding:10px 16px;background:var(--accent);color:#fff;font:inherit;text-decoration:none;cursor:pointer}
code{font:14px/1.6 ui-monospace,monospace;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere}summary{cursor:pointer;font-weight:650;padding:12px 0}
:focus-visible{outline:3px solid #bd7420;outline-offset:3px}.small{font-size:14px;color:var(--muted)}footer{padding:24px 0;font-size:14px}
@media(max-width:480px){main{padding:24px 18px 50px}.urlrow{flex-direction:column}.connection,.prompt,.skill{padding:16px}}
</style><script src="/mcp/setup.js" defer></script></head><body><main>
<header><a href="${escapeHtml(new URL(adminBase, origin).href)}">Inkling</a><p class="eyebrow">Desktop setup · About 5 minutes</p>
<h1>Your website, from your desktop app.</h1><p class="intro">Connect ChatGPT or Codex to this Inkling website. Find content, prepare changes, and work with your own website account.</p>
<p>You need your desktop app, a website login, and permission to make the changes you want. The connection uses your app account for the conversation and your Inkling account for website access.</p></header>
<nav aria-label="On this page"><a href="#connect">1. Connect</a><a href="#check">2. Check it works</a><a href="#skills">3. Add workflows</a><a href="#trouble">Troubleshooting</a></nav>
<section id="connect"><p class="eyebrow">Step 1</p><h2>Connect this website</h2>
<div class="connection"><label for="server">Your website's server URL</label><div class="urlrow"><input id="server" readonly value="${url}"><button type="button" id="copy">Copy URL</button></div><p id="copyresult" role="status" class="small">Copy the complete address, including /mcp.</p></div>
<h3>Codex in the desktop app</h3><ol><li>Open <b>Settings → MCP servers → Add server</b>.</li><li>Name it after your website. Choose <b>Streamable HTTP</b> and paste the server URL above.</li><li>Save, then select <b>Restart</b>. If sign-in is needed, select <b>Authenticate</b>.</li><li>The browser opens this website's Inkling sign-in page. Sign in with your own website account and review the access requested.</li><li>Return to the app. Type <code>/mcp</code> in the composer and check that this server is connected.</li></ol>
<h3>ChatGPT chats</h3><p>ChatGPT chats use a personal plugin. Adding a server to Codex does not automatically create that plugin.</p><ol><li>Open ChatGPT <b>Settings → Security and login</b> and enable <b>Developer mode</b>.</li><li>Open <a href="https://chatgpt.com/plugins" target="_blank" rel="noreferrer">Plugins</a>, select the plus button, and enter the server URL above. Choose OAuth when asked for authentication.</li><li>Finish the connection and sign in to this Inkling website when prompted.</li><li>Open your personal plugin and install it. Start a new <b>Work</b> chat, type <code>@</code>, and select your website plugin.</li></ol>
<p class="small">Menus and access depend on your app version and workspace. If these options are missing, use the current official setup links below or ask your workspace administrator. The website password belongs on the Inkling sign-in page, never in a chat message.</p></section>
<section id="check"><p class="eyebrow">Step 2</p><h2>Make a read-only connection check</h2><p>Start with this message:</p>
<div class="prompt"><p>Use the Inkling connection to tell me which website and account I am connected to, what I am allowed to change, and which pages are available. Do not change anything.</p></div>
<p>The app should call <code>get_connection</code> and <code>list_types</code>, then list your pages. Check the website address and account before asking for edits.</p>
<h3>Try a real workflow</h3><div class="prompt"><p>Prepare a homepage campaign for [book title]. Find the book and its current cover, check which hero controls my site supports, and show me the exact changes. Do not save yet.</p></div>
<p>Once the proposal is correct, ask it to apply those changes. Updating an already published page changes the live website immediately. A new page starts as a draft; ask to publish only when it is ready. Check the public page after saving.</p></section>
<section id="skills"><p class="eyebrow">Step 3 · Optional</p><h2>Add reusable workflows</h2><p>The connection works without skills. These small instruction files teach the app repeatable workflows around Inkling's tools.</p>
${skillCatalog.map(skill => `<article class="skill"><h3>${escapeHtml(skill.frontmatter.name)}</h3><p>${escapeHtml(skill.frontmatter.description)}</p><a class="download" href="/mcp/skills/${skill.frontmatter.name}">Download skill</a></article>`).join("")}
<h3>Install in Codex</h3><p>Download the files, then ask Codex to install each as a local skill. It should place each file in a folder matching its name, as <code>~/.codex/skills/inklingedit/SKILL.md</code>, for example. Start a new conversation after installation. You can invoke a skill with <code>$inklingedit</code>, <code>$inklingcampaign</code>, or <code>$inklingsitereview</code>.</p>
<h3>Use with ChatGPT</h3><p>Ask the built-in skill creator to make a reusable workflow using the downloaded instructions and your Inkling plugin. Availability depends on your workspace. If you cannot install skills, use the example prompts above with the connected plugin.</p>
<p class="small">The MCP server also exposes these files for plugin builders. Importing them into a distributed plugin is a separate packaging step; connecting the website alone does not install skills.</p></section>
<section id="trouble"><h2>If something does not work</h2>
<details><summary>The server is listed but no tools are available</summary><p>Select Restart, authenticate if prompted, and start a new conversation. In Codex, check <code>/mcp</code>. In ChatGPT, install the personal plugin and select it with <code>@</code> in Work.</p></details>
<details><summary>Sign-in fails or the connection has expired</summary><p>Authenticate again using your Inkling website login. Each person needs their own account. If the browser reports an invalid callback, send your site manager the error text and app name, without passwords or tokens.</p></details>
<details><summary>I can read pages but cannot change them</summary><p>The connection respects your website role. Ask your site administrator whether your account has editing or publishing permission. Reconnecting does not grant a higher role.</p></details>
<details><summary>An edit timed out</summary><p>Ask the app to read the entry again before retrying. The save may already have completed. Review the current values and revision history.</p></details>
<details><summary>I want to disconnect</summary><p>Remove the server or plugin in your app. In Inkling, open Agent keys and revoke the connection key if you have access; otherwise ask the site administrator to revoke it. App removal alone may not revoke the server credential immediately.</p></details>
</section><footer><p>Setup instructions checked October 5, 2026.</p><p>Official guidance: <a href="https://learn.chatgpt.com/docs/extend/mcp">Desktop MCP setup</a> · <a href="https://developers.openai.com/plugins/quickstart">ChatGPT plugin setup</a> · <a href="https://developers.openai.com/plugins/build/skills">Skills</a></p></footer>
</main></body></html>`
}

const script = `document.querySelector('#copy').addEventListener('click', async () => {
  const input = document.querySelector('#server');
  const status = document.querySelector('#copyresult');
  try { await navigator.clipboard.writeText(input.value); status.textContent = 'URL copied.'; }
  catch { input.focus(); input.select(); status.textContent = 'Select Copy from your app menu to copy the selected URL.'; }
});`

export const setupRoutes = (adminBase = "/"): Route[] => [
  get("/mcp/setup", c =>
    putHeader(text(c, 200, setupPage(config.publicUrl, adminBase)), "content-type", "text/html; charset=utf-8"),
  ),
  get("/mcp/setup.js", c => putHeader(text(c, 200, script), "content-type", "text/javascript; charset=utf-8")),
  get("/mcp/skills/:name", c => {
    const value = skillDownload(c.params.name ?? "")
    return value === null
      ? text(c, 404, "Unknown skill")
      : putHeader(
          putHeader(text(c, 200, value), "content-type", "text/markdown; charset=utf-8"),
          "content-disposition",
          'attachment; filename="SKILL.md"',
        )
  }),
]
