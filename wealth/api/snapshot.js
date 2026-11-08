import {sql,schema,json,userFrom} from './_lib.js';
import snapshot from '../snapshot-data.js';
export default async function handler(req,res){
 try{
  await schema();
  const uid=userFrom(req);
  if(!uid)return json(res,401,{error:'Sign in required'});
  const users=await sql.query('SELECT role FROM wealth_users WHERE id=$1',[uid]);
  if(!users.length||users[0].role!=='admin')return json(res,403,{error:'Owner admin only'});
  if(req.method==='GET'){
   const rows=await sql.query('SELECT id,source_name,snapshot_date,payload,created_at FROM wealth_snapshots WHERE user_id=$1 AND source_key=$2',[uid,'wealth-ledger-2026-11-07']);
   return json(res,200,{snapshot:rows[0]||null});
  }
  if(req.method==='POST'){
   const rows=await sql.query('INSERT INTO wealth_snapshots(user_id,source_key,source_name,snapshot_date,payload) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(user_id,source_key) DO UPDATE SET source_name=EXCLUDED.source_name,snapshot_date=EXCLUDED.snapshot_date,payload=EXCLUDED.payload RETURNING id,source_name,snapshot_date,created_at',[uid,'wealth-ledger-2026-11-07',snapshot.source,snapshot.snapshotDate,JSON.stringify(snapshot)]);
   return json(res,200,{ok:true,snapshot:rows[0],sections:snapshot.sections.length});
  }
  return json(res,405,{error:'Method not allowed'});
 }catch(e){console.error('[wealth-snapshot]',e?.message||e);return json(res,500,{error:'Unable to import wealth snapshot.'})}
}
