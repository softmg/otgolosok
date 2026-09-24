import test from "node:test";
import assert from "node:assert/strict";
import { loadLocalTtsConfig } from "./local-tts.mjs";

test("local TTS defaults to Silero",()=>{const value=loadLocalTtsConfig({});assert.equal(value.defaultProfile,"silero-ru-v1");assert.equal(value.profiles["silero-ru-v1"].textPreparation.input,"raw");});
test("F5 selection requires frozen model, voice and configuration",()=>{assert.throws(()=>loadLocalTtsConfig({LOCAL_TTS_ENGINE:"f5"}),/F5_MODEL_SHA256/);const value=loadLocalTtsConfig({LOCAL_TTS_ENGINE:"f5",F5_MODEL_SHA256:"a",F5_REFERENCE_ID:"voice",F5_CONFIG_SHA256:"b"});assert.equal(value.defaultProfile,"f5-ru-v1");});
test("F5 profile does not impose a minimum publication duration",()=>{const value=loadLocalTtsConfig({LOCAL_TTS_ENGINE:"f5",F5_MODEL_SHA256:"a",F5_REFERENCE_ID:"voice",F5_CONFIG_SHA256:"b"});assert.equal(Object.hasOwn(value.profiles["f5-ru-v1"],"minimumPublicationDurationSec"),false);});
test("unknown local TTS engine fails at startup",()=>assert.throws(()=>loadLocalTtsConfig({LOCAL_TTS_ENGINE:"other"}),/silero or f5/));
test("HTTP transport requires a private backend connection",()=>{assert.throws(()=>loadLocalTtsConfig({LOCAL_TTS_TRANSPORT:"http"}),/TTS_API_URL/);const value=loadLocalTtsConfig({LOCAL_TTS_TRANSPORT:"http",TTS_API_URL:"https://tts.example",TTS_API_TOKEN:"secret"});assert.equal(value.transport,"http");});
