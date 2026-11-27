# Real-Gateway proof: `before_message_write` footer on a media reply (PR #206651 / issue #206571)

`hook-footer-media-real-gateway.mjs` runs the **actual dist build** end to end:

- a real isolated **Gateway** process (`dist/index.js gateway`, loopback, token auth),
- a real **on-disk plugin** (`footer-hook`) registering a real `before_message_write`
  handler that appends `FOOTER_FROM_HOOK` to the text block carrying a `MEDIA:` directive,
- a scripted loopback **OpenAI Responses** transport that drives a tool turn followed by a
  final reply `Caption text.\n\nMEDIA:./reply.png` (the PNG is staged from the agent
  workspace, so no network/SSRF is involved),
- a real **Chromium** (Playwright) driving the **Control UI** composer, i.e. the real
  WebChat deliver path, then a **reload** and a fresh `chat.history` read,
- a **text-only control** turn that must not get the footer.

It asserts on the rendered display blocks (`openclawDisplayContent` when present, else the
materialized `content`) for the media assistant row.

## How to run

```bash
# from a checkout whose dist/ was built from the commit under test
node hook-footer-media-real-gateway.mjs --repo /path/to/openclaw --expect head --out out/head
node hook-footer-media-real-gateway.mjs --repo /path/to/openclaw --expect base --out out/base
```

`--expect head` passes only if the footer/image/caption are each retained exactly once;
`--expect base` passes only if the bug reproduces.

## Result

| assertion (media assistant row)  | BASE (no fix)      | HEAD (fix) |
| -------------------------------- | ------------------ | ---------- |
| caption blocks                   | **2 (duplicated)** | 1          |
| footer blocks                    | 1                  | 1          |
| image blocks                     | 1                  | 1          |
| after Control UI reload: caption | **2 (duplicated)** | 1          |
| after Control UI reload: footer  | 1                  | 1          |
| text-only control: footer        | 0                  | 0          |

- **BASE** (`proof.base.json`): `displayTexts = ["Caption text.", "FOOTER_FROM_HOOK", "Caption text."]`
  — the caption is rendered **twice**, the exact retained/turn-index duplication described in
  #206571 step 5. `reproduced: true`.
- **HEAD** (`proof.head.json`): `displayTexts = ["Caption text.", "FOOTER_FROM_HOOK"]`
  — footer and image retained exactly once, stable across a Control UI reload, and no footer on
  the text-only control.

This is the retained/turn-index path (`assistantMessageIndex`), one of the two paths #206571
names; the committed unit test `chat-transcript-persistence.hook-caption.test.ts` covers both
the idempotency-key and the turn-index path at the function level.
