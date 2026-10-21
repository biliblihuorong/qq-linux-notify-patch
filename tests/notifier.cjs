'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const patched = path.resolve(__dirname, '..');
function fakeDate(clock) { return class extends Date { constructor(...a) { super(...(a.length ? a : [clock.now])); } static now() { return clock.now; } }; }
function renderer(root) {
  const clock = {now: 100000};
  const state = {focus: false,hidden: false,count: 0,preview: 'old',muted: false,prefix: false,id:'chat-A',recycled: false};
  const sent = [], intervals = [], handlers = new Map();
  const row = {parentElement: null,isConnected:true,scrollIntoView:()=>{},getAttribute:k=>k==='data-peer-id'?state.id:null,getBoundingClientRect: () => ({width: 260,height: 60,left:10,top:100})};
  Object.defineProperty(row,'innerText',{get:()=>state.prefix?`${state.count}\n${state.name||'Alice'}\n${state.preview}`:`${state.name||'Alice'}\n${state.preview}\n${state.count}`});
  const badge = {parentElement: row,closest:()=>row};
  Object.defineProperty(badge,'textContent',{get:()=>String(state.count)});
  Object.defineProperty(badge,'className',{get:()=>state.muted?'q-badge__grey':'q-badge__red'});
  const badges=[badge];
  const doc = {readyState:'complete',documentElement:{},hasFocus:()=>state.focus,
    querySelectorAll:(selector)=>selector.includes('badge')?badges:[], addEventListener:()=>{}};
  Object.defineProperty(doc,'hidden',{get:()=>state.hidden});
  class MutationObserver { constructor(fn) { this.fn=fn; } observe() {} }
  const context={require:(name)=>{ assert.equal(name,'electron');return {ipcRenderer:{send:(channel,p)=>sent.push(p),on:(name,fn)=>handlers.set(name,fn)}};},
    document:doc,window:{addEventListener:()=>{},innerWidth:1024,innerHeight:768},MutationObserver,Date:fakeDate(clock),
    setInterval:fn=>intervals.push(fn),setTimeout:fn=>fn(),console};
  vm.runInNewContext(fs.readFileSync(path.join(root,'qq-notifier-preload.js'),'utf8'),context);
  const step=(changes={},ms=1000)=>{Object.assign(state,changes);clock.now+=ms;intervals.forEach(fn=>fn());};
  step({},0);
  return {step,sent,clock,state,row,handlers,badges,unread:()=>sent.filter(p=>p.type==='unread')};
}
function runRenderer(root,scenario) {
  const r=renderer(root);
  r.step({count:1,preview:'old'});
  if(scenario==='foreground') r.step({focus:true,preview:'new'});
  if(scenario==='mute') r.step({muted:true,preview:'new'});
  if(scenario==='read') r.step({count:0,preview:'new'});
  if(scenario==='fresh') r.step({preview:'new'});
  if(scenario==='same-cycle') { r.step({count:0});r.sent.length=0;r.step({count:1,preview:'new'}); }
  return r;
}
for(const scenario of ['foreground','mute','read']) {
  assert.equal(runRenderer(patched,scenario).unread().length,0,`patch cancels ${scenario}`);
  console.log('PASS pending cancellation:',scenario);
}
let r=runRenderer(patched,'fresh');assert.equal(r.unread().length,1);assert.equal(r.unread()[0].body,'new');
console.log('PASS background fresh preview notification');
r=runRenderer(patched,'same-cycle');assert.equal(r.unread().length,1);assert.equal(r.unread()[0].body,'new');
console.log('PASS count and preview updating in same DOM cycle');
r=renderer(patched);r.step({count:1});r.step({},5000);assert.equal(r.unread().length,0);r.step({},1200);assert.equal(r.unread()[0].body,'(新消息)');
console.log('PASS delayed preview fallback');
r=runRenderer(patched,'fresh');assert.equal(r.sent.filter(p=>p.type==='log').length,0);
console.log('PASS renderer does not send conversation diagnostics');
function main(root, { debug = false, deferTimers = false } = {}) {
  const clock={now:100000},notices=[],writes=[],requests=[],inputs=[],timers=[];
  const ipcMain=new EventEmitter(),app=new EventEmitter();app.isReady=()=>false;app.whenReady=()=>Promise.resolve();
  const sess={setPreloads:()=>{},getPreloads:()=>[]};
  class Notification extends EventEmitter { constructor(options){super();this.options=options;} show(){notices.push(this);} }
  const wc={id:1,mainFrame:{},isDestroyed:()=>false,focus:()=>{},send:(channel,payload)=>requests.push({channel,payload}),sendInputEvent:e=>inputs.push(e)};
  const electron={ipcMain,app,session:{defaultSession:sess},Notification,webContents:{fromId:()=>wc},BrowserWindow:{getAllWindows:()=>[],fromWebContents:()=>null}};
  const fsmock={appendFileSync:(...x)=>writes.push(x),mkdirSync:(...x)=>writes.push(x),openSync:(...x)=>{writes.push(x);return 1;},fstatSync:()=>({size:0}),writeSync:(_fd,text)=>writes.push(text),closeSync:()=>{},ftruncateSync:()=>{},constants:fs.constants};
  const context={require:(name)=>({fs:fsmock,path:require('path'),os:{homedir:()=>'/test-home'},electron})[name],process:{env:debug?{QQX_DEBUG:'1'}:{},stderr:{write:()=>{}}},__dirname:root,Date:fakeDate(clock),setTimeout:fn=>deferTimers?timers.push(fn):fn(),console};
  vm.runInNewContext(fs.readFileSync(path.join(root,'qq-notifier-main.js'),'utf8'),context);
  const emit=(key,body,extra={})=>ipcMain.emit('QQX_NOTIFIER_EVENT',{sender:wc,senderFrame:wc.mainFrame},Object.assign({type:'unread',title:'QQ '+key,key,body,target:'test-token'},extra));
  return {clock,notices,writes,emit,ipcMain,wc,requests,inputs,timers};
}
let m=main(patched);m.emit('A','private');assert.equal(m.notices.length,1);m.emit('A','private');assert.equal(m.notices.length,1);
m.clock.now+=21000;m.emit('A','changed');assert.equal(m.notices.length,2);
m.emit('B','b');m.emit('C','c');m.emit('D','d');assert.equal(m.notices.length,4);
m.clock.now+=61000;m.emit('D','d');assert.equal(m.notices.length,5);
console.log('PASS deduplication, per-chat throttle and global throttle');
m.emit('Bad','x',{body:42});assert.equal(m.notices.length,5);
m.emit('Bad','x',{key:'x'.repeat(600)});assert.equal(m.notices.length,5);
m.ipcMain.emit('QQX_NOTIFIER_EVENT',{sender:m.wc,senderFrame:{}},{type:'unread',title:'QQ X',key:'X',body:'x'});assert.equal(m.notices.length,5);
assert.equal(m.writes.length,0);
console.log('PASS IPC validation and no default filesystem logging');
let originalRequired=false;
vm.runInNewContext(fs.readFileSync(path.join(patched,'qq_main_hook.js'),'utf8'),{module:{exports:{}},require:(name)=>{if(name.includes('notifier'))throw Error('Simulated plugin failure');originalRequired=true;}});
assert.ok(originalRequired);console.log('PASS original QQ startup survives notification-plugin exception');

