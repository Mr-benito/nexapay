/* ethers est chargé par ethers.umd.min.js (script classique) : fonctionne aussi en ouvrant index.html directement */
window.__nexa = true;

/* Serveur du fournisseur (Render). Laisser vide pour travailler sans serveur.
   Exemple : "https://wifi-channel-server.onrender.com" */
const SERVER_URL = "";
async function pushReceipt(ch) {
  if(!SERVER_URL)return;
  try{
    const r=await fetch(`${SERVER_URL}/receipt`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({channelId:ch.id,cumulativeAmount:ch.cumulativeWei,signature:ch.signature})});
    const d=await r.json();
    record(r.ok?"Reçu accepté par le serveur":"Reçu refusé par le serveur",r.ok?`Cumul ${fmtEth(ch.cumulative)} · accès prolongé`:(d.error||r.status));
  }catch(e){log(`Serveur injoignable : ${e.message}`);}
}
async function restoreFromServer(ch) {
  if(!SERVER_URL||ch.signature)return;
  try{
    const r=await fetch(`${SERVER_URL}/receipt/${ch.id}`);
    if(!r.ok)return;
    const d=await r.json();
    ch.cumulativeWei=d.cumulativeAmount;ch.signature=d.signature;ch.cumulative=Number(ethers.formatEther(d.cumulativeAmount));
    saveChannels();log("Dernier reçu récupéré depuis le serveur du fournisseur.");
  }catch(e){log(`Serveur : ${e.message}`);}
}

/*
 * NexaPay academic prototype.
 * Important: the EIP-712 laboratory schema below is a teaching example.
 * It must match the deployed Solidity contract before signatures can settle funds.
 */

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = "nexapay-academic-v1";
const DEFAULT_CHAIN_ID = 11155111n;

const CONTRACT_DEFAULT = "0x34E54c08b0F1e0d2a3f50Eef449cf4b90A6C4c86";
const PAYEE_DEFAULT = "0xA32C0d77f35BB2b8ff80AC57761A10ECf1ccbE62";
// ABI et schéma EIP-712 du contrat réellement déployé (identiques à la version qui fonctionnait)
const ABI = [
  "function openChannel(address payee) external payable returns (bytes32)",
  "function closeCooperative(bytes32 channelId, uint256 cumulativeAmount, bytes calldata signature) external",
  "function channels(bytes32) external view returns (address payer, address payee, uint256 deposit, uint256 withdrawn, uint256 disputeDeadline, bool closed)",
  "function startUnilateralClose(bytes32 channelId) external",
  "function disputeWithSignature(bytes32 channelId, uint256 cumulativeAmount, bytes calldata signature) external",
  "function finalizeUnilateralClose(bytes32 channelId) external",
  "event ChannelOpened(bytes32 indexed channelId, address payer, address payee, uint256 deposit)"
];

let provider = null;
let signer = null;
let contract = null;
let userAddress = null;
let currentChannelId = null;
let lastLab = null;
let wifiInterval = null;
let wifiStart = null;
let wifiMinutesSigned = 0;
let wifiDemoMode = false;
let sessionActive = false;
let currentSessionCost = 0;

