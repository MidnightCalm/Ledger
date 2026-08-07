# Ledger

An objective tracker in the same luxe-dark register as Trove. Every objective is a card
with two toggles — **Checked** and **Complete** — and an exception marker that raises
itself whenever the objective's Exception field has anything in it.

Static PWA: no build step, no framework, no server of its own. Runs on iPhone and on
the desktop from the same URL, and syncs between them through a secret GitHub Gist.

```
ledger-app/
├── index.html            app shell
├── app.js                state, rendering, sync engine
├── style.css             palette + components (inherited from Trove)
├── sw.js                 service worker — offline app shell
├── manifest.webmanifest  PWA metadata
└── icons/                180 / 192 / 512 px
```

## Layout

One codebase, two layouts, chosen by **viewport width** rather than user agent — so a
narrowed desktop window gets the phone layout, and a tablet gets whichever actually fits.
The breakpoint is 900px.

- **Under 900px** — one screen at a time. The list fills the screen; tapping a card pushes
  the detail view over it. Folder chips, filter chips, search and add all sit in a fixed
  cluster at the **bottom** of the screen: these are the controls used on every visit, so
  they belong in right-thumb range rather than at the top where the hand cannot reach.
- **900px and up** — two panes. The list stays on the left while the detail sits on the
  right. Selecting a card swaps the right pane instead of navigating, so you can edit one
  objective while scanning the rest. The selected card is outlined in gold, and edits to a
  name or exception update the list live as you type.
- **1100px and up** — a third column appears: a folder rail with live counts. Drag a card
  from the list onto a rail row to move it into that folder.

The desktop layout fills the window rather than sitting in a fixed-width column, so a wide
monitor is actually used.

Crossing the breakpoint re-renders. Both `matchMedia` and `resize` are wired to a single
guard that only fires when the layout actually changes.

On phones the detail view carries a **Done** button in the bottom-right corner, within
thumb reach. Everything autosaves as you type, so it is navigation rather than a save
gate — the back arrow in the top corner still works and does the same thing.

## Folders and templates

Every objective lives in a folder, and **each folder defines its own toggles**. Solar work
keeps `Checked` / `Complete`; an Emails folder can carry `Awaiting reply` / `Needs my
reply` / `Resolved`. Edit them with the ⚙ chip (or the rail row on desktop): rename a
toggle, cycle its colour, add or remove one, and mark which is the folder's **done** state
with ★ — that is what the Open filter hides and what the stats line counts.

Renaming a toggle keeps its stored key, so existing objectives keep their state. Removing
one leaves the stored flag untouched, so re-adding the toggle brings the state back.

Press and hold a toggle row (or drag its ⠿ handle) to reorder; cards render toggles in
that order. The colour swatch opens a palette with a native colour picker at the end, and
colours are stored as hex, so any colour is expressible.

### Steps and stances

Toggles are **steps in order**, and each carries a stance — what ticking it means for who
holds the ball:

| Stance | Glyph | Meaning |
| --- | --- | --- |
| Actionable | ! | your move — feeds the **Actionable** filter |
| Pending | … | waiting on someone else — feeds the **Pending** filter |
| Neither | – | no bearing on either filter |

Separately, ★ marks the folder's **done** step: hidden by the Open filter and tallied in
the stats. Exactly one per folder, always assigned.

**The furthest-along ticked step wins.** So a folder of
`Drafted (…) → Checked (!) → Pending (…) → Complete (★)` walks an objective through:

| State | Stance |
| --- | --- |
| nothing ticked | the folder's **Starts as** setting (default Actionable) |
| Drafted | Pending |
| Drafted + Checked | Actionable |
| Drafted + Checked + Pending | Pending |
| … + Complete | Done |

Any number of steps can share a stance — a step literally named "Pending" can be pending,
and you can have several actionable stages. Because the stance is derived from one winning
step rather than from independent flags, an objective has exactly one stance and **can
never appear under both Actionable and Pending**.

Selecting a stance filter in a folder where nothing could ever reach it says so rather than
showing a blank list.

### Searching steps

Ticked steps are searchable text. Searching `drafted` returns everything with the Drafted
step ticked, alongside the usual name/notes/tags matching — the step labels do not appear
as tag chips, they just match.

### Right-click / press-and-hold

Right-click a folder (desktop) or press and hold it (phone) for Edit, Show only this
folder, New folder, and Delete — no hunting for a settings button. The **All** chip has no
menu, since there is nothing to edit.

A right-click menu opens **at the pointer** and is nudged back inside the window if it
would hang off an edge. A press-and-hold opens the same menu as a bottom sheet, where the
thumb already is.

**Cards** answer right-click too, with Open, Pin, Archive, a *Move to* list of the other
folders, and Delete. Bound to `contextmenu` only and never to press-and-hold, so phones
keep the swipe tray instead.

## Explanations

Field explanations are collapsed behind a small **ⓘ** next to the label, so a screen you
already understand stays quiet. One opens at a time; the choice is not persisted.

## Pull to sync

At the top of the list, drag down (or keep scrolling up with a wheel or trackpad) to force
a sync. An indicator appears once you pass the threshold. Sync still runs automatically on
launch, on foreground, after edits and once a minute — this is for when you want to be
sure right now.

Deleting a folder moves its objectives to the first remaining folder rather than destroying
them; they keep their text but lose that folder's toggle states. The last folder cannot be
deleted.

## Tags

Tags cut across folders. Put `concord` on a solar project and on the email thread about it,
then tap the tag on any card to pull both up — the tap switches to All folders and searches
`#concord`. Typing `#something` in the search box searches tags only; a bare word searches
name, owner, notes, exception **and** tags.

