---
name: walk-promo
description: Prepare promo materials for a published otgolosok walk — a YouTube Shorts video via ../otgolosok-shorts, a Telegram post about a different story from the same walk, a Telegram illustration and a vertical YouTube cover. Use when the user passes a walk share link and asks for Shorts / Telegram post / covers.
argument-hint: <https://otgolosok.online/walk?share=...> [голос, например alex-bell]
disable-model-invocation: true
---

Prepare a promo set for the walk `$ARGUMENTS`. All work happens in the sibling repo
`../otgolosok-shorts` (absolute: resolve from this repo's parent). Communicate with the user in Russian;
all user-facing texts (post, titles, covers, journal) are in Russian.

**Publishing is outward-facing.** Prepare everything locally, show the result, and upload to YouTube /
send to Telegram only after the user explicitly says so in this conversation.

Before starting, read in `../otgolosok-shorts`: `README.md` (sections «Ролик по готовой прогулке»,
«Telegram»), `docs/agents/shared-walks.md`, `docs/agents/cover-art.md`, `docs/agents/telegram.md`
and the most recent `docs/agents/*-short-*.md` journal — it is the reference for format and checks.

## 0. Names and folders

- `SLUG` — kebab-case of start/end (e.g. `spartak-tushino`), `DATE` — today, `SEED` — `YYYYMMDD`.
- `DATA=tmp/$SLUG-video-$DATE` — **isolated** `SHORTS_DATA_DIR`, so the production scheduler
  (`auto`) never picks up or publishes a manual run.
- `OUT=data/manual/$SLUG-$DATE` — finished materials (ignored by git, survives `cleanup`).
- Voice: argument if given, otherwise `alex-bell`.

## 1. Read the walk

`curl -sS https://otgolosok.online/api/story-walks/shared/<token>` → `document` (title, description,
`route.distanceM`, `route.walkingMinutes`, `mode`, `minutes`) and `chapters[]` (`story.title`,
`story.paragraphs`, `story.sources`, `audio.durationSec`). Save the JSON to `$DATA/walk.json`.
Sum `audio.durationSec` for the total listening time.

## 2. Build the video

```bash
SHORTS_DATA_DIR=$DATA pnpm shorts run --template walk --walk '<url>' --voice <voice> --no-upload --seed $SEED
```

Run it in the background (render takes ~10 min). After the `script` step finishes, inspect
`$DATA/runs/<id>/prepared.json` (`stops[].photo`) and `script.json`. If edits are needed (steps 3–4),
stop the run before the render to save time — the render is redone once at the end.

## 3. Rewrite the hook (always)

The generator's hook is fixed text («Идея для … прогулки от метро …», `src/templates/walk/script.ts`
`fixedLines`) and repeats in every video; the user asked to replace it every time. Write a short
route-specific hook (≈ 8–12 words, e.g. «От «Спартака» до «Тушинской»: по бывшему аэродрому и под
каналом.»), facts only from the walk. Save the original as `script-before-new-hook.json`, set
`hook.text` and `hook.display`. Check with `validateScript` from `src/text/validate.ts` and
`evidenceOf` from `src/templates/walk/script.ts` (put the hook into `description`, since the hook
itself is not validated); expect an empty list.

## 4. Photos for all four episodes (always)

The automatic search usually finds 1–2 of 4. For every stop without `photo`:

1. Search Commons (`list=search&srnamespace=6`), category or file names; send a `User-Agent`
   and pause ~3 s between calls — Commons rate-limits (`You are making too many requests`).
2. Check and download with the generator's own `commonsCandidate` + `fetchPhoto`
   (`src/sources/wikimedia.ts`, cache dir `$DATA/cache/photos`) — they enforce licence, author and size.
3. Look at every candidate (contact sheet via ffmpeg `xstack`): it must show this place and match
   the beat's line. Reject misleading files (e.g. a boat named after the river instead of the river).
4. Save the original as `prepared-before-photos.json`, set `stops[i].photo =
   {path, sha1, width, height, attribution}` from the downloaded `<sha1>.json`.

## 5. Update checkpoints and render

In `$DATA/state/shorts.sqlite` (`run_steps`): set `output_sha256` of `prepare` and `script` to the
new `shasum -a 256` of the edited files; delete the `voice` and `render` rows; **keep `mix`** —
`render --run` refuses to start without `mix=done`, and the redone `voice` step invalidates it itself.
Unchanged lines come from the TTS cache; only the new hook is synthesised.