const state = loadState();
if(!state.settings.payee) state.settings.payee=PAYEE_DEFAULT;
if(!state.settings.contractAddress) state.settings.contractAddress=CONTRACT_DEFAULT;

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return {
      events: Array.isArray(s.events) ? s.events : [],
      channels: Array.isArray(s.channels) ? s.channels : [],
      signatures: Number(s.signatures || 0),
      fees: s.fees || {},
      totalSigned: Number(s.totalSigned || 0),
      provider: s.provider || {name:"NexaPay Guest Wi-Fi", rate:0.001},
      settings: s.settings || {contractAddress:CONTRACT_DEFAULT, chainId:"11155111", payee:PAYEE_DEFAULT}
    };
  } catch {
    return {events:[],channels:[],signatures:0,fees:{},totalSigned:0,provider:{name:"NexaPay Guest Wi-Fi",rate:0.001},settings:{contractAddress:CONTRACT_DEFAULT,chainId:"11155111",payee:PAYEE_DEFAULT}};
  }
}
function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
function shortAddress(s) {
  return s && s.length > 13 ? `${s.slice(0,6)}…${s.slice(-4)}` : (s || "—");
}
function fmtEth(n, digits=6) {
  return `${Number(n || 0).toLocaleString("fr-FR",{maximumFractionDigits:digits,minimumFractionDigits:0})} ETH`;
}
function toast(message, error=false) {
  const el = document.createElement("div");
  el.className = `toast${error ? " error" : ""}`;
  el.textContent = message;
  $("toast-region").appendChild(el);
  setTimeout(() => el.remove(), 4200);
}
function log(message) {
  const now = new Date().toLocaleTimeString("fr-FR");
  const line = `[${now}] ${message}`;
  const box = $("console-log");
  box.textContent = `${box.textContent}\n${line}`.trim().split("\n").slice(-90).join("\n");
  box.scrollTop = box.scrollHeight;
}
function record(type, detail, txHash="") {
  state.events.unshift({id:crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,type,detail,txHash,time:new Date().toISOString()});
  state.events = state.events.slice(0,500);
  persist();
  renderHistory();
  renderActivity();
  updateStats();
}
function showModal(title, message) {
  $("modal-title").textContent = title;
  $("modal-message").textContent = message;
  $("modal-backdrop").classList.add("show");
}
function saveChannels() {
  persist();
  renderChannels();
  updateStats();
}
function getCurrentChannel() {
  return state.channels.find(c => c.id === currentChannelId) || state.channels.find(c => c.status === "open") || null;
}
function setCurrentChannel(id) {
  currentChannelId = id;
  const ch = state.channels.find(c => c.id === id);
  if (ch) {
    $("payee-address").value = ch.payee || "";
    $("channel-id").textContent = ch.id;
    $("channel-deposit").textContent = fmtEth(ch.deposit);
    $("channel-cumulative").textContent = fmtEth(ch.cumulative || 0);
    $("channel-remaining").textContent = fmtEth(Math.max(0,(ch.deposit||0)-(ch.cumulative||0)));
    $("channel-minutes").textContent = ch.minutes || 0;
    $("channel-state-chip").textContent = ch.status === "open" ? "Ouvert" : "Fermé";
    $("channel-state-chip").className = `status-chip ${ch.status}`;
    $("close-channel-btn").disabled = ch.status !== "open" || !ch.signature;
    $("lab-channel-id").value = ch.id;
  }
  renderChannels();
}
function totalSigned() { return state.channels.reduce((a,c)=>a+(c.cumulative||0),0); }
function setBadge(ok) {
  $("badge-state").textContent = ok===null ? "En attente de signature" : ok ? "Signature valide (vérifiée localement)" : "Signature invalide";
  $("badge-mark").textContent = ok===null ? "…" : ok ? "✓" : "✗";
}
function updateStats() {
  $("ana-measured-btn").disabled = !state.fees.open;
  const openCount = state.channels.filter(c=>c.status==="open").length;
  $("stat-channels").textContent = openCount;
  $("stat-paid").textContent = totalSigned().toLocaleString("fr-FR",{maximumFractionDigits:6});
  $("stat-signatures").textContent = state.signatures;
  const classic = Number($("ana-count")?.value || 100) * Number($("ana-direct")?.value || 0.00002);
  const channelCost = Number($("ana-open")?.value || 0.00008) + Number($("ana-settle")?.value || 0.00006);
  const savings = classic-channelCost;
  $("stat-savings").textContent = Math.max(0,savings).toLocaleString("fr-FR",{maximumFractionDigits:6});
  $("hero-savings").textContent = `${Math.max(0,savings).toLocaleString("fr-FR",{maximumFractionDigits:5})} ETH`;
  $("provider-sessions").textContent = state.events.filter(e=>e.type.includes("session")).length;
  $("provider-revenue").textContent = totalSigned().toLocaleString("fr-FR",{maximumFractionDigits:6});
  $("provider-active").textContent = sessionActive ? "1" : "0";
  $("provider-status").textContent = sessionActive ? "Session active" : "En attente";
}
function renderActivity() {
  const root = $("overview-activity");
  const items = state.events.slice(0,5);
  if (!items.length) {
    root.innerHTML = '<div class="empty-state"><div class="empty-symbol">⌁</div><strong>Aucune activité pour le moment</strong><p>Connecte un portefeuille ou lance une démonstration pour commencer.</p></div>';
    return;
  }
  root.replaceChildren();
  for (const e of items) {
    const row = document.createElement("div"); row.className="activity-row";
    const icon = document.createElement("div"); icon.className="activity-icon"; icon.textContent = e.type.includes("signature") ? "⌘" : e.type.includes("canal") ? "◈" : "↗";
    const text = document.createElement("div"); text.className="activity-text";
    const title = document.createElement("strong"); title.textContent=e.type;
    const desc = document.createElement("small"); desc.textContent=e.detail;
    text.append(title,desc);
    const time=document.createElement("span");time.className="activity-time";time.textContent=new Date(e.time).toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"});
    row.append(icon,text,time);root.append(row);
  }
}
function renderChannels() {
  const body=$("channels-table");
  body.replaceChildren();
  if (!state.channels.length) {
    const tr=document.createElement("tr");tr.innerHTML='<td colspan="5" class="table-empty">Aucun canal enregistré.</td>';body.append(tr);return;
  }
  for(const ch of state.channels) {
    const tr=document.createElement("tr");
    const vals=[shortAddress(ch.id),shortAddress(ch.payee),fmtEth(ch.deposit,5)];
    for(const val of vals){const td=document.createElement("td");td.textContent=val;tr.append(td);}
    const status=document.createElement("td");const badge=document.createElement("span");badge.className=`table-status ${ch.status==="open"?"":"closed"}`;badge.textContent=ch.status==="open"?"Ouvert":"Fermé";status.append(badge);tr.append(status);
    const action=document.createElement("td");const btn=document.createElement("button");btn.className="table-action";btn.textContent="Sélectionner";btn.addEventListener("click",()=>setCurrentChannel(ch.id));action.append(btn);tr.append(action);
    body.append(tr);
  }
}
function renderHistory() {
  const body=$("history-table");body.replaceChildren();
  if(!state.events.length){const tr=document.createElement("tr");tr.innerHTML='<td colspan="4" class="table-empty">Aucun événement enregistré.</td>';body.append(tr);return;}
  for(const e of state.events.slice(0,100)){
    const tr=document.createElement("tr");
    [e.type,e.detail,new Date(e.time).toLocaleString("fr-FR"),e.txHash?shortAddress(e.txHash):"Local"].forEach(v=>{const td=document.createElement("td");td.textContent=v;tr.append(td);});
    body.append(tr);
  }
}
function navigate(page) {
  document.querySelectorAll(".page").forEach(p=>p.classList.toggle("active",p.id===`page-${page}`));
  document.querySelectorAll(".nav-item[data-page]").forEach(b=>b.classList.toggle("active",b.dataset.page===page));
  const active=document.querySelector(`.nav-item[data-page="${page}"]`);
  $("page-title").textContent=active ? active.textContent.trim() : "Vue d'ensemble";
  $("sidebar").classList.remove("open");
  window.scrollTo({top:0,behavior:"smooth"});
}
document.querySelectorAll(".nav-item[data-page]").forEach(b=>b.addEventListener("click",()=>navigate(b.dataset.page)));
document.querySelectorAll("[data-go]").forEach(b=>b.addEventListener("click",()=>navigate(b.dataset.go)));
$("mobile-menu").addEventListener("click",()=>$("sidebar").classList.toggle("open"));
$("help-btn").addEventListener("click",()=>showModal("À propos de NexaPay","NexaPay est un prototype académique de micropaiements par canaux. Les signatures EIP-712 sont hors chaîne ; le dépôt, l'ouverture et le règlement sont des opérations blockchain. Le mode démonstration n'exécute aucune transaction."));
$("modal-close").addEventListener("click",()=>$("modal-backdrop").classList.remove("show"));
$("modal-ok").addEventListener("click",()=>$("modal-backdrop").classList.remove("show"));
$("modal-backdrop").addEventListener("click",e=>{if(e.target===$("modal-backdrop"))$("modal-backdrop").classList.remove("show");});

