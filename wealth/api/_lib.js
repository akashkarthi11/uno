import { neon } from '@neondatabase/serverless';
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
const dbUrl=process.env.POSTGRES_URL || process.env.WEALTH_DATABASE_URL || process.env.DATABASE_URL;
export const sql=dbUrl ? neon(dbUrl) : null;
export async function schema(){
 if(!sql) throw new Error('WEALTH_DATABASE_URL is not configured');
 await sql`CREATE TABLE IF NOT EXISTS wealth_users(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
 await sql`ALTER TABLE wealth_users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user'`;
 await sql`UPDATE wealth_users SET role='admin' WHERE lower(email)='karthickkeyan303@gmail.com'`;
 await sql`CREATE TABLE IF NOT EXISTS wealth_transactions(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),user_id UUID NOT NULL REFERENCES wealth_users(id) ON DELETE CASCADE,kind TEXT NOT NULL CHECK(kind IN ('income','expense','transfer','investment','liability')),category TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',amount NUMERIC(16,2) NOT NULL CHECK(amount>0),account TEXT NOT NULL DEFAULT '',occurred_on DATE NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
 await sql`CREATE INDEX IF NOT EXISTS wealth_tx_user_date ON wealth_transactions(user_id,occurred_on DESC)`;
 await sql`CREATE TABLE IF NOT EXISTS wealth_snapshots(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),user_id UUID NOT NULL REFERENCES wealth_users(id) ON DELETE CASCADE,source_key TEXT NOT NULL,source_name TEXT NOT NULL,snapshot_date DATE NOT NULL,payload JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(user_id,source_key))`;
}
export function hash(p){const s=randomBytes(16);return 's1$'+s.toString('base64url')+'$'+scryptSync(p,s,64).toString('base64url')}
export function check(p,h){try{const [v,s,x]=h.split('$');if(v!=='s1')return false;const a=Buffer.from(x,'base64url'),b=scryptSync(p,Buffer.from(s,'base64url'),a.length);return a.length===b.length&&timingSafeEqual(a,b)}catch{return false}}
const secret=()=>process.env.WEALTH_SESSION_SECRET||'';
export function token(uid){if(secret().length<32)throw new Error('WEALTH_SESSION_SECRET must be at least 32 characters');const body=Buffer.from(JSON.stringify({uid,exp:Date.now()+7*864e5})).toString('base64url');return body+'.'+createHmac('sha256',secret()).update(body).digest('base64url')}
export function userFrom(req){try{const c=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('wealth_session='));if(!c)return null;const [b,s]=c.slice(15).split('.');const sig=createHmac('sha256',secret()).update(b).digest();const got=Buffer.from(s,'base64url');if(sig.length!==got.length||!timingSafeEqual(sig,got))return null;const p=JSON.parse(Buffer.from(b,'base64url'));return p.exp>Date.now()?p.uid:null}catch{return null}}
export function cookie(res,v){res.setHeader('Set-Cookie',v?'wealth_session='+v+'; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800':'wealth_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0')}
export function json(res,status,data){res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(data))}
export async function body(req){let s='';for await(const c of req)s+=c;if(s.length>20000)throw new Error('Request too large');return JSON.parse(s||'{}')}
