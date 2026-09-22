export const AUTH_EVENT_KEY = "otgolosok:auth:event";
export const AUTH_CHANNEL = "otgolosok:auth";
export const SIGNED_OUT_MESSAGE = "signed-out";

export const isSignOutStorageEvent = (event: Pick<StorageEvent, "key">) => event.key === AUTH_EVENT_KEY;
export const isSignOutChannelEvent = (event: Pick<MessageEvent, "data">) => event.data === SIGNED_OUT_MESSAGE;