let balanceTimer=null;
async function refreshBalance() {
  if(!provider||!userAddress)return;
  try{
    const b=ethers.formatEther(await provider.getBalance(userAddress));
    const txt=`${Number(b).toFixed(4)} ETH`;
    $("profile-address").textContent=shortAddress(userAddress);
    $("profile-address").nextElementSibling.textContent=`Solde : ${txt}`;
    $("connect-btn").innerHTML=`◇ ${shortAddress(userAddress)} · ${txt}`;
  }catch(e){log(`Solde : ${e.message}`);}
  if(!balanceTimer)balanceTimer=setInterval(refreshBalance,10000);
}
async function connectWallet() {
  if(!window.ethereum){showModal("MetaMask requis","Installe MetaMask dans ton navigateur, puis recharge la page. Tu peux aussi utiliser le mode démonstration pour explorer l'interface.");return;}
  try {
    toast("Regarde la fenêtre MetaMask : une autorisation est demandée.");
    const accounts=await window.ethereum.request({method:"eth_requestAccounts"});
    if(!accounts.length) throw new Error("Aucun compte autorisé.");
    userAddress=accounts[0];
    provider=new ethers.BrowserProvider(window.ethereum);
    signer=await provider.getSigner();
    const network=await provider.getNetwork();
    const expected=BigInt(state.settings.chainId || DEFAULT_CHAIN_ID);
    if(network.chainId!==expected) {
      try{await window.ethereum.request({method:"wallet_switchEthereumChain",params:[{chainId:"0x"+expected.toString(16)}]});location.reload();return;}catch{}
      toast(`Mauvais réseau. Chain ID attendu : ${expected}.`,true);
      $("network-label").textContent=`Mauvais réseau (${network.chainId})`;
      return;
    }
    const ca=state.settings.contractAddress.trim();
    if(ca && ethers.isAddress(ca)) contract=new ethers.Contract(ca,ABI,signer);
    $("connect-btn").innerHTML=`◇ ${shortAddress(userAddress)}`;
    refreshBalance();
    $("network-label").textContent="Portefeuille connecté";
    $("connect-btn").classList.add("connected");
    toast(`Portefeuille connecté : ${shortAddress(userAddress)}`);
    record("Portefeuille connecté",`${userAddress} sur chain ID ${network.chainId}`);
    if(window.ethereum.on) {
      window.ethereum.on("accountsChanged",()=>location.reload());
      window.ethereum.on("chainChanged",()=>location.reload());
    }
    log(`Wallet connecté : ${userAddress}`);
    try{const c=requireContract();for(const ch of state.channels.filter(x=>x.status==="open")){const r=await c.channels(ch.id);if(r.closed)ch.status="closed";}saveChannels();const oc=getCurrentChannel();if(oc)setCurrentChannel(oc.id);}catch(e){log(`Synchronisation : ${e.message}`);}
  } catch(e) { log(`Erreur wallet : ${e.message}`);toast(e.code===-32002?"Une demande est déjà en attente : clique sur l'icône MetaMask de ton navigateur pour la valider.":(e.shortMessage||e.message||"Connexion refusée."),true); }
}
$("connect-btn").addEventListener("click",connectWallet);