// The sender name is not necessarily the first innerText line. Route by target token.
r=renderer(patched);r.step({count:1,prefix:true,preview:'new'});
const alert=r.unread()[0];assert.ok(alert && alert.target);
r.handlers.get('QQX_NOTIFIER_OPEN')({}, {token:alert.target});
let target=r.sent.find(p=>p.type==='open-target' && p.token===alert.target);
assert.equal(target.status,'ready');assert.equal(target.x,110);assert.equal(target.y,130);
console.log('PASS notification target with unread count preceding sender name');
// Main process accepts a location only following this notification's click.
m=main(patched);m.emit('A','body',{target:alert.target});
m.ipcMain.emit('QQX_NOTIFIER_EVENT',{sender:m.wc,senderFrame:m.wc.mainFrame},target);
assert.equal(m.inputs.length,0);
m.notices[0].emit('click');assert.equal(m.requests[0].channel,'QQX_NOTIFIER_OPEN');
m.ipcMain.emit('QQX_NOTIFIER_EVENT',{sender:m.wc,senderFrame:m.wc.mainFrame},target);
assert.deepEqual(m.inputs.map(e=>e.type),['mouseMove','mouseDown','mouseUp']);
assert.equal(m.inputs[1].button,'left');
console.log('PASS token-bound renderer routing and native conversation row click');
// Wrong renderer or a replayed coordinate response cannot inject input.
m.ipcMain.emit('QQX_NOTIFIER_EVENT',{sender:m.wc,senderFrame:m.wc.mainFrame},target);assert.equal(m.inputs.length,3);
m.clock.now+=61000;m.emit('A','again',{target:'wrong-sender-token'});m.notices[1].emit('click');
m.ipcMain.emit('QQX_NOTIFIER_EVENT',{sender:{id:2,isDestroyed:()=>false},senderFrame:null},{...target,token:'wrong-sender-token'});assert.equal(m.inputs.length,3);
console.log('PASS reject unsolicited, replayed and wrong-renderer click coordinates');

