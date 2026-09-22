const GEO_PROMPT_DISMISSED_KEY = "otgolosok:explore:geo-prompt-dismissed";

type PromptStorage = Pick<Storage, "getItem" | "setItem">;

export function shouldShowGeoPrompt(storage: PromptStorage): boolean {
  try {
    return storage.getItem(GEO_PROMPT_DISMISSED_KEY) !== "1";
  } catch {
    return true;
  }
}

export function rememberGeoPromptDismissal(storage: PromptStorage): void {
  try {
    storage.setItem(GEO_PROMPT_DISMISSED_KEY, "1");
  } catch {
    // Закрываем карточку в текущей сессии, даже если хранилище недоступно.
  }
}
