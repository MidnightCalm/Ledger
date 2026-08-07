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
  the detail view over it, with a back button. Search and add live in the floating bottom bar.
- **900px and up** — two panes. The list stays on the left (with search and add inline at
  the top) while the detail sits on the right. Selecting a card swaps the right pane instead
  of navigating, so you can edit one objective while scanning the rest. The selected card is
  outlined in gold, and edits to a name or exception update the list live as you type.

Crossing the breakpoint re-renders. Both `matchMedia` and `resize` are wired to a single
guard that only fires when the layout actually changes.

On phones the detail view carries a **Done** button in the bottom-right corner, within
thumb reach. Everything autosaves as you type, so it is navigation rather than a save
gate — the back arrow in the top corner still works and does the same thing.

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
no GitHub account at all. When linked, a secret Gist holds one `ledger.json` file that
every device merges into.

Merging is **per objective, newest write wins** — not whole-file last-write-wins. Editing
a different objective on each device merges cleanly rather than one device clobbering
the other. Deletes propagate as tombstones, which are purged after 30 days.

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
