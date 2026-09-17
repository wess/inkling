import { useState } from "react"
import { HELP, type HelpEntry } from "./help.ts"

export const HelpContent = ({ entry }: { entry: HelpEntry }): React.JSX.Element => (
  <div className="helpbody">
    <p>{entry.what}</p>
    {entry.steps ? (
      <div>
        <h3>What to do</h3>
        <ol>
          {entry.steps.map(step => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </div>
    ) : null}
    {entry.example ? (
      <p className="helpeg">
        <b>For example: </b>
        {entry.example}
      </p>
    ) : null}
    {entry.careful ? (
      <p className="helpcare">
        <b>Worth knowing: </b>
        {entry.careful}
      </p>
    ) : null}
  </div>
)

const groups = [
  { title: "Getting started", prefixes: ["home.", "account.", "ai.inky", "ai.reach"] },
  { title: "Writing & publishing", prefixes: ["entry."] },
  { title: "Photos & files", prefixes: ["media."] },
  { title: "Social media", prefixes: ["social."] },
  {
    title: "Managing your website",
    prefixes: ["taxonomy.", "term.", "menu.", "menus.", "settings.", "users.", "activity.", "trash."],
  },
  {
    title: "Advanced setup",
    prefixes: [
      "types.",
      "type.",
      "field.",
      "keys.",
      "agentkeys.",
      "webhooks.",
      "plugins.",
      "ai.provider",
      "ai.key",
      "ai.model",
      "ai.baseUrl",
    ],
  },
]

export const HelpScreen = (): React.JSX.Element => {
  const [query, setQuery] = useState("")
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
  const entries = Object.entries(HELP).filter(([, entry]) => {
    const text = [entry.title, entry.what, entry.example, entry.careful, ...(entry.steps ?? [])]
      .join(" ")
      .toLocaleLowerCase()
    return words.every(word => text.includes(word))
  })

  return (
    <div className="helppage">
      <h1>Help</h1>
      <p className="helpintro">
        Find an answer, or follow a guide at your own pace. The (?) buttons around Inkling open the same advice right
        where you need it.
      </p>
      <label className="helpsearch">
        <span>Search help</span>
        <input
          type="search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Try publishing, photos, or password"
        />
      </label>
      <p className="helpresult" role="status">
        {words.length
          ? `${entries.length} ${entries.length === 1 ? "topic" : "topics"} found`
          : "Choose a topic below. Some controls depend on your role and how your website was set up."}
      </p>
      {!entries.length ? <p>No matching topics. Try a shorter search, such as “save” or “photo”.</p> : null}
      {groups.map(group => {
        const topics = entries.filter(([id]) => group.prefixes.some(prefix => id.startsWith(prefix)))
        if (!topics.length) return null
        return (
          <details
            className="helpgroup"
            key={`${query}-${group.title}`}
            open={words.length > 0 || group.title === "Getting started"}
          >
            <summary>
              <h2>{group.title}</h2>
            </summary>
            {group.title === "Advanced setup" ? (
              <p className="helpintro">
                For the person who builds or connects your website. You do not need these settings for everyday updates.
              </p>
            ) : null}
            {topics.map(([id, entry]) => (
              <details className="helptopic" key={`${query}-${id}`}>
                <summary>{entry.title}</summary>
                <HelpContent entry={entry} />
              </details>
            ))}
          </details>
        )
      })}
      <p className="helpintro">
        Still stuck? Contact the person who looks after your website. Tell them which screen you are on and what you
        were trying to do. Never share your password.
      </p>
    </div>
  )
}
