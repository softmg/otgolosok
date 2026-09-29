import { resolve, join } from "node:path";
import { createStore } from "./store.mjs";
import { createProvider } from "./provider.mjs";
import { normalizeAddress,addressKey,publicJob } from "./domain.mjs";
import { runJob } from "./pipeline.mjs";

const directory=resolve(process.env.DATA_DIR??"backend/data");
const store=createStore(join(directory,"jobs.sqlite"));
store.recoverInterrupted();
const address=normalizeAddress(process.argv[2]);
const job=store.createOrGet({key:addressKey(address),address});
if(process.argv.includes("--retry")&&job.stage==="failed")store.retry(job.id,job.revision);
const provider=createProvider({baseUrl:process.env.OPENAI_BASE_URL,apiKey:process.env.OPENAI_API_KEY,model:process.env.STORY_MODEL,writerModel:process.env.WRITER_MODEL,searchModel:process.env.RESEARCH_SEARCH_MODEL||null});
const timer=setInterval(()=>{const current=store.get(job.id);console.log(current.id,current.stage);},15000);
try {
  const claimed=store.claimNext();
  if(claimed) await runJob(claimed,{store,provider,audioDirectory:join(directory,"audio")});
  const current=store.get(job.id);
  console.log(JSON.stringify(publicJob(current),null,2));
  if(current.stage!=="ready")process.exitCode=1;
} finally {clearInterval(timer);store.close();}
