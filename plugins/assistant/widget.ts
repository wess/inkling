// The bubble a visitor sees, as a string because it is served to a browser
// rather than bundled by anything here.
//
// It is deliberately plain: no framework, no build step, no external request
// beyond the one that answers a question. A site adds one script tag and gets a
// launcher in the corner; everything it needs — the endpoint, the greeting — it
// reads from the tag it was loaded by, so nothing has to be configured twice.
//
// Styles are scoped to a shadow root. A widget that inherits a host site's CSS
// looks broken on half of them, and a widget that leaks its own CSS out breaks
// the other half.

export const WIDGET = `
(function () {
  var script = document.currentScript
  if (!script) return

  // Where this script came from is where its answers come from. Deriving it
  // means a site never configures the origin twice, and never points the two
  // halves at different places.
  var base = new URL(script.src, location.href).origin
  var greeting = script.getAttribute("data-greeting") || "Ask me anything about this site."
  var title = script.getAttribute("data-title") || "Ask"
  var accent = script.getAttribute("data-accent") || "#3d5afe"

  var host = document.createElement("div")
  host.setAttribute("data-inkling-assistant", "")
  var root = host.attachShadow({ mode: "open" })
  document.body.appendChild(host)

  var css = document.createElement("style")
  css.textContent = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}',
    '.bubble{position:fixed;right:20px;bottom:20px;width:52px;height:52px;border:0;border-radius:50%;background:' + accent + ';color:#fff;cursor:pointer;display:grid;place-items:center;box-shadow:0 10px 30px rgba(0,0,0,.25);z-index:2147483000}',
    '.bubble:hover{transform:translateY(-2px)}',
    '.panel{position:fixed;right:20px;bottom:84px;width:min(380px,calc(100vw - 40px));max-height:min(560px,calc(100vh - 120px));background:#fff;color:#14161a;border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.24);display:flex;flex-direction:column;overflow:hidden;z-index:2147483000}',
    '.head{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #e6e8ec;font-weight:600;font-size:14px}',
    '.close{margin-left:auto;border:0;background:none;font-size:18px;cursor:pointer;color:#6b7280;line-height:1}',
    '.log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;font-size:14px;line-height:1.5}',
    '.msg{padding:9px 12px;border-radius:12px;max-width:85%;white-space:pre-wrap;overflow-wrap:anywhere}',
    '.them{background:#f1f3f7;align-self:flex-start}',
    '.you{background:' + accent + ';color:#fff;align-self:flex-end}',
    '.src{font-size:12px;color:#6b7280;align-self:flex-start}',
    '.src a{color:inherit}',
    '.bar{display:flex;gap:8px;padding:12px;border-top:1px solid #e6e8ec}',
    '.bar input{flex:1;padding:9px 11px;border:1px solid #d7dae1;border-radius:9px;font-size:14px;min-width:0}',
    '.bar button{border:0;border-radius:9px;padding:0 14px;background:' + accent + ';color:#fff;cursor:pointer;font-size:14px}',
    '.bar button[disabled]{opacity:.55;cursor:default}',
    '@media (prefers-color-scheme:dark){.panel{background:#171a1f;color:#e8eaee}.head,.bar{border-color:#2b2f38}.them{background:#22262e}.bar input{background:#12141a;border-color:#2b2f38;color:inherit}}',
  ].join("")
  root.appendChild(css)

  var bubble = document.createElement("button")
  bubble.className = "bubble"
  bubble.type = "button"
  bubble.setAttribute("aria-label", title)
  bubble.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
  root.appendChild(bubble)

  var panel = null

  var say = function (log, text, who) {
    var el = document.createElement("div")
    el.className = "msg " + who
    el.textContent = text
    log.appendChild(el)
    log.scrollTop = log.scrollHeight
    return el
  }

  var open = function () {
    if (panel) return
    panel = document.createElement("div")
    panel.className = "panel"
    panel.setAttribute("role", "dialog")
    panel.setAttribute("aria-label", title)

    var head = document.createElement("div")
    head.className = "head"
    head.textContent = title
    var close = document.createElement("button")
    close.className = "close"
    close.type = "button"
    close.setAttribute("aria-label", "Close")
    close.textContent = "×"
    close.onclick = shut
    head.appendChild(close)

    var log = document.createElement("div")
    log.className = "log"

    var bar = document.createElement("form")
    bar.className = "bar"
    var input = document.createElement("input")
    input.placeholder = "Ask a question"
    input.setAttribute("aria-label", "Ask a question")
    var send = document.createElement("button")
    send.type = "submit"
    send.textContent = "Ask"
    bar.appendChild(input)
    bar.appendChild(send)

    panel.appendChild(head)
    panel.appendChild(log)
    panel.appendChild(bar)
    root.appendChild(panel)

    say(log, greeting, "them")
    input.focus()

    bar.onsubmit = function (event) {
      event.preventDefault()
      var question = input.value.trim()
      if (!question || send.disabled) return
      input.value = ""
      say(log, question, "you")
      send.disabled = true
      var pending = say(log, "…", "them")

      fetch(base + "/ext/assistant/public-ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: question, path: location.pathname }),
      })
        .then(function (response) {
          return response.json().then(function (body) {
            return { ok: response.ok, body: body }
          })
        })
        .then(function (result) {
          if (!result.ok) throw new Error((result.body && result.body.error) || "That did not work.")
          pending.textContent = (result.body.data && result.body.data.answer) || ""
          var sources = (result.body.data && result.body.data.sources) || []
          if (sources.length) {
            var note = document.createElement("div")
            note.className = "src"
            note.textContent = "Based on: " + sources.map(function (s) { return s.title }).join(", ")
            log.appendChild(note)
          }
        })
        .catch(function (error) {
          pending.textContent = String(error.message || error)
        })
        .then(function () {
          send.disabled = false
          log.scrollTop = log.scrollHeight
          input.focus()
        })
    }
  }

  var shut = function () {
    if (!panel) return
    panel.remove()
    panel = null
    bubble.focus()
  }

  bubble.onclick = function () {
    if (panel) shut()
    else open()
  }

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") shut()
  })
})()
`
