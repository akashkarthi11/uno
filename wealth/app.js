const $=id=>document.getElementById(id);
let mode='login',user=null,items=[];
const money=n=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:2}).format(Number(n||0));
const api=async(url,opt={})=>{const r=await fetch(url,{...opt,headers:{'Content-Type':'application/json',...(opt.headers||{})},credentials:'same-origin'});const d=await r.json();if(!r.ok)throw Error(d.error||'Request failed');return d};
function setMode(m){
 mode=m;
 $('loginTab').classList.toggle('active',m==='login');
 $('registerTab').classList.toggle('active',m==='register');
 $('forgotTab').classList.toggle('active',m==='forgot');
 $('secretWrap').classList.toggle('hidden',m==='login');
 $('authSubmit').textContent=m==='login'?'Sign in securely':m==='register'?'Create private ledger':'Reset password';
 $('password').autocomplete=m==='login'?'current-password':'new-password';
 $('password').placeholder=m==='forgot'?'Enter your new password (10+ characters)':'At least 10 characters';
 $('authMsg').textContent='';
}
$('loginTab').onclick=()=>setMode('login');
$('registerTab').onclick=()=>setMode('register');
$('forgotTab').onclick=()=>setMode('forgot');
$('authForm').onsubmit=async e=>{
 e.preventDefault();$('authMsg').textContent='';
 try{
  const payload={email:$('email').value,password:$('password').value,secretKey:$('secretKey').value};
  const d=await api('/api/auth?action='+mode,{method:'POST',body:JSON.stringify(payload)});
  if(mode==='forgot'){ $('authMsg').textContent='Password reset. You can now sign in.';setMode('login');$('authMsg').textContent='Password reset. Please sign in.';return; }
  user=d.user;await showApp();
 }catch(x){$('authMsg').textContent=x.message}
};
async function showApp(){
 $('auth').classList.add('hidden');$('app').classList.remove('hidden');$('logout').classList.remove('hidden');$('who').textContent=user.email+ (user.role==='admin'?' · OWNER / ADMIN':'');await load();if(user.role==='admin')await loadSnapshot();
}
async function load(){
 const d=await api('/api/ledger');items=d.transactions||[];
 const sum=k=>items.filter(x=>x.kind===k).reduce((a,x)=>a+Number(x.amount),0);
 $('income').textContent=money(sum('income'));$('expense').textContent=money(sum('expense'));$('net').textContent=money(sum('income')-sum('expense'));$('count').textContent=items.length+' entries';
 $('entries').innerHTML=items.length?items.map(x=>{const sign=x.kind==='income'?'+':x.kind==='expense'?'-':'';return '<div class="entry"><div><b>'+esc(x.category)+'</b><small>'+esc(x.description||x.kind)+' · '+esc(x.account||'No account')+' · '+esc(String(x.occurred_on).slice(0,10))+'</small></div><span class="value '+(x.kind==='income'?'income':x.kind==='expense'?'expense':'')+'">'+sign+money(x.amount)+'</span><button class="delete" data-id="'+x.id+'" aria-label="Delete entry">×</button></div>'}).join(''):'<p class="muted">No entries yet. Add your first transaction.</p>';
 $('entries').querySelectorAll('.delete').forEach(b=>b.onclick=async()=>{if(confirm('Delete this ledger entry?')){await api('/api/ledger?id='+encodeURIComponent(b.dataset.id),{method:'DELETE'});await load()}});
}

async function loadSnapshot(){
 const panel=$('snapshotPanel');panel.classList.remove('hidden');
 try{
  let d=await api('/api/snapshot');
  if(!d.snapshot){$('snapshotStatus').textContent='Importing source…';await api('/api/snapshot',{method:'POST',body:'{}'});d=await api('/api/snapshot')}
  const snap=d.snapshot?.payload;
  if(!snap){$('snapshotStatus').textContent='Not imported';return}
  $('snapshotStatus').textContent='Saved in database · '+snap.snapshotDate;
  $('snapshotContent').innerHTML=snap.sections.map((s,i)=>{
   const tables=(s.tables||[]).map(rows=>'<div class="snapshot-table-wrap"><table class="snapshot-table"><tbody>'+rows.map((r,ri)=>'<tr>'+r.map(cell=>ri===0?'<th>'+esc(cell)+'</th>':'<td>'+esc(cell)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>').join('');
   const notes=(s.notes||[]).map(n=>'<li>'+esc(n)+'</li>').join('');
   return '<details class="snapshot-section" '+(i<5?'open':'')+'><summary>'+esc(s.heading)+'</summary>'+tables+(notes?'<ul class="snapshot-notes">'+notes+'</ul>':'')+'</details>';
  }).join('');
 }catch(e){$('snapshotStatus').textContent='Import error';$('snapshotContent').innerHTML='<p class="message">'+esc(e.message)+'</p>'}
}

function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
$('logout').onclick=async()=>{await api('/api/auth?action=logout',{method:'POST',body:'{}'});location.reload()};
$('addToggle').onclick=()=>{$('txForm').classList.remove('hidden');$('date').value=new Date().toISOString().slice(0,10)};
$('cancel').onclick=()=>$('txForm').classList.add('hidden');
$('txForm').onsubmit=async e=>{e.preventDefault();$('txMsg').textContent='';try{await api('/api/ledger',{method:'POST',body:JSON.stringify({kind:$('kind').value,amount:$('amount').value,category:$('category').value,account:$('account').value,date:$('date').value,description:$('description').value})});e.target.reset();$('txForm').classList.add('hidden');await load()}catch(x){$('txMsg').textContent=x.message}};
(async()=>{try{const d=await api('/api/auth');if(d.user){user=d.user;await showApp()}}catch(e){$('globalMsg').textContent='Service is not configured yet.'}})();