function requireContract() {
  if(!signer || !provider || !userAddress) throw new Error("Connecte d'abord MetaMask sur Sepolia.");
  const address=state.settings.contractAddress.trim();
  if(!address || !ethers.isAddress(address)) throw new Error("Configure une adresse de contrat valide dans Configuration.");
  if(!contract) contract=new ethers.Contract(address,ABI,signer);
  return contract;
}
async function openChannel() {
  try {
    const c=requireContract();
    const payee=$("payee-address").value.trim() || state.settings.payee;
    if(!ethers.isAddress(payee)) throw new Error("Saisis une adresse fournisseur valide.");
    const amount=Number($("deposit-amount").value);
    if(!Number.isFinite(amount)||amount<=0) throw new Error("Le dépôt doit être supérieur à zéro.");
    const deposit=ethers.parseEther(String(amount));
    toast("Confirme l'ouverture dans MetaMask.");
    const tx=await c.openChannel(payee,{value:deposit});
    log(`Ouverture envoyée : ${tx.hash}`);
    toast("Transaction envoyée. Attente de confirmation…");
    const receipt=await tx.wait();
    state.fees.open={gas:receipt.gasUsed.toString(),price:receipt.gasPrice.toString()};persist();
    let parsed=null;
    for(const l of receipt.logs){try{const e=c.interface.parseLog(l);if(e?.name==="ChannelOpened"){parsed=e;break;}}catch{}}
    if(!parsed) throw new Error("Transaction confirmée, mais événement ChannelOpened introuvable. Vérifie l'ABI et le contrat.");
    if(parsed.args.payee.toLowerCase()!==payee.toLowerCase()) throw new Error("Le bénéficiaire de l'événement ne correspond pas.");
    const id=parsed.args.channelId;
    currentChannelId=id;
    const ch={id,payer:parsed.args.payer,payee:parsed.args.payee,deposit:Number(ethers.formatEther(parsed.args.deposit)),cumulative:0,minutes:0,status:"open",signature:null,createdAt:new Date().toISOString(),txHash:tx.hash};
    state.channels.unshift(ch);saveChannels();setCurrentChannel(id);
    record("Canal ouvert",`Canal ${shortAddress(id)} · dépôt ${fmtEth(ch.deposit)}`,tx.hash);
    toast("Canal ouvert et confirmé.");
    log(`Canal ouvert : ${id}`);
  } catch(e){log(`Erreur ouverture : ${e.message}`);toast(e.shortMessage||e.message||"Impossible d'ouvrir le canal.",true);}
}
$("open-channel-btn").addEventListener("click",openChannel);
$("refresh-channel-btn").addEventListener("click",async()=>{
  try{
    const ch=getCurrentChannel();if(!ch)throw new Error("Aucun canal sélectionné.");
    if(contract){const row=await contract.channels(ch.id);ch.deposit=Number(ethers.formatEther(row.deposit));ch.status=row.closed?"closed":"open";ch.disputeDeadline=Number(row.disputeDeadline);saveChannels();setCurrentChannel(ch.id);toast("État relu depuis le contrat.");}
    else {setCurrentChannel(ch.id);toast("État local actualisé. Configure le contrat pour une lecture on-chain.");}
  }catch(e){toast(e.message,true);}
});
$("close-channel-btn").addEventListener("click",async()=>{
  try{
    const c=requireContract();const ch=getCurrentChannel();
    if(!ch || ch.status!=="open")throw new Error("Aucun canal ouvert.");
    if(ch.payee.toLowerCase()!==userAddress.toLowerCase())throw new Error("Seul le fournisseur peut régler avec un reçu : choisis le compte fournisseur dans MetaMask.");
    await restoreFromServer(ch);
    if(!ch.signature)throw new Error("Aucune signature de paiement stockée. Utilise d'abord le laboratoire ou une session configurée avec le schéma du contrat.");
    if(ch.cumulativeWei === undefined) {
      throw new Error("Aucune preuve signée pour ce canal : signe au moins une minute.");
    }
    if(sessionActive)stopWifi();
    const tx=await c.closeCooperative(ch.id,ch.cumulativeWei,ch.signature);
    log(`Fermeture envoyée : ${tx.hash}`);const rc=await tx.wait();
    state.fees.close={gas:rc.gasUsed.toString(),price:rc.gasPrice.toString()};persist();
    ch.status="closed";saveChannels();setCurrentChannel(ch.id);
    record("Canal fermé",`Fermeture coopérative ${shortAddress(ch.id)}`,tx.hash);toast("Fermeture confirmée.");
  }catch(e){toast(e.shortMessage||e.message||"Échec de fermeture.",true);log(`Fermeture : ${e.message}`);}
});

