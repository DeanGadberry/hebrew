# Aleph with Beth Offline

A web page for downloading the free [Aleph with Beth](https://freehebrew.online) Biblical Hebrew video lessons, ready for the Apple TV app on a Mac and iPhone. Each file arrives named, numbered and tagged as a TV episode, with cover art.

**Live at <https://www.deangadberry.com/hebrew/>**

The creators give these videos away freely, as public domain ([Matt 10:8](https://sellingjesus.org)), and [invite offline copies](https://freehebrew.online/offline/). If they help you, consider [supporting their work](https://freehebrew.online/give).

## Using it

1. Open the page and pick a season (Lessons, Review Games, Easy Stories, Worship & Songs, Extras).
2. Tick episodes. You can shift-click to select a run, type a range (e.g. 1 to 20), or use **Select not yet saved**.
3. Pick a quality and press **Download**. In Chrome or Edge, **Save to folder…** writes straight into a folder you choose. Other browsers save to Downloads.
4. On the Mac, open the **TV** app, choose **File → Import**, and pick the files. They appear under *TV Shows → Aleph with Beth*, in teaching order.
5. Sync to the iPhone: in **Finder**, open the phone, go to the *TV Shows* tab, tick *Aleph with Beth*, then **Sync**. The TV app on the phone remembers where you stopped.

| Quality | Per 25-min lesson | Notes |
|---|---|---|
| 1080p (default) | ~0.9 GB | Sharp on any iPhone or iPad |
| 4K | ~3.5 GB | For a big TV |
| Audio only | ~30 MB | Goes to the Music app. Turn on *Get Info → Options → Remember playback position* |

### Where episodes come from

| Source | What | How |
|---|---|---|
| [Lets.Church](https://lets.church/channel/AlephwithBeth) | Almost everything (1080p, 4K, audio) | In the browser, through the relay |
| [Internet Archive](https://archive.org/details/aleph-with-beth-lessons-1-66-1080p) | Lessons 6, 35b, 39b, 41b, 58, 60, 64 and 66 (Lets.Church lacks them) | In the browser, through the relay (720p) |
| [Creators' torrent](https://freehebrew.online/offline/) | The rest of the gaps (marked **Torrent** on the page) | **Actions → Fetch missing lessons → Run workflow**, then download the zip from the run |

The episode list refreshes nightly, so new lessons show up on their own. If Lets.Church later adds a lesson that currently comes from elsewhere, the page switches to Lets.Church automatically.

## How it works

```
browser ──► Cloudflare Worker (relay/) ──► Lets.Church / Internet Archive
   │            pass-through only, stores nothing
   └─ site/remux.js rewrites the stream into a plain MP4 with Apple TV tags
      and writes it straight to disk (no server-side processing)
```

- **`site/`**: the static page (GitHub Pages). `remux.js` turns Lets.Church's fragmented MP4 into a standard MP4 and adds iTunes metadata (show, season, episode, artwork, descriptions). It streams, so 4K files don't need to fit in memory.
- **`relay/`**: a Cloudflare Worker. Lets.Church sends no CORS headers, so a page on another site can't read its files directly. The Worker only fetches Aleph with Beth media, only for the origins in `wrangler.toml`.
- **`scripts/build_catalog.py`**: builds `site/catalog.json` from Lets.Church's public API, sorts episodes into seasons, and fills gaps from the Internet Archive and the torrent.
- **`scripts/torrent_fetch.py` + `scripts/tag.mjs`**: fetch only the requested lessons from the torrent (`--seed-time=0`) and tag them the same way.

## Setup (one time)

Everything deploys from `.github/workflows/deploy.yml` on each push to `main`, nightly, or by hand. It always builds `main`, whichever branch is the repository default.

1. **GitHub Pages** publishes from the `gh-pages` branch, which the workflow updates. Nothing to set.
2. **Cloudflare relay**: add one repository secret (Settings → Secrets and variables → Actions):
   - `CLOUDFLARE_API_TOKEN`: Cloudflare dashboard → My Profile → API Tokens → *Create Token* → template **Edit Cloudflare Workers**.

   The next deploy finds the account, claims a `workers.dev` subdomain if there isn't one, publishes the Worker and points the page at it. Without the token the page still publishes; set the `RELAY_URL` repository variable, or enter the address in the page's Settings.

No DNS changes are needed: the `DeanGadberry.github.io` repo owns `www.deangadberry.com`, so this repo's Pages site appears at `/hebrew/`.

## Development

```sh
npm test                       # converter, tagger and torrent helper tests (needs ffmpeg)
npm run catalog                # refresh site/catalog.json
npm run dev                    # page on :8000 + relay on :8787
# then open http://localhost:8000/?relay=http://localhost:8787
```

Set `REMUX_SAMPLE=/path/to/a/lets-church-download.mp4` to also test against a real file.