function replacementBadge(name,id,left=30) {
  const row={innerText:`1\n${name}\nreplacement preview`,isConnected:true,scrollIntoView:()=>{},
    getAttribute:k=>k==='data-peer-id'?id:null,getBoundingClientRect:()=>({width:260,height:60,left,top:100})};
  return {parentElement:row,className:'q-badge__red',textContent:'1',closest:()=>row};
}
r=renderer(patched);r.step({count:1,preview:'new'});let token=r.unread()[0].target;
r.row.isConnected=false;r.badges.splice(0,1,replacementBadge('Renamed Alice','chat-A'));
r.handlers.get('QQX_NOTIFIER_OPEN')({}, {token});target=r.sent.find(p=>p.type==='open-target');
assert.equal(target.status,'ready');assert.equal(target.x,130);
console.log('PASS replaced/renamed row resolves by stable conversation attribute');
r=renderer(patched);r.step({id:'',count:1,preview:'new'});token=r.unread()[0].target;
r.row.isConnected=false;r.badges.splice(0,1,replacementBadge('Alice',''),replacementBadge('Alice','',50));
r.handlers.get('QQX_NOTIFIER_OPEN')({}, {token});target=r.sent.find(p=>p.type==='open-target');assert.equal(target.status,'ambiguous-or-not-found');
console.log('PASS duplicate-name fallback refuses to open an arbitrary person');
r=renderer(patched);r.step({count:1,preview:'new'});token=r.unread()[0].target;
r.state.name='Mallory';r.state.id='chat-B';
r.handlers.get('QQX_NOTIFIER_OPEN')({}, {token});target=r.sent.find(p=>p.type==='open-target');assert.equal(target.status,'ambiguous-or-not-found');
console.log('PASS virtual row recycled for another conversation is not clicked');

// Opt-in diagnostics contain technical events only, even for real notification fields.
m=main(patched,{debug:true});m.emit('PRIVATE_CONTACT_SENTINEL','PRIVATE_BODY_SENTINEL');
assert.ok(m.writes.length>0);
assert.ok(!JSON.stringify(m.writes).includes('PRIVATE_CONTACT_SENTINEL'));
assert.ok(!JSON.stringify(m.writes).includes('PRIVATE_BODY_SENTINEL'));
assert.ok(m.writes.some(v=>Array.isArray(v) && v[2]===0o600));
console.log('PASS opt-in diagnostics redact chat fields and create private log files');
// A renderer disappearing after the notification click cannot cause an async exception.
m=main(patched,{deferTimers:true});m.emit('A','body');m.notices[0].emit('click');
m.wc.send=()=>{throw Error('Renderer disconnected');};
assert.doesNotThrow(()=>m.timers.forEach(fn=>fn()));
console.log('PASS disconnected renderer does not throw from the deferred click request');
// Late responses and out-of-bounds coordinates cannot generate native input.
m=main(patched);m.emit('A','body',{target:'expired'});m.notices[0].emit('click');m.clock.now+=6100;
m.ipcMain.emit('QQX_NOTIFIER_EVENT',{sender:m.wc,senderFrame:m.wc.mainFrame},{type:'open-target',token:'expired',status:'ready',x:10,y:10});
assert.equal(m.inputs.length,0);
m=main(patched);m.emit('A','body',{target:'outside'});m.notices[0].emit('click');
m.ipcMain.emit('QQX_NOTIFIER_EVENT',{sender:m.wc,senderFrame:m.wc.mainFrame},{type:'open-target',token:'outside',status:'ready',x:-1,y:10});
assert.equal(m.inputs.length,0);
console.log('PASS expired requests and invalid coordinates cannot click the page');
