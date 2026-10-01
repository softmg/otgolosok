import { mkdir, readFile, writeFile, rename, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { failure, sha256 } from "./domain.mjs";
import { normalizeForSpeech } from "./text-normalizer.mjs";

const exec = promisify(execFile);
export async function createNarration(story, provider, directory, signal, { minDurationSec = 45, maxDurationSec = 150, normalize = normalizeForSpeech } = {}) {
  if (!Number.isFinite(minDurationSec) || !Number.isFinite(maxDurationSec) || minDurationSec <= 0 || maxDurationSec < minDurationSec || maxDurationSec > 600) throw failure("AUDIO_DURATION");
  const script = story.paragraphs.map((paragraph) => paragraph.text).join("\n\n");
  const spokenScript = await normalize(script, { signal });
  const ttsProvider = provider.ttsProvider ?? "openai";
  const key = sha256(JSON.stringify({script:spokenScript,model:provider.ttsModel,voice:provider.voice,version:2,normalizer:normalize.version ?? "custom",
    ...(ttsProvider === "openai" ? {} : {provider:ttsProvider}),...(provider.scriptVersion ? {scriptVersion:provider.scriptVersion} : {})}));
  await mkdir(directory, { recursive: true });
  const metadataPath = join(directory, `${key}.json`);
  try {
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    const bytes = await readFile(join(directory, `${metadata.sha256}.mp3`));
    if (sha256(bytes) === metadata.sha256 && (metadata.durationSec === undefined || (metadata.durationSec >= minDurationSec && metadata.durationSec <= maxDurationSec))) return metadata;
  } catch { /* No complete previously validated asset. */ }
  const bytes = await provider.speech(spokenScript, {signal,voice:provider.voice});
  const sourcePath = join(directory, `${key}.source.tmp`);
  const outputPath = join(directory, `${key}.encoded.tmp.mp3`);
  try {
    await writeFile(sourcePath, bytes, {mode:0o600});
    await exec("ffmpeg", ["-v","error","-y","-threads","1","-filter_threads","1","-i",sourcePath,"-af","loudnorm=I=-16:TP=-1.5:LRA=11","-ac","1","-ar","24000","-b:a","64k","-map_metadata","-1",outputPath], {timeout:25000,signal,maxBuffer:16000});
    const measured = await exec("ffprobe", ["-v","error","-show_entries","format=duration","-of","json",outputPath], {timeout:10000,signal,maxBuffer:16000});
    const durationSec = Number(JSON.parse(measured.stdout).format?.duration);
    if (!Number.isFinite(durationSec) || durationSec < minDurationSec || durationSec > maxDurationSec) throw failure("AUDIO_DURATION");
    const encoded = await readFile(outputPath);
    const hash = sha256(encoded);
    await rename(outputPath, join(directory, `${hash}.mp3`));
    const metadata = {url:`/api/story-audio/${hash}.mp3`,sha256:hash,bytes:(await stat(join(directory,`${hash}.mp3`))).size,
      durationSec,model:provider.ttsModel,voice:provider.voice,provider:ttsProvider,synthetic:true};
    await writeFile(`${metadataPath}.tmp`, JSON.stringify(metadata), {mode:0o600});
    await rename(`${metadataPath}.tmp`, metadataPath);
    return metadata;
  } finally { await Promise.all([sourcePath,outputPath].map((path) => rm(path,{force:true}))); }
}
