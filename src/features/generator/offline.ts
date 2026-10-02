import type { GenerationJob } from "./types";

// Stories saved for offline listening by earlier versions; the Service Worker still serves them.
const STORY_CACHE = "story-packs-v1";
export const jobUrl = (id: string) => `/api/story-jobs/${id}`;

export async function savedStories(): Promise<GenerationJob[]> {
  if (!("caches" in window)) return [];
  const cache = await caches.open(STORY_CACHE);
  const keys = (await cache.keys()).filter((key)=>new URL(key.url).pathname.startsWith("/api/story-jobs/"));
  const results = await Promise.allSettled(keys.map(async(key)=>(await cache.match(key))?.json()));
  return results.flatMap((result)=>result.status==="fulfilled"&&result.value?.stage==="ready"?[result.value]:[]);
}
