const PREPARATION_VERSION="html-unescape-v1_ru-normalizr-0.3.0_silero-stress-1.5_typography-v1";
const SILERO_SHA="50081637b602126ee06cb3bc8a744d25651d2da149ee8864b9a379bfdd934437";

export function loadLocalTtsConfig(env=process.env) {
  const engine=(env.LOCAL_TTS_ENGINE||"silero").trim().toLowerCase();
  const transport=(env.LOCAL_TTS_TRANSPORT||"worker").trim().toLowerCase();
  if(!["silero","f5"].includes(engine))throw new Error("LOCAL_TTS_ENGINE must be silero or f5");
  if(!["worker","http"].includes(transport))throw new Error("LOCAL_TTS_TRANSPORT must be worker or http");
  const profiles={
    "silero-ru-v1":{engine:"silero",language:"ru",modelSha256:env.SILERO_MODEL_SHA256||SILERO_SHA,speaker:env.SILERO_SPEAKER||"baya",configVersion:"4",chunking:"sentence-v1",textPreparation:{input:"raw",version:PREPARATION_VERSION}},
    "f5-ru-v1":{engine:"f5",language:"ru",modelSha256:env.F5_MODEL_SHA256||null,speaker:env.F5_REFERENCE_ID||null,configSha256:env.F5_CONFIG_SHA256||null,referenceSha256:env.F5_REFERENCE_SHA256||null,configVersion:"2",chunking:"f5-native-v1",textPreparation:{input:"raw",version:PREPARATION_VERSION}},
  };
  const defaultProfile=engine==="f5"?"f5-ru-v1":"silero-ru-v1";
  if(engine==="f5"&&![profiles[defaultProfile].modelSha256,profiles[defaultProfile].speaker,profiles[defaultProfile].configSha256].every(Boolean))throw new Error("F5_MODEL_SHA256, F5_REFERENCE_ID and F5_CONFIG_SHA256 are required when LOCAL_TTS_ENGINE=f5");
  if(transport==="http"&&(!env.TTS_API_URL||!env.TTS_API_TOKEN))throw new Error("TTS_API_URL and TTS_API_TOKEN are required when LOCAL_TTS_TRANSPORT=http");
  return {engine,transport,defaultProfile,profiles,preparationVersion:PREPARATION_VERSION};
}
