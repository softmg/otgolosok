import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const script=resolve(import.meta.dirname,"../scripts/prod-db.mjs");

function database(path,label,audio) {
  const db=new DatabaseSync(path);
  db.exec("CREATE TABLE jobs(stage TEXT,created_at TEXT,record_json TEXT); CREATE TABLE place_texts(audio_json TEXT)");
  db.prepare("INSERT INTO jobs VALUES (?,?,?)").run("ready","2026-09-16T00:00:00.000Z",JSON.stringify({address:label}));
  db.prepare("INSERT INTO place_texts VALUES (?)").run(JSON.stringify({url:`/api/story-audio/${audio}`,sha256:audio.replace(".mp3","")}));
  db.close();
}

test("production import and restore keep the SQLite snapshot, its audio and place photos",()=>{
  const root=mkdtempSync(join(tmpdir(),"otgolosok-prod-db-")),data=join(root,"data"),dump=join(root,"dump");
  try {
    mkdirSync(join(data,"audio"),{recursive:true});mkdirSync(join(dump,"audio"),{recursive:true});
    const oldHash="a".repeat(64),newHash="b".repeat(64);
    database(join(data,"jobs.sqlite"),"old",`${oldHash}.mp3`);writeFileSync(join(data,"audio",`${oldHash}.mp3`),"old-audio");
    database(join(dump,"jobs.sqlite"),"new",`${newHash}.mp3`);writeFileSync(join(dump,"audio",`${newHash}.mp3`),"new-audio");
    const env={...process.env,DATA_DIR:data,DUMP_DIR:dump};
    mkdirSync(join(data,"place-images"));writeFileSync(join(data,"place-images",`${oldHash}.jpg`),"old-photo");
    mkdirSync(join(dump,"place-images"));writeFileSync(join(dump,"place-images",`${newHash}.jpg`),"new-photo");
    execFileSync(process.execPath,[script,"import"],{env,stdio:"pipe"});
    assert.equal(readFileSync(join(data,"audio",`${newHash}.mp3`),"utf8"),"new-audio");
    assert.deepEqual(readdirSync(join(data,"place-images")),[`${newHash}.jpg`]);
    let db=new DatabaseSync(join(data,"jobs.sqlite"),{readOnly:true});assert.equal(JSON.parse(/** @type {string} */ (db.prepare("SELECT record_json FROM jobs").get().record_json)).address,"new");db.close();
    const backup=readdirSync(data).find(name=>name.startsWith("backup-local-"));assert.ok(backup);
    execFileSync(process.execPath,[script,"restore"],{env:{...env,BACKUP:backup},stdio:"pipe"});
    assert.equal(readFileSync(join(data,"audio",`${oldHash}.mp3`),"utf8"),"old-audio");
    assert.equal(readdirSync(join(data,"audio")).includes(`${newHash}.mp3`),false);
    assert.deepEqual(readdirSync(join(data,"place-images")),[`${oldHash}.jpg`]);
    db=new DatabaseSync(join(data,"jobs.sqlite"),{readOnly:true});assert.equal(JSON.parse(/** @type {string} */ (db.prepare("SELECT record_json FROM jobs").get().record_json)).address,"old");db.close();
  } finally {rmSync(root,{recursive:true,force:true});}
});