```bash
SHORTS_DATA_DIR=$DATA pnpm shorts render --run <id>          # background
SHORTS_DATA_DIR=$DATA pnpm shorts stills --run <id> --at 1.5,8,15,23,31,39,47 --debug-safe
```

Check stills visually (one strip via ffmpeg `hstack`): hook, overview, all four photos, final card;
captions must not cover photos. Check `probe.json` (≤ 58,5 s, 1080×1920, 30 fps), `loudness.json`
(≈ −14 LUFS) and a full decode `ffmpeg -v error -i video.mp4 -f null -`.
Copy `video.mp4`, `metadata.json`, `script.json`, `probe.json`, `loudness.json` to `$OUT`.

## 6. Telegram post — a different story

Pick a stop that is **not** among the four video episodes and whose story has a strong visual detail
(a surprising fact, not a summary of the route). Format (see `docs/agents/telegram.md` and the last
journal): bold headline with one emoji, a paragraph with one verified detail + source link
(`story.sources`, Cyrillic Wikipedia URLs are shorter than percent-encoded), 🎬 line with the video
link and what the video shows, 🚶 distance / walking time / total listening time, 🎧 walk link, and a
note that the cover is an illustration. 3–4 emoji total. Use only facts from the story text.
**Caption limit is 1024 characters of HTML including tags** — measure with the real video URL.
Save `telegram-post.draft.json` with a `{{VIDEO}}` placeholder; write the final `telegram-post.json`
only after the YouTube URL exists (`{{VIDEO}}` → `<a href="https://www.youtube.com/shorts/<id>">Короткий ролик по этой прогулке</a>`).

## 7. Covers (Codex `image_gen`)

Follow `docs/agents/cover-art.md`. If the post's object has a historical/real look, download a
reference photo from Commons and pass it to the generator so it does not invent the object.
Save prompts next to the images (`telegram-cover-prompt.txt`, `youtube-cover-prompt.txt`).

- Telegram: 4:5 illustration, no text, the post's object in the foreground → `telegram-cover.png`.
- YouTube: 9:16, upper 40 % — large dark-green Cyrillic title (route «ОТ … ДО …», guillemets),
  terracotta plaque «N ИСТОРИЙ МОСКВЫ» (N = total stops of the full walk), small «ОТГОЛОСОК»;
  lower 60 % — imagery of the video's episodes → `youtube-cover.png`.

Generate with Codex non-interactively, from `$OUT`:

```bash
codex exec -s workspace-write --skip-git-repo-check -C "$PWD" "<instruction: read the prompt file, call image_gen, save ./<name>.png>" -i <ref.jpg> </dev/null
```

Gotchas: the prompt must come **before** `-i` (it takes several files and swallows the prompt);
`</dev/null` is required in the background, otherwise it waits on stdin forever; macOS has no
`timeout`. Run both covers in parallel in the background.
Check each image in full size and at phone width: object geometry, no stray letters on the
Telegram cover, exact title spelling on the YouTube cover. Regenerate on errors. PNG ≤ 10 MB.

## 8. Show and wait

Report in Russian: run id, video duration/loudness, the four episodes and photo credits, the post text
and its length, paths of both covers, and anything done by hand. Then wait for the user's command.

## 9. Publish (only on the user's explicit command)

- YouTube: mark the run publishable and continue it in the same isolated data dir, the way the last
  journal describes (`createYoutubePublisher`, resumable upload); confirm `public / processed /
  succeeded`, then `thumbnails.set` with `youtube-cover.png` and check `maxresdefault.jpg`.
  `thumbnails.set` does **not** change the Shorts-feed thumbnail — tell the user it must be picked in
  YouTube Studio by hand.
- Telegram: finalize `telegram-post.json` with the video URL, copy it with the cover into the run
  dir and run `SHORTS_DATA_DIR=$DATA pnpm shorts telegram:send --run <id>`; the command is
  idempotent (`telegram-delivery.json`).

Helper scripts (Commons check, `validateScript` run) are throwaway: `pnpm check` lints every `.ts`
under the repo including `tmp/`, so delete them (or keep them outside the repo with absolute imports)
before running checks.

## 10. Journal and commit

Write `docs/agents/$SLUG-short-$DATE.md` in `../otgolosok-shorts` (Russian, same structure as the
previous journal: прогон, сценарий, фотографии, Telegram, обложки, проверки, публикация) and add it
to `docs/agents/README.md`. Run `pnpm check`, then commit there:
`docs(video): <описание по-русски>`. No secrets, tokens, server addresses or `data/` files in git.
