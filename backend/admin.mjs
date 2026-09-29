import { createHash, timingSafeEqual } from "node:crypto";
import { failure, validateDraft, validateFacts } from "./domain.mjs";
import { validateSourceUrl } from "./safe-fetch.mjs";
import { isTtsProvider, validVoiceId } from "./tts-voices.mjs";

// A single fixed-size bucket bounds memory and ignores spoofable proxy headers.
export function adminAuth(token, now = Date.now) {
  const enabled = typeof token === "string" && token.trim().length > 0;
  const digest = (value) => createHash("sha256").update(value).digest();
  const expected = digest(enabled ? token : "");
  let failures = 0, resetAt = 0;
  return (authorization) => {
    const time = now();
    if (time >= resetAt) { failures = 0; resetAt = time + 60_000; }
    const match = typeof authorization === "string" && /^Bearer ([^\s]+)$/i.exec(authorization);
    const equal = timingSafeEqual(expected, digest(match ? match[1] : ""));
    if (!enabled || !match || !equal) {
      if (failures >= 20) return 429;
      failures++; return 401;
    }
    return 200;
  };
}

export function editorialDraft(data, draft = data.editorDraft) {
  try {
    if (!data.evidence || !Array.isArray(data.sources)) throw new Error();
    const evidence = validateFacts({ ...data.evidence, addressConfirmed: true }, data.sources);
    if (JSON.stringify(evidence.facts) !== JSON.stringify(data.evidence.facts)) throw new Error();
    for (const source of evidence.sources) validateSourceUrl(source.url);
    return validateDraft(draft, evidence);
  } catch { throw failure("INVALID_DRAFT"); }
}

const draftText = (value, max = 2000) => typeof value === "string" ? value.slice(0, max) : "";
const text = (value, max = 2000) => draftText(value, max)
  .replace(/<[^>]*>/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
const array = (value, max) => Array.isArray(value) ? value.slice(0, max) : [];
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const draftView = (value) => value == null ? null : {
  title: draftText(object(value).title, 140),
  ...(["story-v1","description-v1"].includes(object(value).effectiveProfile) ? {effectiveProfile:object(value).effectiveProfile} : {}),
  ...(object(value).audioDisposition === "not_applicable_short_text" ? {audioDisposition:"not_applicable_short_text"} : {}),
  paragraphs: array(object(value).paragraphs, 6).map((p) => ({
    text: draftText(object(p).text), factIds: array(object(p).factIds, 8).filter(id => typeof id === "string" && /^f[1-8]$/.test(id)),
  })),
};
const factsView = (value) => array(value, 8).map((f) => {
  const fact = object(f);
  return { id: text(fact.id, 16), claim: text(fact.claim, 600), interesting: fact.interesting === true,
    ...(["identity","address","content"].includes(fact.kind) ? {kind:fact.kind} : {}),
    ...(["object","site_context","nearby"].includes(fact.subjectRelation) ? {subjectRelation:fact.subjectRelation} : {}),
    ...(typeof fact.contentReason === "string" ? {contentReason:text(fact.contentReason,300)} : {}),
    evidence: array(fact.evidence, 3).map((p) => ({ sourceId: text(object(p).sourceId, 16), quote: text(object(p).quote, 500) })) };
});

export function hasValidStoryText(value) {
  const story = object(value);
  const profile=story.effectiveProfile??story.requestedProfile??"story-v1";
  if (typeof story.title !== "string" || !story.title.trim() || story.title.length > 140
    || !Array.isArray(story.paragraphs) || story.paragraphs.length < (profile==="description-v1"?1:2) || story.paragraphs.length > 6) return false;
  const paragraphs = story.paragraphs.map((paragraph) => object(paragraph).text);
  if (paragraphs.some((paragraph) => typeof paragraph !== "string" || !paragraph.trim() || paragraph.length > 2000)) return false;
  const wordCount = paragraphs.join(" ").trim().split(/\s+/u).length;
  return profile==="description-v1"?wordCount>=20&&wordCount<=100:wordCount>=100&&wordCount<=250;
}

const selectedVoice = (data) => validVoiceId(data.ttsVoice) ? data.ttsVoice
  : validVoiceId(data.audio?.voice) ? data.audio.voice
    : validVoiceId(data.revoice?.previousAudio?.voice) ? data.revoice.previousAudio.voice : null;

const audioView = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const url = typeof value.url === "string" && /^\/api\/story-audio\/[a-f0-9]{64}\.mp3$/.test(value.url) ? value.url : null;
  if (!url) return null;
  const durationSec = Number.isFinite(value.durationSec) && value.durationSec >= 0 && value.durationSec <= 3600 ? value.durationSec : 0;
  const voice = validVoiceId(value.voice) ? value.voice : null;
  return { url, durationSec, voice, provider: isTtsProvider(value.provider) ? value.provider : "openai", model: text(value.model, 100) };
};

