# Ledger

An objective tracker in the Luxe Dark design language (tokens in Solar Calculations/luxe-dark-theme.css: purple is what you touch, gold is what you read, ghost-paint edges on raised surfaces). Every objective is a card
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

### Popping it out

The **⧉** button in the panel header opens the pinned list as a real always-on-top OS
window via the Document Picture-in-Picture API, so it stays visible when Ledger itself is
minimised — something a DOM panel can never do. The window shares the app's click
delegation and re-renders with the main window, so unpinning in either place updates both.

Chromium only (Chrome/Edge desktop); the button is hidden where the API is missing.
Opening it requires a real click, which is why it is a button rather than automatic.

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

## Sorting

The **⇅** button beside the add button picks the list order. **Most recent** (last
updated first) is the default. **Smart** puts exceptions first, then open before done,
then recent; the **Exceptions** filter chip is the other way to pull those up. The others
are plain orders: least recently updated, last created, first created, and name A–Z
(untitled objectives sort last, not first). The choice is remembered per device, guarded
against a bad stored value, and the button fills purple whenever a non-default order is
active. A device that still held the old Smart default is moved to Most recent once, on
its first launch of v3.2.0. On desktop the picker opens at the pointer; on the phone it
comes up as a bottom sheet.

Clicking a step on a card holds the list order (since v3.3.0): under Most recent the
click would otherwise lift the card to the top, away from your finger. While the order is
held, a small **Order held · tap to re-sort** chip floats at the top of the list; it never
moves a card when it appears. The order is released by that chip, by picking a sort,
filter, folder, search or tag, by pull to sync, by reloading, or by coming back to the app
after more than two minutes away. Cards that arrive while it is held go on top.

## Categories

Since v3.3.0 cards are grouped under **Solar**, **PQ**, **BESS** and **Miscellaneous**
headings, keeping the sort order inside each group. A card's own `category` field wins
(the Active items feed sets it); without one it is read from the Type at the end of a
`Company - Address - Type` title, then from a `solar`, `pq` or `bess` tag, then from its
folder's name, and otherwise it is Miscellaneous. A view that is all one category (the
Solar folder, say) shows no headings. The Done today section stays ungrouped.

## Filters

The default view is **Open**. Ticking an objective's done step folds its card shut where
it stands: the cards below rise into the gap and the list keeps its scroll position (every
re-render now carries the scroll offset across, so syncs and toasts no longer throw the
list back to the top). The card reappears under a **Done today** heading at the foot of the
Open view, dimmed, for 24 hours after it was last touched; after that only the **Done**
filter shows it, which is the archive for finished work. Nothing is deleted. The stats
line under the wordmark always counts every objective.

A notes line that starts with `Next:` is shown on the card itself, under the name, so the
one thing to do is visible without opening the objective.

The chosen filter is remembered per device (in `localStorage`, not synced — it is a view
preference, not data).

## Exclusive steps

Since v3.3.0 ticking a step turns off the steps it cannot coexist with, in one click:

- In every folder, a step with the **!** stance (Actionable) turns off ticked **…** steps
  (Pending) and the other way round, so a card leaves Actionable the moment it is marked
  Pending. Steps of the same stance still stack (Drafted then Checked), and Done is left
  alone, so unticking Done restores where the card stood.
- A folder set to **Steps lit: One at a time** in the folder editor goes further: ticking
  any step, Done included, turns every other step off. Active items is set this way.

## Feed cards (formerly the Active items folder)

`tools/active_items_to_ledger.py` mirrors a feed of Jordan's live work from Drive, one
card per project or thread, titled `Company - Address - Type`, tagged `active` plus the
project's LDC and who assigned it. Since script v4 (2026-10-16) each card sits in the
folder for its category: **Solar**, **Power Quality**, **BESS** or **Miscellaneous**, and
its state uses that folder's own steps: your move leaves no Pending or Done step ticked,
waiting (and Claude on it, which also shows "Claude on it" in the reference line) ticks
Pending, done ticks the done step. Drafted and Checked are yours and left alone. The old
Active items folder was retired once empty. Notes carry `Next:` and a dated update log,
newest first. Any step Jordan clicks is kept until the feed brings a newer update or
adopts the same state, and is reported back through `ledger-done.json` (`done` and
`moved`); a card he moves to another folder stays there until its category changes.
Format and rules are in `G:\My Drive\Ledger feed\LEDGER-SCHEMA.md` (owned by the Ledger
refresh thread) and the script's docstring.

