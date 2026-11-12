---
'@mysten-incubation/cctp-kit': minor
---

Add `recipient: { editable: false }`, which takes the recipient out of the user's hands: the widget
shows no "Send to a different address" toggle and no address field, transfers go to the connected
destination wallet or to the address the host set with `kit.setRecipient()`, and that address
stays set when the route changes, shown read-only. `ui.title: false` renders no heading.