function getDomain() {
  const a=state.settings.contractAddress;
  if(!a||!ethers.isAddress(a)) throw new Error("Configure l'adresse du contrat avant de signer.");
  return {name:"WiFiPaymentChannel",version:"1",chainId:BigInt(state.settings.chainId||11155111),verifyingContract:a};
}
function labTypes() {
  return {Payment:[{name:"channelId",type:"bytes32"},{name:"cumulativeAmount",type:"uint256"}]};
}
function makeLabValue() {
  const channelId=$("lab-channel-id").value.trim();
  if(!/^0x[0-9a-fA-F]{64}$/.test(channelId)) throw new Error("L'identifiant doit être un bytes32 (0x + 64 caractères hexadécimaux).");
  const amount=Number($("lab-amount").value);
  if(!Number.isFinite(amount)||amount<0)throw new Error("Montant invalide.");
  return {channelId,cumulativeAmount:ethers.parseEther(String(amount)).toString()};
}
const minuteMs=()=>Number($("wifi-speed").value)||60000;
let paying=false;
// Signature d'une minute supplémentaire : le montant est cumulatif et ne dépasse jamais le dépôt.
async function signMinute() {
  const ch=getCurrentChannel();
  if(!ch||!signer||ch.status!=="open"){toast("Connecte MetaMask et sélectionne un canal ouvert.",true);return false;}
  try{
    ch.rate=ch.rate||Number($("wifi-rate").value)||0.001;
    const next=(ch.minutes||0)+1;
    const amount=ethers.parseEther(String(ch.rate))*BigInt(next);
    if(amount>ethers.parseEther(String(ch.deposit))){toast("Dépôt épuisé : signature refusée.",true);return false;}
    const domain=getDomain(),types=labTypes(),value={channelId:ch.id,cumulativeAmount:amount.toString()};
    const signature=await signer.signTypedData(domain,types,value);
    if(ethers.verifyTypedData(domain,types,value,signature).toLowerCase()!==userAddress.toLowerCase()) throw new Error("Signature locale invalide.");
    Object.assign(ch,{minutes:next,cumulativeWei:amount.toString(),cumulative:Number(ethers.formatEther(amount)),signature});
    state.signatures++;saveChannels();setCurrentChannel(ch.id);setBadge(true);
    record("Signature EIP-712 créée",`Minute ${next} · cumul ${fmtEth(ch.cumulative)} (0 gaz)`);
    pushReceipt(ch);
    return true;
  }catch(e){toast(e.shortMessage||e.message||"Signature annulée.",true);log(`Signature : ${e.message}`);return false;}
}
$("ana-measured-btn").addEventListener("click",()=>{
  const f=state.fees,gp=BigInt(f.open.price);
  $("ana-open").value=ethers.formatEther(BigInt(f.open.gas)*gp);
  if(f.close)$("ana-settle").value=ethers.formatEther(BigInt(f.close.gas)*BigInt(f.close.price));
  $("ana-direct").value=ethers.formatEther(21000n*gp);
  updateAnalytics();record("Analyse des coûts","Frais mesurés sur Sepolia appliqués");toast("Frais mesurés appliqués.");
});
$("lab-sign-btn").addEventListener("click",async()=>{
  try{
    if(!signer)throw new Error("Connecte MetaMask avant de signer.");
    const domain=getDomain();const value=makeLabValue();const types=labTypes();
    const signature=await signer.signTypedData(domain,types,value);
    const hash=ethers.TypedDataEncoder.hash(domain,types,value);
    lastLab={domain,types,value,signature,hash};
    const linkedChannel=state.channels.find(ch=>ch.id.toLowerCase()===value.channelId.toLowerCase() && ch.status==="open");
    if(linkedChannel && BigInt(value.cumulativeAmount)>BigInt(linkedChannel.cumulativeWei||0) && BigInt(value.cumulativeAmount)<=ethers.parseEther(String(linkedChannel.deposit))) {
      linkedChannel.cumulativeWei=BigInt(value.cumulativeAmount).toString();
      linkedChannel.cumulative=Number(ethers.formatEther(value.cumulativeAmount));
                  linkedChannel.signature=signature;
      linkedChannel.minutes=Math.floor(linkedChannel.cumulative / Math.max(Number($("wifi-rate").value)||0.001,0.000000001));
      saveChannels();
      setCurrentChannel(linkedChannel.id);
      $("channel-note").textContent="Cette preuve est liée au canal et utilisera le schéma du contrat.";
    }
    $("lab-signer").textContent=userAddress;$("lab-signature").textContent=signature;$("lab-hash").textContent=hash;
    $("lab-verify").textContent="Signature créée";$("lab-verify").className="verify-ok";
    $("lab-verify-btn").disabled=false;$("lab-tamper-btn").disabled=false;
    state.signatures++;persist();updateStats();
    record("Signature EIP-712 créée",`Montant cumulé ${fmtEth(ethers.formatEther(value.cumulativeAmount))}`);
    log(`Signature EIP-712 créée ; hash ${hash}`);
  }catch(e){toast(e.shortMessage||e.message||"Signature impossible.",true);log(`Laboratoire : ${e.message}`);}
});
$("lab-verify-btn").addEventListener("click",()=>{
  try{
    if(!lastLab)throw new Error("Aucune signature à vérifier.");
    const recovered=ethers.verifyTypedData(lastLab.domain,lastLab.types,lastLab.value,lastLab.signature);
    const ok=recovered.toLowerCase()===userAddress.toLowerCase();
    $("lab-verify").textContent=ok?`Valide · ${shortAddress(recovered)}`:`Invalide · ${shortAddress(recovered)}`;
    $("lab-verify").className=ok?"verify-ok":"verify-bad";
    setBadge(ok);record("Vérification EIP-712",ok?"Signature valide":"Adresse récupérée différente du compte connecté");
    toast(ok?"Signature valide.":"Signature invalide.",!ok);
  }catch(e){toast(e.message,true);}
});
$("lab-tamper-btn").addEventListener("click",()=>{
  if(!lastLab)return;
  const tampered={...lastLab.value,cumulativeAmount:(BigInt(lastLab.value.cumulativeAmount)+1n).toString()};
  const recovered=ethers.verifyTypedData(lastLab.domain,lastLab.types,tampered,lastLab.signature);
  const ok=recovered.toLowerCase()===userAddress?.toLowerCase();
  $("lab-verify").textContent=ok?"ATTENTION : vérification inattendue":"Modification détectée — signature non valide";
  $("lab-verify").className=ok?"verify-bad":"verify-ok";
  record("Test de modification",ok?"Échec du test pédagogique":"Signature rejetée après modification du montant");
  toast(ok?"Le test nécessite une investigation.":"La modification change le message signé.",ok);
});