export function adminSummary(job, safeError) {
  const data = object(job.data);
  return { id: job.id, address: text(job.address, 200), stage: job.stage, revision: job.revision,
    updatedAt: job.updatedAt, irrelevant: job.irrelevant === true,
    ttsProvider: isTtsProvider(data.ttsProvider) ? data.ttsProvider : "openai", ttsVoice: selectedVoice(data),
    error: job.error ? safeError(job.error) : null };
}

export function adminDetail(job, providerAvailable, safeError, ttsProviders = [], researchProviderAvailable = providerAvailable) {
  const data = job.data ?? {};
  let canApprove = false;
  if (providerAvailable && job.stage === "review_required" && !job.irrelevant) {
    try { editorialDraft(data); canApprove = true; } catch { /* Invalid checkpoints remain readable. */ }
  }
  const canRetry = job.stage === "failed" && job.attempts < 3 && !job.irrelevant;
  const canRegenerate = Boolean(researchProviderAvailable) && job.stage === "review_required"
    && job.attempts < 3 && !job.irrelevant;
  const canRevoice = Boolean(providerAvailable) && ["ready", "failed"].includes(job.stage)
    && !job.irrelevant && hasValidStoryText(data.story);
  const currentAudio = data.audio ?? data.revoice?.previousAudio ?? null;
  const evidence = object(data.evidence), review = object(data.review), factReview = object(data.factReview);
  return { ...adminSummary(job, safeError), ttsProviders, data: {
    ttsProvider: isTtsProvider(data.ttsProvider) ? data.ttsProvider : "openai",
    ttsVoice: selectedVoice(data), story: draftView(data.story), audio: audioView(currentAudio),
    revoice: data.revoice == null ? null : { requestedAt: text(object(data.revoice).requestedAt, 40) },
    editorDraft: draftView(data.editorDraft), draft: draftView(data.draft), draftCandidate: draftView(data.draftCandidate),
    evidence: data.evidence == null ? null : {
      placeName: text(evidence.placeName, 160), resolvedAddress: text(evidence.resolvedAddress, 200),
      identityNote:text(evidence.identityNote,1000),facts: factsView(evidence.facts),
      sources: array(evidence.sources, 10).map((s) => {
        const source = object(s); let url = null;
        try { url = validateSourceUrl(source.url).href; } catch { /* Never expose unsafe links. */ }
        return { id: text(source.id, 16), url, title: text(source.title, 250), publisher: text(source.publisher, 250) };
      }),
    },
    review: data.review == null ? null : { approved: review.approved === true, issues: array(review.issues, 20).filter(v => typeof v === "string").map(v => text(v)),
      checks:{substantive:object(review.checks).substantive===true,subjectAligned:object(review.checks).subjectAligned===true,audioClear:object(review.checks).audioClear===true} },
    factReview: data.factReview == null ? null : { addressConfirmed: factReview.addressConfirmed === true,
      identityNote: text(factReview.identityNote), placeName: text(factReview.placeName, 160),
      resolvedAddress: text(factReview.resolvedAddress, 200), facts: factsView(factReview.facts) },
  }, canApprove, canRetry, canRegenerate, canRevoice };
}
