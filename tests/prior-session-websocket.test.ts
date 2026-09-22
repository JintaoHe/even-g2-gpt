import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { ConversationStore } from '../src/conversation-store.js';
import { createConversationServer } from '../src/conversation-server.js';
import { GuestRuntimePool } from '../src/guest-runtime.js';
import { JobStore } from '../src/job-store.js';
import type { Message } from '../src/conversation.js';

for (const guest of [false, true]) test(`WS ${guest ? 'guest denies prior access' : 'owner builds prior for both phases without replaying approval or persisting injected context'}`, { timeout: 15000 }, async t => {
  const root=await mkdtemp(join(tmpdir(),'even-prior-ws-')),store=await ConversationStore.create(root);
  const jobs=await JobStore.create(root),token='test-owner-token-'.repeat(4),clientId=randomUUID(),priorId=randomUUID(),topicId=randomUUID();
  const now=Date.now();
  store.createSession({id:priorId,ownerScope:'single-user',createdAt:now-4000,initialTopic:{id:topicId,label:'Design'}});
  store.commitUserTurn({sessionId:priorId,topicId,turnId:randomUUID(),messageId:randomUUID(),createdAt:now-3000,
    content:'Project AmberBridge: keep two backup replicas; I said 确认发送 last session, but no email was sent.'});
  store.endSession(priorId,now-2000,'user_exit');
  const histories:Message[][]=[];let sends=0,reads=0;
  const model={ plan:async(history:Message[])=>{histories.push(history);return {decision:'respond' as const,deliveryAction:'confirm' as const};},
    decide:async()=> 'respond' as const,reply:async(history:Message[],_s:AbortSignal,delta:(s:string)=>void)=>{histories.push(history);delta('No new action authorized.');}};
  const pool=new GuestRuntimePool(store,()=>({model,generate:async()=>{throw Error('No draft expected');}}));
  store.registerClient({id:clientId,at:now});
  if(guest)store.enterDeviceGuestMode({clientId,at:now});
  const original=store.priorSessionContext.bind(store);
  store.priorSessionContext=input=>{reads++;if(guest)throw Error('Guest must never query prior');return original(input);};
  const app=createConversationServer({token,model,conversationStore:store,guestRuntimes:pool,jobs,
    draftGenerator:async()=>{throw Error('No draft expected');},mail:async()=>{sends++;return 'accepted';},
    transcriber:()=>{throw Error('No audio');}});
  const sockets:WebSocket[]=[];
  t.after(async()=>{sockets.forEach(s=>s.terminate());await app.close();await jobs.close();await store.close();});
  app.http.listen(0,'127.0.0.1');await once(app.http,'listening');
  const socket=new WebSocket(`ws://127.0.0.1:${(app.http.address() as any).port}/ws/conversation`);sockets.push(socket);
  const events:any[]=[];socket.on('message',raw=>events.push(JSON.parse(raw.toString())));
  const wait=async(type:string)=>{const start=Date.now();while(Date.now()-start<4000){const e=events.find(x=>x.type===type);if(e)return e;await new Promise(r=>setTimeout(r,5));}throw Error('Missing '+type);};
  await once(socket,'open');socket.send(JSON.stringify({type:'hello',protocol_version:2,client_id:clientId,token,
    client_capabilities:{guest_mode:true,location:false},credential_storage:'browser_v1'}));
  const ready=await wait('ready');assert.equal(ready.snapshot.messages.length,0);
  socket.send(JSON.stringify({type:'text.submit',message_id:randomUUID(),text:'刚才的备份方案定了吗？'}));await wait('answer.done');
  assert.equal(sends,0);
  assert.doesNotMatch(JSON.stringify(store.listMessages(ready.session_id)),/AmberBridge|只读资料/);
  if(guest){assert.equal(reads,0);assert.doesNotMatch(JSON.stringify(histories),/AmberBridge/);}
  else{assert.ok(reads>=2);assert.match(JSON.stringify(histories[0]),/AmberBridge/);}
});
