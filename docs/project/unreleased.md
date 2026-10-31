# Unreleased changes

- Added optional provider retry counts and initial waits in Settings → AI.
  Clear either field to restore the existing per-class defaults; zero means
  unlimited retries or an immediate wait. Changes apply on the next turn,
  including builtin subagents. Stop and server `Retry-After` remain authoritative.
- Added native DNS over HTTPS in Settings → General → Network, off by default
  and local to this device. Chromium owns resolution for supported Desktop
  routes, including provider/Host traffic through the authenticated local relay.
  System DNS fallback requires explicit opt-in; disabling retains preferences
  without changing OS DNS or trust. Startup/configuration races now reject stale
  Host/sidecar state instead of admitting an unconfigured provider process.
  See [Network and AI settings](../spec/04-ux/06-settings-ia.md) for defaults,
  reset semantics and scope. This entry does not mark the candidate as released.
- Fixed prompt cache misses after a conversation's agent runtime is rebuilt
  (#1972). Rebuilding happens after a restart or when the thinking level, mode,
  project rules, or model settings change. Assistant replies now keep the
  provider's thinking, reasoning, and Gemini function-call signatures in the
  transcript, so Claude, OpenAI Responses, Gemini, and other reasoning models
  receive the same history as before the rebuild instead of a rewritten one.
- Fixed duplicate `/、` when opening slash commands with a Chinese IME in an
  empty composer. Keep pre-edit text intact and apply the slash alias only
  after composition commits, preserving recovery from a missing end event.
- Add OpenAI Fast mode (#1657). Allow it per model in Settings → Models for a
  ChatGPT subscription or an OpenAI Responses connection, then type `/fast` to
  turn it on for the current conversation. Requests ask for the priority
  service tier, which replies faster and spends plan limits faster or bills
  more per token; the Composer model chip shows a Fast mark while it is on.
- Fixed an older regenerated prompt appearing after the latest reply when its
  branch archive completed outside the loaded history window (#1870). Pager
  acknowledgements now update existing rows without appending historical roots.
- Generate inline visualizations faster. The visualization shell now preloads
  the bundled D3 and a `viz` chart helper layer (container sizing, resize and
  theme redraw, axes, tick overlap, legends, and a declarative `viz.render`
  for bar, line, area, point, heatmap, and donut charts), so model-written
  fragments are shorter. The `visualize` skill asks for a single write
  followed by the reply instead of reading the file back. Fragments written
  under the earlier skill keep rendering. When a fragment's script fails, the
  card now says so and shows the error instead of staying blank, and the
  model's write result flags syntax errors and missing chart containers so it
  can fix them with one edit.