function updateAnalytics() {
  const n=Math.max(1,Number($("ana-count").value)||1);
  const direct=Math.max(0,Number($("ana-direct").value)||0);
  const open=Math.max(0,Number($("ana-open").value)||0);
  const settle=Math.max(0,Number($("ana-settle").value)||0);
  const classic=n*direct, channel=open+settle, saving=classic-channel;
  const breakEven=direct>0?Math.ceil(channel/direct):Infinity;
  $("ana-classic-result").innerHTML=`${classic.toLocaleString("fr-FR",{maximumFractionDigits:8})} <small>ETH</small>`;
  $("ana-channel-result").innerHTML=`${channel.toLocaleString("fr-FR",{maximumFractionDigits:8})} <small>ETH</small>`;
  $("ana-saving-result").innerHTML=`${saving.toLocaleString("fr-FR",{maximumFractionDigits:8})} <small>ETH</small>`;
  $("ana-percent-result").textContent=classic>0?`${(saving/classic*100).toLocaleString("fr-FR",{maximumFractionDigits:1})}% d'économie estimée`:"Aucun frais direct pour calculer un pourcentage";
  $("ana-break-even").textContent=Number.isFinite(breakEven)?breakEven.toLocaleString("fr-FR"):"—";
  $("bar-classic-label").textContent=fmtEth(classic,8);$("bar-channel-label").textContent=fmtEth(channel,8);
  const max=Math.max(classic,channel,0.0000001);
  $("bar-classic").style.width=`${Math.max(1,classic/max*100)}%`;
  $("bar-channel").style.width=`${Math.max(1,channel/max*100)}%`;
  updateStats();
}
$("run-analysis").addEventListener("click",()=>{updateAnalytics();record("Analyse des coûts",`N=${$("ana-count").value} ; modèle de frais mis à jour`);toast("Comparaison recalculée.");});
["ana-count","ana-direct","ana-open","ana-settle"].forEach(id=>$(id).addEventListener("input",updateAnalytics));

