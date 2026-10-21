import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const root=await mkdtemp(join(tmpdir(),'pi-goal-monitor-pair-'));
process.env.PI_GOAL_GLOBAL_SETTINGS_FILE=join(root,'global.json');
process.env.PI_GOAL_SETTINGS_FILE=join(root,'local.json');
const sdk=process.env.PI_SDK_ROOT||'/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent';
const req=createRequire(`${sdk}/package.json`);
const {createJiti}=req('jiti');
const jiti=createJiti(import.meta.url,{alias:{typebox:req.resolve('typebox')}});
const {GoalScheduler}=await jiti.import('../extensions/goal-scheduler.ts');
const {newGoalScheduler}=await jiti.import('../extensions/goal-scheduler-state.ts');
const {default:monitor}=await jiti.import('../../pi-event-monitor-batched/extensions/index.ts');
const bus=new EventEmitter(),tools=new Map(),handlers=new Map(),messages=[],errors=[];
const events={on:(n,f)=>{bus.on(n,f);return()=>bus.off(n,f)},emit:(n,v)=>bus.emit(n,v)};
let queued=0;
const core={state:{goal:{id:'test-goal',status:'active',autoContinue:true,usage:{tokensUsed:0},scheduler:newGoalScheduler('test-session')}},pi:{events},
  goalService:{flushForAudit:()=>undefined,isTurnBuffered:()=>false,apply:(_ctx,operation)=>{core.state.goal=operation.mutate(structuredClone(core.state.goal));return{ok:true,goal:core.state.goal}}},
  updateUI(){},clearActiveAccounting(){},reconcileFocusedGoalFromDisk:()=>true,
  runtime:{clearContinuationState(){},clearContinuationTimer(){},queueContinuation(){queued++}}};
const ctx={cwd:root,hasUI:true,hasPendingMessages:()=>false,sessionManager:{getSessionId:()=> 'test-session'},ui:{confirm:async()=>true,setStatus(){},notify:(m,k)=>{if(k==='warning')errors.push(m)}}};
const scheduler=new GoalScheduler(core);
monitor({events,registerTool:d=>tools.set(d.name,d),registerCommand(){},on:(n,f)=>handlers.set(n,f),sendMessage:(m,o)=>messages.push({m,o})});
scheduler.attach(ctx);
const call=(n,p)=>tools.get(n).execute('pair-test',p,undefined,undefined,ctx);
const finish=()=>{scheduler.recordFinalMessage([{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Waiting for the job. GOAL_WAIT'}]}]);scheduler.settled(ctx,true)};
async function until(p){const end=Date.now()+5000;while(!p()){assert(Date.now()<end,'timed out');await delay(15)}}
try {
  const start=await call('monitor_start',{description:'paired monitor',interval_minutes:0.004,command:'sleep 0.1; echo PROGRESS; sleep 20'});
  scheduler.begin(ctx);finish();
  assert(core.state.goal.scheduler.monitorWait,'must enter wait');assert.equal(queued,0);
  await until(()=>messages.length===1);
  assert(!core.state.goal.scheduler.monitorWait,'real monitor event releases wait');assert.equal(queued,0,'wake must not enqueue an extra goal turn');
  assert.equal(messages[0].o.triggerTurn,true);
  scheduler.begin(ctx);scheduler.message(ctx,{role:'custom',...messages[0].m});finish();
  assert(core.state.goal.scheduler.monitorWait,'may wait again after consuming intermediate notification');
  await call('monitor_stop',{id:start.details.id});await until(()=>messages.length===2);
  assert(!core.state.goal.scheduler.monitorWait,'final monitor event releases wait');assert.equal(queued,0);
  assert.match(messages[1].m.content,/process exited/);
  const second=await call('monitor_start',{description:'user wake',command:'sleep 20'});
  scheduler.begin(ctx);finish();assert(core.state.goal.scheduler.monitorWait);
  scheduler.begin(ctx);scheduler.message(ctx,{role:'user',content:'continue now'});
  assert(!core.state.goal.scheduler.monitorWait,'user message releases wait');assert.equal(queued,0);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,realMonitorIntermediateWake:true,realMonitorFinalWake:true,canWaitAgain:true,userWake:true,duplicateGoalRuns:queued}));
} finally {
  scheduler.shutdown();await handlers.get('session_shutdown')({},ctx);await rm(root,{recursive:true,force:true});
}