Since script v6 (2026-10-19, review fixes F126 and F172):

- A card is deleted only by `"state": "remove"`. An open card left out of a feed is kept
  with the alert *Missing from feed …*; a done card left out is archived, and the **Done**
  filter shows archived done cards too.
- A feed is refused when more than three open cards vanish from it at once, when its
  `base` does not lead back to the last feed applied, or when it is older than that feed.
  It moves to `Ledger feed\refused\` and a **Ledger feed refused** card appears in
  Miscellaneous until a good feed lands.
- Failures are logged and counted, gh calls time out, and the Gist is read again just
  before every write (the app does the same). `ledger-v2.json` is copied once a day to
  `Ledger feed\backups\` and kept 30 days.
- The script writes a heartbeat, `pc-sync.json`, into the Gist at least every five
  minutes, and merges the routines' `health-*.json` records into `routine-health.json`.
- Since v6.1 (F062) small op files in `Ledger feed\ops\` change one card at a time
  (upsert, state, note, remove, merge) and are moved to `ops\done\` once applied. The
  script keeps every feed card and writes them all to `ledger-cards.json` for op
  writers. Once `ops\ops-mode.json` exists, full feeds are refused.
- Since v6.2 it also publishes `pipeline-board.json` (from the pipeline state files) and
  the newest `today-<date>.json` into the Gist for the desk board.

## Desk board (v3.5.0)

At 1100 px and wider Ledger opens on a board with five tabs. **List** is the classic
folder, list and detail view where cards are edited; the other four are read-only, and
clicking a row or card opens it in List.

- **Today**: six tiles (Your move, Held, Due in 7 days, Claude on it, Waiting on others,
  Meetings today), then today's calendar, the Your move table (oldest first, held cards
  first and amber with their reason) and new mail with the ClickUp overdue count. The
  calendar and mail come from the morning brief's `today-<date>.json`, which the PC
  copies into the Gist; until one exists for today those panels say so.
- **Board**: Solar, Power Quality, BESS and Miscellaneous lanes across Your move, Claude
  on it, Waiting on others and Done this week.
- **Pipeline**: one row per proposal job from the pipeline state files (published by the
  PC as `pipeline-board.json`), stage columns with chips coloured by owner and age in
  days, held jobs amber, and a side panel with the number, flags, latest events and the
  exact phrase to type next (`calcs done …`, `blacken …`).
- **Week**: Done, Decided, Next week and Waiting on, with a Print button laid out for one
  landscape page. Held cards print as "held, under review" with no figures.

A card is *held* when its alert starts `HELD:`. On the phone the list opens on **Your
move** with held cards first, and Pending is split into **Claude** and **Others**.

## Health chips and due dates (v3.4.0)

Under the sync chip sits one row of routine chips (Mail, ClickUp, Gas AM, Gas PM,
Weekly, Brief…) and, last, **PC sync**. A routine chip is green when its last scheduled
run reported back fine, amber after one missed or failed run, red after two in a row, and
grey when paused or not yet due. PC sync shows how long ago the PC script last ran
cleanly: amber at 15 minutes, red at two hours. Hover a chip (or tap it on the phone) for
the note, the times and the last error.

A card can carry a **due** date (set by the feed, or in the card's Due field). The card
shows it as a small tag: plain while it is more than a week out, gold inside a week, red
on the day and after. It is coloured when drawn, so nothing has to rewrite the card as
the date approaches.

An unreadable or missing `ledger-v2.json` in the Gist is now a sync error. The app no
longer falls back to the frozen v1 `ledger.json`.

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

The running build is shown as a faded `v3.5.1` beside the wordmark, and again at the foot
of the sync pane. That is the only reliable way to tell what a given device is actually
running — a PWA gives no other signal.

On every release, bump **all three**:

- `APP_VERSION` in `app.js`
- `CACHE` in `sw.js`
- the `?v=` on both links in `index.html`

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