Tags are lower-cased and de-duplicated on entry, so the same tag typed two ways on two
devices still matches.

### Suggestions

Under the tags field is a row of one-tap suggestions, refreshed as you type. There is no
model involved — the signal is already in your own data, and a tag scores on:

1. **Mentioned** — the tag appears in this objective's name, owner, notes or exception
2. **Related** — it habitually co-occurs with tags already on this objective
3. **Frequent** — how often you use it at all, which also breaks ties

Gold chips were inferred (1 or 2); plain chips are just your common tags.

## Pinned overlay (desktop)

Pin an objective from its detail pane and it appears in a floating panel above everything
else. Drag it by its header, resize it from the corner, collapse it to a title bar. The
panel's position and size are remembered per screen (in `localStorage`, not synced — the
pinned flag itself does sync). Geometry is clamped back into view on every commit and on
window resize, so a panel dragged to an edge cannot be stranded off-screen by a smaller
window later.

## Swipe actions

Drag a card left to reveal **Archive** and **Delete**. The card tracks your finger and
snaps with an overshoot curve. Vertical intent wins early, so the list still scrolls
normally, and a drag never registers as a tap.

Archived objectives drop out of every view except the **Archived** filter, where the same
swipe offers **Restore**. Archiving is not deleting — nothing is removed and it syncs like
any other change.

## Filters

The default view is **Open**, so completed objectives drop out of the list once ticked.
They are not deleted: the **Complete** and **All** chips bring them back, and the stats
line under the wordmark always counts every objective. Completing something from the list
shows a brief toast, since a card silently vanishing under your thumb otherwise reads as
a glitch.

The chosen filter is remembered per device (in `localStorage`, not synced — it is a view
preference, not data).

## How the data works

`localStorage` is always the working copy — the app is fully usable with no network and
no GitHub account at all. When linked, a secret Gist holds one `ledger-v2.json` file that
every device merges into.

Merging is **per record, newest write wins** — not whole-file last-write-wins. Folders and
objectives merge independently, so editing a different one on each device merges cleanly
rather than one device clobbering the other. Deletes propagate as tombstones, purged after
30 days.

### Why `ledger-v2.json` and not `ledger.json`

Schema v1 had no folders. A v1 client reading v2 data would strip every field it did not
recognise — `folderId`, `flags`, `tags` — and push the stripped result back, destroying
folders for every device. Giving v2 its own filename makes that impossible. The original
`ledger.json` is left in place, untouched, as a frozen pre-folders backup.

On first run against a Gist that still only holds `ledger.json`, v2 imports and migrates it
once, then writes to the new file from then on.

Sync runs on launch, ~1.8s after any edit, whenever the app returns to the foreground,
and once a minute while it is open.

## Setup

### 1. Host it

The phone needs an https URL it can reach, so the folder can't just live on the desktop.
GitHub Pages is the natural choice since the Gist already puts you on GitHub:

1. Create a repository (public is fine — see the security note below) and upload the
   contents of `ledger-app/`, with `index.html` at the repository root.
2. Settings → Pages → Source: `main` / `/ (root)`.
3. Wait a minute for `https://<username>.github.io/<repo>/`.

Cloudflare Pages or Netlify work identically if you'd rather the repository be private.

### 2. Install it

- **iPhone:** open the URL in Safari → Share → *Add to Home Screen*. It launches
  standalone, with no browser chrome.
- **Desktop:** open the URL in Chrome or Edge and use *Install app* from the address bar,
  or just leave it as a tab.

### 3. Link the two

1. Create a token at
   [github.com/settings/tokens/new](https://github.com/settings/tokens/new?scopes=gist&description=Ledger)
   with **only** the `gist` scope ticked. Copy it.
2. In Ledger, tap the sync chip under the wordmark, paste the token, and press
   **Create new Gist**.
3. On the second device, paste the *same* token and the Gist ID from the first device,
   then **Sync now**.

The Gist ID is the long hex string at the end of the Gist URL. Pasting the whole URL
works too — the app pulls the ID out.

## Security notes

- A `public: false` Gist is **secret, not private**: it is unlisted and won't appear in
  search or on your profile, but anyone who has the URL can read it. If the objectives
  are sensitive, use a private repo with a real backend instead.
- The token is stored in `localStorage` on each device and is scoped to `gist` only, so
  a leak exposes your Gists and nothing else in your GitHub account. **Unlink this
  device** in settings clears it.
- The app itself contains no secrets, so hosting it on a public GitHub Pages site is
  safe — a stranger loading the URL gets an empty tracker.

## Local development

```bash
py -m http.server 8777 --directory ledger-app
```

Then open `http://localhost:8777`. A `.claude/launch.json` entry named `ledger` does the
same thing.

## Versions and updating

The running build is shown as a faded `v1.3.0` beside the wordmark, and again at the foot
of the sync pane. That is the only reliable way to tell what a given device is actually
running — a PWA gives no other signal.

On every release, bump **both**:

- `APP_VERSION` in `app.js`
- `CACHE` in `sw.js`

They are separate files and cannot share a constant, so they drift silently if you forget.

Same-origin files are served **network-first** (see `sw.js`). Earlier versions were
cache-first, which meant a deployed update could never reach an installed app on its own —
the cache always answered before the network was consulted. The cache is still written on
every successful fetch, so it remains a full offline copy; it is now the fallback rather
than the first choice.

The app also asks the worker to check for a new build on launch and whenever it returns to
the foreground, and reloads itself once when a new worker takes control. Updates therefore
land by themselves, usually within one relaunch.

**Devices still running a pre-1.3.0 build need one manual nudge**, because the old
cache-first worker is what is deciding: force-quit and reopen the app twice. Check the
version badge to confirm.
