import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scrypt = promisify(scryptCallback);
const root = dirname(fileURLToPath(import.meta.url));
const hash = s => createHash('sha256').update(s).digest('hex');
const fail = (status,message) => { const error = new Error(message); error.status=status; throw error; };
const sets = {
  major:['计算机类','工学类','经济与管理','人文社科','医学与健康','教育学','艺术设计','理学','农学','其他'],
  tier:['普通本科','双一流','高职专科','其他'],region:['华东','华北','华中','华南','西南','西北','东北','港澳台','海外'],
  degree:['专科','本科','硕士','博士'],status:['就业','升学','待业','备考','自由职业','创业','职业中断'],
  salary:['不愿透露','暂无工资','5k以下','5–8k','8–12k','12–18k','18–25k','25k以上']
};
function text(value,name,max,min=1){if(typeof value!=='string'||value.trim().length<min||value.trim().length>max)fail(400,`${name}须为 ${min}–${max} 字。`);return value.trim();}
function validateRecord(data){
  const r={};
  for(const k of Object.keys(sets)){if(!sets[k].includes(data[k]))fail(400,`${k} 的选项无效。`);r[k]=data[k];}
  for(const [k,label,max,min]of [['alias','昵称',20,1],['city','城市',30,1],['industry','行业',30,1],['role','岗位',40,1],['summary','经历概括',200,10],['advice','建议',600,10]])r[k]=text(data[k],label,max,min);
  if(!Number.isInteger(data.year)||data.year<1980||data.year>new Date().getFullYear())fail(400,'毕业年份无效。');r.year=data.year;
  if(data.consent!==true)fail(400,'请明确同意公开所提交的职业资料。');
  if(typeof data.followup!=='boolean')fail(400,'请选择是否参与回访。');r.followup=data.followup;
  r.startCity=data.startCity?text(data.startCity,'启航城市',30):'';
  return r;
}
function validateTimeline(value){
  if(!Array.isArray(value)||value.length<1||value.length>20)fail(400,'时间线需要 1–20 条记录。');
  return value.map(t=>({year:text(t?.year,'时间线年份',10),title:text(t?.title,'时间线标题',80),text:text(t?.text,'时间线内容',600)}));
}
export function followupInfo(record, now=new Date()){
  if(!record.followup)return {nextFollowup:null,due:false};
  const current=now.toISOString().slice(0,10);
  const checkpoint = record.lastFollowupAt?.slice(0,10)||`${record.year}-01-01`;
  const next=[1,2,5,10].map(n=>`${record.year+n}-07-01`).find(date=>date>checkpoint);
  return {nextFollowup:next||null,due:!!next&&next<=current};
}
export function createApp(config={}){
  const dataDir=resolve(config.dataDir||process.env.DATA_DIR||resolve(root,'data'));mkdirSync(dataDir,{recursive:true});
  const db=new DatabaseSync(resolve(dataDir,'acris.db'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,alias TEXT NOT NULL,salt TEXT NOT NULL,password_hash TEXT NOT NULL,admin INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,consent_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,csrf TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,payload TEXT NOT NULL,review_status TEXT NOT NULL DEFAULT 'pending',review_note TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,consent_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS record_status_idx ON records(review_status);
    CREATE INDEX IF NOT EXISTS session_expiry_idx ON sessions(expires);`);
  const secure=config.secure??process.env.COOKIE_SECURE==='1';
  const trustedOrigin=config.origin||process.env.APP_ORIGIN||null;
  const buckets=new Map();
  const cleanup=setInterval(()=>{const now=Date.now();for(const [k,v]of buckets)if(v.reset<now)buckets.delete(k);db.prepare('DELETE FROM sessions WHERE expires < ?').run(now);},60000);cleanup.unref();
  function limited(key,max=15){const now=Date.now();let bucket=buckets.get(key);if(!bucket||bucket.reset<now){bucket={count:0,reset:now+15*60*1000};buckets.set(key,bucket);}if(++bucket.count>max)fail(429,'操作过于频繁，请稍后再试。');}
  function session(req){const match=(req.headers.cookie||'').match(/(?:^|;\s*)acris_session=([a-f0-9]{64})(?:;|$)/);if(!match)return null;return db.prepare('SELECT s.csrf,s.token_hash,u.id,u.email,u.alias,u.admin FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>?').get(hash(match[1]),Date.now())||null;}
  const userView=u=>u?{id:u.id,email:u.email,alias:u.alias,admin:!!u.admin}:null;
  function requireUser(req){const s=session(req);if(!s)fail(401,'请先登录。');if(req.headers['x-csrf-token']!==s.csrf)fail(403,'登录状态校验失败，请刷新后重试。');return s;}
  function view(row,privateView=false){const payload=JSON.parse(row.payload);const {followup,lastFollowupAt,...publicPayload}=payload;const result={...publicPayload,id:row.id,source:'self-report',verified:false,updatedAt:row.updated_at};return privateView?{...result,followup,lastFollowupAt,reviewStatus:row.review_status,reviewNote:row.review_note,...followupInfo(payload)}:result;}
  function reply(res,status,data,headers={}){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(data));}
  async function body(req){if(!(req.headers['content-type']||'').startsWith('application/json'))fail(415,'请发送 JSON 数据。');const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>32768)fail(413,'提交内容过大。');chunks.push(chunk);}try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'数据格式错误。');return value;}catch(e){if(e.status)throw e;fail(400,'数据格式错误。');}}
  function loginSession(res,u,status=200){const token=randomBytes(32).toString('hex'),csrf=randomBytes(24).toString('hex');db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(token),u.id,csrf,Date.now()+7*86400000);reply(res,status,{user:userView(u),csrf},{'Set-Cookie':`acris_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure?'; Secure':''}`});}
  const cookieClear={'Set-Cookie':`acris_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure?'; Secure':''}`};
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try{
      const url=new URL(req.url,'http://localhost'),path=url.pathname,method=req.method;
      if(path.startsWith('/api/')){
        if(!['GET','POST','PATCH','DELETE'].includes(method))fail(405,'不支持的请求方法。');
        if(method!=='GET'){
          // Require the browser's exact configured origin. No forwarded Host trust.
          const origin=req.headers.origin;
          const expected=trustedOrigin||`http://${req.headers.host}`;
          if(origin!==expected)fail(403,'请求来源校验失败。');
          if(req.headers['sec-fetch-site']==='cross-site')fail(403,'不接受跨站请求。');
          limited(`write:${req.socket.remoteAddress}`,120);
        }
        if(path==='/api/health'&&method==='GET')return reply(res,200,{service:'acris',version:'0.1.0'});
        if(path==='/api/me'&&method==='GET'){const s=session(req);return reply(res,200,{user:userView(s),csrf:s?.csrf||''});}
        if(['/api/register','/api/login'].includes(path)&&method==='POST'){
          limited(`auth:${req.socket.remoteAddress}`,20);const data=await body(req);const email=text(data.email,'邮箱',254).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail(400,'邮箱格式无效。');
          const password=text(data.password,'密码',128,10);
          if(path==='/api/register'){
            if(data.consent!==true)fail(400,'请先同意账号隐私说明。');const alias=text(data.alias,'昵称',20);const salt=randomBytes(16).toString('hex');const digest=(await scrypt(password,salt,64)).toString('hex');
            // Admin is never granted through unverified public email registration.
            const u={id:randomUUID(),email,alias,admin:0},now=new Date().toISOString();
            try{db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)').run(u.id,email,alias,salt,digest,0,now,now);}catch(e){if(String(e.message).includes('UNIQUE'))fail(409,'该邮箱无法注册，请登录或更换邮箱。');throw e;}
            return loginSession(res,u,201);
          }
          const u=db.prepare('SELECT * FROM users WHERE email=?').get(email);const digest=await scrypt(password,u?.salt||'acris-dummy-salt',64);
          if(!u||!timingSafeEqual(digest,Buffer.from(u.password_hash,'hex')))fail(401,'邮箱或密码错误。');return loginSession(res,u);
        }
        if(path==='/api/logout'&&method==='POST'){const s=requireUser(req);db.prepare('DELETE FROM sessions WHERE token_hash=?').run(s.token_hash);return reply(res,200,{ok:true},cookieClear);}
        if(path==='/api/records'&&method==='GET'){const rows=db.prepare("SELECT * FROM records WHERE review_status='approved' ORDER BY updated_at DESC").all();return reply(res,200,{records:rows.map(r=>view(r))});}
        if(path==='/api/records'&&method==='POST'){
          const s=requireUser(req),data=await body(req),r=validateRecord(data),now=new Date().toISOString();
          if(db.prepare('SELECT id FROM records WHERE user_id=?').get(s.id))fail(409,'每个账号保留一份职业档案，请在“我的航程”更新已有记录。');
          r.timeline=[{year:String(r.year),title:`毕业 · ${r.role}`,text:r.summary}];const id=randomUUID();db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?)').run(id,s.id,JSON.stringify(r),'pending','',now,now,now);return reply(res,201,{id,reviewStatus:'pending'});
        }
        if(path==='/api/mine'&&method==='GET'){const s=session(req);if(!s)fail(401,'请先登录。');return reply(res,200,{records:db.prepare('SELECT * FROM records WHERE user_id=?').all(s.id).map(r=>view(r,true))});}
        if(path==='/api/export'&&method==='GET'){const s=session(req);if(!s)fail(401,'请先登录。');return reply(res,200,{user:userView(s),records:db.prepare('SELECT * FROM records WHERE user_id=?').all(s.id).map(r=>view(r,true)),exportedAt:new Date().toISOString()});}
        const match=path.match(/^\/api\/records\/([a-f0-9-]{36})(\/withdraw)?$/);
        if(match&&['PATCH','POST','DELETE'].includes(method)){
          const s=requireUser(req),row=db.prepare('SELECT * FROM records WHERE id=? AND user_id=?').get(match[1],s.id);if(!row)fail(404,'记录不存在。');const now=new Date().toISOString();
          if(method==='DELETE'&&!match[2]){db.prepare('DELETE FROM records WHERE id=?').run(row.id);return reply(res,200,{ok:true});}
          if(method==='POST'&&match[2]){db.prepare("UPDATE records SET review_status='withdrawn',updated_at=? WHERE id=?").run(now,row.id);return reply(res,200,{ok:true});}
          if(method==='PATCH'&&!match[2]){
            const data=await body(req),r=validateRecord(data),old=JSON.parse(row.payload);r.timeline=validateTimeline(data.timeline);r.lastFollowupAt=old.lastFollowupAt||null;
            if(data.update){const update=text(data.update,'回访内容',600,10);if(r.timeline.length>=20)fail(400,'时间线已满，请先精简既有记录。');r.timeline.push({year:now.slice(0,4),title:`回访 · ${r.role}`,text:update});r.lastFollowupAt=now;}
            db.prepare("UPDATE records SET payload=?,review_status='pending',review_note='',updated_at=?,consent_at=? WHERE id=?").run(JSON.stringify(r),now,now,row.id);return reply(res,200,{ok:true,reviewStatus:'pending'});
          }fail(405,'不支持的请求方法。');
        }
        if(path==='/api/admin/records'&&method==='GET'){
          const s=session(req);if(!s?.admin)fail(403,'仅管理员可访问。');return reply(res,200,{records:db.prepare("SELECT * FROM records WHERE review_status IN ('pending','approved') ORDER BY CASE review_status WHEN 'pending' THEN 0 ELSE 1 END,updated_at").all().map(r=>view(r,true))});
        }
        const review=path.match(/^\/api\/admin\/records\/([a-f0-9-]{36})$/);
        if(review&&method==='POST'){
          const s=requireUser(req);if(!s.admin)fail(403,'仅管理员可审核。');const data=await body(req);if(!['approved','rejected'].includes(data.status))fail(400,'审核状态无效。');const note=data.note?text(data.note,'审核意见',300):'';if(data.status==='rejected'&&!note)fail(400,'退回时请填写审核意见。');
          const row=db.prepare('SELECT * FROM records WHERE id=?').get(review[1]);if(!row||!['pending','approved'].includes(row.review_status))fail(409,'记录状态已变化，请刷新。');
          db.prepare('UPDATE records SET review_status=?,review_note=?,updated_at=? WHERE id=?').run(data.status,note,new Date().toISOString(),row.id);return reply(res,200,{ok:true});
        }
        if(path==='/api/account'&&method==='DELETE'){
          const s=requireUser(req),data=await body(req),u=db.prepare('SELECT * FROM users WHERE id=?').get(s.id);limited(`delete:${s.id}`,5);const password=text(data.password,'密码',128,10);const digest=await scrypt(password,u.salt,64);if(!timingSafeEqual(digest,Buffer.from(u.password_hash,'hex')))fail(401,'密码错误。');db.prepare('DELETE FROM users WHERE id=?').run(s.id);return reply(res,200,{ok:true},cookieClear);
        }
        fail(404,'接口不存在。');
      }
      if(!['GET','HEAD'].includes(method))fail(405,'不支持的请求方法。');
      // Explicit allowlist prevents accidental exposure of source, database or secrets.
      const allowed=new Map([['/','index.html'],['/index.html','index.html'],['/app.js','app.js'],['/galaxy.js','galaxy.js'],['/demo-data.js','demo-data.js'],['/style.css','style.css'],['/cosmos.css','cosmos.css'],['/favicon.svg','favicon.svg']]);
      const file=allowed.get(path);if(!file)fail(404,'页面不存在。');const content=readFileSync(resolve(root,'dist',file));const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};res.writeHead(200,{'Content-Type':mime[extname(file)],'Cache-Control':'no-cache'});res.end(method==='HEAD'?undefined:content);
    }catch(e){if(!res.headersSent)reply(res,e.status||500,{error:e.status?e.message:'服务暂时不可用，请稍后再试。'});else res.end();if(!e.status)console.error('Acris server error:',e.code||e.name);}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  return {server,db,close:()=>new Promise((resolve,reject)=>{server.close(err=>{clearInterval(cleanup);db.close();err?reject(err):resolve();});})};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.includes('--grant-admin')){
    const email=process.argv[process.argv.indexOf('--grant-admin')+1]?.trim().toLowerCase();if(!email||email.startsWith('--'))throw new Error('Usage: node server.mjs --grant-admin owner@example.com');
    const app=createApp();const result=app.db.prepare('UPDATE users SET admin=1 WHERE email=?').run(email);app.db.close();if(!result.changes)throw new Error('Register this account first.');console.log('Administrator access granted to the existing account.');
  }else{
    const app=createApp();const port=Number(process.env.PORT||3000),host=process.env.HOST||'127.0.0.1';
    app.server.listen(port,host,()=>console.log(`Acris ready: http://${host}:${port}`));
    for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{app.close().finally(()=>process.exit());});
  }
}
