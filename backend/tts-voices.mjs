// Built-in voices: https://developers.openai.com/api/docs/guides/text-to-speech
// Russian voices: https://aistudio.yandex.ru/ru/docs/speechkit/tts/voices
// ElevenLabs voices belong to the account and are loaded from its API at startup.
const voices = {
  openai: ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"]
    .map(id => ({ id, label: id[0].toUpperCase() + id.slice(1) })),
  yandex: [
    ["marina", "Марина"], ["dasha", "Даша"], ["julia", "Юлия"], ["lera", "Лера"], ["masha", "Маша"],
    ["alexander", "Александр"], ["anton", "Антон"], ["kirill", "Кирилл"], ["ermil", "Ермил"],
    ["filipp", "Филипп"], ["zahar", "Захар"], ["jane", "Джейн"], ["omazh", "Омаж"],
    ["madi_ru", "Мади"], ["saule_ru", "Сауле"], ["zamira_ru", "Замира"], ["zhanar_ru", "Жанар"], ["yulduz_ru", "Юлдуз"],
  ].map(([id, label]) => ({ id, label })),
  elevenlabs: [],
};

export const TTS_PROVIDERS = Object.freeze(["openai", "yandex", "elevenlabs"]);

export function isTtsProvider(value) {
  return TTS_PROVIDERS.includes(value);
}

// ElevenLabs voice ids are mixed-case (for example "JBFqnCBsd6RMkjVDRZzb").
export function validVoiceId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
}

/** @param {string} provider @param {string | null | undefined} configuredVoice @param {{id: string, label: string}[]} [catalog] */
export function ttsVoiceOptions(provider, configuredVoice, catalog = voices[provider]) {
  const defaultVoice = validVoiceId(configuredVoice) ? configuredVoice : catalog[0]?.id ?? "";
  return { defaultVoice, voices: !defaultVoice || catalog.some(voice => voice.id === defaultVoice)
    ? catalog : [{ id: defaultVoice, label: defaultVoice }, ...catalog] };
}