function setWifiUi() {
  const mins=Math.floor((Date.now()-wifiStart)/60000);
  const secs=Math.floor(((Date.now()-wifiStart)%60000)/1000);
  $("wifi-timer").textContent=`${String(mins).padStart(2,"0")}:${String(secs).padStart(2,"0")}`;
  $("wifi-minutes").textContent=`${wifiMinutesSigned} min`;
  $("wifi-cost").textContent=fmtEth(currentSessionCost);
  const ch=getCurrentChannel();
  $("wifi-balance").textContent=ch?fmtEth(Math.max(0,ch.deposit-(ch.cumulative||0))):"— ETH";
  $("wifi-progress").style.width=`${Math.min(100,(secs/60)*100)}%`;
}
async function startWifi(demo=false) {
  if(sessionActive)return;
  if(!demo && !getCurrentChannel()) {toast("Ouvre ou sélectionne un canal avant de démarrer.",true);navigate("channels");return;}
  wifiDemoMode=demo;sessionActive=true;wifiStart=Date.now();wifiMinutesSigned=0;currentSessionCost=0;
  $("wifi-session-state").textContent=demo?"Démo en cours":"Session en cours";
  $("wifi-session-subtitle").textContent=demo?"Aucune transaction ni signature réelle ne sera produite.":"Une signature EIP-712 est demandée à chaque minute (aucun gaz).";
  $("wifi-start-btn").disabled=true;$("wifi-stop-btn").disabled=false;
  record("session démarrée",demo?"Session Wi-Fi de démonstration":"Session Wi-Fi liée à un canal sélectionné");
  log(`Session Wi-Fi démarrée (${demo?"démo":"canal"}).`);
  if(!demo){
    if(!(await signMinute())){stopWifi();return;}
    wifiMinutesSigned=1;currentSessionCost=getCurrentChannel().cumulative;setWifiUi();
  }
  wifiInterval=setInterval(async()=>{
    setWifiUi();
    const elapsed=Math.floor((Date.now()-wifiStart)/minuteMs());
    if(elapsed>wifiMinutesSigned-(wifiDemoMode?0:1)) {
      // Demo mode only auto-advances the visual timer; live mode requires a matching
      // Solidity EIP-712 schema and an explicit signature workflow.
      if(wifiDemoMode) {
        wifiMinutesSigned=elapsed;
        currentSessionCost=wifiMinutesSigned*Math.max(0,Number($("wifi-rate").value)||0);
        setWifiUi();
      } else if(!paying) {
        paying=true;wifiMinutesSigned++;
        const ok=await signMinute();paying=false;
        if(!ok){toast("Signature refusée ou dépôt épuisé : session arrêtée.",true);stopWifi();return;}
        currentSessionCost=getCurrentChannel().cumulative;setWifiUi();
      }
    }
  },1000);
}
function stopWifi() {
  if(!sessionActive)return;
  sessionActive=false;if(wifiInterval)clearInterval(wifiInterval);wifiInterval=null;
  $("wifi-session-state").textContent="Session terminée";
  $("wifi-session-subtitle").textContent=`Durée simulée : ${$("wifi-timer").textContent}. Coût estimé : ${fmtEth(currentSessionCost)}.`;
  $("wifi-start-btn").disabled=false;$("wifi-stop-btn").disabled=true;
  record("session terminée",`${wifiMinutesSigned} minute(s), coût estimé ${fmtEth(currentSessionCost)}${wifiDemoMode?" (démo)":" (non réglé)"}`);
  log("Session Wi-Fi terminée.");
  updateStats();
}
$("wifi-start-btn").addEventListener("click",()=>startWifi(false));
$("wifi-stop-btn").addEventListener("click",stopWifi);
$("wifi-demo-btn").addEventListener("click",()=>startWifi(true));
$("wifi-rate").addEventListener("change",()=>{state.provider.rate=Math.max(0,Number($("wifi-rate").value)||0);persist();});
$("wifi-provider").addEventListener("change",()=>{$("payee-address").value=$("wifi-provider").value;});

$("save-provider").addEventListener("click",()=>{
  state.provider={name:$("provider-name").value.trim()||"NexaPay Guest Wi-Fi",rate:Math.max(0,Number($("provider-rate").value)||0)};
  $("wifi-rate").value=state.provider.rate;
  persist();record("Paramètres fournisseur enregistrés",`${state.provider.name} · ${state.provider.rate} ETH/min`);toast("Paramètres enregistrés localement.");
});
$("save-settings").addEventListener("click",()=>{
  const address=$("contract-address").value.trim();
  if(address && !ethers.isAddress(address)){toast("Adresse de contrat invalide.",true);return;}
  const payee=$("default-payee").value.trim();
  if(payee && !ethers.isAddress(payee)){toast("Adresse fournisseur invalide.",true);return;}
  state.settings={contractAddress:address,chainId:$("chain-id").value||"11155111",payee};
  contract=null;persist();
  if(payee)$("payee-address").value=payee;
  record("Configuration modifiée",`Chain ID ${state.settings.chainId} · contrat ${shortAddress(address)}`);
  toast("Configuration enregistrée.");
});

