import {sql,schema,hash,check,token,cookie,json,body,userFrom} from './_lib.js';
export default async function handler(req,res){
 try{await schema();const action=new URL(req.url,'https://local').searchParams.get('action');
 if(req.method==='GET'){const uid=userFrom(req);if(!uid)return json(res,200,{user:null});const rows=await sql('SELECT id,email,created_at FROM wealth_users WHERE id=$1',[uid]);return json(res,200,{user:rows[0]||null})}
 if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
 if(action==='logout'){cookie(res,'');return json(res,200,{ok:true})}
 const {email,password}=await body(req);const e=String(email||'').trim().toLowerCase();const p=String(password||'');
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)||p.length<10||p.length>200)return json(res,400,{error:'Use a valid email and password of at least 10 characters.'});
 if(action==='register'){const rows=await sql('INSERT INTO wealth_users(email,password_hash) VALUES($1,$2) ON CONFLICT(email) DO NOTHING RETURNING id,email',[e,hash(p)]);if(!rows.length)return json(res,409,{error:'An account with this email already exists.'});cookie(res,token(rows[0].id));return json(res,201,{user:rows[0]})}
 if(action==='login'){const rows=await sql('SELECT id,email,password_hash FROM wealth_users WHERE email=$1',[e]);if(!rows.length||!check(p,rows[0].password_hash))return json(res,401,{error:'Email or password is incorrect.'});cookie(res,token(rows[0].id));return json(res,200,{user:{id:rows[0].id,email:rows[0].email}})}
 return json(res,400,{error:'Unknown action'});
 }catch(e){return json(res,500,{error:'Server configuration or database error.'})}
}
