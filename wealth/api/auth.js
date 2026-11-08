import {sql,schema,hash,check,token,cookie,json,body,userFrom} from './_lib.js';
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const accessAllowed = supplied => {
 const expected = process.env.WEALTH_ACCESS_KEY || '';
 return expected.length > 0 && String(supplied || '') === expected;
};
export default async function handler(req,res){
 try {
  await schema();
  const action = new URL(req.url,'https://local').searchParams.get('action');
  if(req.method==='GET'){
   const uid=userFrom(req);
   if(!uid)return json(res,200,{user:null});
   const rows=await sql('SELECT id,email,created_at FROM wealth_users WHERE id=$1',[uid]);
   return json(res,200,{user:rows[0]||null});
  }
  if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
  if(action==='logout'){cookie(res,'');return json(res,200,{ok:true});}
  const data=await body(req);
  const e=String(data.email||'').trim().toLowerCase();
  const p=String(data.password||'');
  if(!validEmail(e))return json(res,400,{error:'Enter a valid email address.'});
  if(action!=='login'&&!accessAllowed(data.secretKey))return json(res,403,{error:'Secret key is incorrect.'});
  if(p.length<10||p.length>200)return json(res,400,{error:'Password must be at least 10 characters.'});
  if(action==='register'){
   const rows=await sql('INSERT INTO wealth_users(email,password_hash) VALUES($1,$2) ON CONFLICT(email) DO NOTHING RETURNING id,email',[e,hash(p)]);
   if(!rows.length)return json(res,409,{error:'An account with this email already exists.'});
   cookie(res,token(rows[0].id));
   return json(res,201,{user:rows[0]});
  }
  if(action==='forgot'){
   const rows=await sql('UPDATE wealth_users SET password_hash=$1 WHERE email=$2 RETURNING id,email',[hash(p),e]);
   if(!rows.length)return json(res,404,{error:'No account was found for that email.'});
   return json(res,200,{ok:true,message:'Password reset. You can now sign in.'});
  }
  if(action==='login'){
   const rows=await sql('SELECT id,email,password_hash FROM wealth_users WHERE email=$1',[e]);
   if(!rows.length||!check(p,rows[0].password_hash))return json(res,401,{error:'Email or password is incorrect.'});
   cookie(res,token(rows[0].id));
   return json(res,200,{user:{id:rows[0].id,email:rows[0].email}});
  }
  return json(res,400,{error:'Unknown action'});
 } catch(e) {
  return json(res,500,{error:'Server configuration or database error.'});
 }
}
