import {sql,schema,json,body,userFrom} from './_lib.js';
export default async function handler(req,res){
 try{await schema();const uid=userFrom(req);if(!uid)return json(res,401,{error:'Sign in required'});
 if(req.method==='GET'){const rows=await sql('SELECT id,kind,category,description,amount,account,occurred_on FROM wealth_transactions WHERE user_id=$1 ORDER BY occurred_on DESC,created_at DESC LIMIT 500',[uid]);return json(res,200,{transactions:rows})}
 if(req.method==='POST'){const b=await body(req);const kind=String(b.kind||'');const category=String(b.category||'').slice(0,60);const description=String(b.description||'').slice(0,180);const account=String(b.account||'').slice(0,80);const amount=Number(b.amount);const date=String(b.date||'');if(!['income','expense','transfer','investment','liability'].includes(kind)||!category||!Number.isFinite(amount)||amount<=0||amount>1e12||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date))return json(res,400,{error:'Invalid transaction details'});const rows=await sql('INSERT INTO wealth_transactions(user_id,kind,category,description,amount,account,occurred_on) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,kind,category,description,amount,account,occurred_on',[uid,kind,category,description,amount,account,date]);return json(res,201,{transaction:rows[0]})}
 if(req.method==='DELETE'){const id=new URL(req.url,'https://local').searchParams.get('id');if(!id)return json(res,400,{error:'Transaction id required'});const rows=await sql('DELETE FROM wealth_transactions WHERE id=$1 AND user_id=$2 RETURNING id',[id,uid]);return json(res,200,{deleted:rows.length===1})}
 return json(res,405,{error:'Method not allowed'});
 }catch(e){return json(res,500,{error:'Unable to access ledger.'})}
}