function downloadFile(filename,content,type="text/plain") {
  const blob=new Blob([content],{type});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=filename;a.click();URL.revokeObjectURL(url);
}
$("export-history").addEventListener("click",()=>{
  const rows=[["Événement","Détail","Date ISO","Transaction"],...state.events.map(e=>[e.type,e.detail,e.time,e.txHash||""])];
  const csv=rows.map(row=>row.map(v=>`"${String(v).replaceAll('"','""')}"`).join(",")).join("\n");
  downloadFile("nexapay-historique.csv",csv,"text/csv;charset=utf-8;");
});
$("export-channels").addEventListener("click",()=>downloadFile("nexapay-canaux.json",JSON.stringify(state.channels,null,2),"application/json"));
$("clear-history").addEventListener("click",()=>{
  if(!confirm("Effacer tous les événements locaux ? Cette action ne supprime rien sur la blockchain."))return;
  state.events=[];persist();renderHistory();renderActivity();toast("Journal local effacé.");
});
$("clear-console").addEventListener("click",()=>$("console-log").textContent="Journal technique effacé.");
function loadSettingsUi() {
  $("contract-address").value=state.settings.contractAddress||"";
  $("chain-id").value=state.settings.chainId||"11155111";
  $("default-payee").value=state.settings.payee||"";
  $("provider-name").value=state.provider.name||"NexaPay Guest Wi-Fi";
  $("provider-rate").value=state.provider.rate??0.001;
  $("wifi-rate").value=state.provider.rate??0.001;
  if(state.settings.payee)$("payee-address").value=state.settings.payee;
}
/* ---- Fermeture unilatérale et contestation ---- */
async function disputeAction(label,fn,after){
  try{
    const c=requireContract(),ch=getCurrentChannel();
    if(!ch||ch.status!=="open")throw new Error("Aucun canal ouvert sélectionné.");
    const tx=await fn(c,ch);log(`${label} : ${tx.hash}`);toast("Transaction envoyée…");
    const rc=await tx.wait();
    const row=await c.channels(ch.id);ch.disputeDeadline=Number(row.disputeDeadline);
    if(row.closed)ch.status="closed";
    if(after)after(ch,rc);saveChannels();setCurrentChannel(ch.id);
    record(label,`Canal ${shortAddress(ch.id)} · gaz ${rc.gasUsed}`,tx.hash);toast(`${label} : confirmé.`);
  }catch(e){toast(e.shortMessage||e.message,true);log(`${label} : ${e.message}`);}
}
$("start-dispute-btn").addEventListener("click",()=>disputeAction("Fermeture unilatérale démarrée",(c,ch)=>c.startUnilateralClose(ch.id)));
$("dispute-sig-btn").addEventListener("click",()=>disputeAction("Contestation avec reçu",(c,ch)=>{
  if(!ch.signature)throw new Error("Aucun reçu signé enregistré pour ce canal.");
  return c.disputeWithSignature(ch.id,ch.cumulativeWei,ch.signature);}));
$("finalize-btn").addEventListener("click",()=>disputeAction("Canal finalisé",(c,ch)=>c.finalizeUnilateralClose(ch.id),(ch,rc)=>{state.fees.close={gas:rc.gasUsed.toString(),price:rc.gasPrice.toString()};}));
setInterval(()=>{
  const ch=getCurrentChannel(),chip=$("dispute-chip"),info=$("dispute-info");
  if(!ch||ch.status!=="open"||!ch.disputeDeadline){chip.textContent="Aucune contestation";info.textContent="Utilise cette section si l'autre partie ne répond plus.";return;}
  const left=ch.disputeDeadline-Math.floor(Date.now()/1000);
  if(left>0){chip.textContent="Contestation en cours";const f=n=>String(n).padStart(2,"0");info.textContent=`Délai restant : ${f(Math.floor(left/3600))}:${f(Math.floor(left%3600/60))}:${f(left%60)}. Le fournisseur peut encore soumettre un reçu plus élevé.`;}
  else{chip.textContent="Délai écoulé";info.textContent="Le délai est terminé : tu peux finaliser pour répartir les fonds.";}
},1000);
loadSettingsUi();
renderActivity();renderHistory();renderChannels();updateAnalytics();updateStats();
{const oc=getCurrentChannel();if(oc)setCurrentChannel(oc.id);}
if(window.ethereum?.on){
  window.ethereum.on("accountsChanged",()=>location.reload());
  window.ethereum.on("chainChanged",()=>location.reload());
}