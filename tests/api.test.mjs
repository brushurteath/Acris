import test,{after,before} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp,followupInfo} from '../server.mjs';

let app,base,temp;
before(async()=>{temp=mkdtempSync(join(tmpdir(),'acris-test-'));app=createApp({dataDir:temp});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${app.server.address().port}`;});
after(async()=>{await app.close();rmSync(temp,{recursive:true,force:true});});
async function request(path,method='GET',body,auth={},extra={}){const res=await fetch(base+'/api'+path,{method,headers:{'Content-Type':'application/json',Origin:base,...auth,...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')};}
async function register(email){const res=await request('/register','POST',{email,alias:'测试远航者',password:'Test-password-2026',consent:true});assert.equal(res.status,201);return {Cookie:res.cookie.split(';')[0],'X-CSRF-Token':res.data.csrf};}
const sample={alias:'测试昵称',major:'计算机类',tier:'普通本科',region:'华东',degree:'本科',year:2023,city:'杭州',industry:'软件服务',role:'前端开发',salary:'8–12k',status:'就业',summary:'这是用于测试的虚构职业经历，不涉及真实个人资料。',advice:'建议先尝试不同岗位，了解真实工作内容，再做出适合自己的决定。',followup:true,consent:true};

test('signup, review, ownership, update, withdrawal, export and deletion lifecycle',async()=>{
  const owner=await register('owner@example.test'),other=await register('other@example.test');
  assert.equal((await request('/records','POST',sample)).status,401);
  assert.equal((await request('/records','POST',sample,{Cookie:owner.Cookie})).status,403);
  assert.equal((await request('/records','POST',{...sample,consent:false},owner)).status,400);
  const created=await request('/records','POST',sample,owner);assert.equal(created.status,201);const id=created.data.id;
  assert.equal((await request('/records')).data.records.length,0,'unreviewed content must remain private');
  assert.equal((await request('/records','POST',sample,owner)).status,409,'one record per user');
  assert.equal((await request(`/records/${id}`,'DELETE',{},other)).status,404,'another user cannot delete it');
  assert.equal((await request('/admin/records','GET',undefined,owner)).status,403);
  app.db.prepare('UPDATE users SET admin=1 WHERE email=?').run('other@example.test');
  assert.equal((await request(`/admin/records/${id}`,'POST',{status:'rejected',note:''},other)).status,400);
  assert.equal((await request(`/admin/records/${id}`,'POST',{status:'approved',note:'测试内容'},other)).status,200);
  let publicly=(await request('/records')).data.records;assert.equal(publicly.length,1);assert.equal(publicly[0].source,'self-report');assert.equal(publicly[0].verified,false);assert.ok(!('email'in publicly[0]));assert.ok(!('followup'in publicly[0]));assert.ok(!('user_id'in publicly[0]));
  const mine=(await request('/mine','GET',undefined,owner)).data.records[0];
  assert.equal(mine.due,true);assert.equal(mine.nextFollowup,'2024-07-01');
  assert.equal((await request(`/records/${id}`,'PATCH',{...sample,timeline:mine.timeline,update:'回访期间开始学习新的技能，也逐渐了解自己适合的工作方式。'},owner)).status,200);
  assert.equal((await request('/records')).data.records.length,0,'updates must be reviewed again');
  assert.equal((await request('/mine','GET',undefined,owner)).data.records[0].timeline.length,2);
  assert.equal((await request('/export','GET',undefined,owner)).data.user.email,'owner@example.test');
  await request(`/admin/records/${id}`,'POST',{status:'approved'},other);
  assert.equal((await request(`/records/${id}/withdraw`,'POST',{},owner)).status,200);
  assert.equal((await request('/records')).data.records.length,0);
  assert.equal((await request(`/admin/records/${id}`,'POST',{status:'approved'},other)).status,409,'withdrawn content cannot be republished by admin');
  assert.equal((await request(`/records/${id}`,'DELETE',{},owner)).status,200);
  assert.equal((await request('/mine','GET',undefined,owner)).data.records.length,0);
  assert.equal((await request('/account','DELETE',{password:'incorrect-password'},owner)).status,401);
  assert.equal((await request('/account','DELETE',{password:'Test-password-2026'},owner)).status,200);
  assert.equal((await request('/me','GET',undefined,owner)).data.user,null);
});
test('origin checks, input validation, secret file protection and login',async()=>{
  const auth=await register('security@example.test');
  assert.equal((await request('/records','POST',sample,auth,{Origin:'https://evil.example'})).status,403);
  assert.equal((await request('/records','POST',{...sample,year:9999},auth)).status,400);
  assert.equal((await request('/records','POST',{...sample,major:'unlisted'},auth)).status,400);
  const denied=await fetch(base+'/.env');assert.equal(denied.status,404);
  assert.equal((await fetch(base+'/data/acris.db')).status,404);
  const login=await request('/login','POST',{email:'security@example.test',password:'Test-password-2026'});assert.equal(login.status,200);assert.match(login.cookie,/HttpOnly; SameSite=Strict/);
  assert.equal((await request('/login','POST',{email:'security@example.test',password:'wrong-password'})).status,401);
  assert.equal((await request('/logout','POST',{},auth)).status,200);
  assert.equal((await request('/mine','GET',undefined,auth)).status,401);
  const row=app.db.prepare('SELECT * FROM users WHERE email=?').get('security@example.test');assert.notEqual(row.password_hash,'Test-password-2026');assert.equal(row.admin,0);
});
test('graduation follow-up checkpoints, completion and opt-out',()=>{
  assert.deepEqual(followupInfo({year:2025,followup:true},new Date('2026-10-23')),{nextFollowup:'2026-07-01',due:true});
  assert.deepEqual(followupInfo({year:2025,followup:true,lastFollowupAt:'2026-10-23'},new Date('2026-10-23')),{nextFollowup:'2027-07-01',due:false});
  assert.deepEqual(followupInfo({year:2020,followup:false}),{nextFollowup:null,due:false});
  assert.deepEqual(followupInfo({year:2000,followup:true,lastFollowupAt:'2020-01-01'}),{nextFollowup:null,due:false});
});
