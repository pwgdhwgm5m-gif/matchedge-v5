import express from "express";
import fs from "node:fs";
import path from "node:path";

const app = express();
const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.API_FOOTBALL_KEY || "";
const API_BASE = "https://v3.football.api-sports.io";
const ODDS_API_KEY = process.env.ODDS_API_KEY || "";
const ODDS_API_BASE = "https://api.the-odds-api.com/v4";
const ODDS_API_CACHE_TTL_MS = Number(process.env.ODDS_API_CACHE_TTL_MS || 21600000);
const MIN_GAP = Number(process.env.API_MIN_GAP_MS || 6200);
const MODE = process.env.ANALYSIS_MODE || "professional";
const APP_TIME_ZONE = "Europe/Istanbul";
app.use(express.json());
// Prevent mobile browsers / intermediate proxies from ever serving a stale
// cached copy of the HTML shell or any /api/ JSON response. This was the
// root cause of fixtures silently "not loading" after a redeploy: the app
// itself was fine, the browser was just reusing an old cached response.
app.use((req,res,next)=>{
  res.set("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma","no-cache");
  res.set("Expires","0");
  next();
});

const ODDS_SNAPSHOT_FILE = process.env.ODDS_SNAPSHOT_FILE || "/tmp/matchedge-odds-v1.json";
let oddsSnapshotStore={};
try{
  if(fs.existsSync(ODDS_SNAPSHOT_FILE)){
    const raw=fs.readFileSync(ODDS_SNAPSHOT_FILE,"utf8");
    oddsSnapshotStore=raw?JSON.parse(raw):{};
  }
}catch(e){console.warn("Odds snapshot load:",e.message);oddsSnapshotStore={};}
function persistOddsSnapshotStore(){
  try{
    const dir=path.dirname(ODDS_SNAPSHOT_FILE);
    if(!fs.existsSync(dir))fs.mkdirSync(dir,{recursive:true});
    const tmp=ODDS_SNAPSHOT_FILE+".tmp";
    fs.writeFileSync(tmp,JSON.stringify(oddsSnapshotStore));
    fs.renameSync(tmp,ODDS_SNAPSHOT_FILE);
  }catch(e){console.warn("Odds snapshot persist:",e.message);}
}

/* ---------------- Prediction log / calibration tracking ----------------
   Logs each analyzed fixture's model pick once, then settles it against the
   real final score once the fixture is finished, so accuracy/calibration can
   be measured over time instead of just trusted blindly.
   NOTE: this file lives on local disk (default /tmp), which most Render plans
   wipe on every restart/redeploy unless a persistent disk is attached. Set
   PREDICTION_LOG_FILE to a path on a mounted persistent disk to keep history
   across deploys; otherwise treat this as "since last restart" only. -------- */
const PREDICTION_LOG_FILE = process.env.PREDICTION_LOG_FILE || "/tmp/matchedge-predictions-v1.json";
let predictionLogStore={};
try{
  if(fs.existsSync(PREDICTION_LOG_FILE)){
    const raw=fs.readFileSync(PREDICTION_LOG_FILE,"utf8");
    predictionLogStore=raw?JSON.parse(raw):{};
  }
}catch(e){console.warn("Prediction log load:",e.message);predictionLogStore={};}
function persistPredictionLogStore(){
  try{
    const dir=path.dirname(PREDICTION_LOG_FILE);
    if(!fs.existsSync(dir))fs.mkdirSync(dir,{recursive:true});
    const tmp=PREDICTION_LOG_FILE+".tmp";
    fs.writeFileSync(tmp,JSON.stringify(predictionLogStore));
    fs.renameSync(tmp,PREDICTION_LOG_FILE);
  }catch(e){console.warn("Prediction log persist:",e.message);}
}
function logPrediction(f,model){
  try{
    if(!f?.id||!model)return;
    const key=String(f.id);
    if(predictionLogStore[key])return; // log once per fixture
    const m=model.markets||[];
    const outcome1x2=["1","X","2"].map(n=>m.find(x=>x.name===n)).filter(Boolean);
    if(!outcome1x2.length)return;
    const top=outcome1x2.slice().sort((a,b)=>(b.probability||0)-(a.probability||0))[0];
    const strongest=(model.recommendations||[])[0]||null;
    predictionLogStore[key]={
      fixtureId:key,leagueCode:f.leagueCode,league:f.league,
      home:f.home?.name||"",away:f.away?.name||"",
      kickoffTs:f.timestamp||null,loggedAt:new Date().toISOString(),
      predicted1x2:top.name,predicted1x2Prob:top.probability,
      strongestMarket:strongest?.name||null,strongestProb:strongest?.analysisProbability??strongest?.probability??null,
      betDecision:model.betRecommendation?.decision||null,
      settled:false,correct1x2:null,actualHome:null,actualAway:null,settledAt:null
    };
    persistPredictionLogStore();
  }catch(e){console.warn("logPrediction:",e.message);}
}
function settlePendingPredictions(fixtures){
  try{
    let changed=false;
    for(const f of fixtures||[]){
      const key=String(f.id),entry=predictionLogStore[key];
      if(!entry||entry.settled)continue;
      if(!statusFinishedServer(f.status))continue;
      const hg=f.score?.home,ag=f.score?.away;
      if(hg==null||ag==null)continue;
      const actual=hg>ag?"1":hg<ag?"2":"X";
      entry.settled=true;entry.actualHome=hg;entry.actualAway=ag;
      entry.correct1x2=(entry.predicted1x2===actual);
      entry.settledAt=new Date().toISOString();
      changed=true;
    }
    if(changed)persistPredictionLogStore();
  }catch(e){console.warn("settlePendingPredictions:",e.message);}
}
function computeAccuracyStats(){
  const rows=Object.values(predictionLogStore).filter(x=>x.settled);
  const total=rows.length;
  const correct=rows.filter(x=>x.correct1x2).length;
  let brierSum=0,brierN=0;
  for(const r of rows){
    const p=Number(r.predicted1x2Prob);
    if(!Number.isFinite(p))continue;
    const hit=r.correct1x2?1:0;
    brierSum+=Math.pow(p/100-hit,2);brierN++;
  }
  const recent=rows.sort((a,b)=>new Date(b.settledAt)-new Date(a.settledAt)).slice(0,15)
    .map(r=>({home:r.home,away:r.away,league:r.league,predicted:r.predicted1x2,predictedProb:r.predicted1x2Prob,actualHome:r.actualHome,actualAway:r.actualAway,correct:r.correct1x2}));
  return {
    totalSettled:total,
    totalPending:Object.values(predictionLogStore).filter(x=>!x.settled).length,
    accuracyPct:total?Math.round((correct/total)*1000)/10:null,
    brierScore:brierN?+(brierSum/brierN).toFixed(3):null,
    recent
  };
}
function recordOddsSnapshot(fixtureId,payload){
  if(!fixtureId||!payload?.odds||!Object.keys(payload.odds).length)return null;
  const key=String(fixtureId),arr=oddsSnapshotStore[key]||[];
  const stamp=payload.providerUpdatedAt||payload.fetchedAt||new Date().toISOString();
  const signature=JSON.stringify(payload.odds);
  const last=arr.at(-1);
  if(!last||last.signature!==signature){
    arr.push({ts:stamp,signature,odds:payload.odds,bookmakers:payload.bookmakers||{},provider:payload.provider||"API-Football"});
    if(arr.length>96)arr.splice(0,arr.length-96);
    oddsSnapshotStore[key]=arr;
    persistOddsSnapshotStore();
  }
  return oddsSnapshotStore[key];
}
function oddsSeriesForChart(fixtureId,marketName,maxPoints=16){
  if(!fixtureId||!marketName)return [];
  const arr=oddsSnapshotStore[String(fixtureId)]||[];
  const pts=arr.map(x=>({ts:x.ts,odd:Number(x.odds?.[marketName])})).filter(x=>Number.isFinite(x.odd)&&x.odd>1);
  if(pts.length<=maxPoints)return pts;
  const step=Math.ceil(pts.length/maxPoints);
  const out=pts.filter((_,i)=>i%step===0);
  if(out.at(-1)!==pts.at(-1))out.push(pts.at(-1));
  return out;
}
function oddsMovementForFixture(fixtureId,currentOdds={}){
  const arr=oddsSnapshotStore[String(fixtureId)]||[];
  const out={};
  const names=new Set([...Object.keys(currentOdds||{}),...arr.flatMap(x=>Object.keys(x.odds||{}))]);
  for(const name of names){
    const first=arr.find(x=>Number(x.odds?.[name])>1);
    const latest=[...arr].reverse().find(x=>Number(x.odds?.[name])>1);
    const opening=Number(first?.odds?.[name]), current=Number(currentOdds?.[name]??latest?.odds?.[name]);
    if(!(opening>1&&current>1))continue;
    const openImp=1/opening,curImp=1/current;
    out[name]={
      opening:+opening.toFixed(3),current:+current.toFixed(3),
      oddsMovePct:+(((current-opening)/opening)*100).toFixed(1),
      impliedMovePts:+((curImp-openImp)*100).toFixed(1),
      direction:current<opening?"shortening":current>opening?"drifting":"flat",
      firstSeen:first?.ts||null,lastSeen:latest?.ts||null
    };
  }
  return out;
}


/* =========================================================
   MATCHEDGE PREMIUM V7.19.0
   Fixtures: SADECE BUGÜN
   Providers: API-Football + Football-Data.co.uk fallback
   Timezone: Europe/Istanbul
   Analysis: 2026/27 weighted strongest + 2025/26 support
   ========================================================= */

const LEAGUES = {
  TSL:{name:"Süper Lig",country:"Türkiye",apiId:203,csv:"T1",emoji:"🇹🇷"},
  PL:{name:"Premier League",country:"İngiltere",apiId:39,csv:"E0",emoji:"🏴"},
  CH:{name:"Championship",country:"İngiltere",apiId:40,csv:"E1",emoji:"🏴"},
  L1:{name:"League One",country:"İngiltere",apiId:41,csv:"E2",emoji:"🏴"},
  L2:{name:"League Two",country:"İngiltere",apiId:42,csv:"E3",emoji:"🏴"},
  NL:{name:"National League",country:"İngiltere",apiId:43,csv:"EC",emoji:"🏴"},
  PD:{name:"La Liga",country:"İspanya",apiId:140,csv:"SP1",emoji:"🇪🇸"},
  SD:{name:"La Liga 2",country:"İspanya",apiId:141,csv:"SP2",emoji:"🇪🇸"},
  SA:{name:"Serie A",country:"İtalya",apiId:135,csv:"I1",emoji:"🇮🇹"},
  SB:{name:"Serie B",country:"İtalya",apiId:136,csv:"I2",emoji:"🇮🇹"},
  BL1:{name:"Bundesliga",country:"Almanya",apiId:78,csv:"D1",emoji:"🇩🇪"},
  BL2:{name:"2. Bundesliga",country:"Almanya",apiId:79,csv:"D2",emoji:"🇩🇪"},
  FL1:{name:"Ligue 1",country:"Fransa",apiId:61,csv:"F1",emoji:"🇫🇷"},
  FL2:{name:"Ligue 2",country:"Fransa",apiId:62,csv:"F2",emoji:"🇫🇷"},
  DED:{name:"Eredivisie",country:"Hollanda",apiId:88,csv:"N1",emoji:"🇳🇱"},
  BEL:{name:"Pro League",country:"Belçika",apiId:144,csv:"B1",emoji:"🇧🇪"},
  PPL:{name:"Primeira Liga",country:"Portekiz",apiId:94,csv:"P1",emoji:"🇵🇹"},
  GRE:{name:"Super League",country:"Yunanistan",apiId:197,csv:"G1",emoji:"🇬🇷"},
  SCP:{name:"Premiership",country:"İskoçya",apiId:179,csv:"SC0",emoji:"🏴"},
  SCC:{name:"Championship",country:"İskoçya",apiId:180,csv:"SC1",emoji:"🏴"},
  SCL1:{name:"League One",country:"İskoçya",apiId:183,csv:"SC2",emoji:"🏴"},
  SCL2:{name:"League Two",country:"İskoçya",apiId:184,csv:"SC3",emoji:"🏴"},
  T1L:{name:"1. Lig",country:"Türkiye",apiId:204,csv:null,emoji:"🇹🇷"},
  UCL:{name:"UEFA Champions League",country:"Avrupa",apiId:2,csv:null,emoji:"🏆"},
  UEL:{name:"UEFA Europa League",country:"Avrupa",apiId:3,csv:null,emoji:"🏆"},
  UECL:{name:"UEFA Conference League",country:"Avrupa",apiId:848,csv:null,emoji:"🏆"},
  FAC:{name:"FA Cup",country:"İngiltere",apiId:45,csv:null,emoji:"🏆"},
  CDR:{name:"Copa del Rey",country:"İspanya",apiId:143,csv:null,emoji:"🏆"},
  CIT:{name:"Coppa Italia",country:"İtalya",apiId:137,csv:null,emoji:"🏆"},
  DFB:{name:"DFB Pokal",country:"Almanya",apiId:81,csv:null,emoji:"🏆"},
  CDF:{name:"Coupe de France",country:"Fransa",apiId:66,csv:null,emoji:"🏆"},
  KNVB:{name:"KNVB Beker",country:"Hollanda",apiId:90,csv:null,emoji:"🏆"},
  TKC:{name:"Türkiye Kupası",country:"Türkiye",apiId:206,csv:null,emoji:"🏆"},
  RPL:{name:"Premier League",country:"Rusya",apiId:235,csv:null,emoji:"🇷🇺"},
  UPL:{name:"Premier League",country:"Ukrayna",apiId:333,csv:null,emoji:"🇺🇦"},
  FIN:{name:"Veikkausliiga",country:"Finlandiya",apiId:244,csv:null,emoji:"🇫🇮"},
  NOR:{name:"Eliteserien",country:"Norveç",apiId:103,csv:null,emoji:"🇳🇴"},
  SWE:{name:"Allsvenskan",country:"İsveç",apiId:113,csv:null,emoji:"🇸🇪"},
  DEN:{name:"Superliga",country:"Danimarka",apiId:119,csv:null,emoji:"🇩🇰"},
  SUI:{name:"Super League",country:"İsviçre",apiId:207,csv:null,emoji:"🇨🇭"},
  AUT:{name:"Bundesliga",country:"Avusturya",apiId:218,csv:null,emoji:"🇦🇹"},
  POL:{name:"Ekstraklasa",country:"Polonya",apiId:106,csv:null,emoji:"🇵🇱"},
  CZE:{name:"Czech Liga",country:"Çekya",apiId:345,csv:null,emoji:"🇨🇿"},
  ROU:{name:"SuperLiga",country:"Romanya",apiId:283,csv:null,emoji:"🇷🇴"},
  CRO:{name:"HNL",country:"Hırvatistan",apiId:210,csv:null,emoji:"🇭🇷"},
  SRB:{name:"Super Liga",country:"Sırbistan",apiId:286,csv:null,emoji:"🇷🇸"},
  CYP:{name:"1. Division",country:"Kıbrıs",apiId:318,csv:null,emoji:"🇨🇾"},
  SVK:{name:"Super Liga",country:"Slovakya",apiId:332,csv:null,emoji:"🇸🇰"},
  SVN:{name:"1. SNL",country:"Slovenya",apiId:373,csv:null,emoji:"🇸🇮"},
  ISR:{name:"Ligat Ha'al",country:"İsrail",apiId:383,csv:null,emoji:"🇮🇱"},
  IRL:{name:"Premier Division",country:"İrlanda",apiId:357,csv:null,emoji:"🇮🇪"},
  SUIC:{name:"Challenge League",country:"İsviçre",apiId:208,csv:null,emoji:"🇨🇭"},
  SWE2:{name:"Superettan",country:"İsveç",apiId:114,csv:null,emoji:"🇸🇪"},
  RUSC:{name:"Russian Cup",country:"Rusya",apiId:237,csv:null,emoji:"🏆"},
  POLC:{name:"Polish Cup",country:"Polonya",apiId:107,csv:null,emoji:"🏆"},
  ROUC:{name:"Cupa României",country:"Romanya",apiId:284,csv:null,emoji:"🏆"},
  DEN2:{name:"1st Division",country:"Danimarka",apiId:120,csv:null,emoji:"🇩🇰"},
  AUT2:{name:"2. Liga",country:"Avusturya",apiId:219,csv:null,emoji:"🇦🇹"},
  SWEC:{name:"Svenska Cupen",country:"İsveç",apiId:115,csv:null,emoji:"🏆"}
};

const LEAGUE_BY_API = {};
for (const [code,l] of Object.entries(LEAGUES)) LEAGUE_BY_API[l.apiId] = {code,...l};
const LEAGUE_BY_CSV = {};
for (const [code,l] of Object.entries(LEAGUES)) if(l.csv) LEAGUE_BY_CSV[l.csv] = {code,...l};

const ESPN_SLUGS = {
  TSL:"tur.1", PL:"eng.1", CH:"eng.2", L1:"eng.3", L2:"eng.4", NL:"eng.5",
  PD:"esp.1", SD:"esp.2", SA:"ita.1", SB:"ita.2", BL1:"ger.1", BL2:"ger.2",
  FL1:"fra.1", FL2:"fra.2", DED:"ned.1", BEL:"bel.1", PPL:"por.1", GRE:"gre.1",
  SCP:"sco.1", SCC:"sco.2", SCL1:"sco.3", SCL2:"sco.4",
  T1L:"tur.2", UCL:"uefa.champions", UEL:"uefa.europa", UECL:"uefa.europa.conf",
  FAC:"eng.fa", CDR:"esp.copa_del_rey", CIT:"ita.coppa_italia", DFB:"ger.dfb_pokal",
  CDF:"fra.coupe_de_france", KNVB:"ned.knvb_beker", TKC:"tur.turkish_cup",
  RPL:"rus.1", UPL:"ukr.1",
  NOR:"nor.1", SWE:"swe.1", DEN:"den.1", SUI:"sui.1", AUT:"aut.1",
  POL:"pol.1", ROU:"rou.1", IRL:"irl.1",
  SUIC:"sui.2", SWE2:"swe.2", DEN2:"den.2", AUT2:"aut.2"
};

const cache = new Map();
function getCache(k){ const x=cache.get(k); if(!x) return null; if(Date.now()>x.expires){cache.delete(k);return null;} return x.value; }
function setCache(k,v,ttl=600000){ cache.set(k,{value:v,expires:Date.now()+ttl}); }
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const pct=v=>Math.round(v*1000)/10;
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
const safe=(v,d=0)=>Number.isFinite(v)?v:d;

function shiftYmd(date,amount){
  const d=new Date(date+"T12:00:00Z");
  d.setUTCDate(d.getUTCDate()+amount);
  return d.toISOString().slice(0,10);
}
function localYmdFromDate(value){
  const d=value instanceof Date?value:new Date(value);
  if(Number.isNaN(d.getTime())) return null;
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:APP_TIME_ZONE,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(d);
  const o=Object.fromEntries(parts.filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));
  return `${o.year}-${o.month}-${o.day}`;
}
function localTimeFromDate(value){
  const d=new Date(value);
  if(Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("tr-TR",{timeZone:APP_TIME_ZONE,hour:"2-digit",minute:"2-digit",hour12:false}).format(d);
}


/* ---------------- Dynamic API-Football league resolver ----------------
   API-Football competition ids are discovered from /leagues for the active
   season instead of trusting only hard-coded ids. This also rebuilds
   LEAGUE_BY_API so /fixtures?date rows are no longer discarded when an id
   differs from the old static map.
----------------------------------------------------------------------- */
const API_LEAGUE_HINTS={
  TSL:{country:"Turkey",aliases:["Super Lig","Süper Lig"]},
  T1L:{country:"Turkey",aliases:["1. Lig","1 Lig","First League"]},
  TKC:{country:"Turkey",aliases:["Cup","Turkish Cup"]},
  RPL:{country:"Russia",aliases:["Premier League"]},
  RUSC:{country:"Russia",aliases:["Cup","Russian Cup"]},
  DEN:{country:"Denmark",aliases:["Superliga","Super Liga"]},
  DEN2:{country:"Denmark",aliases:["1. Division","First Division"]},
  SWE:{country:"Sweden",aliases:["Allsvenskan"]},
  SWE2:{country:"Sweden",aliases:["Superettan"]},
  SWEC:{country:"Sweden",aliases:["Svenska Cupen","Cup"]},
  SUI:{country:"Switzerland",aliases:["Super League"]},
  SUIC:{country:"Switzerland",aliases:["Challenge League"]},
  AUT:{country:"Austria",aliases:["Bundesliga"]},
  AUT2:{country:"Austria",aliases:["2. Liga","2 Liga"]},
  POL:{country:"Poland",aliases:["Ekstraklasa"]},
  POLC:{country:"Poland",aliases:["Cup","Polish Cup","Puchar Polski"]},
  ROU:{country:"Romania",aliases:["Liga I","Superliga"]},
  ROUC:{country:"Romania",aliases:["Cupa României","Cupa Romaniei","Cup"]},
  SA:{country:"Italy",aliases:["Serie A"]},
  SB:{country:"Italy",aliases:["Serie B"]},
  CIT:{country:"Italy",aliases:["Coppa Italia","Cup"]}
};
function apiNameNorm(v){
  return String(v||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
}
function apiLeagueMatchScore(item,hint,code){
  const country=apiNameNorm(item?.country?.name),wantedCountry=apiNameNorm(hint.country);
  if(country!==wantedCountry)return -999;
  const name=apiNameNorm(item?.league?.name);
  let best=-50;
  for(const a of hint.aliases||[]){
    const al=apiNameNorm(a);
    if(name===al)best=Math.max(best,100);
    else if(name.includes(al)||al.includes(name))best=Math.max(best,75);
    else{
      const aw=new Set(al.split(" ")),nw=new Set(name.split(" "));
      const common=[...aw].filter(x=>nw.has(x)).length;
      best=Math.max(best,common*15);
    }
  }
  const type=String(item?.league?.type||"").toLowerCase();
  const isCup=/C$/.test(code)||["TKC","SWEC"].includes(code);
  if(isCup&&type==="cup")best+=20;
  if(!isCup&&type==="league")best+=10;
  const seasons=item?.seasons||[];
  if(seasons.some(x=>Number(x.year)===2026))best+=15;
  if(seasons.some(x=>Number(x.year)===2026&&x.current))best+=10;
  return best;
}
let dynamicLeagueResolvePromise=null;
async function ensureDynamicLeagueIds(season=2026){
  if(!API_KEY)return {};
  const cached=getCache(`dynamic-league-map:${season}`);
  if(cached){
    for(const [code,id] of Object.entries(cached)){
      if(LEAGUES[code]&&id){
        LEAGUES[code].apiId=id;
        LEAGUE_BY_API[id]={code,...LEAGUES[code]};
      }
    }
    return cached;
  }
  if(dynamicLeagueResolvePromise)return dynamicLeagueResolvePromise;
  dynamicLeagueResolvePromise=(async()=>{
    try{
      const catalog=await apiFootball(`/leagues?season=${season}`,12*60*60*1000);
      const resolved={};
      for(const [code,hint] of Object.entries(API_LEAGUE_HINTS)){
        let best=null,bestScore=-999;
        for(const item of catalog||[]){
          const sc=apiLeagueMatchScore(item,hint,code);
          if(sc>bestScore){bestScore=sc;best=item;}
        }
        if(best&&bestScore>=70&&best.league?.id){
          const id=Number(best.league.id);
          resolved[code]=id;
          LEAGUES[code].apiId=id;
        }
      }
      // Rebuild id -> app league map from the freshly resolved ids.
      for(const k of Object.keys(LEAGUE_BY_API))delete LEAGUE_BY_API[k];
      for(const [code,l] of Object.entries(LEAGUES)){
        if(l.apiId)LEAGUE_BY_API[Number(l.apiId)]={code,...l};
      }
      setCache(`dynamic-league-map:${season}`,resolved,12*60*60*1000);
      console.log("Dynamic API-Football league ids:",resolved);
      return resolved;
    }catch(e){
      console.warn("Dynamic league resolver:",e.message);
      return {};
    }finally{
      dynamicLeagueResolvePromise=null;
    }
  })();
  return dynamicLeagueResolvePromise;
}

/* ---------------- API-Football ---------------- */
let lastApiCall=0, apiChain=Promise.resolve();
// Generic timeout wrapper for every "public fallback" provider (ESPN, TFF, RFS,
// federation sites, TheSportsDB, football-data.co.uk, etc). Without this, a single
// slow/unresponsive third-party site can hang the whole /api/three-days request
// forever, since Promise.allSettled waits for every promise to settle and plain
// fetch() has no default timeout in Node.
async function fetchT(url,options={},ms=8000){
  const c=new AbortController();
  const t=setTimeout(()=>c.abort(),ms);
  try{ return await fetch(url,{...options,signal:c.signal}); }
  finally{ clearTimeout(t); }
}
async function rateLimitedFetch(url,options={}){
  const run=async()=>{
    const wait=Math.max(0,MIN_GAP-(Date.now()-lastApiCall));
    if(wait) await new Promise(r=>setTimeout(r,wait));
    lastApiCall=Date.now();
    const c=new AbortController(); const t=setTimeout(()=>c.abort(),25000);
    try{return await fetch(url,{...options,signal:c.signal});}finally{clearTimeout(t);}
  };
  apiChain=apiChain.then(run,run); return apiChain;
}
async function apiFootball(path,ttl=240000){
  if(!API_KEY) throw new Error("API_FOOTBALL_KEY bulunamadı.");
  const k=`api:${path}`, c=getCache(k); if(c) return c;
  const r=await rateLimitedFetch(API_BASE+path,{headers:{"x-apisports-key":API_KEY}});
  if(!r.ok) throw new Error(`API-Football HTTP ${r.status}`);
  const b=await r.json();
  if(b.errors&&Object.keys(b.errors).length) throw new Error(typeof b.errors==="string"?b.errors:JSON.stringify(b.errors));
  const data=b.response||[]; setCache(k,data,ttl); return data;
}

/* ---------------- Football-Data CSV ---------------- */
function parseCSV(text){
  text=text.replace(/^\uFEFF/,""); const rows=[]; let row=[],v="",q=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i], nx=text[i+1];
    if(ch==='"'&&q&&nx==='"'){v+='"';i++;continue;}
    if(ch==='"'){q=!q;continue;}
    if(ch===','&&!q){row.push(v);v="";continue;}
    if((ch==='\n'||ch==='\r')&&!q){if(ch==='\r'&&nx==='\n')i++;row.push(v);v="";if(row.some(x=>String(x).trim()))rows.push(row);row=[];continue;}
    v+=ch;
  }
  if(v||row.length){row.push(v);rows.push(row);} if(rows.length<2)return [];
  const h=rows[0].map(x=>x.trim());
  return rows.slice(1).map(vals=>Object.fromEntries(h.map((x,i)=>[x,vals[i]??""])));
}
function num(v){if(v==null||v==="")return null;const x=Number(String(v).replace(",","."));return Number.isFinite(x)?x:null;}
function parseDate(v){
  if(!v)return null; const p=String(v).trim().split("/");
  if(p.length===3){let[d,m,y]=p;if(y.length===2)y=Number(y)>70?`19${y}`:`20${y}`;const z=new Date(+y,+m-1,+d,12);return Number.isNaN(z.getTime())?null:z;}
  const z=new Date(v); return Number.isNaN(z.getTime())?null:z;
}
const fdUrl=(season,div)=>`https://www.football-data.co.uk/mmz4281/${season}/${div}.csv`;
async function loadCSV(season,div){
  const k=`csv-v2:${season}:${div}`,c=getCache(k);if(c)return c;
  try{
    for(let attempt=0;attempt<2;attempt++){
      try{
        const r=await fetchT(fdUrl(season,div),{headers:{"User-Agent":"MatchEdge/7.19.0","Accept":"text/csv,text/plain,*/*"}});
        if(!r.ok){if(attempt===0)continue;return[];}
        const text=await r.text();
        if(text.toLowerCase().includes("<html")||text.length<20){if(attempt===0)continue;return[];}
        const rows=parseCSV(text);
        setCache(k,rows,rows.length?1800000:30000);
        return rows;
      }catch(e){if(attempt===1)throw e;}
    }
    return[];
  }catch(e){console.warn(`Football-Data ${season}/${div}:`,e.message);return[];}
}
function completed(r,season){
  const hg=num(r.FTHG),ag=num(r.FTAG),date=parseDate(r.Date); if(hg==null||ag==null||!date)return null;
  return {season,date,home:r.HomeTeam||"",away:r.AwayTeam||"",homeGoals:hg,awayGoals:ag,htHome:num(r.HTHG),htAway:num(r.HTAG),
    homeShots:num(r.HS),awayShots:num(r.AS),homeSOT:num(r.HST),awaySOT:num(r.AST),homeCorners:num(r.HC),awayCorners:num(r.AC),
    homeYellow:num(r.HY),awayYellow:num(r.AY),homeRed:num(r.HR),awayRed:num(r.AR)};
}

const NEW_LEAGUE_CSV={AUT:"AUT",POL:"POL",ROU:"ROU",FIN:"FIN",NOR:"NOR",DEN:"DNK",IRL:"IRL",SWE:"SWE",SUI:"SWZ",RPL:"RUS"};

function normalizeSeasonLabel(v,date=null){
  const s=String(v||"").trim();
  let m=s.match(/^(\d{4})[\/-](\d{4})$/);
  if(m)return `${m[1]}/${m[2].slice(-2)}`;
  m=s.match(/^(\d{4})[\/-](\d{2})$/);
  if(m)return `${m[1]}/${m[2]}`;
  m=s.match(/^(\d{4})$/);
  if(m)return `${m[1]}/${String(+m[1]+1).slice(-2)}`;
  if(date){
    const d=new Date(date);
    if(!Number.isNaN(d.getTime())){
      const y=d.getFullYear(),mo=d.getMonth()+1;
      const sy=mo>=7?y:y-1;
      return `${sy}/${String(sy+1).slice(-2)}`;
    }
  }
  return s;
}

async function loadNewLeagueCSV(code){
  const file=NEW_LEAGUE_CSV[code];if(!file)return[];
  const k=`newcsv-v3:${code}`,c=getCache(k);if(c)return c;
  try{
    const r=await fetchT(`https://www.football-data.co.uk/new/${file}.csv`,{
      headers:{"User-Agent":"MatchEdge/7.19.0","Accept":"text/csv,text/plain,*/*"}
    });
    if(!r.ok){console.warn(`Football-Data new ${code}: HTTP ${r.status}`);return[];}
    const text=await r.text();
    if(text.toLowerCase().includes("<html")||text.length<20)return[];
    const rows=parseCSV(text);
    setCache(k,rows,rows.length?1800000:30000);
    return rows;
  }catch(e){
    console.warn(`Football-Data new ${code}:`,e.message);
    return[];
  }
}

function completedNew(r){
  const hg=num(r.HG??r.FTHG),ag=num(r.AG??r.FTAG),date=parseDate(r.Date);
  if(hg==null||ag==null||!date)return null;
  return {
    season:normalizeSeasonLabel(r.Season,date),
    date,
    home:r.Home||r.HomeTeam||"",
    away:r.Away||r.AwayTeam||"",
    homeGoals:hg,awayGoals:ag,
    htHome:num(r.HTHG),htAway:num(r.HTAG),
    homeShots:null,awayShots:null,homeSOT:null,awaySOT:null,
    homeCorners:null,awayCorners:null,
    homeYellow:null,awayYellow:null,homeRed:null,awayRed:null,
    source:"football-data-extra"
  };
}
async function leagueHistory(code){
  const l=LEAGUES[code]; if(!l)return[];
  const k=`history-v4:${code}`,c=getCache(k);if(c)return c;
  let all=[];
  if(l.csv){
    const [cur,prev]=await Promise.all([loadCSV("2627",l.csv),loadCSV("2526",l.csv)]);
    all=[...prev.map(x=>completed(x,"2025/26")),...cur.map(x=>completed(x,"2026/27"))].filter(Boolean);
  }else if(NEW_LEAGUE_CSV[code]){
    const rows=await loadNewLeagueCSV(code);
    all=rows.map(completedNew).filter(Boolean)
      .filter(m=>{
        if(m.season==="2025/26"||m.season==="2026/27")return true;
        const y=m.date?.getFullYear?.();
        return y===2025||y===2026;
      });
  }
  all.sort((a,b)=>a.date-b.date);
  setCache(k,all,all.length?1800000:30000);
  return all;
}

const CYRILLIC_MAP={"а":"a","б":"b","в":"v","г":"g","д":"d","е":"e","ё":"e","ж":"zh","з":"z","и":"i","й":"y","к":"k","л":"l","м":"m","н":"n","о":"o","п":"p","р":"r","с":"s","т":"t","у":"u","ф":"f","х":"kh","ц":"ts","ч":"ch","ш":"sh","щ":"shch","ъ":"","ы":"y","ь":"","э":"e","ю":"yu","я":"ya"};
function transliterateCyrillic(s){
  let x=String(s||"").toLowerCase().replace(/[а-яё]/g,ch=>CYRILLIC_MAP[ch]??"");
  // Common English-media exonyms diverge from strict letter-by-letter transliteration.
  x=x.replace(/iy\b/g,"y").replace(/yy\b/g,"y")
     .replace(/\bmoskva\b/g,"moscow")
     .replace(/\bsankt[- ]?peterburg\b/g,"st petersburg")
     .replace(/\bpeterburg\b/g,"petersburg");
  return x;
}
function norm(s=""){
  let x=String(s||"");
  if(/[а-яё]/i.test(x))x=transliterateCyrillic(x);
  return x.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/ı/g,"i").replace(/ş/g,"s").replace(/ğ/g,"g").replace(/ü/g,"u").replace(/ö/g,"o").replace(/ç/g,"c").replace(/ø/g,"o").replace(/æ/g,"ae").replace(/å/g,"a").replace(/ł/g,"l").replace(/\b(fc|cf|afc|fk|sk|as|ac|ssc|calcio|football|club)\b/g,"").replace(/[^a-z0-9]/g,"");
}
const ALIASES={
"fcsb":["steauabucuresti","fcsteauabucuresti"],
"cfrcluj":["fccfr1907cluj","cfr1907cluj"],
"rapidbucuresti":["fcrapid","rapid"],
"dinamobucuresti":["dinamo"],
"universitateacraiova":["ucraiova","csuniversitateacraiova"],
"universitateacluj":["ucluj","fcuniversitateacluj"],
"farulconstanta":["farul"],
"otelulgalati":["scotelulgalati","otelul"],
"botosani":["fcbotosani"],
"petrolulploiesti":["petrolul"],
"hermannstadt":["fchermannstadt"],
"utaarad":["utaarad","uta"],
"sepsiosk":["sepsi"],
"argespitesti":["fcarges","arges"],
"unireaslobozia":["slobozia"],
"metaloglobusbucuresti":["metaloglobus"],
"fckobenhavn":["fcopenhagen","copenhagen","kobenhavn"],
"brondby":["brondbyif"],
"midtjylland":["fcmidtjylland"],
"nordsjaelland":["fcnordsjaelland"],
"randers":["randersfc"],
"silkeborg":["silkeborgif"],
"viborg":["viborgff"],
"aarhus":["agf","aarhusgf"],
"sonderjyske":["sonderjyske"],
"zenitstpetersburg":["zenit","zenitsaintpetersburg"],
"cskamoscow":["cskamoscow","cska","tsskamoscow","tska"],
"lokomotivmoscow":["lokomotivmoscow","lokomotiv"],
"spartakmoscow":["spartakmoscow","spartak"],
"dinamomoscow":["dynamomoscow","dinamomoscow"],
"dynamomakhachkala":["dinamomakhachkala"],
"krasnodar":["fckrasnodar"],
"rostov":["fcrostov"],
"rubinkazan":["rubinkazan"],
"akhmatgrozny":["akhmat","terekgrozny"],
"kryliasovetov":["krylyasovetov","krylasovetov","kryliasovetovsamara","krylyasovetovsamara"],
"nizhnynovgorod":["nizhniynovgorod","nn","parinn"],
"inter":["internazionale","intermilano","fcinternazionale"],
"milan":["acmilan","milanac"],
"juventus":["juve"],
"napoli":["sscnapoli"],
"roma":["asroma"],
"lazio":["sslazio"],
"atalanta":["atalantabc"],
"fiorentina":["acfiorentina"],
"bologna":["bolognafc"],
"torino":["torinofc"],
"genoa":["genoacfc"],
"udinese":["udinesecalcio"],
"verona":["hellasverona"],
"parma":["parmacalcio1913"],
"cagliari":["cagliaricalcio"],
"lecce":["uslecce"],
"monza":["acmonza"],
"sassuolo":["ussassuolo"],
"spezia":["speziacalcio"],
"sampdoria":["ucsampdoria"],
"palermo":["palermofc"],
"venezia":["veneziacf"],
"empoli":["empolifc"],
"pisa":["pisasc"],
"modena":["modenafc"],
"bari":["sscbari"],
"cremonese":["uscremonese"],
"catanzaro":["uscatanzaro"],
"cesena":["cesenafc"],
"manchesterunited":["manunited"],"manchestercity":["mancity"],"tottenhamhotspur":["tottenham"],"wolverhamptonwanderers":["wolves"],"nottinghamforest":["nottmforest"],"newcastleunited":["newcastle"],"westhamunited":["westham"],"sheffieldwednesday":["sheffwed"],"sheffieldunited":["sheffunited"],"queensparkrangers":["qpr"],"intermilano":["inter"],"internazionale":["inter"],"acmilan":["milan"],"atleticomadrid":["athmadrid"],"athleticclub":["athbilbao"],"borussiamonchengladbach":["mgladbach"],"sportingcp":["sportinglisbon","sporting"],
"gent":["kaagent"],
"oudheverleeleuven":["ohleuven"],
"royaleunionsaintgilloise":["unionsg","uniongilloise","unionsaintgilloise"],
"standarddeliege":["standard","standardliege"],
"krcgenk":["genk"],
"royalantwerpfc":["antwerp","royalantwerp"],
"sinttruidensevv":["stvv","sinttruiden"],
"kvcwesterlo":["westerlo"],
"sportingcharleroi":["charleroi","rcharleroi"],
"kvkortrijk":["kortrijk"],
"kvmechelen":["mechelen"],
"rwdmolenbeek":["rwdm","rwdmolenbeek1902"],
"clubbrugge":["clubbruggekv","brugge"],
"cerclebrugge":["cercle"],
"kaseraing":["seraing"],
"beerschotva":["beerschot"],
"dessel":["desselsport"],
"heartofmidlothian":["hearts"]};
function aliasSet(name){const base=norm(name),s=new Set([base]);for(const[k,vals]of Object.entries(ALIASES)){const all=[norm(k),...vals.map(norm)];if(all.includes(base))all.forEach(x=>s.add(x));}return s;}
function similarity(a,b){const A=aliasSet(a),B=aliasSet(b);let best=0;for(const x of A)for(const y of B){if(x===y)return 1;if(x&&y&&(x.includes(y)||y.includes(x))){const mn=Math.min(x.length,y.length),mx=Math.max(x.length,y.length);if(mn>=5)return .92;best=Math.max(best,mn/mx);}}return best;}
function findTeam(name,h){const teams=[...new Set(h.flatMap(m=>[m.home,m.away]))];let best=null,score=0;for(const t of teams){const s=similarity(name,t);if(s>score){score=s;best=t;}}return score>=.55?best:null;}

const CUP_SUPPORT_LEAGUES={
  FAC:["PL","CH","L1","L2"], CDR:["PD","SD"], CIT:["SA","SB"], DFB:["BL1","BL2"],
  CDF:["FL1","FL2"], KNVB:["DED"], TKC:["TSL","T1L"], POLC:["POL"],
  SUIC:["SUI"], ROUC:["ROU"], RUSC:["RPL"], SWEC:["SWE","SWE2"]
};
function hasPrimaryHistorySource(code){
  const l=LEAGUES[code];
  return !!(l?.csv||NEW_LEAGUE_CSV[code]||ESPN_SLUGS[code]||["TSL","T1L","ROU","AUT","POL"].includes(code));
}
function historyCapability(code){
  const l=LEAGUES[code]||{};
  return {
    fixtures:true,
    localHistory:!!(l.csv||NEW_LEAGUE_CSV[code]),
    espnHistory:!!ESPN_SLUGS[code],
    officialHistory:["TSL","T1L","ROU","AUT","POL"].includes(code),
    apiHistory:!!(API_KEY&&l.apiId),
    supportLeagues:CUP_SUPPORT_LEAGUES[code]||[]
  };
}


/* ---------------- Derived stats ---------------- */
function perspective(m,t){
  const home=m.home===t,gf=home?m.homeGoals:m.awayGoals,ga=home?m.awayGoals:m.homeGoals;
  const htGF=m.htHome==null||m.htAway==null?null:(home?m.htHome:m.htAway), htGA=m.htHome==null||m.htAway==null?null:(home?m.htAway:m.htHome);
  return {date:m.date,season:m.season,home,opponent:home?m.away:m.home,gf,ga,points:gf>ga?3:gf===ga?1:0,btts:gf>0&&ga>0?1:0,htGF,htGA,shGF:htGF==null?null:gf-htGF,shGA:htGA==null?null:ga-htGA,
    shots:home?m.homeShots:m.awayShots,shotsAgainst:home?m.awayShots:m.homeShots,sot:home?m.homeSOT:m.awaySOT,sotAgainst:home?m.awaySOT:m.homeSOT,corners:home?m.homeCorners:m.awayCorners,cornersAgainst:home?m.awayCorners:m.homeCorners};
}
function weightedAvg(rows,key){let s=0,w=0;rows.forEach((x,i)=>{const v=x[key];if(v==null||!Number.isFinite(v))return;const sw=x.season==="2026/27"?1.75:.55;const rw=.65+.35*((i+1)/rows.length);const ww=sw*rw;s+=v*ww;w+=ww;});return w?s/w:null;}
function teamStats(h,t,venue=null,n=10){let r=h.filter(m=>m.home===t||m.away===t).map(m=>perspective(m,t));if(venue==="home")r=r.filter(x=>x.home);if(venue==="away")r=r.filter(x=>!x.home);r=r.slice(-n);if(!r.length)return null;return{matches:r.length,current:r.filter(x=>x.season==="2026/27").length,points:weightedAvg(r,"points"),gf:weightedAvg(r,"gf"),ga:weightedAvg(r,"ga"),htGF:weightedAvg(r,"htGF"),htGA:weightedAvg(r,"htGA"),shGF:weightedAvg(r,"shGF"),shGA:weightedAvg(r,"shGA"),shots:weightedAvg(r,"shots"),shotsAgainst:weightedAvg(r,"shotsAgainst"),sot:weightedAvg(r,"sot"),sotAgainst:weightedAvg(r,"sotAgainst"),corners:weightedAvg(r,"corners"),cornersAgainst:weightedAvg(r,"cornersAgainst"),btts:weightedAvg(r,"btts"),rows:r};}
function currentSeason(h){return h.filter(m=>m.season==="2026/27");}
function buildTable(h){
  const rows=currentSeason(h),map=new Map();
  const get=t=>{if(!map.has(t))map.set(t,{team:t,p:0,w:0,d:0,l:0,gf:0,ga:0,pts:0,hp:0,hpts:0,ap:0,apts:0});return map.get(t);};
  for(const m of rows){const H=get(m.home),A=get(m.away);H.p++;A.p++;H.gf+=m.homeGoals;H.ga+=m.awayGoals;A.gf+=m.awayGoals;A.ga+=m.homeGoals;H.hp++;A.ap++;if(m.homeGoals>m.awayGoals){H.w++;A.l++;H.pts+=3;H.hpts+=3;}else if(m.homeGoals<m.awayGoals){A.w++;H.l++;A.pts+=3;A.apts+=3;}else{H.d++;A.d++;H.pts++;A.pts++;H.hpts++;A.apts++;}}
  const arr=[...map.values()].map(x=>({...x,gd:x.gf-x.ga,ppg:x.p?x.pts/x.p:0,homePPG:x.hp?x.hpts/x.hp:0,awayPPG:x.ap?x.apts/x.ap:0})).sort((a,b)=>b.pts-a.pts||b.gd-a.gd||b.gf-a.gf);
  arr.forEach((x,i)=>x.pos=i+1);
  [...arr].sort((a,b)=>b.homePPG-a.homePPG||b.hpts-a.hpts||(b.gf-b.ga)-(a.gf-a.ga)).forEach((x,i)=>x.homePos=i+1);
  [...arr].sort((a,b)=>b.awayPPG-a.awayPPG||b.apts-a.apts||(b.gf-b.ga)-(a.gf-a.ga)).forEach((x,i)=>x.awayPos=i+1);
  return arr;
}
function eloRatings(h){const r={};const rows=h.slice(-500);for(const m of rows){r[m.home]??=1500;r[m.away]??=1500;const eh=1/(1+10**((r[m.away]-r[m.home]-65)/400)),ea=1-eh;const sh=m.homeGoals>m.awayGoals?1:m.homeGoals===m.awayGoals?.5:0,sa=1-sh;const K=m.season==="2026/27"?28:16;r[m.home]+=K*(sh-eh);r[m.away]+=K*(sa-ea);}return r;}
function h2h(h,a,b){const r=h.filter(m=>(m.home===a&&m.away===b)||(m.home===b&&m.away===a)).slice(-6);if(!r.length)return{matches:0,homeGF:null,awayGF:null};let hg=0,ag=0;for(const m of r){if(m.home===a){hg+=m.homeGoals;ag+=m.awayGoals;}else{hg+=m.awayGoals;ag+=m.homeGoals;}}return{matches:r.length,homeGF:hg/r.length,awayGF:ag/r.length};}
function commonOpp(h,a,b){const A=h.filter(m=>m.home===a||m.away===a).slice(-14).map(m=>perspective(m,a));const B=h.filter(m=>m.home===b||m.away===b).slice(-14).map(m=>perspective(m,b));const xs=[];for(const x of A)for(const y of B)if(x.opponent===y.opponent)xs.push((x.gf-x.ga)-(y.gf-y.ga));return{count:xs.length,adj:xs.length?clamp(mean(xs)*.07,-.28,.28):0};}
function leagueAvg(h){const r=h.slice(-220);return{homeGoals:mean(r.map(x=>x.homeGoals))||1.45,awayGoals:mean(r.map(x=>x.awayGoals))||1.15,htGoals:mean(r.filter(x=>x.htHome!=null).map(x=>x.htHome+x.htAway))||1.08,corners:mean(r.filter(x=>x.homeCorners!=null).map(x=>x.homeCorners+x.awayCorners))};}

/* ---------------- Distributions ---------------- */
function factorial(n){let x=1;for(let i=2;i<=n;i++)x*=i;return x;}
const poisson=(k,l)=>Math.exp(-l)*Math.pow(l,k)/factorial(k);
// Dixon-Coles (1997) low-score correlation correction: independent Poisson
// slightly overstates 0-0/1-1 and understates 1-0/0-1 in real football data.
// rho is the standard small negative dampening factor from the original paper's
// fitted range (-0.05 to -0.15 across leagues/seasons); -0.11 is a reasonable
// fixed default absent a full per-league re-fit.
const DIXON_COLES_RHO=-0.11;
function dcTau(x,y,lambda,mu,rho){
  if(x===0&&y===0)return 1-lambda*mu*rho;
  if(x===0&&y===1)return 1+lambda*rho;
  if(x===1&&y===0)return 1+mu*rho;
  if(x===1&&y===1)return 1-rho;
  return 1;
}
function scoreMatrix(hl,al,max=8,rho=DIXON_COLES_RHO){
  const a=[];
  for(let h=0;h<=max;h++)for(let z=0;z<=max;z++){
    const base=poisson(h,hl)*poisson(z,al);
    const p=Math.max(base*dcTau(h,z,hl,al,rho),0);
    a.push({h,a:z,p});
  }
  const s=a.reduce((q,x)=>q+x.p,0);
  return a.map(x=>({...x,p:x.p/s}));
}
const probability=(m,f)=>m.filter(f).reduce((s,x)=>s+x.p,0);
function overPoisson(lambda,line){const k=Math.floor(line)+1;let p=0;for(let i=k;i<30;i++)p+=poisson(i,lambda);return clamp(p,0,1);}
function empiricalOver(values,line){const xs=values.filter(Number.isFinite);return xs.length?xs.filter(x=>x>line).length/xs.length:null;}
function cornerSample(rows){
  const valid=(rows||[]).filter(x=>Number.isFinite(x.corners)&&Number.isFinite(x.cornersAgainst));
  if(!valid.length)return{matches:0,forAvg:null,againstAvg:null,totalAvg:null,totals:[]};
  const totals=valid.map(x=>x.corners+x.cornersAgainst);
  return{
    matches:valid.length,
    forAvg:weightedAvg(valid,"corners"),
    againstAvg:weightedAvg(valid,"cornersAgainst"),
    totalAvg:weightedAvg(valid.map((x,i)=>({...x,total:totals[i]})),"total"),
    totals
  };
}
function weightedProb(items){
  let n=0,d=0;
  for(const [p,w] of items){if(p==null||!Number.isFinite(p)||w<=0)continue;n+=p*w;d+=w;}
  return d?n/d:null;
}
function pct1(v){return v==null?null:+v.toFixed(1);}


/* ---------------- Model ---------------- */

function firstOdd(row,keys){
  for(const k of keys){const v=decimalOdd(row?.[k]);if(v)return v}
  return null;
}
async function footballDataFixtureOdds(f,date){
  const div=LEAGUES[f?.leagueCode]?.csv;
  if(!div)return null;
  try{
    const rows=await loadCSV("2627",div);
    const match=rows.find(r=>{
      const d=parseDate(r.Date); if(!d||localYmdFromDate(d)!==date)return false;
      return similarity(r.HomeTeam||"",f.home?.name||"")>=.80&&similarity(r.AwayTeam||"",f.away?.name||"")>=.80;
    });
    if(!match)return null;
    const opening={},closing={};
    const put=(name,openKeys,closeKeys)=>{
      const o=firstOdd(match,openKeys),c=firstOdd(match,closeKeys);
      if(o)opening[name]=o;if(c)closing[name]=c;
    };
    put("1",["AvgH","MaxH","B365H"],["AvgCH","MaxCH","B365CH"]);
    put("X",["AvgD","MaxD","B365D"],["AvgCD","MaxCD","B365CD"]);
    put("2",["AvgA","MaxA","B365A"],["AvgCA","MaxCA","B365CA"]);
    put("2.5 Üst",["Avg>2.5","Max>2.5","B365>2.5"],["AvgC>2.5","MaxC>2.5","B365C>2.5"]);
    put("2.5 Alt",["Avg<2.5","Max<2.5","B365<2.5"],["AvgC<2.5","MaxC<2.5","B365C<2.5"]);
    return Object.keys(opening).length||Object.keys(closing).length
      ? {opening,closing,provider:"Football-Data.co.uk",fetchedAt:new Date().toISOString()}
      : null;
  }catch{return null}
}

function mergeOddsSources(oddsApiOdds,apiOdds,fdOdds,fixtureId){
  if(!oddsApiOdds&&!apiOdds&&!fdOdds)return null;
  const current={...(fdOdds?.closing||{}),...(apiOdds?.odds||{}),...(oddsApiOdds?.odds||{})};
  const opening={...(fdOdds?.opening||{})};
  const bookmakers={...(apiOdds?.bookmakers||{}),...(oddsApiOdds?.bookmakers||{})};
  let movement=oddsMovementForFixture(fixtureId,current);
  for(const [name,o] of Object.entries(opening)){
    const c=Number(current[name]);
    if(!(Number(o)>1&&c>1))continue;
    movement[name]={
      opening:+Number(o).toFixed(3),current:+c.toFixed(3),
      oddsMovePct:+(((c-Number(o))/Number(o))*100).toFixed(1),
      impliedMovePts:+(((1/c)-(1/Number(o)))*100).toFixed(1),
      direction:c<Number(o)?"shortening":c>Number(o)?"drifting":"flat",
      firstSeen:"football-data-opening",lastSeen:oddsApiOdds?.providerUpdatedAt||apiOdds?.providerUpdatedAt||apiOdds?.fetchedAt||fdOdds?.fetchedAt||null,
      openingProvider:"Football-Data.co.uk"
    };
  }
  return {
    odds:current,opening,bookmakers,movement,
    comparisonTable:oddsApiOdds?.comparisonTable||null,
    provider:oddsApiOdds?.provider||apiOdds?.provider||fdOdds?.provider||null,
    providers:[...new Set([oddsApiOdds?.provider,apiOdds?.provider,fdOdds?.provider].filter(Boolean))],
    fetchedAt:oddsApiOdds?.fetchedAt||apiOdds?.fetchedAt||fdOdds?.fetchedAt||new Date().toISOString(),
    providerUpdatedAt:oddsApiOdds?.providerUpdatedAt||apiOdds?.providerUpdatedAt||null
  };
}
function normalizeOddLabel(v){
  return String(v||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/ı/g,"i").replace(/ş/g,"s").replace(/ğ/g,"g").replace(/ü/g,"u").replace(/ö/g,"o").replace(/ç/g,"c")
    .replace(/[^a-z0-9.+-]+/g," ").replace(/\s+/g," ").trim();
}
function decimalOdd(v){const n=Number(String(v??"").replace(",","."));return Number.isFinite(n)&&n>1?n:null}
function bestBookmakerOdd(bookmakers,pred){
  let best=null,bookmaker=null;
  for(const b of bookmakers||[]){
    for(const bet of b.bets||[]){
      for(const val of bet.values||[]){
        if(!pred(bet,val))continue;
        const o=decimalOdd(val.odd);
        if(o&&(best==null||o>best)){best=o;bookmaker=b.name||null}
      }
    }
  }
  return best?{odd:best,bookmaker}:null;
}
async function apiFixtureMarketOdds(f){
  if(!API_KEY||!f?.apiFixtureId)return null;
  const k=`prematch-odds-v2:${f.apiFixtureId}`,c=getCache(k);if(c)return c;
  try{
    const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),4800);
    const url=`${API_BASE}/odds?fixture=${encodeURIComponent(f.apiFixtureId)}`;
    const r=await fetch(url,{headers:{"x-apisports-key":API_KEY},signal:ctrl.signal});
    clearTimeout(timer);
    if(!r.ok)return null;
    const b=await r.json();
    if(b.errors&&Object.keys(b.errors).length)return null;
    const rows=b.response||[];

    const bookmakers=rows.flatMap(x=>x.bookmakers||[]);
    if(!bookmakers.length)return null;
    const out={},meta={};

    const put=(name,pred)=>{
      const x=bestBookmakerOdd(bookmakers,pred);
      if(x){out[name]=x.odd;meta[name]=x.bookmaker;}
    };
    const betName=(bet)=>normalizeOddLabel(bet.name);
    const valName=(val)=>normalizeOddLabel(val.value);

    put("1",(bet,val)=>/match\s*winner|winner|1x2/.test(betName(bet))&&/^(home|1)$/.test(valName(val)));
    put("X",(bet,val)=>/match\s*winner|winner|1x2/.test(betName(bet))&&/^(draw|x)$/.test(valName(val)));
    put("2",(bet,val)=>/match\s*winner|winner|1x2/.test(betName(bet))&&/^(away|2)$/.test(valName(val)));

    put("1X",(bet,val)=>/double chance/.test(betName(bet))&&/home.?draw|1x/.test(valName(val)));
    put("X2",(bet,val)=>/double chance/.test(betName(bet))&&/draw.?away|x2/.test(valName(val)));
    put("12",(bet,val)=>/double chance/.test(betName(bet))&&/home.?away|12/.test(valName(val)));

    put("2.5 Üst",(bet,val)=>/goals?\s*over\s*under|over\s*under|total\s*goals?/.test(betName(bet))&&/over 2\.5|2\.5 over/.test(valName(val)));
    put("2.5 Alt",(bet,val)=>/goals?\s*over\s*under|over\s*under|total\s*goals?/.test(betName(bet))&&/under 2\.5|2\.5 under/.test(valName(val)));
    put("1.5 Üst",(bet,val)=>/goals?\s*over\s*under|over\s*under|total\s*goals?/.test(betName(bet))&&/over 1\.5|1\.5 over/.test(valName(val)));
    put("3.5 Alt",(bet,val)=>/goals?\s*over\s*under|over\s*under|total\s*goals?/.test(betName(bet))&&/under 3\.5|3\.5 under/.test(valName(val)));

    put("KG Var",(bet,val)=>/both\s*teams.*score|btts/.test(betName(bet))&&/^(yes|var)$/.test(valName(val)));
    put("KG Yok",(bet,val)=>/both\s*teams.*score|btts/.test(betName(bet))&&/^(no|yok)$/.test(valName(val)));

    put("Ev 1.5 Üst",(bet,val)=>/home.*total|home\s*team.*goals/.test(betName(bet))&&/over 1\.5|1\.5 over/.test(valName(val)));
    put("Dep 1.5 Üst",(bet,val)=>/away.*total|away\s*team.*goals/.test(betName(bet))&&/over 1\.5|1\.5 over/.test(valName(val)));

    put("İY 0.5 Üst",(bet,val)=>/first\s*half.*over\s*under|1st\s*half.*over\s*under/.test(betName(bet))&&/over 0\.5|0\.5 over/.test(valName(val)));
    put("İY 1.5 Üst",(bet,val)=>/first\s*half.*over\s*under|1st\s*half.*over\s*under/.test(betName(bet))&&/over 1\.5|1\.5 over/.test(valName(val)));

    for(const line of [7.5,8.5,9.5,10.5,11.5,12.5]){
      put(`Korner ${line} Üst`,(bet,val)=>/corner/.test(betName(bet))&&new RegExp(`over ${String(line).replace(".","\\.")}|${String(line).replace(".","\\.")} over`).test(valName(val)));
      put(`Korner ${line} Alt`,(bet,val)=>/corner/.test(betName(bet))&&new RegExp(`under ${String(line).replace(".","\\.")}|${String(line).replace(".","\\.")} under`).test(valName(val)));
    }

    const providerUpdatedAt=rows.map(x=>x.update).filter(Boolean).sort().at(-1)||null;
    const result={odds:out,bookmakers:meta,provider:"API-Football",fetchedAt:new Date().toISOString(),providerUpdatedAt};
    recordOddsSnapshot(f.apiFixtureId,result);
    result.movement=oddsMovementForFixture(f.apiFixtureId,out);
    setCache(k,result,180000);
    return result;
  }catch(e){console.warn("API odds:",e.message);return null}
}

/* ---------------- The Odds API (real multi-bookmaker odds) ----------------
   Free key from the-odds-api.com. Sport keys are resolved dynamically from
   /v4/sports (does not count against quota) instead of being hard-coded,
   since exact slugs are undocumented/unstable for smaller leagues.
------------------------------------------------------------------------- */
const ODDS_API_HINTS={
  PL:/england.*premier|premier league.*england|\bepl\b/i,
  CH:/england.*championship|championship.*england/i,
  L1:/england.*league ?1|league one.*england/i,
  L2:/england.*league ?2|league two.*england/i,
  PD:/spain.*la ?liga(?!.*2)|la ?liga.*spain(?!.*2)/i,
  SD:/spain.*la ?liga ?2|segunda.*spain/i,
  SA:/italy.*serie ?a/i,
  SB:/italy.*serie ?b/i,
  BL1:/germany.*bundesliga(?!.*2)/i,
  BL2:/germany.*bundesliga ?2/i,
  FL1:/france.*ligue ?1/i,
  FL2:/france.*ligue ?2/i,
  DED:/netherlands.*eredivisie|dutch.*eredivisie/i,
  BEL:/belgium.*first ?div/i,
  PPL:/portugal.*primeira/i,
  GRE:/greece.*super ?league/i,
  SCP:/scotland.*premiership/i,
  TSL:/turkey.*super ?league/i,
  UCL:/uefa.*champions ?league(?!.*qual)/i,
  UEL:/uefa.*europa ?league(?!.*conf)/i,
  UECL:/uefa.*europa.*conf/i,
  FAC:/\bfa ?cup\b/i,
  CDR:/copa del rey/i,
  DFB:/dfb.?pokal/i,
  CDF:/coupe de france/i,
  CIT:/coppa italia/i,
  RPL:/russia.*premier ?league/i,
  POL:/poland.*ekstraklasa/i,
  DEN:/denmark.*superliga/i,
  SWE:/sweden.*allsvenskan/i,
  SWE2:/sweden.*superettan/i,
  SUI:/switzerland.*super ?league/i,
  AUT:/austria.*bundesliga/i,
  NOR:/norway.*eliteserien/i,
  IRL:/ireland.*league of ireland/i,
  FIN:/finland.*veikkausliiga/i
};
let oddsApiSportMap=null,oddsApiSportMapPromise=null;
async function ensureOddsApiSportKeys(){
  if(!ODDS_API_KEY)return {};
  if(oddsApiSportMap)return oddsApiSportMap;
  if(oddsApiSportMapPromise)return oddsApiSportMapPromise;
  oddsApiSportMapPromise=(async()=>{
    try{
      const r=await fetchT(`${ODDS_API_BASE}/sports/?apiKey=${encodeURIComponent(ODDS_API_KEY)}&all=true`);
      if(!r.ok){console.warn("The Odds API /sports:",r.status);return {};}
      const rows=await r.json();
      const map={};
      for(const [code,re] of Object.entries(ODDS_API_HINTS)){
        const hit=(rows||[]).find(s=>re.test(`${s.group||""} ${s.title||""} ${s.description||""}`));
        if(hit)map[code]=hit.key;
      }
      oddsApiSportMap=map;
      return map;
    }catch(e){console.warn("The Odds API sport map:",e.message);return {};}
  })().finally(()=>{oddsApiSportMapPromise=null;});
  return oddsApiSportMapPromise;
}
async function oddsApiLeagueOdds(sportKey){
  if(!ODDS_API_KEY||!sportKey)return [];
  const k=`odds-api-league:${sportKey}`,c=getCache(k);if(c)return c;
  try{
    const url=`${ODDS_API_BASE}/sports/${encodeURIComponent(sportKey)}/odds/?apiKey=${encodeURIComponent(ODDS_API_KEY)}&regions=eu,uk&markets=h2h,totals&oddsFormat=decimal`;
    const r=await fetchT(url);
    if(!r.ok){console.warn("The Odds API odds:",sportKey,r.status);setCache(k,[],300000);return [];}
    const rows=await r.json();
    setCache(k,rows||[],ODDS_API_CACHE_TTL_MS);
    return rows||[];
  }catch(e){console.warn("The Odds API odds fetch:",e.message);return [];}
}
function bestAcrossBookmakers(event,marketKey,outcomePred){
  let best=null,bookmaker=null;
  const table=[];
  for(const bm of event.bookmakers||[]){
    const mkt=(bm.markets||[]).find(m=>m.key===marketKey);
    if(!mkt)continue;
    for(const out of mkt.outcomes||[]){
      if(!outcomePred(out))continue;
      const price=Number(out.price);
      if(!Number.isFinite(price)||price<=1)continue;
      table.push({bookmaker:bm.title||bm.key,odd:price});
      if(best==null||price>best){best=price;bookmaker=bm.title||bm.key;}
    }
  }
  return {best,bookmaker,table};
}
async function theOddsApiFixtureOdds(f){
  if(!ODDS_API_KEY||!f)return null;
  const sportMap=await ensureOddsApiSportKeys();
  const sportKey=sportMap[f.leagueCode];
  if(!sportKey)return null;
  const events=await oddsApiLeagueOdds(sportKey);
  if(!events.length)return null;
  const fLocalDate=f.localDate;
  let match=null,bestScore=0;
  for(const ev of events){
    const evDate=localYmdFromDate(ev.commence_time);
    if(evDate!==fLocalDate)continue;
    const hs=similarity(ev.home_team||"",f.home?.name||"");
    const as=similarity(ev.away_team||"",f.away?.name||"");
    const score=Math.min(hs,as);
    if(score>bestScore){bestScore=score;match=ev;}
  }
  if(!match||bestScore<0.55)return null;

  const out={},meta={},comparisonTable={};
  const put=(name,marketKey,pred)=>{
    const r=bestAcrossBookmakers(match,marketKey,pred);
    if(r.best){out[name]=r.best;meta[name]=r.bookmaker;comparisonTable[name]=r.table.sort((a,b)=>b.odd-a.odd).slice(0,8);}
  };
  put("1","h2h",o=>similarity(o.name||"",match.home_team||"")>=0.8);
  put("X","h2h",o=>/^draw$/i.test(String(o.name||"").trim()));
  put("2","h2h",o=>similarity(o.name||"",match.away_team||"")>=0.8);
  put("2.5 Üst","totals",o=>/^over$/i.test(o.name||"")&&Number(o.point)===2.5);
  put("2.5 Alt","totals",o=>/^under$/i.test(o.name||"")&&Number(o.point)===2.5);
  put("1.5 Üst","totals",o=>/^over$/i.test(o.name||"")&&Number(o.point)===1.5);
  put("3.5 Alt","totals",o=>/^under$/i.test(o.name||"")&&Number(o.point)===3.5);

  if(!Object.keys(out).length)return null;
  const fid=f.apiFixtureId||f.id;
  const result={odds:out,bookmakers:meta,comparisonTable,provider:"The Odds API",fetchedAt:new Date().toISOString(),
    providerUpdatedAt:match.bookmakers?.map(b=>b.last_update).filter(Boolean).sort().at(-1)||null};
  recordOddsSnapshot(fid,result);
  result.movement=oddsMovementForFixture(fid,out);
  return result;
}

function impliedProbability(odd){
  const o=Number(odd);return Number.isFinite(o)&&o>1?1/o:null;
}
function fairOddFromProbability(p){
  const q=Number(p);return q>0?1/q:null;
}
function marketValueAnalysis(markets=[],fixtureOdds=null){
  const odds=fixtureOdds||{};
  return (markets||[]).map(m=>{
    const p=Number(m.probability)/100;
    const fair=fairOddFromProbability(p);
    const marketOdd=Number(odds[m.name]??odds[m.group]?.[m.name]);
    const implied=impliedProbability(marketOdd);
    const edge=Number.isFinite(marketOdd)&&marketOdd>1 ? p-(1/marketOdd) : null;
    const ev=Number.isFinite(marketOdd)&&marketOdd>1 ? p*marketOdd-1 : null;
    const mv=fixtureOdds?.__movement?.[m.name]||null;
    return {...m,fairOdd:fair?Number(fair.toFixed(2)):null,marketOdd:Number.isFinite(marketOdd)?marketOdd:null,
      impliedProbability:implied==null?null:pct(implied),edge:edge==null?null:pct(edge),expectedValue:ev==null?null:pct(ev),
      openingOdd:mv?.opening??null,oddsMovePct:mv?.oddsMovePct??null,impliedMovePts:mv?.impliedMovePts??null,movementDirection:mv?.direction??null};
  });
}
// Tunable bet-decision thresholds. Loosened on user request from the original
// conservative defaults (70/45/58/4/5) to surface more BET/PLAYABLE signals.
// Lower thresholds trade some precision for more frequent picks — the model's
// probability/edge/EV numbers next to each pick still show the real confidence.
const BET_PROB_MIN=62;
const BET_CONF_MIN=40;
const BET_VALUE_PROB_MIN=52;
const BET_VALUE_EDGE_MIN=3;
const BET_VALUE_EV_MIN=3;
const MODEL_LEAN_CONF_MIN=42;
function selectBetRecommendation(valueMarkets=[]){
  const withOdds=valueMarkets.filter(x=>x.marketOdd&&x.edge!=null&&x.expectedValue!=null);
  if(withOdds.length){
    const ranked=withOdds
      .filter(x=>Number(x.marketOdd)>=1.28)
      .filter(x=>{
        const p=Number(x.analysisProbability??x.probability);
        const c=Number(x.analysisConfidence??x.confidence);
        // 70%+ is a strong probability; lower probabilities can still qualify only with stronger value.
        const strongProb=p>=BET_PROB_MIN;
        const valueCase=p>=BET_VALUE_PROB_MIN&&Number(x.edge)>=BET_VALUE_EDGE_MIN&&Number(x.expectedValue)>=BET_VALUE_EV_MIN;
        return c>=BET_CONF_MIN&&(strongProb||valueCase)&&Number(x.edge)>=0&&Number(x.expectedValue)>=0;
      })
      .map(x=>{
        const p=Number(x.analysisProbability??x.probability);
        const move=Number(x.impliedMovePts);
        let movementScore=0;
        if(Number.isFinite(move))movementScore=clamp(move,-6,6);
        const odd=Number(x.marketOdd);
        const oddScore=odd>=1.28&&odd<1.40?2:odd<1.70?4:odd<2.20?6:4;
        return {...x,movementScore,
          valueScore:p*.45+Number(x.expectedValue)*.65+Number(x.edge)*.55+
            Number(x.analysisConfidence??x.confidence)*.14+movementScore*.5+oddScore};
      })
      .sort((a,b)=>b.valueScore-a.valueScore);

    if(ranked[0]){
      const top=ranked[0];
      if(Number(top.impliedMovePts)<=-5&&Number(top.edge)<6)return {decision:"NO BET",reason:"market-drift-conflict"};
      return {...top,decision:"BET",reason:"probability-price-value"};
    }
    return {decision:"NO BET",reason:"no-playable-value"};
  }

  const ranked=valueMarkets.filter(x=>{
    const p=Number(x.analysisProbability??x.probability);
    const c=Number(x.analysisConfidence??x.confidence);
    return p>=BET_PROB_MIN&&c>=MODEL_LEAN_CONF_MIN;
  }).sort((a,b)=>Number(b.analysisProbability??b.probability)-Number(a.analysisProbability??a.probability));

  return ranked[0]?{...ranked[0],decision:"MODEL LEAN",reason:"odds-unavailable"}:{decision:"NO BET",reason:"weak-model"};
}


function noVigMarketProbabilities(valueMarkets=[]){
  const byName=Object.fromEntries((valueMarkets||[]).map(x=>[x.name,x]));
  const out={};
  const normalizeSet=(names)=>{
    const rows=names.map(n=>byName[n]).filter(x=>Number(x?.marketOdd)>1);
    if(rows.length!==names.length)return;
    const raw=rows.map(x=>1/Number(x.marketOdd));
    const sum=raw.reduce((a,b)=>a+b,0);
    if(!(sum>0))return;
    rows.forEach((x,i)=>{out[x.name]=raw[i]/sum;});
  };
  normalizeSet(["1","X","2"]);
  normalizeSet(["2.5 Üst","2.5 Alt"]);
  normalizeSet(["KG Var","KG Yok"]);
  for(const line of [7.5,8.5,9.5,10.5,11.5,12.5]){
    normalizeSet([`Korner ${line} Üst`,`Korner ${line} Alt`]);
  }
  return out;
}

function marketAwareMarkets(valueMarkets=[],dataQuality=60){
  const noVig=noVigMarketProbabilities(valueMarkets);
  return (valueMarkets||[]).map(x=>{
    const modelP=Number(x.probability)/100;
    const marketP=noVig[x.name];
    if(!Number.isFinite(marketP)){
      return {...x,modelProbability:x.probability,analysisProbability:x.probability,marketProbability:null,
        marketAgreement:null,marketWeight:0,analysisConfidence:x.confidence};
    }
    const marketWeight=dataQuality>=78?.10:dataQuality>=65?.13:.16;
    const blended=clamp(modelP*(1-marketWeight)+marketP*marketWeight,.02,.98);
    const agreement=(modelP-marketP)*100;
    let conf=Number(x.confidence)||40;
    if(Math.abs(agreement)<=5)conf+=4;
    else if(Math.abs(agreement)>=12)conf-=6;
    const mv=Number(x.impliedMovePts);
    if(Number.isFinite(mv)){
      if(mv>=2)conf+=2;
      if(mv<=-3)conf-=3;
    }
    return {...x,
      modelProbability:x.probability,
      analysisProbability:pct(blended),
      marketProbability:pct(marketP),
      marketAgreement:+agreement.toFixed(1),
      marketWeight:pct(marketWeight),
      analysisConfidence:Math.round(clamp(conf,25,88))
    };
  });
}

function kellyStakePct(p,odd,fractional=0.5){
  if(!Number.isFinite(p)||!Number.isFinite(odd)||odd<=1)return null;
  const b=odd-1,q=1-p;
  const raw=(b*p-q)/b;
  if(!Number.isFinite(raw)||raw<=0)return 0;
  return Math.round(clamp(raw*fractional,0,0.25)*1000)/10;
}
function withKellyStakes(markets=[]){
  return (markets||[]).map(x=>{
    const p=Number(x.analysisProbability??x.probability)/100;
    const odd=Number(x.marketOdd);
    const full=kellyStakePct(p,odd,1);
    return {...x,kelly:full==null?null:{full,half:kellyStakePct(p,odd,.5),quarter:kellyStakePct(p,odd,.25)}};
  });
}
function marketAwareRecommendations(markets=[]){
  const pref={"Çifte Şans":8,"Gol":7,"1X2":6,"KG":5,"Takım Gol":4,"Korner":3,"İlk Yarı":2,"İkinci Yarı":1,"Yarı":0};
  return (markets||[])
    .filter(x=>Number(x.analysisProbability??x.probability)>=54&&Number(x.analysisConfidence??x.confidence)>=40)
    .filter(x=>x.group!=="İkinci Yarı"||(Number(x.analysisProbability??x.probability)>=66&&Number(x.analysisConfidence??x.confidence)>=48))
    .map(x=>{
      const p=Number(x.analysisProbability??x.probability);
      const c=Number(x.analysisConfidence??x.confidence);
      const edge=Number(x.edge),ev=Number(x.expectedValue),mv=Number(x.impliedMovePts);
      const valueBonus=Number.isFinite(edge)&&Number.isFinite(ev)?clamp(edge,-8,12)*.35+clamp(ev,-12,18)*.18:0;
      const movementBonus=Number.isFinite(mv)?clamp(mv,-5,5)*.35:0;
      const agreementPenalty=Number.isFinite(Number(x.marketAgreement))&&Math.abs(Number(x.marketAgreement))>=12?3:0;
      return {...x,rankingScore:p*.54+c*.31+(pref[x.group]||0)+valueBonus+movementBonus-agreementPenalty};
    })
    .sort((a,b)=>b.rankingScore-a.rankingScore);
}

function selectVisibleRecommendations(ranked=[]){
  const rec=[],groupCount={};
  for(const x of ranked){
    const cap=(x.group==="Gol"||x.group==="Çifte Şans")?2:1;
    if((groupCount[x.group]||0)>=cap)continue;
    if(x.group==="İkinci Yarı"&&rec.some(y=>y.group==="İlk Yarı"||y.group==="Yarı"))continue;
    rec.push(x);groupCount[x.group]=(groupCount[x.group]||0)+1;
    if(rec.length>=7)break;
  }
  return rec;
}

function strongestSignalScore(x){
  const p=Number(x.analysisProbability??x.probability)||0;
  const c=Number(x.analysisConfidence??x.confidence)||0;
  const odd=Number(x.marketOdd);
  const ev=Number(x.expectedValue);
  const edge=Number(x.edge);
  const move=Number(x.impliedMovePts);

  let score=p*.62+c*.22;
  if(Number.isFinite(odd)&&odd>1){
    if(odd<1.28)score-=14;
    else if(odd<1.40)score+=2;
    else if(odd<1.70)score+=5;
    else if(odd<2.20)score+=7;
    else score+=5;

    if(Number.isFinite(ev))score+=clamp(ev,-20,25)*.55;
    if(Number.isFinite(edge))score+=clamp(edge,-15,18)*.45;
    if(Number.isFinite(move))score+=clamp(move,-6,6)*.25;
  }

  if(p>=BET_PROB_MIN)score+=8;
  if(p>=78)score+=3;
  if(p<55)score-=8;
  return score;
}

function chooseStrongestSignal(markets=[],betRecommendation=null){
  const all=(markets||[]).filter(Boolean);

  // 1) True playable priced candidates first.
  const playable=all.filter(x=>{
    const p=Number(x.analysisProbability??x.probability)||0;
    const c=Number(x.analysisConfidence??x.confidence)||0;
    const odd=Number(x.marketOdd);
    const ev=x.expectedValue==null?null:Number(x.expectedValue);
    const edge=x.edge==null?null:Number(x.edge);
    return odd>=1.28 && p>=BET_PROB_MIN && c>=BET_CONF_MIN &&
      (ev==null||ev>=0) &&
      (edge==null||edge>=0);
  }).sort((a,b)=>strongestSignalScore(b)-strongestSignalScore(a));

  if(playable[0]){
    return {...playable[0],
      decision:betRecommendation?.name===playable[0].name&&betRecommendation?.decision==="BET"?"BET":"PLAYABLE"};
  }

  // 2) No worthwhile priced bet: do not let a random priced market hide the strongest model signal.
  const strongModel=all.filter(x=>{
    const p=Number(x.analysisProbability??x.probability)||0;
    const c=Number(x.analysisConfidence??x.confidence)||0;
    return p>=BET_PROB_MIN&&c>=BET_CONF_MIN;
  }).sort((a,b)=>strongestSignalScore(b)-strongestSignalScore(a));

  if(strongModel[0])return {...strongModel[0],decision:"MODEL LEAN"};

  // 3) Fallback to best analytical signal.
  const ranked=all.slice().sort((a,b)=>strongestSignalScore(b)-strongestSignalScore(a));
  return ranked[0]?{...ranked[0],decision:"MODEL LEAN"}:null;
}

function confidence({p,current,total,dataQuality,market}){
  let c=38+Math.abs(p-.5)*42+Math.min(12,current*1.6)+(dataQuality-60)*.18;
  if(total<5)c=Math.min(c,42);if(current<5)c=Math.min(c,48);if(current<=2)c=Math.min(c,40);
  if(market==="corners"&&dataQuality<70)c-=6;
  return Math.round(clamp(c,25,84));
}
function buildModel(h,home,away,leagueH=h,fixtureOdds=null){
  const la=leagueAvg(leagueH),ha=teamStats(h,home),aa=teamStats(h,away),hv=teamStats(h,home,"home")||ha,av=teamStats(h,away,"away")||aa;
  if(!ha||!aa)throw new Error("No data");
  const table=buildTable(leagueH),ht=table.find(x=>x.team===home)||null,at=table.find(x=>x.team===away)||null,elo=eloRatings(h),eh=elo[home]||1500,ea=elo[away]||1500;
  const H2H=h2h(h,home,away),co=commonOpp(h,home,away);
  const tableAdj=ht&&at&&ht.p>=3&&at.p>=3?clamp((ht.ppg-at.ppg)*.10,-.22,.22):0;
  const eloAdj=clamp((eh-ea)/900,-.28,.28);
  let hl=(safe(hv.gf,la.homeGoals)*.39+safe(av.ga,la.homeGoals)*.28+la.homeGoals*.18+safe(ha.gf,la.homeGoals)*.08+safe(aa.ga,la.homeGoals)*.07)+tableAdj+eloAdj+co.adj;
  let al=(safe(av.gf,la.awayGoals)*.39+safe(hv.ga,la.awayGoals)*.28+la.awayGoals*.18+safe(aa.gf,la.awayGoals)*.08+safe(ha.ga,la.awayGoals)*.07)-tableAdj-eloAdj-co.adj;
  if(H2H.matches>=2){hl=hl*.9+H2H.homeGF*.1;al=al*.9+H2H.awayGF*.1;}
  const shotEdge=(safe(hv.sot,0)-safe(av.sotAgainst,0)-safe(av.sot,0)+safe(hv.sotAgainst,0))*.015;hl+=clamp(shotEdge,-.12,.12);al-=clamp(shotEdge,-.12,.12);
  hl=clamp(hl,.25,3.6);al=clamp(al,.2,3.3);
  const m=scoreMatrix(hl,al,8),pHome=probability(m,x=>x.h>x.a),pDraw=probability(m,x=>x.h===x.a),pAway=probability(m,x=>x.h<x.a),pOver25=probability(m,x=>x.h+x.a>=3),pBTTS=probability(m,x=>x.h>0&&x.a>0);

  const fhHL=clamp(safe(hv.htGF,hl*.43)*.45+safe(av.htGA,hl*.43)*.35+la.htGoals*.52*.20,.06,1.8),fhAL=clamp(safe(av.htGF,al*.43)*.45+safe(hv.htGA,al*.43)*.35+la.htGoals*.48*.20,.05,1.6);
  const fm=scoreMatrix(fhHL,fhAL,5),pFH05=probability(fm,x=>x.h+x.a>=1),pFH15=probability(fm,x=>x.h+x.a>=2),pFHBTTS=probability(fm,x=>x.h>0&&x.a>0);
  const pFHHomeGoal=probability(fm,x=>x.h>=1),pFHAwayGoal=probability(fm,x=>x.a>=1);
  const shHL=clamp(safe(hv.shGF,hl-fhHL)*.45+safe(av.shGA,hl-fhHL)*.35+(hl-fhHL)*.20,.08,2),shAL=clamp(safe(av.shGF,al-fhAL)*.45+safe(hv.shGA,al-fhAL)*.35+(al-fhAL)*.20,.08,1.9);
  const sm=scoreMatrix(shHL,shAL,5),pSH05=probability(sm,x=>x.h+x.a>=1),pSH15=probability(sm,x=>x.h+x.a>=2);
  const halfTotal=fhHL+fhAL+shHL+shAL,firstShare=(fhHL+fhAL)/halfTotal,secondShare=1-firstShare,equal=clamp(.32-Math.abs(firstShare-secondShare)*.4,.12,.32),first=firstShare*(1-equal),second=secondShare*(1-equal);

  const cur=Math.min(ha.current,aa.current),tot=Math.min(ha.matches,aa.matches);
  let dq=55;dq+=Math.min(15,cur*2);if(hv.shots!=null&&av.shots!=null)dq+=8;if(hv.sot!=null&&av.sot!=null)dq+=8;if(hv.corners!=null&&av.corners!=null)dq+=8;if(ht&&at)dq+=6;dq=Math.round(clamp(dq,35,100));
  const mk=(name,p,group,market="goals")=>({name,group,probability:pct(p),confidence:confidence({p,current:cur,total:tot,dataQuality:dq,market})});
  const pOver15=probability(m,x=>x.h+x.a>=2),pUnder35=probability(m,x=>x.h+x.a<=3);
  const markets=[mk("1",pHome,"1X2"),mk("X",pDraw,"1X2"),mk("2",pAway,"1X2"),
    mk("1X",pHome+pDraw,"Çifte Şans"),mk("X2",pAway+pDraw,"Çifte Şans"),mk("12",pHome+pAway,"Çifte Şans"),
    mk("1.5 Üst",pOver15,"Gol"),mk("2.5 Üst",pOver25,"Gol"),mk("2.5 Alt",1-pOver25,"Gol"),mk("3.5 Alt",pUnder35,"Gol"),
    mk("KG Var",pBTTS,"KG"),mk("KG Yok",1-pBTTS,"KG"),
    mk("Ev 1.5 Üst",probability(m,x=>x.h>=2),"Takım Gol"),mk("Dep 1.5 Üst",probability(m,x=>x.a>=2),"Takım Gol"),
    mk("İY 0.5 Üst",pFH05,"İlk Yarı"),mk("İY 1.5 Üst",pFH15,"İlk Yarı"),mk("İY KG Var",pFHBTTS,"İlk Yarı"),
    mk("İY Ev Gol",pFHHomeGoal,"İlk Yarı"),mk("İY Dep Gol",pFHAwayGoal,"İlk Yarı"),
    mk("2Y 0.5 Üst",pSH05,"İkinci Yarı"),mk("2Y 1.5 Üst",pSH15,"İkinci Yarı"),
    mk("Daha Çok Gol: İlk Yarı",first,"Yarı"),mk("Daha Çok Gol: İkinci Yarı",second,"Yarı"),mk("Yarılar Eşit",equal,"Yarı")];

  // Corner model: analyse each team's recent match-by-match corner production/concession.
  // Venue-specific samples receive the highest weight, then overall recent form and league baseline.
  const homeAll=cornerSample(ha.rows),awayAll=cornerSample(aa.rows);
  const homeVenue=cornerSample(hv.rows),awayVenue=cornerSample(av.rows);
  const leagueTeamCorner=la.corners==null?null:la.corners/2;

  let expHomeCorners=null,expAwayCorners=null,cornerLambda=null;
  if(homeVenue.forAvg!=null||homeAll.forAvg!=null){
    expHomeCorners=
      safe(homeVenue.forAvg,homeAll.forAvg??leagueTeamCorner??4.8)*.48+
      safe(awayVenue.againstAvg,awayAll.againstAvg??leagueTeamCorner??4.8)*.32+
      safe(homeAll.forAvg,leagueTeamCorner??4.8)*.12+
      safe(leagueTeamCorner,4.8)*.08;
  }
  if(awayVenue.forAvg!=null||awayAll.forAvg!=null){
    expAwayCorners=
      safe(awayVenue.forAvg,awayAll.forAvg??leagueTeamCorner??4.8)*.48+
      safe(homeVenue.againstAvg,homeAll.againstAvg??leagueTeamCorner??4.8)*.32+
      safe(awayAll.forAvg,leagueTeamCorner??4.8)*.12+
      safe(leagueTeamCorner,4.8)*.08;
  }
  if(expHomeCorners!=null&&expAwayCorners!=null)cornerLambda=clamp(expHomeCorners+expAwayCorners,4.5,16.5);
  else if(la.corners!=null)cornerLambda=la.corners;

  const cornerLines=[7.5,8.5,9.5,10.5,11.5,12.5];
  const cornerMarkets=[];
  const cornerLineStats=[];
  if(cornerLambda!=null){
    for(const line of cornerLines){
      const poissonOver=overPoisson(cornerLambda,line);
      const hVenueOver=empiricalOver(homeVenue.totals,line),aVenueOver=empiricalOver(awayVenue.totals,line);
      const hAllOver=empiricalOver(homeAll.totals,line),aAllOver=empiricalOver(awayAll.totals,line);
      const empirical=weightedProb([
        [hVenueOver,Math.min(homeVenue.matches,10)*1.25],
        [aVenueOver,Math.min(awayVenue.matches,10)*1.25],
        [hAllOver,Math.min(homeAll.matches,10)*.70],
        [aAllOver,Math.min(awayAll.matches,10)*.70]
      ]);
      const sampleN=homeVenue.matches+awayVenue.matches;
      const empiricalWeight=clamp(sampleN/20,.25,.55);
      const pOver=clamp(poissonOver*(1-empiricalWeight)+(empirical??poissonOver)*empiricalWeight,.03,.97);
      const pUnder=1-pOver;
      cornerMarkets.push(mk(`Korner ${line} Üst`,pOver,"Korner","corners"));
      cornerMarkets.push(mk(`Korner ${line} Alt`,pUnder,"Korner","corners"));
      cornerLineStats.push({line,over:pct(pOver),under:pct(pUnder)});
    }
  }
  const cornerProfile={
    expectedTotal:cornerLambda==null?null:+cornerLambda.toFixed(2),
    expectedHome:expHomeCorners==null?null:+expHomeCorners.toFixed(2),
    expectedAway:expAwayCorners==null?null:+expAwayCorners.toFixed(2),
    home:{matches:homeVenue.matches,forAvg:pct1(homeVenue.forAvg),againstAvg:pct1(homeVenue.againstAvg),totalAvg:pct1(homeVenue.totalAvg)},
    away:{matches:awayVenue.matches,forAvg:pct1(awayVenue.forAvg),againstAvg:pct1(awayVenue.againstAvg),totalAvg:pct1(awayVenue.totalAvg)},
    lines:cornerLineStats
  };

  const allMarkets=[...markets,...cornerMarkets];

  const oddsForValue={...(fixtureOdds?.odds||fixtureOdds||{})};
  oddsForValue.__movement=fixtureOdds?.movement||{};
  const valueMarkets=marketValueAnalysis(allMarkets,oddsForValue);
  const analysisMarkets=withKellyStakes(marketAwareMarkets(valueMarkets,dq));
  const betRecommendation=selectBetRecommendation(analysisMarkets);
  if(betRecommendation&&betRecommendation.name&&fixtureOdds?.bookmakers?.[betRecommendation.name]){
    betRecommendation.bookmaker=fixtureOdds.bookmakers[betRecommendation.name];
  }

  const ranked=marketAwareRecommendations(analysisMarkets);
  let rec=selectVisibleRecommendations(ranked);

  // A genuine positive-value BET should be visible in the main recommendation set,
  // not hidden only inside the odds toggle.
  if(betRecommendation?.decision==="BET"&&betRecommendation.name){
    const betRow=analysisMarkets.find(x=>x.name===betRecommendation.name);
    if(betRow){
      rec=[{...betRow,decision:"BET"},...rec.filter(x=>x.name!==betRow.name)].slice(0,7);
    }
  }

  const strongest=chooseStrongestSignal(analysisMarkets,betRecommendation) || rec[0] || null;

  // Make sure the strongest signal is visible in the main list too.
  if(strongest){
    rec=[strongest,...rec.filter(x=>x.name!==strongest.name)].slice(0,7);
  }

  const strongestP=Number(strongest?.analysisProbability??strongest?.probability);
  const strongestC=Number(strongest?.analysisConfidence??strongest?.confidence);
  const hasStrongestOdd=strongest?.marketOdd!=null && Number(strongest.marketOdd)>1;
  const strongestOdd=hasStrongestOdd?Number(strongest.marketOdd):null;
  const hasStrongestEV=strongest?.expectedValue!=null && Number.isFinite(Number(strongest.expectedValue));
  const strongestEV=hasStrongestEV?Number(strongest.expectedValue):null;

  // IMPORTANT: null odds must NOT become Number(null)=0 and force every match to NO BET.
  // A strong model signal can still be shown as MODEL LEAN when odds are unavailable.
  // It becomes PLAYABLE/BET only when a real price >= 1.28 is present and value is non-negative.
  const strongModelSignal=!!(strongest && strongestP>=BET_PROB_MIN && strongestC>=BET_CONF_MIN);
  const playablePrice=!hasStrongestOdd || strongestOdd>=1.28;
  const acceptableValue=!hasStrongestEV || strongestEV>=0;
  const noBet=betRecommendation?.decision==="BET"
    ? false
    : !(strongModelSignal && playablePrice && acceptableValue);

  // Exact score must be the true Poisson mode. Do not bias it with market priority.
  const exactScores=m.slice().sort((a,b)=>b.p-a.p);
  const top=exactScores[0];
  const likelyScoreProbability=top?pct(top.p):null;
  const scoreAlternatives=exactScores.slice(1,4).map(x=>({score:`${x.h}-${x.a}`,probability:pct(x.p)}));
  const reasons=[];
  if(ht&&at){reasons.push(`${home} ligde ${ht.pos}. (${ht.pts} puan), ${away} ${at.pos}. (${at.pts} puan).`);reasons.push(`İç/dış saha gücü: ${home} evde ${ht.homePos}. (${ht.homePPG.toFixed(2)} PPM), ${away} deplasmanda ${at.awayPos}. (${at.awayPPG.toFixed(2)} PPM).`);}
  reasons.push(`2026/27 güncel örneklem: ${ha.current} / ${aa.current} maç.`);
  if(Number.isFinite(eh)&&Number.isFinite(ea))reasons.push(`Elo güç farkı: ${Math.round(eh-ea)} puan.`);
  if(co.count)reasons.push(`${co.count} ortak rakip karşılaştırması modele dahil edildi.`);
  if(H2H.matches)reasons.push(`Son ${H2H.matches} H2H düşük ağırlıkla kullanıldı.`);
  if(hv.sot!=null&&av.sot!=null)reasons.push(`İsabetli şut profili: ${hv.sot.toFixed(1)} / ${av.sot.toFixed(1)}.`);
  if(top)reasons.push(`En olası tek skor ${top.h}-${top.a} (%${likelyScoreProbability}); bu değer toplam ${Number(hl+al).toFixed(2)} xG'nin yuvarlanması değil, skor dağılımındaki en yüksek tek olasılıktır.`);
  if(strongest){
    const so=Number(strongest.marketOdd);
    const sp=Number(strongest.analysisProbability??strongest.probability);
    const sev=Number(strongest.expectedValue);
    if(Number.isFinite(so))reasons.push(`En güçlü sinyal seçiminde yalnızca yüzde değil; %${sp} olasılık, ${so.toFixed(2)} piyasa oranı${Number.isFinite(sev)?`, EV ${sev>=0?"+":""}${sev}%`:""} birlikte değerlendirildi.`);
  }
  if(fixtureOdds?.odds&&Object.keys(fixtureOdds.odds).length){
    const priced=analysisMarkets.filter(x=>Number(x.marketOdd)>1);
    reasons.push(`Piyasa analizi ${priced.length} fiyatlanmış marketi model olasılıklarıyla karşılaştırdı.`);
    if(betRecommendation?.decision==="BET"){
      reasons.push(`${betRecommendation.name}: model ${betRecommendation.modelProbability??betRecommendation.probability}%, piyasa-marjsız olasılık ${betRecommendation.marketProbability??"—"}%, edge ${betRecommendation.edge??"—"}%, EV ${betRecommendation.expectedValue??"—"}%.`);
      if(betRecommendation.openingOdd&&betRecommendation.marketOdd)reasons.push(`${betRecommendation.name} oran hareketi: ${betRecommendation.openingOdd} → ${betRecommendation.marketOdd}.`);
    }else if(betRecommendation?.reason==="market-drift-conflict"){
      reasons.push(`Piyasa hareketi model yönüyle çeliştiği için seçim NO BET'e düşürüldü.`);
    }
  }
  if(cornerLambda!=null){
    reasons.push(`Beklenen toplam korner: ${cornerLambda.toFixed(1)}.`);
    if(expHomeCorners!=null&&expAwayCorners!=null)reasons.push(`Takım bazlı korner beklentisi: ${home} ${expHomeCorners.toFixed(1)} · ${away} ${expAwayCorners.toFixed(1)}.`);
    if(homeVenue.matches||awayVenue.matches)reasons.push(`Korner modeli maç başı üretim/yeme ortalamalarını ve iç/dış saha örneklemlerini kullanıyor (${homeVenue.matches}/${awayVenue.matches} maç).`);
  }

  return {expectedGoals:{home:+hl.toFixed(2),away:+al.toFixed(2),total:+(hl+al).toFixed(2)},likelyScore:`${top.h}-${top.a}`,likelyScoreProbability,scoreAlternatives,dataQuality:dq,noBet,markets:analysisMarkets,rawModelMarkets:allMarkets,recommendations:rec,valueMarkets:analysisMarkets,betRecommendation,marketAware:!!(fixtureOdds?.odds&&Object.keys(fixtureOdds.odds).length),oddsInfo:fixtureOdds||null,reasons,
    standings:{home:ht,away:at},strength:{homeElo:Math.round(eh),awayElo:Math.round(ea)},stats:{homeCurrentMatches:ha.current,awayCurrentMatches:aa.current,homeFormPPG:ha.points==null?null:+ha.points.toFixed(2),awayFormPPG:aa.points==null?null:+aa.points.toFixed(2),homeShots:hv.shots==null?null:+hv.shots.toFixed(1),awayShots:av.shots==null?null:+av.shots.toFixed(1),homeSOT:hv.sot==null?null:+hv.sot.toFixed(1),awaySOT:av.sot==null?null:+av.sot.toFixed(1),expectedCorners:cornerLambda==null?null:+cornerLambda.toFixed(1),expectedHomeCorners:expHomeCorners==null?null:+expHomeCorners.toFixed(1),expectedAwayCorners:expAwayCorners==null?null:+expAwayCorners.toFixed(1),h2h:H2H.matches,commonOpponents:co.count},cornerProfile,
    sampleWarning:cur<5?"2026/27 örneklemi 5 maçın altında. 2025/26 destek verisi kullanıldı ve güven otomatik sınırlandı.":null};
}

/* ---------------- Upcoming fixtures fallback: Football-Data.co.uk ---------------- */
const FD_FIXTURES_URL="https://www.football-data.co.uk/fixtures.csv";
function stableFixtureId(parts){let h=2166136261;for(const ch of parts.join("|")){h^=ch.charCodeAt(0);h=Math.imul(h,16777619);}return 1000000000+(Math.abs(h>>>0)%900000000);}
function ymd(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;}

async function footballDataUpcoming(date){
  const k=`fd-upcoming-v73:${date}`,c=getCache(k);if(c)return c;
  try{
    const r=await fetchT(FD_FIXTURES_URL,{headers:{"User-Agent":"MatchEdge/7.3"}});
    if(!r.ok)throw new Error(`Football-Data fixtures HTTP ${r.status}`);
    const text=await r.text();
    if(text.toLowerCase().includes("<html")||text.length<20)throw new Error("Football-Data fixtures yanıtı geçersiz.");
    const rows=parseCSV(text),out=[];
    for(const row of rows){
      const l=LEAGUE_BY_CSV[String(row.Div||row.div||"").trim()];if(!l)continue;
      const d=parseDate(row.Date||row.date);if(!d||ymd(d)!==date)continue;
      const home=String(row.HomeTeam||row.Home||"").trim(),away=String(row.AwayTeam||row.Away||"").trim();if(!home||!away)continue;
      let tm=String(row.Time||row.time||"12:00").trim();if(!/^\d{1,2}:\d{2}$/.test(tm))tm="12:00";if(tm.length===4)tm="0"+tm;
      const dt=`${date}T${tm}:00`,id=stableFixtureId([l.csv,date,home,away]);
      const hasFT=row.FTHG!==""&&row.FTHG!=null&&row.FTAG!==""&&row.FTAG!=null;
      const f={id,date:dt,localDate:date,displayTime:tm,timestamp:Math.floor(new Date(dt).getTime()/1000),status:hasFT?"FT":"NS",leagueCode:l.code,league:l.name,country:l.country,emoji:l.emoji,round:"",home:{name:home,logo:""},away:{name:away,logo:""},
        score:{home:hasFT?Number(row.FTHG):null,away:hasFT?Number(row.FTAG):null,htHome:row.HTHG!==""&&row.HTHG!=null?Number(row.HTHG):null,htAway:row.HTAG!==""&&row.HTAG!=null?Number(row.HTAG):null},
        elapsed:null,fixtureSource:"football-data.co.uk"};
      out.push(f);setCache(`fixture:${id}`,f,21600000);
    }
    out.sort((a,b)=>a.timestamp-b.timestamp);setCache(k,out,1800000);return out;
  }catch(e){console.warn("Football-Data fixture warning:",e.message);return[];}
}


/* ---------------- ESPN public fixture fallback ---------------- */
function espnStatusToShort(x){
  const n=String(x?.type?.name||"").toUpperCase();
  const d=String(x?.type?.description||"").toUpperCase();
  if(n.includes("STATUS_FINAL")||d.includes("FINAL")) return "FT";
  if(n.includes("STATUS_HALFTIME")||d.includes("HALF")) return "HT";
  if(n.includes("STATUS_IN_PROGRESS")||x?.type?.state==="in") return "LIVE";
  if(n.includes("STATUS_POSTPONED")||d.includes("POSTPON")) return "PST";
  if(n.includes("STATUS_CANCELED")||n.includes("STATUS_CANCELLED")||d.includes("CANCEL")) return "CANC";
  return "NS";
}
async function espnFixturesForDate(date){
  const k=`espn-fixtures:${date}`,c=getCache(k); if(c) return c;
  const compact=date.replaceAll("-","");
  const jobs=Object.entries(ESPN_SLUGS).map(async([code,slug])=>{
    const l=LEAGUES[code];
    try{
      const url=`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${compact}`;
      const r=await fetchT(url,{headers:{"User-Agent":"MatchEdge/7.3.2"}});
      if(!r.ok) return [];
      const b=await r.json(), out=[];
      for(const ev of b.events||[]){
        const comp=ev.competitions?.[0]; if(!comp) continue;
        const competitors=comp.competitors||[];
        const hc=competitors.find(x=>x.homeAway==="home"), ac=competitors.find(x=>x.homeAway==="away");
        if(!hc||!ac) continue;
        const dt=ev.date||comp.date; if(!dt) continue;
        const localDate=localYmdFromDate(dt); if(localDate!==date) continue;
        const home=hc.team?.displayName||hc.team?.shortDisplayName||hc.team?.name||"";
        const away=ac.team?.displayName||ac.team?.shortDisplayName||ac.team?.name||"";
        if(!home||!away) continue;
        const id=stableFixtureId(["espn",code,date,home,away]);
        const f={id,date:dt,localDate,displayTime:localTimeFromDate(dt),timestamp:Math.floor(new Date(dt).getTime()/1000),
          status:espnStatusToShort(ev.status||comp.status),leagueCode:code,league:l.name,country:l.country,emoji:l.emoji,
          round:ev.season?.slug||"",home:{id:hc.team?.id||null,name:home,logo:hc.team?.logo||""},away:{id:ac.team?.id||null,name:away,logo:ac.team?.logo||""},
          score:{home:hc.score!==undefined&&hc.score!==null&&hc.score!==""?Number(hc.score):null,away:ac.score!==undefined&&ac.score!==null&&ac.score!==""?Number(ac.score):null,
            htHome:hc.linescores?.[0]?.value!==undefined?Number(hc.linescores[0].value):null,
            htAway:ac.linescores?.[0]?.value!==undefined?Number(ac.linescores[0].value):null},
          elapsed:ev.status?.displayClock||comp.status?.displayClock||null,
          espnEventId:ev.id||null,espnSlug:slug,fixtureSource:"espn-fallback"};
        out.push(f); setCache(`fixture:${id}`,f,21600000);
      }
      return out;
    }catch{return[];}
  });
  const out=(await Promise.all(jobs)).flat().sort((a,b)=>a.timestamp-b.timestamp);
  setCache(k,out,300000);
  return out;
}



/* ---------------- TheSportsDB global public fallback ---------------- */
function sportsDbLeagueCode(ev){
  const league=String(ev?.strLeague||"").toLowerCase();
  const country=String(ev?.strCountry||"").toLowerCase();
  const tests=[
    ["SWE2",/superettan/],["SWE",/allsvenskan/],["SWEC",/svenska cup/],
    ["SUI",/swiss super league|super league switzerland|switzerland super league/],
    ["SUIC",/challenge league/],
    ["RUSC",/russian cup|cup of russia/],["RPL",/russian premier|premier league russia/],
    ["ROUC",/cupa romaniei|romanian cup/],["ROU",/liga i|superliga romania/],
    ["POLC",/polish cup|puchar polski/],["POL",/ekstraklasa/]
  ];
  for(const [code,re] of tests)if(re.test(league))return code;
  // Turkey checks require the country too: "Super Liga" also appears in Slovak/Serbian
  // league names, and a country-blind regex previously misrouted those to Türkiye.
  if(country.includes("turkey")&&/1\.? lig|first league turkey/.test(league))return "T1L";
  if(country.includes("turkey")&&/super lig|süper lig/.test(league))return "TSL";
  if(country.includes("sweden")&&league.includes("cup"))return "SWEC";
  if(country.includes("switzerland")&&league.includes("challenge"))return "SUIC";
  if(country.includes("switzerland")&&league.includes("super"))return "SUI";
  if(country.includes("russia")&&league.includes("cup"))return "RUSC";
  if(country.includes("romania")&&league.includes("cup"))return "ROUC";
  if(country.includes("poland")&&league.includes("cup"))return "POLC";
  // These leagues have no Football-Data CSV and no ESPN slug, so TheSportsDB's
  // daily feed is their only free fallback besides API-Football.
  if(country.includes("czech")&&/first league|liga/.test(league))return "CZE";
  if(country.includes("croatia")&&/hnl|prva|first.*league/.test(league))return "CRO";
  if(country.includes("serbia")&&/super\s?liga/.test(league))return "SRB";
  if(country.includes("cyprus")&&/first division/.test(league))return "CYP";
  if(country.includes("slovakia")&&/super\s?liga/.test(league))return "SVK";
  if(country.includes("slovenia")&&/prva\s?liga|1\.?\s*snl/.test(league))return "SVN";
  if(country.includes("israel")&&/premier league|ligat/.test(league))return "ISR";
  return null;
}
function sportsDbStatus(ev){
  const st=String(ev?.strStatus||ev?.strProgress||"").toLowerCase();
  if(/final|finished|ft/.test(st))return "FT";
  if(/half/.test(st))return "HT";
  if(/live|in progress|\d+\s*'/.test(st))return "LIVE";
  if(/postpon/.test(st))return "PST";
  if(/cancel/.test(st))return "CANC";
  return "NS";
}
function sportsDbDateTime(ev,date){
  let tm=String(ev?.strTime||ev?.strEventTime||"").trim();
  const m=tm.match(/(\d{1,2}):(\d{2})/);
  tm=m?`${m[1].padStart(2,"0")}:${m[2]}`:"12:00";
  // TheSportsDB dateEvent is league-local in many feeds; keep selected calendar date
  // and let displayTime represent the published kickoff time.
  return {tm,dt:`${date}T${tm}:00`};
}
async function sportsDbFixturesForDate(date){
  const k=`sportsdb-day:${date}`,c=getCache(k);if(c)return c;
  try{
    const url=`https://www.thesportsdb.com/api/v1/json/123/eventsday.php?d=${encodeURIComponent(date)}&s=Soccer`;
    const r=await fetchT(url,{headers:{"User-Agent":"MatchEdge/7.19.0"}});
    if(!r.ok)return[];
    const b=await r.json(),out=[];
    for(const ev of b?.events||[]){
      const code=sportsDbLeagueCode(ev);if(!code||!LEAGUES[code])continue;
      const home=String(ev.strHomeTeam||"").trim(),away=String(ev.strAwayTeam||"").trim();if(!home||!away)continue;
      const {tm,dt}=sportsDbDateTime(ev,date),l=LEAGUES[code];
      const hs=ev.intHomeScore!==null&&ev.intHomeScore!==undefined&&ev.intHomeScore!==""?Number(ev.intHomeScore):null;
      const as=ev.intAwayScore!==null&&ev.intAwayScore!==undefined&&ev.intAwayScore!==""?Number(ev.intAwayScore):null;
      const id=stableFixtureId(["sportsdb",ev.idEvent||"",code,date,home,away]);
      out.push({
        id,date:dt,localDate:date,displayTime:tm,timestamp:Math.floor(new Date(dt+"+03:00").getTime()/1000),
        status:sportsDbStatus(ev),leagueCode:code,league:l.name,country:l.country,emoji:l.emoji,round:String(ev.intRound||ev.strSeason||""),
        home:{id:ev.idHomeTeam||null,name:home,logo:ev.strHomeTeamBadge||""},
        away:{id:ev.idAwayTeam||null,name:away,logo:ev.strAwayTeamBadge||""},
        score:{home:Number.isFinite(hs)?hs:null,away:Number.isFinite(as)?as:null,htHome:null,htAway:null},
        elapsed:ev.strProgress||null,fixtureSource:"sportsdb-fallback",
        sportsDbEventId:ev.idEvent||null,sportsDbLeagueId:ev.idLeague||null
      });
    }
    setCache(k,out,180000);return out;
  }catch(e){console.warn("SportsDB day fallback:",e.message);return[]}
}
async function sportsDbLeagueHistory(f,date){
  const id=f?.sportsDbLeagueId;if(!id)return[];
  const k=`sportsdb-history:${id}`,c=getCache(k);if(c)return c;
  try{
    const url=`https://www.thesportsdb.com/api/v1/json/123/eventspastleague.php?id=${encodeURIComponent(id)}`;
    const r=await fetchT(url,{headers:{"User-Agent":"MatchEdge/7.19.0"}});
    if(!r.ok)return[];
    const b=await r.json(),out=[];
    for(const ev of b?.events||[]){
      const ds=String(ev.dateEvent||"");if(!/^\d{4}-\d{2}-\d{2}$/.test(ds)||ds>=date)continue;
      const home=String(ev.strHomeTeam||"").trim(),away=String(ev.strAwayTeam||"").trim();
      const hg=Number(ev.intHomeScore),ag=Number(ev.intAwayScore);
      if(!home||!away||!Number.isFinite(hg)||!Number.isFinite(ag))continue;
      out.push({
        season:String(ev.strSeason||""),date:new Date(`${ds}T12:00:00+03:00`),home,away,homeGoals:hg,awayGoals:ag,
        htHome:null,htAway:null,homeShots:null,awayShots:null,homeSOT:null,awaySOT:null,homeCorners:null,awayCorners:null,
        homeYellow:null,awayYellow:null,homeRed:null,awayRed:null,source:"sportsdb-history"
      });
    }
    out.sort((a,b)=>a.date-b.date);setCache(k,out,300000);return out;
  }catch(e){console.warn("SportsDB history fallback:",e.message);return[]}
}

/* ---------------- Official federation fixture fallbacks ---------------- */
async function fetchTextSmart(url,headers={}){
  const r=await fetchT(url,{headers});
  if(!r.ok)throw new Error(`HTTP ${r.status}`);
  const buf=await r.arrayBuffer();
  const ct=String(r.headers.get("content-type")||"").toLowerCase();
  let enc=/windows-1254|iso-8859-9|latin5/.test(ct)?"windows-1254":"utf-8";
  let text=new TextDecoder(enc).decode(buf);
  if((text.match(/�/g)||[]).length>1||/Ã[‡–œ¼¶§]/.test(text)){
    try{text=new TextDecoder("windows-1254").decode(buf)}catch{}
  }
  return text;
}
function decodeHtmlText(html){
  return String(html||"")
    .replace(/<script[\s\S]*?<\/script>/gi," ")
    .replace(/<style[\s\S]*?<\/style>/gi," ")
    .replace(/<br\s*\/?>/gi,"\n")
    .replace(/<\/(?:tr|td|div|p|li|h\d)>/gi,"\n")
    .replace(/<[^>]+>/g," ")
    .replace(/&nbsp;|&#160;/gi," ")
    .replace(/&amp;/gi,"&")
    .replace(/&quot;/gi,'"')
    .replace(/&#39;|&apos;/gi,"'")
    .replace(/&uuml;/gi,"ü").replace(/&Uuml;/g,"Ü")
    .replace(/&ouml;/gi,"ö").replace(/&Ouml;/g,"Ö")
    .replace(/&ccedil;/gi,"ç").replace(/&Ccedil;/g,"Ç")
    .replace(/&scedil;/gi,"ş").replace(/&Scedil;/g,"Ş")
    .replace(/&gbreve;/gi,"ğ").replace(/&Gbreve;/g,"Ğ")
    .replace(/&imath;/gi,"ı").replace(/&Idot;/g,"İ")
    .replace(/[ \t]+/g," ")
    .replace(/\n\s*\n+/g,"\n")
    .trim();
}

function htmlTableRows(html){
  const rows=[];
  const trRe=/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr;
  while((tr=trRe.exec(String(html||"")))){
    const cells=[];
    const tdRe=/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let td;
    while((td=tdRe.exec(tr[1]))){
      const txt=decodeHtmlText(td[1]).replace(/\s+/g," ").trim();
      if(txt)cells.push(txt);
    }
    if(cells.length)rows.push(cells);
  }
  return rows;
}
function cleanTffCell(x){
  return String(x||"")
    .replace(/\s*Detaylar\s*$/i,"")
    .replace(/\s+/g," ")
    .trim();
}
function tffFixtureRowsFromHtml(raw,date){
  const dd=date.slice(8,10)+"."+date.slice(5,7)+"."+date.slice(0,4);
  const out=[];
  for(const cells0 of htmlTableRows(raw)){
    const cells=cells0.map(cleanTffCell).filter(Boolean);
    const joined=cells.join(" ");
    if(!joined.includes(dd))continue;
    const time=(joined.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/)||[])[0];
    if(!time)continue;

    let sep=-1;
    for(let i=0;i<cells.length;i++){
      if(/^(?:-|\d+\s*-\s*\d+)$/.test(cells[i])){sep=i;break}
    }
    if(sep<0)continue;

    const noise=x=>x===dd || /^\d{2}\.\d{2}\.\d{4}$/.test(x) ||
      /^\d{1,2}:\d{2}$/.test(x) || /^Detaylar$/i.test(x);
    let home="",away="";
    for(let i=sep-1;i>=0;i--){if(!noise(cells[i])){home=cells[i];break}}
    for(let i=sep+1;i<cells.length;i++){if(!noise(cells[i])){away=cells[i];break}}
    if(home&&away)out.push({time,home:cleanTffCell(home),away:cleanTffCell(away),score:cells[sep]});
  }
  return out;
}
function tffSeasonHistoryFromHtml(raw,date){
  const out=[];
  const text=String(raw||"");
  const marker=text.search(/Fikst(?:ü|&uuml;)r\s+Listesi/i);
  const scope=marker>=0?text.slice(marker):text;

  // TFF's full-season fixture list is rendered in HTML. Parse each week separately,
  // then parse table rows rather than depending on one flattened-text regex.
  const weekRe=/(\d{1,2})\s*\.\s*Hafta/gi;
  const marks=[]; let wm;
  while((wm=weekRe.exec(scope)))marks.push({week:Number(wm[1]),start:wm.index,end:weekRe.lastIndex});
  const seasonStartYear=Number(String(date).slice(0,4));
  for(let k=0;k<marks.length;k++){
    const week=marks[k].week;
    const seg=scope.slice(marks[k].end,k+1<marks.length?marks[k+1].start:scope.length);
    for(const cells0 of htmlTableRows(seg)){
      const cells=cells0.map(cleanTffCell).filter(Boolean);
      let si=-1,hm=null,am=null;
      for(let i=0;i<cells.length;i++){
        const m=cells[i].match(/^(\d+)\s*-\s*(\d+)$/);
        if(m){si=i;hm=Number(m[1]);am=Number(m[2]);break}
      }
      if(si<0)continue;
      let home="",away="";
      for(let i=si-1;i>=0;i--){
        if(!/^\d+$/.test(cells[i])&&!/^Detaylar$/i.test(cells[i])){home=cells[i];break}
      }
      for(let i=si+1;i<cells.length;i++){
        if(!/^\d+$/.test(cells[i])&&!/^Detaylar$/i.test(cells[i])){away=cells[i];break}
      }
      if(!home||!away)continue;

      // weekOrderDate is only an internal ordering key; match results are real TFF results.
      const weekOrderDate=new Date(Date.UTC(seasonStartYear,0,week,12,0,0));
      out.push({
        season:`${seasonStartYear}/${String(seasonStartYear+1).slice(-2)}`,
        date:weekOrderDate,week,
        home:cleanTffCell(home),away:cleanTffCell(away),
        homeGoals:hm,awayGoals:am,
        htHome:null,htAway:null,homeShots:null,awayShots:null,homeSOT:null,awaySOT:null,
        homeCorners:null,awayCorners:null,homeYellow:null,awayYellow:null,homeRed:null,awayRed:null,
        source:"tff-season-fixture-list"
      });
    }
  }

  // Some TFF layouts don't wrap full-list matches in TRs. Fallback: use anchors/cells
  // from the decoded fixture-list text and detect TEAM SCORE TEAM triplets.
  if(!out.length){
    const plain=decodeHtmlText(scope).replace(/\s+/g," ").trim();
    const chunks=plain.split(/(\d{1,2})\s*\.\s*Hafta/i);
    for(let i=1;i+1<chunks.length;i+=2){
      const week=Number(chunks[i]), block=chunks[i+1];
      const rowRe=/([A-ZÇĞİÖŞÜ0-9][A-ZÇĞİÖŞÜ0-9 .'\-]{1,80}?)\s+(\d+)\s*-\s*(\d+)\s+([A-ZÇĞİÖŞÜ0-9][A-ZÇĞİÖŞÜ0-9 .'\-]{1,80}?)(?=\s+[A-ZÇĞİÖŞÜ0-9][A-ZÇĞİÖŞÜ0-9 .'\-]{1,80}?\s+\d+\s*-\s*\d+|\s+\d{1,2}\s*\.\s*Hafta|$)/g;
      let m;
      while((m=rowRe.exec(block))){
        out.push({
          season:`${seasonStartYear}/${String(seasonStartYear+1).slice(-2)}`,
          date:new Date(Date.UTC(seasonStartYear,0,week,12,0,0)),week,
          home:cleanTffCell(m[1]),away:cleanTffCell(m[4]),
          homeGoals:Number(m[2]),awayGoals:Number(m[3]),
          htHome:null,htAway:null,homeShots:null,awayShots:null,homeSOT:null,awaySOT:null,
          homeCorners:null,awayCorners:null,homeYellow:null,awayYellow:null,homeRed:null,awayRed:null,
          source:"tff-season-fixture-list"
        });
      }
    }
  }

  return [...new Map(out.map(m=>[`${m.week}|${norm(m.home)}|${norm(m.away)}`,m])).values()]
    .sort((a,b)=>(a.week||0)-(b.week||0));
}
function trDateToYmd(d){
  const m=String(d||"").match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return m?`${m[3]}-${m[2]}-${m[1]}`:null;
}
function displayLatinName(name){
  const s=String(name||"").trim();
  if(!/[а-яё]/i.test(s))return s;
  const t=transliterateCyrillic(s).replace(/\s+/g," ").trim();
  return t.replace(/\b\w/g,c=>c.toUpperCase());
}
// Converts any Latin-script team name with non-English letters (ø, æ, å, ł, đ, ß,
// plus any standard accented letter like é/ü/ç/etc.) into a plain-English-looking
// display form, while preserving the original capitalisation and word spacing
// (unlike norm(), which is for internal matching only and destroys structure).
const DISPLAY_CHAR_MAP={"ø":"o","Ø":"O","æ":"ae","Æ":"AE","å":"a","Å":"A","ł":"l","Ł":"L","đ":"d","Đ":"D","ß":"ss"};
function toEnglishDisplay(name){
  let s=displayLatinName(name);
  s=s.replace(/[øØæÆåÅłŁđĐß]/g,ch=>DISPLAY_CHAR_MAP[ch]||ch);
  s=s.normalize("NFD").replace(/[\u0300-\u036f]/g,"");
  return s;
}
function officialFixture(code,date,time,home,away,source,extra={}){
  const l=LEAGUES[code]; if(!l||!home||!away)return null;
  const tm=/^\d{1,2}:\d{2}$/.test(time)?time.padStart(5,"0"):"12:00";
  const dt=`${date}T${tm}:00`;
  return {
    id:stableFixtureId([source,code,date,tm,home,away]),date:dt,localDate:date,displayTime:tm,
    timestamp:Math.floor(new Date(dt+"+03:00").getTime()/1000),status:"NS",
    leagueCode:code,league:l.name,country:l.country,emoji:l.emoji,round:extra.round||"",
    home:{name:displayLatinName(home),logo:""},away:{name:displayLatinName(away),logo:""},
    score:{home:null,away:null,htHome:null,htAway:null},elapsed:null,
    fixtureSource:source,...extra
  };
}
async function tffOfficialFixturesForDate(date){
  const k=`tff-official-v2:${date}`,c=getCache(k);if(c)return c;
  const out=[];
  const pages=[
    {code:"TSL",url:"https://www.tff.org/default.aspx?pageID=198"},
    {code:"T1L",url:"https://www.tff.org/default.aspx?pageID=142"}
  ];
  for(const p of pages){
    try{
      const raw=await fetchTextSmart(p.url,{"User-Agent":"Mozilla/5.0 MatchEdge/7.19.0","Accept-Language":"tr-TR,tr;q=0.9"});
      const rows=tffFixtureRowsFromHtml(raw,date);
      for(const row of rows){
        const f=officialFixture(p.code,date,row.time,row.home,row.away,"tff-official");
        if(f)out.push(f);
      }
      // Last-resort flattened-text parser, only for today's active-week block.
      if(!rows.length){
        const text=decodeHtmlText(raw),dd=date.slice(8,10)+"."+date.slice(5,7)+"."+date.slice(0,4);
        const flat=text.replace(/\n/g," ").replace(/\s+/g," ");
        const re=new RegExp(dd.replace(/\./g,"\\.")+String.raw`\s+(\d{1,2}:\d{2})\s+(.{2,90}?)\s+(?:\d+\s*-\s*\d+|-)\s+(.{2,90}?)(?=\s+Detaylar|\s+\d{2}\.\d{2}\.\d{4}|$)`,"gi");
        let m;
        while((m=re.exec(flat))){
          const f=officialFixture(p.code,date,m[1],cleanTffCell(m[2]),cleanTffCell(m[3]),"tff-official");
          if(f)out.push(f);
        }
      }
    }catch(e){console.warn("TFF official fallback:",e.message)}
  }
  const ded=[...new Map(out.map(f=>[fixtureMergeKey(f),f])).values()];
  setCache(k,ded,300000);return ded;
}
function tffCleanTeamName(x){return String(x||"").replace(/\s+/g," ").replace(/\s+Detaylar.*$/i,"").trim();}
async function tffLeagueHistory(code,date){
  if(!["TSL","T1L"].includes(code))return[];
  const k=`tff-history-v2:${code}:${date}`,c=getCache(k);if(c)return c;
  const url=code==="T1L"?"https://www.tff.org/default.aspx?pageID=142":"https://www.tff.org/default.aspx?pageID=198";
  try{
    const raw=await fetchTextSmart(url,{"User-Agent":"Mozilla/5.0 MatchEdge/7.19.0","Accept-Language":"tr-TR,tr;q=0.9"});
    let out=tffSeasonHistoryFromHtml(raw,date);

    // If the full list unexpectedly fails, retain any dated completed rows from the active week.
    if(!out.length){
      const rows=tffFixtureRowsFromHtml(raw,date);
      out=rows.filter(r=>/^\d+\s*-\s*\d+$/.test(r.score)).map((r,i)=>{
        const m=r.score.match(/^(\d+)\s*-\s*(\d+)$/);
        return {
          season:`${date.slice(0,4)}/${String(Number(date.slice(0,4))+1).slice(-2)}`,
          date:new Date(Date.UTC(Number(date.slice(0,4)),0,i+1,12)),week:i+1,
          home:r.home,away:r.away,homeGoals:Number(m[1]),awayGoals:Number(m[2]),
          htHome:null,htAway:null,homeShots:null,awayShots:null,homeSOT:null,awaySOT:null,
          homeCorners:null,awayCorners:null,homeYellow:null,awayYellow:null,homeRed:null,awayRed:null,
          source:"tff-active-week"
        };
      });
    }
    setCache(k,out,300000);return out;
  }catch(e){console.warn("TFF history:",e.message);return[]}
}

const SUI_TEAMS=[
  "Grasshopper Club Zürich","FC St. Gallen 1879","FC Thun Berner Oberland","FC Lausanne-Sport",
  "BSC Young Boys","FC Basel 1893","FC Zürich","FC Luzern","FC Lugano","FC Vaduz",
  "Servette FC","FC Sion"
];
const SUIC_TEAMS=[
  "Stade Lausanne-Ouchy","Étoile Carouge FC","FC Rapperswil-Jona","SC Kriens",
  "Stade Nyonnais","FC Winterthur","Neuchâtel Xamax FCS","Yverdon Sport FC",
  "FC Aarau","AC Bellinzona","FC Wil 1900","FC Schaffhausen"
];
function splitKnownSwissTeams(segment,teams){
  const tx=String(segment||"").replace(/\s+/g," ").trim();
  const sorted=[...teams].sort((a,b)=>b.length-a.length);
  for(const home of sorted){
    if(!tx.toLowerCase().startsWith(home.toLowerCase()))continue;
    const rest=tx.slice(home.length).trim();
    for(const away of sorted){
      if(rest.toLowerCase().startsWith(away.toLowerCase()))return {home,away};
    }
  }
  return null;
}
function swissMatchesFromOfficialText(raw,date,code){
  const text=decodeHtmlText(raw).replace(/\s+/g," ").trim();
  const dd=date.slice(8,10)+"."+date.slice(5,7)+"."+date.slice(0,4);
  const teams=code==="SUIC"?SUIC_TEAMS:SUI_TEAMS,out=[];
  // Official Match Center shape:
  // Di 01.09.2026 20:30 FC Zürich BSC Young Boys Spielnummer 100101
  const re=new RegExp(
    `(?:Mo|Di|Mi|Do|Fr|Sa|So|Lu|Ma|Me|Je|Ve|Sa|Di|Lun|Mar|Mer|Gio|Ven|Sab|Dom)?\\s*${dd.replace(/\./g,"\\\\.")}\\s+(\\d{1,2}:\\d{2})\\s+(.+?)\\s+(?:Spielnummer|N° match|no\\. gara|Nº match|Match no\\.)\\s+\\d+`,
    "gi"
  );
  let m;
  while((m=re.exec(text))){
    const pair=splitKnownSwissTeams(m[2],teams);
    if(!pair)continue;
    const f=officialFixture(code,date,m[1],pair.home,pair.away,"sfl-official-direct");
    if(f)out.push(f);
  }
  return out;
}
async function swissOfficialFixturesForDate(date){
  const k=`sfl-official-v3:${date}`,c=getCache(k);if(c)return c;
  const out=[];
  try{
    // Official Swiss Football League Match Center, current Super League season.
    const seasonEnd=Number(date.slice(0,4))+1;
    const url=`https://dev-matchcenter-sfl.football.ch/default.aspx?a=mag&ln=11011&lng=1&ls=25694&oid=2&s=${seasonEnd}&sg=70075`;
    const r=await fetchT(url,{headers:{"User-Agent":"Mozilla/5.0 MatchEdge/7.19.0","Accept-Language":"de-CH,de;q=0.9"}});
    if(r.ok){
      const raw=await r.text();
      out.push(...swissMatchesFromOfficialText(raw,date,"SUI"));
      const text=decodeHtmlText(raw);
      const dd=date.slice(8,10)+"."+date.slice(5,7)+"."+date.slice(0,4);
      const lines=text.split("\n").map(x=>x.replace(/\s+/g," ").trim()).filter(Boolean);
      for(let i=0;i<lines.length;i++){
        let time=null,home=null,away=null;
        if(lines[i].includes(dd)){
          const same=lines[i].match(new RegExp(dd.replace(/\./g,"\\.")+String.raw`.*?(\d{1,2}:\d{2})$`));
          if(same)time=same[1];
          if(!time&&/^\d{1,2}:\d{2}$/.test(lines[i+1]||"")){time=lines[i+1];i++;}
          let j=i+1;
          while(j<lines.length&&j<i+7){
            if(!time&&/^\d{1,2}:\d{2}$/.test(lines[j])){time=lines[j];j++;continue;}
            if(!home&&!/^(Spielnummer|Match|Meisterschaft|Brack Super League|Stadion|Phase|Runde)/i.test(lines[j])){home=lines[j];j++;continue;}
            if(home&&!away&&!/^(Spielnummer|Match|Stadion|Nr\.|No\.)/i.test(lines[j])){away=lines[j];break;}
            j++;
          }
          if(time&&home&&away){
            home=home.replace(/\s+\(SL\)$/i,"").trim();away=away.replace(/\s+\(SL\)$/i,"").trim();
            const f=officialFixture("SUI",date,time,home,away,"sfl-official");
            if(f)out.push(f);
          }
        }
      }
      // Known Match Center pages often flatten date/time/teams into one line.
      const flat=text.replace(/\n/g," ");
      const re=new RegExp(dd.replace(/\./g,"\\.")+String.raw`\s+(\d{1,2}:\d{2})\s+([A-Za-zÀ-ž0-9 .'-]{2,45}?)\s+([A-Za-zÀ-ž0-9 .'-]{2,45}?)(?=\s+(?:Spielnummer|No\.|Nr\.|Stadion|Meisterschaft|$))`,"g");
      let m;while((m=re.exec(flat))){
        const f=officialFixture("SUI",date,m[1],m[2].trim(),m[3].trim(),"sfl-official");
        if(f)out.push(f);
      }
    }
  }catch(e){console.warn("SFL official fallback:",e.message)}
  if(!out.length){
    try{
      const raw=await fetchTextSmart("https://matchcenter-sfl.football.ch/Default.aspx?a=sp&lng=1&ls=25694&oid=2&sg=70075",{"User-Agent":"Mozilla/5.0 MatchEdge/7.19.0"});
      const tx=decodeHtmlText(raw).replace(/\s+/g," ");
      const dd=date.slice(8,10)+"."+date.slice(5,7)+"."+date.slice(0,4);
      const pos=tx.indexOf(dd);
      if(pos>=0){
        const block=tx.slice(pos,pos+1200);
        const re=/(\d{1,2}:\d{2})\s+(.+?)\s+(.+?)\s+(?:Spielnummer|N° match|no\. gara)\s+\d+/gi;
        let m;while((m=re.exec(block))){
          const home=m[2].trim(),away=m[3].trim();
          if(home&&away){
            const f=officialFixture("SUI",date,m[1],home,away,"sfl-official-flat");
            if(f)out.push(f);
          }
        }
      }
    }catch(e){console.warn("SFL flat fallback:",e.message)}
  }
  const ded=[...new Map(out.map(f=>[fixtureMergeKey(f),f])).values()];
  setCache(k,ded,300000);return ded;
}
async function swissChallengeOfficialFixturesForDate(date){
  const k=`sfl-challenge-official-v2:${date}`,c=getCache(k);if(c)return c;
  const out=[];
  try{
    const seasonEnd=Number(date.slice(0,4))+1;
    // Swiss Football League Match Center: Challenge League competition.
    const url=`https://matchcenter-sfl.football.ch/Default.aspx?a=mag&lng=1&ls=25695&oid=2&s=${seasonEnd}`;
    const r=await fetchT(url,{headers:{"User-Agent":"Mozilla/5.0 MatchEdge/7.10.6","Accept-Language":"de-CH,de;q=0.9"}});
    if(r.ok){
      const raw=await r.text();
      out.push(...swissMatchesFromOfficialText(raw,date,"SUIC"));
      const text=decodeHtmlText(raw),dd=date.slice(8,10)+"."+date.slice(5,7)+"."+date.slice(0,4);
      const lines=text.split("\n").map(x=>x.replace(/\s+/g," ").trim()).filter(Boolean);
      for(let i=0;i<lines.length;i++){
        if(!lines[i].includes(dd))continue;
        let time=null,home=null,away=null,j=i;
        while(j<lines.length&&j<i+8){
          if(!time&&/^\d{1,2}:\d{2}$/.test(lines[j])){time=lines[j];j++;continue;}
          if(time&&!home&&!/^(Spielnummer|Match|Meisterschaft|Challenge League|Stadion|Phase|Runde)/i.test(lines[j])){home=lines[j];j++;continue;}
          if(home&&!away&&!/^(Spielnummer|Match|Stadion|Nr\.|No\.)/i.test(lines[j])){away=lines[j];break;}
          j++;
        }
        if(time&&home&&away){
          const f=officialFixture("SUIC",date,time,home.replace(/\s+\(CL\)$/i,"").trim(),away.replace(/\s+\(CL\)$/i,"").trim(),"sfl-official");
          if(f)out.push(f);
        }
      }
    }
  }catch(e){console.warn("SFL Challenge fallback:",e.message)}
  const ded=[...new Map(out.map(f=>[fixtureMergeKey(f),f])).values()];
  setCache(k,ded,300000);return ded;
}

const SV_MONTHS={jan:1,feb:2,mar:3,apr:4,maj:5,jun:6,jul:7,aug:8,sep:9,okt:10,nov:11,dec:12};
function svffEliteFixturesFromText(text,date){
  const out=[],y=Number(date.slice(0,4)),mo=Number(date.slice(5,7)),day=Number(date.slice(8,10));
  const flat=String(text||"").replace(/\s+/g," ").trim();
  const mon=Object.entries(SV_MONTHS).find(([,v])=>v===mo)?.[0]?.toUpperCase();
  if(!mon)return out;

  // Actual SvFF official page shape:
  // 01 SEP. Superettan 2026 Helsingborgs IF - Örebro 19:00 Olympia, Helsingborg
  const re=new RegExp(
    `\\b0?${day}\\s+${mon}\\\\.?\\s+(Allsvenskan|Superettan)\\s+${y}\\s+(.+?)\\s+-\\s+(.+?)\\s+(\\d{1,2}:\\d{2})(?=\\s|$)`,
    "gi"
  );
  let m;
  while((m=re.exec(flat))){
    const code=/superettan/i.test(m[1])?"SWE2":"SWE";
    let home=m[2].replace(/\s+/g," ").trim();
    let away=m[3].replace(/\s+/g," ").trim();
    // Prevent a preceding fixture/location fragment leaking into team names.
    home=home.replace(/^.*?(?=(?:Helsingborgs|Örebro|IFK|IK|GIF|Norrby|Varberg|Falkenberg|Landskrona|Östers|Sandvikens|Nordic|Ljungk|Mjällby|Djurgården|Malmö|Hammarby|AIK|BK Häcken|GAIS|Degerfors|Sirius|Elfsborg|Brommapojkarna|Halmstad|Kalmar))/i,"");
    if(home&&away){
      const f=officialFixture(code,date,m[4],home,away,"svff-official");
      if(f)out.push(f);
    }
  }
  return out;
}
async function svffOfficialFixturesForDate(date){
  const k=`svff-official:${date}`,c=getCache(k);if(c)return c;
  const out=[];
  try{
    const raw=await fetchTextSmart("https://www.svenskfotboll.se/serier-cuper/elitfotboll",{
      "User-Agent":"Mozilla/5.0 MatchEdge/7.19.0","Accept-Language":"sv-SE,sv;q=0.9,en;q=0.7"
    });
    const text=decodeHtmlText(raw);
    out.push(...svffEliteFixturesFromText(text,date));

    // HTML-table/card fallback: find date-bearing blocks and inspect their text.
    const dd=String(Number(date.slice(8,10))).padStart(2,"0");
    const mon=Object.entries(SV_MONTHS).find(([,v])=>v===Number(date.slice(5,7)))?.[0]?.toUpperCase();
    const blocks=String(raw).match(/<(?:article|li|div)\b[^>]*>[\s\S]*?<\/(?:article|li|div)>/gi)||[];
    for(const b of blocks){
      const tx=decodeHtmlText(b).replace(/\s+/g," ").trim();
      if(!mon||!new RegExp(`\\b0?${Number(dd)}\\s+${mon}\\.?\\b`,"i").test(tx))continue;
      const lm=tx.match(/\b(Allsvenskan|Superettan)\s+2026\b/i);
      const tm=tx.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/);
      const vs=tx.match(/(?:Allsvenskan|Superettan)\s+2026\s+(.+?)\s+-\s+(.+?)\s+\d{1,2}:\d{2}/i);
      if(lm&&tm&&vs){
        const code=/superettan/i.test(lm[1])?"SWE2":"SWE";
        const f=officialFixture(code,date,tm[0],vs[1].trim(),vs[2].trim(),"svff-official");
        if(f)out.push(f);
      }
    }
  }catch(e){console.warn("SvFF official fallback:",e.message)}
  const ded=[...new Map(out.map(f=>[fixtureMergeKey(f),f])).values()];
  setCache(k,ded,180000);return ded;
}


function datePartsForLocale(date){
  return {d:Number(date.slice(8,10)),m:Number(date.slice(5,7)),y:Number(date.slice(0,4))};
}
const RU_MONTHS={"января":1,"февраля":2,"марта":3,"апреля":4,"мая":5,"июня":6,"июля":7,"августа":8,"сентября":9,"октября":10,"ноября":11,"декабря":12};
const RO_MONTHS={"ianuarie":1,"februarie":2,"martie":3,"aprilie":4,"mai":5,"iunie":6,"iulie":7,"august":8,"septembrie":9,"octombrie":10,"noiembrie":11,"decembrie":12};

async function russianCupOfficialFixturesForDate(date){
  const k=`rfs-cup:${date}`,c=getCache(k);if(c)return c;
  const out=[],p=datePartsForLocale(date);
  try{
    const raw=await fetchTextSmart("https://www.rfs.ru/cup/tournament/matches/rpl",{"User-Agent":"Mozilla/5.0 MatchEdge/7.19.0","Accept-Language":"ru-RU,ru;q=0.9"});
    const text=decodeHtmlText(raw).replace(/\s+/g," ");
    const month=Object.entries(RU_MONTHS).find(([,v])=>v===p.m)?.[0];
    if(month){
      const dateRe=new RegExp(`\\b${p.d}\\s+${month}\\s+${p.y}\\b`,"i"),dm=dateRe.exec(text);
      if(dm){
        const tail=text.slice(dm.index+dm[0].length);
        const next=tail.search(new RegExp(`\\b\\d{1,2}\\s+(?:${Object.keys(RU_MONTHS).join("|")})\\s+${p.y}\\b`,"i"));
        const block=next>=0?tail.slice(0,next):tail.slice(0,1600);
        const re=/([А-ЯЁA-Z][А-Яа-яЁёA-Za-z0-9 .()\-]{1,45}?)\s+(\d{1,2}:\d{2})\s+([А-ЯЁA-Z][А-Яа-яЁёA-Za-z0-9 .()\-]{1,45}?)(?=\s+[А-ЯЁA-Z]|\s*$)/g;
        let m;while((m=re.exec(block))){
          const f=officialFixture("RUSC",date,m[2],m[1].trim(),m[3].trim(),"rfs-official");
          if(f)out.push(f);
        }
      }
    }
  }catch(e){console.warn("RFS cup fallback:",e.message)}
  const ded=[...new Map(out.map(f=>[fixtureMergeKey(f),f])).values()];setCache(k,ded,180000);return ded;
}


const RO_MONTH_NUM={ian:1,ianuarie:1,feb:2,februarie:2,mar:3,martie:3,apr:4,aprilie:4,mai:5,iun:6,iunie:6,iul:7,iulie:7,aug:8,august:8,sep:9,sept:9,septembrie:9,oct:10,octombrie:10,nov:11,noiembrie:11,dec:12,decembrie:12};
function lpfDateToYmd(day,mon,year){
  const m=RO_MONTH_NUM[String(mon||"").toLowerCase().replace(/\./g,"")];
  return m?`${year}-${String(m).padStart(2,"0")}-${String(day).padStart(2,"0")}`:null;
}
function repairRomanianText(v){
  let x=String(v??"").trim();
  const pairs=[
    ["È™","ș"],["È˜","Ș"],["È›","ț"],["Èš","Ț"],
    ["ÅŸ","ș"],["Åž","Ș"],["Å£","ț"],["Å¢","Ț"],
    ["Äƒ","ă"],["Ä‚","Ă"],["Ã¢","â"],["Ã‚","Â"],
    ["Ã®","î"],["ÃŽ","Î"],["Ã£","ă"],["Ãƒ","Ă"]
  ];
  for(const [bad,good] of pairs)x=x.split(bad).join(good);
  try{
    const repaired=Buffer.from(x,"latin1").toString("utf8");
    const bad=t=>(t.match(/[ÃÄÅÈ]/g)||[]).length+(t.match(/\uFFFD/g)||[]).length*4;
    if(repaired && bad(repaired)<bad(x))x=repaired;
  }catch{}
  return x.normalize("NFC").replace(/\s+/g," ").trim();
}

const ROU_CANONICAL_NAMES={
  fcsb:"FCSB", steauabucuresti:"FCSB",
  cfrcluj:"CFR Cluj",
  rapidbucuresti:"Rapid București", rapid1923:"Rapid București", rapid:"Rapid București",
  dinamobucuresti:"Dinamo București", dinamo1948:"Dinamo București",
  universitateacraiova:"Universitatea Craiova", ucraiova:"Universitatea Craiova",
  universitateacluj:"Universitatea Cluj", ucluj:"Universitatea Cluj",
  farulconstanta:"Farul Constanța", farul:"Farul Constanța",
  otelulgalati:"Oțelul Galați", otelul:"Oțelul Galați",
  fcbotosani:"FC Botoșani", botosani:"FC Botoșani",
  petrolulploiesti:"Petrolul Ploiești", petrolul:"Petrolul Ploiești",
  fchermannstadt:"FC Hermannstadt", hermannstadt:"FC Hermannstadt",
  utaarad:"UTA Arad", uta:"UTA Arad",
  sepsiosk:"Sepsi OSK",
  fcarges:"FC Argeș", argespitesti:"FC Argeș", arges:"FC Argeș",
  unireaslobozia:"Unirea Slobozia", slobozia:"Unirea Slobozia",
  metaloglobusbucuresti:"Metaloglobus București", metaloglobus:"Metaloglobus București",
  csmioveni:"CS Mioveni",
  poliiasi:"Poli Iași", politehnicaiasi:"Poli Iași",
  fcvoluntari:"FC Voluntari", voluntari:"FC Voluntari",
  chindiatargoviste:"Chindia Târgoviște", chindia:"Chindia Târgoviște"
};
function romanianDisplayName(v){
  const fixed=repairRomanianText(v);
  return ROU_CANONICAL_NAMES[norm(fixed)]||fixed;
}
function decodeHtmlEntities(v){
  return String(v??"")
    .replace(/&#8211;|&#x2013;/gi,"–")
    .replace(/&#8212;|&#x2014;/gi,"—")
    .replace(/&#39;|&#x27;/gi,"'")
    .replace(/&quot;/gi,'"')
    .replace(/&amp;/gi,"&")
    .replace(/&nbsp;/gi," ")
    .replace(/&#(\d+);/g,(_,n)=>{try{return String.fromCodePoint(Number(n))}catch{return" "}});
}
function sanitizeRomanianTeamName(v){
  let x=repairRomanianText(decodeHtmlEntities(v)).replace(/\s+/g," ").trim();
  x=x.replace(/^\d+\s*[:.)-]\s*/,"").trim();
  x=x.replace(/\s+\d+\s*[-–]\s*\d+\s*$/,"").trim();
  return romanianDisplayName(x);
}
function validRomanianTeamName(v){
  const x=sanitizeRomanianTeamName(v);
  if(!x || x.length<2 || x.length>34)return false;
  if(/[<>]|&#\d+;/.test(x))return false;
  if(/[():;]/.test(x))return false;
  if(/\b(?:campionii|clasament|prima sport|digi sport|grupa|etapa|rezultate|program|statistici|live|sport)\b/i.test(x))return false;
  if((x.match(/\d/g)||[]).length>3)return false;
  return true;
}
function isRomanianFixture(f){
  const c=norm(f?.country||"");
  return ["ROU","ROUC"].includes(f?.leagueCode)||c==="romanya"||c==="romania";
}
function isTrustedRomanianFixtureSource(f){
  if(!isRomanianFixture(f))return true;
  const src=String(f?.fixtureSource||"").toLowerCase();
  // Only structured providers are allowed to create Romanian fixtures.
  return src==="api-football"||src==="espn-fallback"||src==="football-data.co.uk"||src==="sportsdb-fallback";
}
function validRomanianFixture(f){
  if(!isRomanianFixture(f))return true;
  return validRomanianTeamName(f.home?.name) && validRomanianTeamName(f.away?.name);
}

function normalizeRomanianFixture(f){
  if(!isRomanianFixture(f))return f;
  return {...f,
    leagueCode:f.leagueCode==="ROUC"?"ROUC":"ROU",
    league:f.leagueCode==="ROUC"?"Cupa României":"SuperLiga",
    country:"Romanya",
    home:{...f.home,name:sanitizeRomanianTeamName(f.home?.name)},
    away:{...f.away,name:sanitizeRomanianTeamName(f.away?.name)}
  };
}

function cleanLpfTeam(x){
  const cleaned=repairRomanianText(String(x||""))
    .replace(/\b(?:FCB|FAR|OSK|DIN|OGL|UCV|UCJ|FCP|COR|FCV|FCA|FKCS|RAP)\b/g," ")
    .replace(/\bImage\b/gi," ").replace(/\s+/g," ").trim();
  return romanianDisplayName(cleaned);
}
async function romanianLeagueOfficialFixturesForDate(date){
  // Disabled permanently: HTML page text is not a reliable structured fixture source.
  return [];
}

async function romanianCupOfficialFixturesForDate(date){
  // Disabled permanently: HTML page text is not a reliable structured fixture source.
  return [];
}

async function polishCupFixturesForDate(date){
  const k=`polish-cup:${date}`,c=getCache(k);if(c)return c;
  const out=[],p=datePartsForLocale(date);
  try{
    const raw=await fetchTextSmart("https://www.legalsport.pl/rozgrywki/pilka-nozna/puchar-polski/",{"User-Agent":"Mozilla/5.0 MatchEdge/7.19.0","Accept-Language":"pl-PL,pl;q=0.9"});
    const text=decodeHtmlText(raw).replace(/\s+/g," ");
    const dd=String(p.d).padStart(2,"0")+"."+String(p.m).padStart(2,"0")+"."+p.y;
    const re=new RegExp(dd.replace(/\./g,"\\.")+String.raw`\s+(\d{1,2}:\d{2})\s+(.+?)\s+(.+?)\s+(?:-\s+-|\d+\s*-\s*\d+)(?=\s+\d{2}\.\d{2}\.\d{4}|$)`,"g");
    let m;while((m=re.exec(text))){
      // Prefer separating team names around known Polish club suffix/prefix boundaries.
      let both=(m[2]+" "+m[3]).replace(/\s+/g," ").trim(),home=m[2].trim(),away=m[3].trim();
      if(home&&away){
        const f=officialFixture("POLC",date,m[1],home,away,"polish-cup-fallback");
        if(f)out.push(f);
      }
    }
  }catch(e){console.warn("Polish Cup fallback:",e.message)}
  const ded=[...new Map(out.map(f=>[fixtureMergeKey(f),f])).values()];setCache(k,ded,180000);return ded;
}

/* Extra scoreboard coverage: if a competition provider misses a match, these
   federation/competition fallbacks enter the same merged fixture array, so
   scoreboard and fixture cards always use one source of truth. */
async function officialFixturesForDate(date){
  const [tr,ch,ch2,se,ru,roLeague,roCup,pl]=await Promise.all([
    tffOfficialFixturesForDate(date),
    swissOfficialFixturesForDate(date),
    swissChallengeOfficialFixturesForDate(date),
    svffOfficialFixturesForDate(date),
    russianCupOfficialFixturesForDate(date),
    romanianLeagueOfficialFixturesForDate(date),
    romanianCupOfficialFixturesForDate(date),
    polishCupFixturesForDate(date)
  ]);
  return [...tr,...ch,...ch2,...se,...ru,...roLeague,...roCup,...pl];
}

/* ---------------- Fixtures ---------------- */
function inferLeagueCodeFromApiFixture(x){
  const id=Number(x?.league?.id);
  if(id&&LEAGUE_BY_API[id]?.code)return LEAGUE_BY_API[id].code;

  const name=apiNameNorm(x?.league?.name);
  const country=apiNameNorm(x?.league?.country);
  if(!name||!country)return null;

  let bestCode=null,best=-999;
  for(const [code,hint] of Object.entries(API_LEAGUE_HINTS)){
    if(apiNameNorm(hint.country)!==country)continue;
    const fake={league:{name:x.league.name,type:x.league.type||""},country:{name:x.league.country},seasons:[{year:2026,current:true}]};
    const sc=apiLeagueMatchScore(fake,hint,code);
    if(sc>best){best=sc;bestCode=code;}
  }
  if(bestCode&&best>=70){
    if(id){
      LEAGUES[bestCode].apiId=id;
      LEAGUE_BY_API[id]={code:bestCode,...LEAGUES[bestCode]};
    }
    return bestCode;
  }

  // Last-resort exact competition recognizers for the leagues that were
  // repeatedly being discarded despite the API returning the fixture.
  const exact=[
    ["SWE2","sweden",/superettan/],["SWE","sweden",/allsvenskan/],["SWEC","sweden",/svenska cup|cup/],
    ["SUIC","switzerland",/challenge league/],["SUI","switzerland",/super league/],
    ["RUSC","russia",/cup/],["RPL","russia",/premier league/],
    ["POLC","poland",/cup|puchar/],["POL","poland",/ekstraklasa/],
    ["AUT2","austria",/2 liga/],["AUT","austria",/bundesliga/],
    ["ROUC","romania",/cup|cupa/],["ROU","romania",/liga i|superliga/],
    ["CIT","italy",/coppa italia|cup/],["SB","italy",/serie b/],["SA","italy",/serie a/]
  ];
  for(const [code,c,re] of exact){
    if(country===c&&re.test(name)){
      if(id){
        LEAGUES[code].apiId=id;
        LEAGUE_BY_API[id]={code,...LEAGUES[code]};
      }
      return code;
    }
  }
  return null;
}
function mapFixture(x){
  const code=inferLeagueCodeFromApiFixture(x);if(!code)return null;
  const l=LEAGUES[code];if(!l)return null;
  return {id:x.fixture.id,apiFixtureId:x.fixture.id,date:x.fixture.date,localDate:localYmdFromDate(x.fixture.date),displayTime:localTimeFromDate(x.fixture.date),timestamp:x.fixture.timestamp,status:x.fixture.status?.short||"",leagueCode:code,league:l.name,country:l.country,emoji:l.emoji,round:x.league.round||"",
    apiLeagueId:Number(x?.league?.id)||l.apiId||null,apiLeagueName:x?.league?.name||l.name,apiLeagueCountry:x?.league?.country||l.country,
    home:{id:x.teams.home.id||null,name:x.teams.home.name,logo:x.teams.home.logo||""},away:{id:x.teams.away.id||null,name:x.teams.away.name,logo:x.teams.away.logo||""},
    score:{home:x.goals?.home??null,away:x.goals?.away??null,htHome:x.score?.halftime?.home??null,htAway:x.score?.halftime?.away??null},
    elapsed:x.fixture.status?.elapsed??null,fixtureSource:"api-football"};
}
function fixtureMergeKey(f){return [f.leagueCode||"",f.localDate||"",norm(f.home?.name||""),norm(f.away?.name||"")].join("|");}
function fixtureTeamKey(v){
  return norm(v).replace(/\b(fc|cf|sc|afc|sv|fk|sk|ac|as|us|ssc|rc|rsc|kv|krc|club|football|futbol|calcio)\b/g,"")
    .replace(/^(sint|saint)/,"st").replace(/(united|union)$/,"").replace(/\s+/g,"");
}
function fixtureTeamSimilarity(a,b){
  const x=fixtureTeamKey(a),y=fixtureTeamKey(b);
  if(!x||!y)return 0;
  if(x===y)return 1;
  if(x.includes(y)||y.includes(x))return .90;
  return similarity(a,b);
}
function sameFixtureIdentity(a,b){
  if(!a||!b||a.localDate!==b.localDate)return false;
  if(a.leagueCode&&b.leagueCode&&a.leagueCode!==b.leagueCode){
    const ca=LEAGUES[a.leagueCode]?.country,cb=LEAGUES[b.leagueCode]?.country;
    if(!ca||!cb||ca!==cb)return false;
  }
  const direct=fixtureTeamSimilarity(a.home?.name,b.home?.name)>=.68 &&
               fixtureTeamSimilarity(a.away?.name,b.away?.name)>=.68;
  const swapped=fixtureTeamSimilarity(a.home?.name,b.away?.name)>=.78 &&
                fixtureTeamSimilarity(a.away?.name,b.home?.name)>=.78;
  if(!direct&&!swapped)return false;
  const ta=Date.parse(a.date||""),tb=Date.parse(b.date||"");
  return !(Number.isFinite(ta)&&Number.isFinite(tb)&&Math.abs(ta-tb)>3*3600000);
}
function fixtureProviderPriority(f){
  const src=String(f?.fixtureSource||"").toLowerCase();
  if(src==="api-football")return 50;
  if(src==="football-data.co.uk")return 40;
  if(src==="espn-fallback")return 30;
  if(src==="sportsdb-fallback")return 20;
  return 0;
}
function fixtureRichness(f){
  return (f?.apiFixtureId?8:0)+(f?.home?.logo?3:0)+(f?.away?.logo?3:0)+
    ((f?.score?.home!=null||f?.goals?.home!=null)?4:0)+
    (f?.fixtureSource==="api-football"?5:f?.fixtureSource==="football-data"?4:f?.fixtureSource==="espn"?3:0);
}
function mergeFixturePair(a,b){
  let p,q;
  if(isRomanianFixture(a)||isRomanianFixture(b)){
    p=fixtureProviderPriority(a)>=fixtureProviderPriority(b)?a:b;
    q=p===a?b:a;
  }else{
    p=fixtureRichness(a)>=fixtureRichness(b)?a:b;
    q=p===a?b:a;
  }
  return {...q,...p,home:{...q.home,...p.home},away:{...q.away,...p.away},
    providers:[...new Set([...(a.providers||[a.fixtureSource]),...(b.providers||[b.fixtureSource])].filter(Boolean))]};
}
function mergeFixtures(apiRows,fdRows){
  const out=[];
  for(const f of [...(apiRows||[]),...(fdRows||[])].filter(Boolean)){
    const i=out.findIndex(x=>sameFixtureIdentity(x,f));
    if(i<0)out.push({...f,providers:[...new Set(f.providers||[f.fixtureSource].filter(Boolean))]});
    else out[i]=mergeFixturePair(out[i],f);
  }
  return out;
}




async function fetchHistoryHalftime(f){
  if(!f||!LEAGUES[f.leagueCode]?.csv)return null;
  try{
    const hist=await leagueHistory(f.leagueCode);
    const target=hist.find(m=>{
      if(ymd(m.date)!==f.localDate)return false;
      return similarity(f.home?.name,m.home)>=.72&&similarity(f.away?.name,m.away)>=.72;
    });
    if(!target)return null;
    return {
      home:target.homeGoals??null,away:target.awayGoals??null,
      htHome:target.htHome??null,htAway:target.htAway??null,status:"FT"
    };
  }catch{return null}
}

async function fetchFixtureHalftime(f){
  if(!API_KEY||!f?.id)return null;
  // Only API-Football numeric fixture ids are suitable here.
  if(!/^\d+$/.test(String(f.id)))return null;
  try{
    const rows=await apiFootball(`/fixtures?id=${encodeURIComponent(f.id)}&timezone=${encodeURIComponent(APP_TIME_ZONE)}`,120000);
    const x=rows?.[0];
    if(!x)return null;
    return {
      home:x.goals?.home??null,
      away:x.goals?.away??null,
      htHome:x.score?.halftime?.home??null,
      htAway:x.score?.halftime?.away??null,
      status:x.fixture?.status?.short||f.status,
      elapsed:x.fixture?.status?.elapsed??f.elapsed??null
    };
  }catch{return null}
}



async function fetchEspnHalftime(f){
  if(!f?.espnEventId||!f?.espnSlug)return null;
  try{
    const url=`https://site.api.espn.com/apis/site/v2/sports/soccer/${f.espnSlug}/summary?event=${encodeURIComponent(f.espnEventId)}`;
    const r=await fetchT(url,{headers:{"User-Agent":"MatchEdge/7.9.12"}});
    if(!r.ok)return null;
    const b=await r.json();
    const comp=b.header?.competitions?.[0]||b.boxscore?.teams?.[0]?.competition||null;
    const competitors=comp?.competitors||b.header?.competitions?.[0]?.competitors||[];
    const hc=competitors.find(x=>x.homeAway==="home"),ac=competitors.find(x=>x.homeAway==="away");
    let htHome=hc?.linescores?.[0]?.value,htAway=ac?.linescores?.[0]?.value;

    // Some ESPN soccer summaries expose periods in header/plays rather than competitor linescores.
    if(htHome==null||htAway==null){
      const periods=b.header?.competitions?.[0]?.details||[];
      const half=periods.find(x=>String(x?.type?.text||x?.type?.name||"").toLowerCase().includes("half"));
      if(half?.competitors){
        const hh=half.competitors.find(x=>x.homeAway==="home"),aa=half.competitors.find(x=>x.homeAway==="away");
        htHome=hh?.score?.value??hh?.score??htHome;
        htAway=aa?.score?.value??aa?.score??htAway;
      }
    }
    return {
      htHome:htHome!=null?Number(htHome):null,
      htAway:htAway!=null?Number(htAway):null
    };
  }catch{return null}
}

async function enrichHalftimeScores(fixtures){
  const byLeague=new Map();
  for(const f of fixtures){
    if(f?.score?.htHome!=null&&f?.score?.htAway!=null)continue;
    if(!LEAGUES[f.leagueCode]?.csv)continue;
    if(!byLeague.has(f.leagueCode))byLeague.set(f.leagueCode,[]);
    byLeague.get(f.leagueCode).push(f);
  }
  for(const [code,list] of byLeague){
    let hist=[];try{hist=await leagueHistory(code)}catch{}
    if(!hist.length)continue;
    for(const f of list){
      const target=hist.find(m=>{
        const d=ymd(m.date);
        if(d!==f.localDate)return false;
        return similarity(f.home?.name,m.home)>=.72&&similarity(f.away?.name,m.away)>=.72;
      });
      if(!target)continue;
      f.score=f.score||{};
      if(f.score.home==null)f.score.home=target.homeGoals;
      if(f.score.away==null)f.score.away=target.awayGoals;
      if(f.score.htHome==null)f.score.htHome=target.htHome;
      if(f.score.htAway==null)f.score.htAway=target.htAway;
      if(f.status==="NS"&&f.score.home!=null&&f.score.away!=null)f.status="FT";
    }
  }
  // Final pass: for finished/live API-Football fixtures still missing HT,
  // request fixture detail directly. This fills cups/leagues that have no CSV history.
  const missing=fixtures.filter(f=>{
    const htMissing=f?.score?.htHome==null||f?.score?.htAway==null;
    const oldScored=scoreKnownServer(f)&&Number(f.timestamp||0)>0&&Number(f.timestamp)<Math.floor(Date.now()/1000)-5400;
    return htMissing&&(statusFinishedServer(f.status)||oldScored||["1H","HT","2H","ET","BT","P","INT","LIVE"].includes(String(f.status||"").toUpperCase()));
  });
  let cursor=0;
  const workers=Array.from({length:Math.min(4,missing.length||1)},async()=>{
    while(true){
      const i=cursor++;if(i>=missing.length)break;
      const f=missing[i];
      let d=await fetchFixtureHalftime(f);
      f.score=f.score||{};
      if(d){
        if(d.home!=null)f.score.home=d.home;
        if(d.away!=null)f.score.away=d.away;
        if(d.htHome!=null)f.score.htHome=d.htHome;
        if(d.htAway!=null)f.score.htAway=d.htAway;
        if(d.status)f.status=d.status;
        if(d.elapsed!=null)f.elapsed=d.elapsed;
      }
      if(f.score.htHome==null||f.score.htAway==null){
        const e=await fetchEspnHalftime(f);
        if(e){
          if(e.htHome!=null)f.score.htHome=e.htHome;
          if(e.htAway!=null)f.score.htAway=e.htAway;
        }
      }
    }
  });
  await Promise.all(workers);
  return fixtures;
}

async function romanianStructuredFixturesForDate(date){
  const k=`rou-structured-fixtures-v2:${date}`,c=getCache(k);if(c)return c;
  const out=[];

  // Dedicated ESPN Romania call: do not depend on the all-league fallback batch.
  try{
    const compact=date.replaceAll("-","");
    const slug=ESPN_SLUGS.ROU||"rou.1";
    const url=`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${compact}`;
    const r=await fetchT(url,{headers:{"User-Agent":"MatchEdge/7.19.0"}});
    if(r.ok){
      const b=await r.json();
      for(const ev of b.events||[]){
        const comp=ev.competitions?.[0];if(!comp)continue;
        const hc=(comp.competitors||[]).find(x=>x.homeAway==="home");
        const ac=(comp.competitors||[]).find(x=>x.homeAway==="away");
        const dt=ev.date||comp.date;
        if(!hc||!ac||!dt||localYmdFromDate(dt)!==date)continue;
        const home=sanitizeRomanianTeamName(hc.team?.displayName||hc.team?.shortDisplayName||hc.team?.name||"");
        const away=sanitizeRomanianTeamName(ac.team?.displayName||ac.team?.shortDisplayName||ac.team?.name||"");
        if(!validRomanianTeamName(home)||!validRomanianTeamName(away))continue;
        const f={
          id:stableFixtureId(["espn-rou",date,home,away]),date:dt,localDate:date,
          displayTime:localTimeFromDate(dt),timestamp:Math.floor(new Date(dt).getTime()/1000),
          status:espnStatusToShort(ev.status||comp.status),leagueCode:"ROU",league:"SuperLiga",country:"Romanya",emoji:"🇷🇴",
          round:repairRomanianText(ev.season?.slug||""),
          home:{id:hc.team?.id||null,name:home,logo:hc.team?.logo||""},
          away:{id:ac.team?.id||null,name:away,logo:ac.team?.logo||""},
          score:{home:hc.score!==undefined&&hc.score!==null&&hc.score!==""?Number(hc.score):null,
                 away:ac.score!==undefined&&ac.score!==null&&ac.score!==""?Number(ac.score):null,
                 htHome:hc.linescores?.[0]?.value!==undefined?Number(hc.linescores[0].value):null,
                 htAway:ac.linescores?.[0]?.value!==undefined?Number(ac.linescores[0].value):null},
          elapsed:ev.status?.displayClock||comp.status?.displayClock||null,
          espnEventId:ev.id||null,espnSlug:slug,fixtureSource:"espn-fallback"
        };
        out.push(f);
      }
    }
  }catch{}

  // Direct API-Football Romania request bypasses the slow all-league queue.
  if(!out.length&&API_KEY){
    try{
      const ctrl=new AbortController();
      const timer=setTimeout(()=>ctrl.abort(),4500);
      const leagueId=Number(LEAGUES.ROU?.apiId||283);
      const season=Number(String(date).slice(0,4));
      const url=`${API_BASE}/fixtures?league=${leagueId}&season=${season}&date=${encodeURIComponent(date)}&timezone=${encodeURIComponent(APP_TIME_ZONE)}`;
      const r=await fetch(url,{headers:{"x-apisports-key":API_KEY},signal:ctrl.signal});
      clearTimeout(timer);
      if(r.ok){
        const b=await r.json();
        for(const x of b.response||[]){
          const f=mapFixture(x);
          if(f){
            const rf=normalizeRomanianFixture({...f,leagueCode:"ROU",league:"SuperLiga",country:"Romanya"});
            if(validRomanianFixture(rf))out.push(rf);
          }
        }
      }
    }catch{}
  }

  const clean=mergeFixtures(out,[]).map(normalizeRomanianFixture).filter(validRomanianFixture);
  setCache(k,clean,clean.length?300000:30000);
  return clean;
}

async function structuredLeagueFixturesForDate(code,date){
  const slug=ESPN_SLUGS[code], l=LEAGUES[code];
  if(!l)return[];
  const k=`structured-v7173:${code}:${date}`,c=getCache(k);if(c)return c;
  let out=[];
  if(slug)try{
    const compact=date.replaceAll("-","");
    const url=`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${compact}`;
    const r=await fetchT(url,{headers:{"User-Agent":"MatchEdge/7.19.0"}});
    if(r.ok){
      const b=await r.json();
      for(const ev of b.events||[]){
        const comp=ev.competitions?.[0];if(!comp)continue;
        const hc=(comp.competitors||[]).find(x=>x.homeAway==="home"),ac=(comp.competitors||[]).find(x=>x.homeAway==="away");
        const dt=ev.date||comp.date;if(!hc||!ac||!dt||localYmdFromDate(dt)!==date)continue;
        out.push({
          id:stableFixtureId(["structured",code,date,hc.team?.displayName,ac.team?.displayName]),date:dt,localDate:date,
          displayTime:localTimeFromDate(dt),timestamp:Math.floor(new Date(dt).getTime()/1000),
          status:espnStatusToShort(ev.status||comp.status),leagueCode:code,league:l.name,country:l.country,emoji:l.emoji,
          home:{id:hc.team?.id||null,name:hc.team?.displayName||hc.team?.name||"",logo:hc.team?.logo||""},
          away:{id:ac.team?.id||null,name:ac.team?.displayName||ac.team?.name||"",logo:ac.team?.logo||""},
          score:{home:hc.score!==undefined&&hc.score!==""?Number(hc.score):null,away:ac.score!==undefined&&ac.score!==""?Number(ac.score):null},
          espnEventId:ev.id||null,espnSlug:slug,fixtureSource:"espn-fallback"
        });
      }
    }
  }catch{}
  if(!out.length&&API_KEY){
    try{
      const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),4500);
      const season=Number(date.slice(0,4));
      const url=`${API_BASE}/fixtures?league=${Number(l.apiId)}&season=${season}&date=${date}&timezone=${encodeURIComponent(APP_TIME_ZONE)}`;
      const r=await fetch(url,{headers:{"x-apisports-key":API_KEY},signal:ctrl.signal});clearTimeout(timer);
      if(r.ok){const b=await r.json();out=(b.response||[]).map(mapFixture).filter(Boolean);}
    }catch{}
  }
  out=out.filter(f=>f.localDate===date);
  setCache(k,out,out.length?300000:30000);
  return out;
}

async function denmarkRussiaHistoryRecovery(f,date,base=[]){
  if(!["DEN","DEN2","RPL","RUSC"].includes(f?.leagueCode))return mergeHistoryRows(base);
  if(f?.leagueCode==="RUSC")f={...f,leagueCode:"RPL"};
  if(f?.leagueCode==="DEN2"){
    let merged=mergeHistoryRows(base);
    try{const espn=await espnLeagueRangeHistory(f,date);if(espn?.length)merged=mergeHistoryRows(merged,espn)}catch{}
    if(API_KEY&&teamCoverage(merged,f).home<3){try{const api=await apiLeagueResearchHistory(f,date);if(api?.length)merged=mergeHistoryRows(merged,api)}catch{}}
    return merged;
  }
  let merged=mergeHistoryRows(base);
  try{
    const csv=await leagueHistory(f.leagueCode);
    if(csv?.length)merged=mergeHistoryRows(merged,csv);
  }catch{}
  try{
    const espn=await espnLeagueRangeHistory(f,date);
    if(espn?.length)merged=mergeHistoryRows(merged,espn);
  }catch{}
  const cov=teamCoverage(merged,f);
  if(API_KEY&&(!merged.length||cov.home<3||cov.away<3)){
    try{
      const api=await apiLeagueResearchHistory(f,date);
      if(api?.length)merged=mergeHistoryRows(merged,api);
    }catch{}
  }
  return merged;
}

async function fixturesForThreeDays(centerDate){
  const k=`daily-v7190:${centerDate}`,cached=getCache(k); if(cached) return cached;
  const dates=[centerDate];
  // Direct structured recovery for leagues/cups that can disappear from generic daily feeds.
  // Keep Russian Cup independent from RPL: on cup days there may be no RPL fixtures at all.
  const [denDirect,den2Direct,belDirect,rplDirect,ruscDirect]=await Promise.all([
    structuredLeagueFixturesForDate("DEN",centerDate),
    structuredLeagueFixturesForDate("DEN2",centerDate),
    structuredLeagueFixturesForDate("BEL",centerDate),
    structuredLeagueFixturesForDate("RPL",centerDate),
    structuredLeagueFixturesForDate("RUSC",centerDate)
  ]);
  let apiRows=[],fdRows=[],espnRows=[],officialRows=[],sportsDbRows=[],romaniaRows=[];

  // Dynamic league-id refresh must never sit in front of fixture rendering.
  Promise.resolve().then(()=>ensureDynamicLeagueIds(Number(String(centerDate).slice(0,4))))
    .catch(e=>console.warn("Dynamic league ids:",e.message));

  // Start public providers immediately.
  const fallbackSettledPromise=Promise.allSettled(dates.flatMap(date=>[
    footballDataUpcoming(date).then(v=>({type:"fd",date,v})),
    espnFixturesForDate(date).then(v=>({type:"espn",date,v})),
    officialFixturesForDate(date).then(v=>({type:"official",date,v})),
    sportsDbFixturesForDate(date).then(v=>({type:"sportsdb",date,v})),
    romanianStructuredFixturesForDate(date).then(v=>({type:"romania",date,v}))
  ]));

  // API-Football is rate-limited. Schedule all three date jobs together, but do not
  // let a cold API queue block public fixtures forever.
  const apiPromise=(async()=>{
    const settled=await Promise.allSettled(dates.map(date=>
      apiFootball(`/fixtures?date=${encodeURIComponent(date)}&timezone=${encodeURIComponent(APP_TIME_ZONE)}`,300000)
        .then(rows=>(rows||[]).map(mapFixture).filter(Boolean))
    ));
    return settled.flatMap(r=>r.status==="fulfilled"?r.value:[]);
  })();

  const fallbackSettled=await fallbackSettledPromise;
  for(const r of fallbackSettled){
    if(r.status!=="fulfilled"){console.warn("Fixture fallback:",r.reason?.message||r.reason);continue}
    const {type,v=[]}=r.value;
    if(type==="fd")fdRows.push(...v);
    else if(type==="espn")espnRows.push(...v);
    else if(type==="official")officialRows.push(...v);
    else if(type==="sportsdb")sportsDbRows.push(...v);
    else if(type==="romania")romaniaRows.push(...v);
  }

  const apiBudget=await Promise.race([
    apiPromise.then(v=>({done:true,v})),
    new Promise(resolve=>setTimeout(()=>resolve({done:false,v:[]}),5000))
  ]);
  apiRows.push(...apiBudget.v);
  if(!apiBudget.done){
    apiPromise.then(v=>setCache(`api-fixtures-late:${centerDate}`,v,300000))
      .catch(()=>{});
  }else{
    setCache(`api-fixtures-late:${centerDate}`,apiRows,300000);
  }
  const lateApi=getCache(`api-fixtures-late:${centerDate}`);
  if(lateApi?.length)apiRows=mergeFixtures(apiRows,lateApi);

  officialRows=officialRows.filter(f=>!isRomanianFixture(f));
  let merged=mergeFixtures(apiRows,[...fdRows,...espnRows,...officialRows,...sportsDbRows,...romaniaRows,...denDirect,...den2Direct,...belDirect,...rplDirect,...ruscDirect]).filter(f=>dates.includes(f.localDate));
  merged=mergeFixtures(merged,[]);

  // Final safety net: if today's BEL/RUSC rows are still absent, re-inject their direct structured fixtures.
  // This runs before dedupe and never fabricates fixtures; it only reuses provider-returned structured rows.
  if(!merged.some(f=>f.leagueCode==="BEL")){
    try{
      const emergencyBel=belDirect?.length?belDirect:await structuredLeagueFixturesForDate("BEL",centerDate);
      if(emergencyBel?.length)merged=mergeFixtures(merged,emergencyBel.filter(f=>f.localDate===centerDate));
    }catch(e){console.warn("BEL emergency recovery:",e.message)}
  }
  if(!merged.some(f=>f.leagueCode==="RUSC")){
    try{
      const emergencyRusc=ruscDirect?.length?ruscDirect:await structuredLeagueFixturesForDate("RUSC",centerDate);
      if(emergencyRusc?.length)merged=mergeFixtures(merged,emergencyRusc.filter(f=>f.localDate===centerDate));
    }catch(e){console.warn("RUSC emergency recovery:",e.message)}
  }

  merged=merged.map(normalizeRomanianFixture).filter(validRomanianFixture);
  if(!merged.some(isRomanianFixture)){
    try{
      const emergency=await romanianStructuredFixturesForDate(centerDate);
      if(emergency?.length)merged=mergeFixtures(merged,emergency).map(normalizeRomanianFixture).filter(validRomanianFixture);
    }catch{}
  }
  const dedupe=new Map();
  for(const f0 of merged){
    const f={...f0,providers:[...(f0.providers||[]),f0.fixtureSource||"unknown"]};
    const key=fixtureMergeKey(f);
    if(!dedupe.has(key)) dedupe.set(key,f);
    else{
      const old=dedupe.get(key);
      const providers=[...new Set([...(old.providers||[]),...(f.providers||[])])];
      const preferApi=f.fixtureSource==="api-football"||f.fixtureSource==="merged";
      const primary=preferApi?f:old,secondary=preferApi?old:f;
      dedupe.set(key,{...secondary,...primary,providers,home:{...secondary.home,...primary.home},away:{...secondary.away,...primary.away},
        score:{
          home:f.score?.home??old.score?.home??null,away:f.score?.away??old.score?.away??null,
          htHome:primary.score?.htHome??secondary.score?.htHome??null,htAway:primary.score?.htAway??secondary.score?.htAway??null
        },
        espnEventId:primary.espnEventId??secondary.espnEventId??null,espnSlug:primary.espnSlug??secondary.espnSlug??null});
    }
  }
  const fixtures=[...dedupe.values()].sort((a,b)=>a.timestamp-b.timestamp);
  // Normalize every displayed team name to plain-English/ASCII letters, regardless
  // of source (ESPN often returns native-script names like "F.C. København" or
  // "Heart of Midlothian" while other sources use the plain-English form).
  for(const f of fixtures){
    if(f.home?.name)f.home.name=toEnglishDisplay(f.home.name);
    if(f.away?.name)f.away.name=toEnglishDisplay(f.away.name);
  }
  // Keep fixture loading fast. Halftime enrichment must never block the whole page.
  fixtures.forEach(f=>setCache(`fixture:${f.id}`,f,3600000));
  const result={center:centerDate,dates:{today:centerDate},fixtures};
  setCache(k,result,300000);
  Promise.resolve().then(()=>prewarmAnalysisData(fixtures))
    .catch(e=>console.warn("Analysis background prewarm:",e.message));
  // Enrich scores asynchronously; cached fixture objects are updated in place.
  Promise.resolve().then(()=>enrichHalftimeScores(fixtures)).then(()=>{
    fixtures.forEach(f=>setCache(`fixture:${f.id}`,f,3600000));
    settlePendingPredictions(fixtures);
  }).catch(e=>console.warn("Halftime background enrichment:",e.message));
  settlePendingPredictions(fixtures);
  return result;
}
async function fixturesForDate(date){
  const result=await fixturesForThreeDays(date);
  return result.fixtures.filter(f=>f.localDate===date);
}




function espnStatValue(teamBlock,names){
  const want=names.map(x=>String(x).toLowerCase().replace(/[^a-z0-9]/g,""));
  for(const st of teamBlock?.statistics||[]){
    const key=String(st.name||st.label||st.abbreviation||"").toLowerCase().replace(/[^a-z0-9]/g,"");
    if(want.includes(key)){
      const n=parseFloat(st.value??st.displayValue);
      if(Number.isFinite(n))return n;
    }
  }
  return null;
}

async function espnEventTeamStats(slug,eventId,homeId,awayId){
  try{
    const r=await fetchT(`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/summary?event=${encodeURIComponent(eventId)}`,{headers:{"User-Agent":"MatchEdge/7.10.4"}});
    if(!r.ok)return{};
    const b=await r.json();
    const teams=b.boxscore?.teams||[];
    const hb=teams.find(x=>String(x.team?.id)===String(homeId))||teams.find(x=>x.homeAway==="home");
    const ab=teams.find(x=>String(x.team?.id)===String(awayId))||teams.find(x=>x.homeAway==="away");
    return{
      homeShots:espnStatValue(hb,["totalshots","shots"]),
      awayShots:espnStatValue(ab,["totalshots","shots"]),
      homeSOT:espnStatValue(hb,["shotsonTarget","shotsontarget"]),
      awaySOT:espnStatValue(ab,["shotsonTarget","shotsontarget"]),
      homeCorners:espnStatValue(hb,["cornerkicks","corners"]),
      awayCorners:espnStatValue(ab,["cornerkicks","corners"])
    };
  }catch{return{}}
}


async function espnLeagueRangeHistory(f,date){
  const slug=f?.espnSlug||ESPN_SLUGS[f?.leagueCode];
  if(!slug)return[];
  const ck=`espn-range:${slug}:${date}`,cached=getCache(ck);
  if(cached)return cached;
  const end=date.replace(/-/g,"");
  const startDate=new Date(`${date}T12:00:00+03:00`);
  const historyDays=["ROU","RPL","DEN"].includes(f?.leagueCode)?430:220;
  startDate.setDate(startDate.getDate()-historyDays);
  const start=localYmdFromDate(startDate).replace(/-/g,"");
  try{
    const url=`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${start}-${end}&limit=300`;
    const r=await fetchT(url,{headers:{"User-Agent":"MatchEdge/7.19.0"}});
    if(!r.ok)return[];
    const b=await r.json(),out=[];
    for(const ev of b.events||[]){
      const comp=ev.competitions?.[0],cs=comp?.competitors||[];
      const hc=cs.find(x=>x.homeAway==="home"),ac=cs.find(x=>x.homeAway==="away");
      if(!hc||!ac)continue;
      const dt=ev.date||comp.date;if(!dt||localYmdFromDate(dt)>=date)continue;
      const st=espnStatusToShort(ev.status||comp.status);if(st!=="FT")continue;
      const hg=Number(hc.score),ag=Number(ac.score);if(!Number.isFinite(hg)||!Number.isFinite(ag))continue;
      out.push({
        season:normalizedSeasonLabelFromDate(dt),date:new Date(dt),
        home:hc.team?.displayName||hc.team?.name||"",away:ac.team?.displayName||ac.team?.name||"",
        homeGoals:hg,awayGoals:ag,
        htHome:hc.linescores?.[0]?.value!=null?Number(hc.linescores[0].value):null,
        htAway:ac.linescores?.[0]?.value!=null?Number(ac.linescores[0].value):null,
        homeShots:null,awayShots:null,homeSOT:null,awaySOT:null,homeCorners:null,awayCorners:null,
        homeYellow:null,awayYellow:null,homeRed:null,awayRed:null,source:"espn-range-history"
      });
    }
    const rows=out.sort((a,b)=>a.date-b.date);
    setCache(ck,rows,rows.length?900000:30000);
    return rows;
  }catch(e){console.warn("ESPN range history:",e.message);return[]}
}

async function espnTeamResearchHistory(f,date){
  const slug=f?.espnSlug||ESPN_SLUGS[f?.leagueCode];
  if(!slug||!f?.home?.id||!f?.away?.id)return[];
  const season=+String(date||"").slice(0,4);
  const ids=[String(f.home.id),String(f.away.id)];
  try{
    const jobs=ids.map(async teamId=>{
      const urls=[
        `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/teams/${teamId}/schedule?season=${season}`,
        `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/teams/${teamId}/schedule`
      ];
      for(const url of urls){
        try{
          const r=await fetchT(url,{headers:{"User-Agent":"MatchEdge/7.10.4"}});
          if(!r.ok)continue;
          const b=await r.json();
          if(Array.isArray(b.events)&&b.events.length)return b.events;
        }catch{}
      }
      return[];
    });
    const events=(await Promise.all(jobs)).flat();
    const seen=new Map();
    for(const ev of events){
      const comp=ev.competitions?.[0]; if(!comp)continue;
      const cs=comp.competitors||[];
      const hc=cs.find(x=>x.homeAway==="home"),ac=cs.find(x=>x.homeAway==="away");
      if(!hc||!ac)continue;
      const dt=ev.date||comp.date;if(!dt||localYmdFromDate(dt)>=date)continue;
      const status=espnStatusToShort(ev.status||comp.status);
      if(status!=="FT")continue;
      const home=hc.team?.displayName||hc.team?.shortDisplayName||hc.team?.name||"";
      const away=ac.team?.displayName||ac.team?.shortDisplayName||ac.team?.name||"";
      if(!home||!away)continue;
      const key=String(ev.id||[dt,home,away].join("|"));
      if(seen.has(key))continue;
      seen.set(key,{
        eventId:ev.id||null,homeId:hc.team?.id||null,awayId:ac.team?.id||null,
        season:`${season}/${String(season+1).slice(-2)}`,date:new Date(dt),home,away,
        homeGoals:Number(hc.score??0),awayGoals:Number(ac.score??0),
        htHome:hc.linescores?.[0]?.value!=null?Number(hc.linescores[0].value):null,
        htAway:ac.linescores?.[0]?.value!=null?Number(ac.linescores[0].value):null,
        homeShots:null,awayShots:null,homeSOT:null,awaySOT:null,
        homeCorners:null,awayCorners:null,homeYellow:null,awayYellow:null,homeRed:null,awayRed:null
      });
    }
    let rows=[...seen.values()].sort((a,b)=>a.date-b.date);
    // Enrich only the most recent relevant games with team stats/corners.
    const relevant=rows.filter(m=>ids.includes(String(m.homeId))||ids.includes(String(m.awayId))).slice(-8);
    await Promise.all(relevant.map(async m=>{
      if(!m.eventId)return;
      const st=await espnEventTeamStats(slug,m.eventId,m.homeId,m.awayId);
      Object.assign(m,st);
    }));
    return rows;
  }catch{return[]}
}

async function apiLeagueResearchHistory(f,date){
  if(!API_KEY||!f?.leagueCode||!LEAGUES[f.leagueCode]?.apiId)return[];
  const leagueId=LEAGUES[f.leagueCode].apiId;
  const current=+String(date||"").slice(0,4);
  const ck=`api-league-history-v2:${leagueId}:${current}:${date}`,cached=getCache(ck);
  if(cached)return cached;

  const out=[];
  for(const season of [current,current-1]){
    try{
      const to=season===current?date:`${season+1}-06-30`;
      const rows=await apiFootball(`/fixtures?league=${leagueId}&season=${season}&from=${season}-07-01&to=${to}&timezone=${encodeURIComponent(APP_TIME_ZONE)}`,180000);
      for(const x of rows||[]){
        const st=String(x.fixture?.status?.short||"");
        if(!["FT","AET","PEN"].includes(st))continue;
        if(season===current&&localYmdFromDate(x.fixture.date)>=date)continue;
        out.push({
          season:`${season}/${String(season+1).slice(-2)}`,date:new Date(x.fixture.date),
          home:x.teams.home.name,away:x.teams.away.name,
          homeGoals:x.goals?.home??0,awayGoals:x.goals?.away??0,
          htHome:x.score?.halftime?.home??null,htAway:x.score?.halftime?.away??null,
          homeShots:null,awayShots:null,homeSOT:null,awaySOT:null,
          homeCorners:null,awayCorners:null,homeYellow:null,awayYellow:null,homeRed:null,awayRed:null,
          source:"api-football-history"
        });
      }
    }catch(e){console.warn(`API history ${f.leagueCode} ${season}:`,e.message)}
  }
  const sorted=mergeHistoryRows(out);
  setCache(ck,sorted,sorted.length?1800000:30000);
  return sorted;
}

async function apiTeamResearchHistory(f,date){
  if(!API_KEY||!f?.home?.id||!f?.away?.id)return[];
  const season=+String(date||"").slice(0,4);
  const ids=[f.home.id,f.away.id];
  const jobs=ids.map(async teamId=>{
    try{
      const rows=await apiFootball(`/fixtures?team=${teamId}&season=${season}&last=12&timezone=${encodeURIComponent(APP_TIME_ZONE)}`,180000);
      const out=[];
      for(const x of (rows||[]).slice(-6)){
        if(!x?.fixture?.id||!x?.teams?.home||!x?.teams?.away)continue;
        if(localYmdFromDate(x.fixture.date)>=date)continue;
        let st=null;
        try{
          const sr=await apiFootball(`/fixtures/statistics?fixture=${x.fixture.id}`,180000);
          const hst=(sr||[]).find(z=>z.team?.id===x.teams.home.id),ast=(sr||[]).find(z=>z.team?.id===x.teams.away.id);
          const val=(obj,label)=>{const z=obj?.statistics?.find(q=>q.type===label)?.value;const n=parseFloat(z);return Number.isFinite(n)?n:null};
          st={
            homeShots:val(hst,"Total Shots"),awayShots:val(ast,"Total Shots"),
            homeSOT:val(hst,"Shots on Goal"),awaySOT:val(ast,"Shots on Goal"),
            homeCorners:val(hst,"Corner Kicks"),awayCorners:val(ast,"Corner Kicks")
          };
        }catch{}
        out.push({
          season:season===2026?"2026/27":"2025/26",date:new Date(x.fixture.date),
          home:x.teams.home.name,away:x.teams.away.name,
          homeGoals:x.goals?.home??0,awayGoals:x.goals?.away??0,
          htHome:x.score?.halftime?.home??null,htAway:x.score?.halftime?.away??null,
          homeShots:st?.homeShots??null,awayShots:st?.awayShots??null,
          homeSOT:st?.homeSOT??null,awaySOT:st?.awaySOT??null,
          homeCorners:st?.homeCorners??null,awayCorners:st?.awayCorners??null,
          homeYellow:null,awayYellow:null,homeRed:null,awayRed:null
        });
      }
      return out;
    }catch{return[]}
  });
  const rows=(await Promise.all(jobs)).flat();
  const seen=new Set();
  return rows.filter(m=>{const k=[m.date.toISOString().slice(0,10),norm(m.home),norm(m.away)].join("|");if(seen.has(k))return false;seen.add(k);return true}).sort((a,b)=>a.date-b.date);
}

function siblingLeagueCodes(code){const base=LEAGUES[code];if(!base)return[];return Object.entries(LEAGUES).filter(([c,l])=>c!==code&&l.country===base.country).map(([c])=>c);}
async function resolveCupTeamsFromDomesticHistory(f,date,history=[]){
  if(!CUP_SUPPORT_LEAGUES[f?.leagueCode]?.length)return {history,fixture:f};
  const rows=history?.length?history:await domesticCupSupportHistory(f,date,[]);
  if(!rows.length)return {history:rows,fixture:f};
  const names=[...new Set(rows.flatMap(x=>[x.home,x.away]).filter(Boolean))];
  const best=(name)=>{
    let pick=name,score=0;
    for(const n of names){
      const q=similarity(name,n);
      if(q>score){score=q;pick=n;}
    }
    return score>=.55?pick:name;
  };
  return {history:rows,fixture:{...f,modelHomeName:best(f.home?.name||""),modelAwayName:best(f.away?.name||"")}};
}

async function resolveTeams(f,leagueH,{allowSiblingLookup=false}={}){
  let home=findTeam(f.home.name,leagueH),away=findTeam(f.away.name,leagueH),extra=[];
  if(isRomanianFixture(f)){
    const exactFind=(name,rows)=>{
      const teams=[...new Set((rows||[]).flatMap(m=>[m.home,m.away]))];
      let best=null,score=0;
      for(const t of teams){const q=similarity(name,t);if(q>score){score=q;best=t;}}
      return score>=0.82?best:null;
    };
    home=exactFind(sanitizeRomanianTeamName(f.home.name),leagueH);
    away=exactFind(sanitizeRomanianTeamName(f.away.name),leagueH);
  }
  // Interactive analysis must never fan out across every CSV league.
  // Optional sibling lookup is reserved for background enrichment only.
  if(allowSiblingLookup&&(!home||!away)){
    let sib=siblingLeagueCodes(f.leagueCode);
    const hs=await Promise.all(sib.map(leagueHistory));extra=hs.flat();
    if(!home)home=findTeam(f.home.name,extra);
    if(!away)away=findTeam(f.away.name,extra);
  }
  const merged=mergeHistoryRows(leagueH,extra);
  return {home,away,history:merged};
}

/* ---------------- Routes ---------------- */
app.get("/api/model-accuracy",(req,res)=>{
  try{ res.json({ok:true,...computeAccuracyStats()}); }
  catch(e){ res.status(500).json({ok:false,error:e.message}); }
});
app.get("/api/health",(req,res)=>res.json({ok:true,version:"7.19.0-live-state-analysis",timezone:APP_TIME_ZONE,mode:MODE,providers:{apiFootball:!!API_KEY,footballData:true,fixtureFallback:true},features:{yesterdayTodayTomorrow:false,timezoneNormalization:true,fixtureMerge:true,romaniaStructuredOnly:true,analysisToggle:true,marketAwareAnalysis:true,noVigMarketProbability:true}}));

app.get("/api/debug/history",async(req,res)=>{
  try{
    const codes=String(req.query.codes||"POL,SWE,SUI,RPL").split(",").map(x=>x.trim().toUpperCase()).filter(Boolean);
    const out={};
    for(const code of codes){
      const h=await leagueHistory(code);
      out[code]={
        count:h.length,
        seasons:[...new Set(h.map(x=>x.season))],
        first:h[0]?{date:localYmdFromDate(h[0].date),home:h[0].home,away:h[0].away,score:`${h[0].homeGoals}-${h[0].awayGoals}`} : null,
        last:h.at(-1)?{date:localYmdFromDate(h.at(-1).date),home:h.at(-1).home,away:h.at(-1).away,score:`${h.at(-1).homeGoals}-${h.at(-1).awayGoals}`} : null,
        teams:[...new Set(h.flatMap(x=>[x.home,x.away]))].slice(0,40)
      };
    }
    res.json({ok:true,out});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.get("/api/debug/fixtures",async(req,res)=>{
  try{
    const date=String(req.query.date||istanbulTodayYmd());
    await ensureDynamicLeagueIds(Number(date.slice(0,4)));
    const rows=await apiFootball(`/fixtures?date=${encodeURIComponent(date)}&timezone=${encodeURIComponent(APP_TIME_ZONE)}`,60000);
    const focusCountries=new Set(["sweden","switzerland","russia","poland","austria","romania"]);
    const raw=(rows||[]).filter(x=>focusCountries.has(apiNameNorm(x?.league?.country))).map(x=>({
      fixtureId:x?.fixture?.id,leagueId:x?.league?.id,league:x?.league?.name,country:x?.league?.country,
      home:x?.teams?.home?.name,away:x?.teams?.away?.name,status:x?.fixture?.status?.short,
      inferredCode:inferLeagueCodeFromApiFixture(x)
    }));
    res.json({ok:true,date,count:raw.length,rows:raw});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.get("/api/debug/leagues",async(req,res)=>{
  try{
    const season=Number(req.query.season||2026);
    const resolved=await ensureDynamicLeagueIds(season);
    const focus=["SWE","SWE2","SWEC","SUI","SUIC","RPL","RUSC","POL","POLC","AUT","AUT2","ROU","ROUC"];
    res.json({ok:true,season,resolved,leagues:Object.fromEntries(focus.map(c=>[c,{name:LEAGUES[c]?.name,country:LEAGUES[c]?.country,apiId:LEAGUES[c]?.apiId||null}]))});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.get("/api/data-audit",(req,res)=>{
  const leagues=Object.entries(LEAGUES).map(([code,l])=>{
    const c=historyCapability(code);
    return {code,name:l.name,country:l.country,historySource:hasPrimaryHistorySource(code),capability:c};
  });
  res.json({ok:true,unsupportedHistory:leagues.filter(x=>!x.historySource&&!x.capability.supportLeagues.length),leagues});
});

app.get("/api/data-health",async(req,res)=>{
  try{
    const date=String(req.query.date||localYmdFromDate(new Date()));
    const result=await fixturesForThreeDays(date);
    const rows={};
    for(const [code,l] of Object.entries(LEAGUES)){
      const fs=result.fixtures.filter(f=>f.leagueCode===code);
      const pub=getCache(`prepared-history:${code}:${date}:public`)||[];
      const full=getCache(`prepared-history:${code}:${date}:full`)||[];
      rows[code]={
        name:l.name,country:l.country,fixtures:fs.length,
        fixtureProviders:[...new Set(fs.flatMap(f=>f.providers||[f.fixtureSource]).filter(Boolean))],
        historyRows:Math.max(pub.length,full.length),
        historyReady:Math.max(pub.length,full.length)>0,
        directSource:LEAGUES[code]?.csv||NEW_LEAGUE_CSV[code]||null,
        capability:historyCapability(code)
      };
    }
    res.json({ok:true,date,leagues:rows});
  }catch(e){res.status(500).json({ok:false,error:e.message})}
});

app.get("/api/three-days",async(req,res)=>{
  try{
    const date=String(req.query.date||"");
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return res.status(400).json({ok:false,error:"Geçerli merkez tarih gerekli."});
    const result=await fixturesForThreeDays(date);
    const days={
      [result.dates.yesterday]:result.fixtures.filter(f=>f.localDate===result.dates.yesterday),
      [result.dates.today]:result.fixtures.filter(f=>f.localDate===result.dates.today),
      [result.dates.tomorrow]:result.fixtures.filter(f=>f.localDate===result.dates.tomorrow)
    };
    res.json({ok:true,center:date,dates:result.dates,count:result.fixtures.length,days,fixtures:result.fixtures});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.get("/api/day",async(req,res)=>{
  try{
    const date=String(req.query.date||"");
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return res.status(400).json({ok:false,error:"Geçerli tarih gerekli."});
    const fixtures=await fixturesForDate(date);
    res.json({ok:true,date,count:fixtures.length,fixtures});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});



app.get("/api/halftime/:id",async(req,res)=>{
  try{
    const id=String(req.params.id||"");
    const cached=getCache(`fixture:${id}`);
    if(!cached)return res.status(404).json({ok:false,error:"Fixture not found"});
    const f={...cached,score:{...(cached.score||{})}};
    if(f.score.htHome!=null&&f.score.htAway!=null)return res.json({ok:true,score:f.score});
    let d=await fetchHistoryHalftime(f);
    if(!d||d.htHome==null||d.htAway==null)d=await fetchFixtureHalftime(f);
    if(d){
      if(d.home!=null)f.score.home=d.home;
      if(d.away!=null)f.score.away=d.away;
      if(d.htHome!=null)f.score.htHome=d.htHome;
      if(d.htAway!=null)f.score.htAway=d.htAway;
      if(d.status)f.status=d.status;
    }
    if(f.score.htHome==null||f.score.htAway==null){
      const e=await fetchEspnHalftime(f);
      if(e){
        if(e.htHome!=null)f.score.htHome=e.htHome;
        if(e.htAway!=null)f.score.htAway=e.htAway;
      }
    }
    setCache(`fixture:${id}`,f,3600000);
    res.json({ok:true,score:f.score,status:f.status});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});


function kickoffAgeMinutes(f){
  const ts=Number(f?.timestamp||0);if(!ts)return null;
  return (Date.now()/1000-ts)/60;
}
function scoredOfficialFixture(base,home,away,status="LIVE",elapsed=null){
  return {...base,status,elapsed,score:{
    home:home!=null?Number(home):base?.score?.home??null,
    away:away!=null?Number(away):base?.score?.away??null,
    htHome:base?.score?.htHome??null,htAway:base?.score?.htAway??null
  }};
}
async function tffLiveScoresForDate(date){
  const out=[];
  for(const p of [
    {code:"TSL",url:"https://www.tff.org/default.aspx?pageID=198"},
    {code:"T1L",url:"https://www.tff.org/default.aspx?pageID=142"}
  ]){
    try{
      const raw=await fetchTextSmart(p.url,{"User-Agent":"Mozilla/5.0 MatchEdge/7.19.0","Accept-Language":"tr-TR,tr;q=0.9"});
      for(const row of tffFixtureRowsFromHtml(raw,date)){
        const sm=String(row.score||"").match(/^(\d+)\s*-\s*(\d+)$/);if(!sm)continue;
        const f=officialFixture(p.code,date,row.time,row.home,row.away,"tff-live");
        if(!f)continue;
        const age=kickoffAgeMinutes(f);
        const status=age!=null&&age>150?"FT":"LIVE";
        out.push(scoredOfficialFixture(f,sm[1],sm[2],status,status==="LIVE"?Math.max(1,Math.min(120,Math.floor(age||1))):null));
      }
    }catch(e){console.warn("TFF live refresh:",e.message)}
  }
  return out;
}
async function romanianLiveScoresForDate(date){
  const out=[];
  try{
    const raw=await fetchTextSmart("https://www.gsp.ro/rezultate-live/",{
      "User-Agent":"Mozilla/5.0 MatchEdge/7.19.0","Accept-Language":"ro-RO,ro;q=0.9"
    });
    const text=decodeHtmlText(raw).replace(/\s+/g," ");
    // GSP live/result text often contains: 16:00 Progresul Spartac 2 Chiajna 5
    const map=[
      ["Progresul Spartac","Concordia Chiajna"],["Corona Brasov","FC Bihor Oradea"],
      ["Corona Brașov","FC Bihor Oradea"],["Sepsi OSK","CFR Cluj"],
      ["Chindia","FC Voluntari"],["Chindia Târgoviște","FC Voluntari"],
      ["U Cluj","FC Petrolul"],["Universitatea Cluj","ACS Petrolul 52"]
    ];
    for(const [h,a] of map){
      const hn=h.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),an=a.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
      const re=new RegExp(`(?:\\d{1,2}:\\d{2}\\s+)?${hn}\\s+(\\d+)\\s+${an}\\s+(\\d+)`,"i");
      const m=text.match(re);if(!m)continue;
      const tm=(text.slice(Math.max(0,m.index-12),m.index).match(/(\d{1,2}:\d{2})\s*$/)||[])[1]||"12:00";
      const f=officialFixture("ROUC",date,tm,h,a,"gsp-live");
      if(!f)continue;
      const age=kickoffAgeMinutes(f),status=age!=null&&age>150?"FT":"LIVE";
      out.push(scoredOfficialFixture(f,m[1],m[2],status,status==="LIVE"?Math.max(1,Math.min(120,Math.floor(age||1))):null));
    }
  }catch(e){console.warn("Romania live refresh:",e.message)}
  return out;
}
async function publicLiveRefreshForDate(date){
  const rows=[];
  try{rows.push(...await tffLiveScoresForDate(date));}catch{}
  try{rows.push(...await romanianLiveScoresForDate(date));}catch{}
  return rows;
}
function dedupeLiveRows(rows){
  const map=new Map();
  for(const f of rows||[]){
    const k=fixtureMergeKey(f);
    const old=map.get(k);
    if(!old){map.set(k,f);continue}
    const score=(f.score?.home!=null&&f.score?.away!=null)?f.score:old.score;
    map.set(k,{...old,...f,score:{
      home:score?.home??old.score?.home??null,away:score?.away??old.score?.away??null,
      htHome:f.score?.htHome??old.score?.htHome??null,htAway:f.score?.htAway??old.score?.htAway??null
    }});
  }
  return [...map.values()];
}

app.get("/api/live",async(req,res)=>{
  const date=String(req.query.date||istanbulTodayYmd());
  const rows=[];let apiOk=false;
  try{
    if(API_KEY){
      try{
        const live=await apiFootball(`/fixtures?live=all&timezone=${encodeURIComponent(APP_TIME_ZONE)}`,20000);
        rows.push(...(live||[]).map(mapFixture).filter(Boolean));apiOk=true;
      }catch(e){console.warn("API-Football live:",e.message)}
      // Important: completed matches disappear from live=all. Refresh today's full date too,
      // so scoreboard receives FT scores immediately after the whistle.
      try{
        const day=await apiFootball(`/fixtures?date=${encodeURIComponent(date)}&timezone=${encodeURIComponent(APP_TIME_ZONE)}`,20000);
        rows.push(...(day||[]).map(mapFixture).filter(Boolean));apiOk=true;
      }catch(e){console.warn("API-Football day refresh:",e.message)}
    }
    // ESPN is useful for live/FT refresh even when the original fixture came from a federation fallback.
    try{rows.push(...await espnFixturesForDate(date));}catch(e){console.warn("ESPN live refresh:",e.message)}
    // Federation/public score refresh for competitions not carried live by the main APIs.
    try{rows.push(...await publicLiveRefreshForDate(date));}catch(e){console.warn("Public live refresh:",e.message)}
    const fixtures=dedupeLiveRows(rows).filter(f=>f.localDate===date);
    res.json({ok:true,fixtures,liveAvailable:apiOk||fixtures.length>0,updatedAt:new Date().toISOString()});
  }catch(e){
    res.status(502).json({ok:false,error:e.message,fixtures:[]});
  }
});

app.get("/api/analyze/:id",async(req,res)=>{
  try{
    const date=String(req.query.date||""),id=+req.params.id;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return res.status(400).json({ok:false,error:"Geçerli tarih gerekli."});
    let f=getCache(`fixture:${id}`);
    if(["ROU","ROUC"].includes(f?.leagueCode)){
      f=normalizeRomanianFixture(f);
      if(!validRomanianFixture(f))return res.status(422).json({error:"INVALID FIXTURE DATA"});
    }
    if(!f){const result=await fixturesForThreeDays(date);f=result.fixtures.find(x=>x.id===id);}
    if(!f)return res.status(404).json({ok:false,error:"Maç bulunamadı."});
    const started=Date.now();
    const model=await analyzeFixtureModel(f,date);
    res.json({ok:true,fixture:f,data:{provider:"normalized cached data engine",seasons:["2026/27","2025/26"],h2hRequired:false,analysisMs:Date.now()-started},model});
  }catch(e){
    const status=e.message==="DATA PREPARING"?202:500;
    res.status(status).json({ok:false,error:e.message});
  }
});


function scoreKnownServer(f){return f?.score?.home!=null&&f?.score?.away!=null}
function statusFinishedServer(s){return["FT","AET","PEN","CANC","ABD","AWD","WO"].includes(String(s||"").toUpperCase())}


/* ---------------- Austria + Poland direct league-history fallbacks ---------------- */
async function austriaBundesligaHistory(date){
  const k=`aut-history-direct:${date}`,c=getCache(k);if(c)return c;
  try{
    const raw=await fetchTextSmart("https://www.bundesliga.at/de/spielplan",{
      "User-Agent":"Mozilla/5.0 MatchEdge/7.19.0","Accept-Language":"de-AT,de;q=0.9"
    });
    const text=decodeHtmlText(raw).replace(/\s+/g," ");
    const out=[];
    // Official Bundesliga schedule exposes DD.MM.YYYY + kickoff + home/away + FT (HT).
    const re=/(\d{2}\.\d{2}\.\d{4})\s+(\d{1,2}:\d{2})\s+(.{2,55}?)\s+(.{2,55}?)\s+(\d+)\s*:\s*(\d+)(?:\s*\((\d+)\s*:\s*(\d+)\))?/g;
    let m;
    while((m=re.exec(text))){
      const ymd=trDateToYmd(m[1]);if(!ymd||ymd>=date)continue;
      out.push({
        season:"2026/27",date:new Date(`${ymd}T12:00:00+02:00`),
        home:m[3].trim(),away:m[4].trim(),homeGoals:Number(m[5]),awayGoals:Number(m[6]),
        htHome:m[7]!=null?Number(m[7]):null,htAway:m[8]!=null?Number(m[8]):null,
        homeShots:null,awayShots:null,homeSOT:null,awaySOT:null,homeCorners:null,awayCorners:null,
        homeYellow:null,awayYellow:null,homeRed:null,awayRed:null,source:"bundesliga-at"
      });
    }
    // Fallback to FBref's stable season table when official markup hides team cells.
    if(out.length<6){
      try{
        const fb=await fetchTextSmart("https://fbref.com/en/comps/56/2026-2027/schedule/2026-2027-Austrian-Bundesliga-Scores-and-Fixtures",{
          "User-Agent":"Mozilla/5.0 MatchEdge/7.19.0"
        });
        const rows=htmlTableRows(fb);
        for(const cells of rows){
          const di=cells.findIndex(x=>/^\d{4}-\d{2}-\d{2}$/.test(x));
          const si=cells.findIndex(x=>/^\d+\s*[–-]\s*\d+$/.test(x));
          if(di<0||si<0||cells[di]>=date)continue;
          const sm=cells[si].match(/^(\d+)\s*[–-]\s*(\d+)$/);
          // FBref columns: Wk, Day, Date, Time, Home, Score, Away...
          const home=cells[di+2],away=cells[si+1];
          if(!home||!away||!sm)continue;
          out.push({
            season:"2026/27",date:new Date(`${cells[di]}T12:00:00+02:00`),
            home,away,homeGoals:Number(sm[1]),awayGoals:Number(sm[2]),
            htHome:null,htAway:null,homeShots:null,awayShots:null,homeSOT:null,awaySOT:null,
            homeCorners:null,awayCorners:null,homeYellow:null,awayYellow:null,homeRed:null,awayRed:null,source:"fbref-aut"
          });
        }
      }catch(e){console.warn("Austria FBref fallback:",e.message)}
    }
    const ded=[...new Map(out.map(x=>[`${localYmdFromDate(x.date)}|${norm(x.home)}|${norm(x.away)}`,x])).values()].sort((a,b)=>a.date-b.date);
    setCache(k,ded,300000);return ded;
  }catch(e){console.warn("Austria history:",e.message);return[]}
}

async function polandEkstraklasaHistory(date){
  const k=`pol-history-direct:${date}`,c=getCache(k);if(c)return c;
  const out=[];
  const urls=[
    "https://www.legalsport.pl/rozgrywki/pilka-nozna/ekstraklasa/wyniki/",
    "https://ekstraklasa.org/en/"
  ];
  for(const url of urls){
    try{
      const raw=await fetchTextSmart(url,{"User-Agent":"Mozilla/5.0 MatchEdge/7.19.0","Accept-Language":"pl-PL,pl;q=0.9,en;q=0.7"});
      const text=decodeHtmlText(raw).replace(/\s+/g," ");
      // LegalSport shape: 28.08.2026 koniec Wisła Płock Korona Kielce 0 2
      const re=/(\d{2}\.\d{2}\.\d{4})\s+(?:koniec|zakończony|FT)\s+(.{2,55}?)\s+(.{2,55}?)\s+(\d+)\s+(\d+)(?=\s+\d{2}\.\d{2}\.\d{4}|\s+\d+\.\s*kolejka|$)/gi;
      let m;
      while((m=re.exec(text))){
        const ymd=trDateToYmd(m[1]);if(!ymd||ymd>=date)continue;
        out.push({
          season:"2026/27",date:new Date(`${ymd}T12:00:00+02:00`),
          home:m[2].trim(),away:m[3].trim(),homeGoals:Number(m[4]),awayGoals:Number(m[5]),
          htHome:null,htAway:null,homeShots:null,awayShots:null,homeSOT:null,awaySOT:null,homeCorners:null,awayCorners:null,
          homeYellow:null,awayYellow:null,homeRed:null,awayRed:null,source:"ekstraklasa-direct"
        });
      }
      // Official Ekstraklasa card/table HTML: date, home, score, away.
      for(const cells of htmlTableRows(raw)){
        const di=cells.findIndex(x=>/^\d{2}\.\d{2}\.\d{4}$/.test(x)||/^\d{4}-\d{2}-\d{2}$/.test(x));
        const si=cells.findIndex(x=>/^\d+\s*:\s*\d+$/.test(x));
        if(di<0||si<0)continue;
        const ymd=cells[di].includes(".")?trDateToYmd(cells[di]):cells[di];
        if(!ymd||ymd>=date)continue;
        const sm=cells[si].match(/^(\d+)\s*:\s*(\d+)$/);
        const home=cells[si-1],away=cells[si+1];
        if(home&&away&&sm)out.push({
          season:"2026/27",date:new Date(`${ymd}T12:00:00+02:00`),home,away,
          homeGoals:Number(sm[1]),awayGoals:Number(sm[2]),htHome:null,htAway:null,
          homeShots:null,awayShots:null,homeSOT:null,awaySOT:null,homeCorners:null,awayCorners:null,
          homeYellow:null,awayYellow:null,homeRed:null,awayRed:null,source:"ekstraklasa-official"
        });
      }
      if(out.length>=8)break;
    }catch(e){console.warn("Poland history source:",e.message)}
  }
  const ded=[...new Map(out.map(x=>[`${localYmdFromDate(x.date)}|${norm(x.home)}|${norm(x.away)}`,x])).values()].sort((a,b)=>a.date-b.date);
  setCache(k,ded,300000);return ded;
}


function normalizedSeasonLabelFromDate(d){
  const x=d instanceof Date?d:new Date(d);
  if(Number.isNaN(x.getTime()))return "2026/27";
  const y=x.getUTCFullYear(),m=x.getUTCMonth()+1;
  const start=m>=7?y:y-1;
  return `${start}/${String(start+1).slice(-2)}`;
}
function normalizeRomanianHistoryRows(rows=[],code=""){
  if(!["ROU","ROUC"].includes(code))return rows;
  return (rows||[]).map(m=>({
    ...m,
    home:sanitizeRomanianTeamName(m.home),
    away:sanitizeRomanianTeamName(m.away),
    league:m.league?repairRomanianText(decodeHtmlEntities(m.league)):m.league,
    round:m.round?repairRomanianText(decodeHtmlEntities(m.round)):m.round
  })).filter(m=>validRomanianTeamName(m.home)&&validRomanianTeamName(m.away));
}

function normalizeHistorySeasonRows(rows=[]){
  return rows.map(m=>({...m,season:/^\d{4}\/\d{2}$/.test(String(m.season||""))?m.season:normalizedSeasonLabelFromDate(m.date)}));
}
function mergeHistoryRows(...groups){
  const out=new Map();
  for(const raw of groups.flat()){
    if(!raw||!raw.home||!raw.away||raw.homeGoals==null||raw.awayGoals==null)continue;
    const m={...raw,season:/^\d{4}\/\d{2}$/.test(String(raw.season||""))?raw.season:normalizedSeasonLabelFromDate(raw.date)};
    const d=localYmdFromDate(m.date);
    const key=`${d}|${norm(m.home)}|${norm(m.away)}`;
    if(!out.has(key)){out.set(key,m);continue}
    const old=out.get(key);
    // Keep the richest row: never overwrite available HT/shots/corners with nulls.
    const score=x=>["htHome","htAway","homeShots","awayShots","homeSOT","awaySOT","homeCorners","awayCorners"].reduce((n,k)=>n+(x[k]!=null?1:0),0);
    if(score(m)>score(old))out.set(key,{...old,...m});
  }
  return [...out.values()].sort((a,b)=>new Date(a.date)-new Date(b.date));
}
function teamCoverage(rows,f){
  const h=findTeam(f.home?.name||"",rows),a=findTeam(f.away?.name||"",rows);
  return {
    home:h?rows.filter(m=>m.home===h||m.away===h).length:0,
    away:a?rows.filter(m=>m.home===a||m.away===a).length:0
  };
}
const analysisHistoryPromises=new Map();

async function italyLeagueHistoryRecovery(f,date,base=[]){
  let merged=mergeHistoryRows(base);
  if(!["SA","SB","CIT"].includes(f?.leagueCode))return merged;

  const jobs=[espnLeagueRangeHistory(f,date)];
  if(["SA","SB"].includes(f.leagueCode))jobs.push(leagueHistory(f.leagueCode));
  if(f.leagueCode==="CIT")jobs.push(leagueHistory("SA"),leagueHistory("SB"));

  const settled=await Promise.allSettled(jobs);
  for(const r of settled)if(r.status==="fulfilled"&&r.value?.length)merged=mergeHistoryRows(merged,r.value);

  const cov=teamCoverage(merged,f);
  if(API_KEY&&LEAGUES[f.leagueCode]?.apiId&&(!merged.length||cov.home<3||cov.away<3)){
    try{
      const apiRows=await apiLeagueResearchHistory(f,date);
      if(apiRows.length)merged=mergeHistoryRows(merged,apiRows);
    }catch{}
  }
  return merged;
}

async function romaniaLeagueHistoryRecovery(f,date,base=[]){
  let merged=normalizeRomanianHistoryRows(mergeHistoryRows(base),"ROU");
  if(!["ROU","ROUC"].includes(f?.leagueCode))return merged;

  const jobs=[
    leagueHistory("ROU"),
    espnLeagueRangeHistory({...f,leagueCode:"ROU"},date)
  ];
  const settled=await Promise.allSettled(jobs);
  for(const r of settled){
    if(r.status==="fulfilled"&&r.value?.length){
      merged=mergeHistoryRows(merged,normalizeRomanianHistoryRows(r.value,"ROU"));
    }
  }

  const probe={
    ...f,
    leagueCode:"ROU",
    home:{...f.home,name:romanianDisplayName(f.home?.name)},
    away:{...f.away,name:romanianDisplayName(f.away?.name)}
  };
  const cov=teamCoverage(merged,probe);

  if(API_KEY&&LEAGUES.ROU?.apiId&&(!merged.length||cov.home<3||cov.away<3)){
    try{
      const apiRows=await apiLeagueResearchHistory(probe,date);
      if(apiRows?.length){
        merged=mergeHistoryRows(merged,normalizeRomanianHistoryRows(apiRows,"ROU"));
      }
    }catch{}
  }
  return normalizeRomanianHistoryRows(merged,"ROU");
}

async function reliableLeagueHistory(f,date,base=[],allowApiFallback=true){
  const code=f?.leagueCode;
  let merged=mergeHistoryRows(base);
  merged=normalizeRomanianHistoryRows(merged,code);

  if(["DEN","DEN2","RPL","RUSC"].includes(code)){
    merged=await denmarkRussiaHistoryRecovery(f,date,merged);
  }
  if(["ROU","ROUC"].includes(code)){
    merged=await romaniaLeagueHistoryRecovery(f,date,merged);
  }
  if(["SA","SB","CIT"].includes(code)){
    merged=await italyLeagueHistoryRecovery(f,date,merged);
  }

  const publicJobs=[];
  if(f?.espnSlug||ESPN_SLUGS[code])publicJobs.push(espnLeagueRangeHistory(f,date));
  if(["TSL","T1L"].includes(code))publicJobs.push(tffLeagueHistory(code,date));

  if(publicJobs.length){
    const settled=await Promise.allSettled(publicJobs);
    for(const r of settled){
      if(r.status==="fulfilled"&&r.value?.length)merged=mergeHistoryRows(merged,r.value);
    }
  }

  // API is recovery only, and works for every API-covered league.
  if(allowApiFallback&&API_KEY&&LEAGUES[code]?.apiId){
    const cov=teamCoverage(merged,f);
    if(!merged.length||cov.home<5||cov.away<5){
      const apiRows=await apiLeagueResearchHistory(f,date);
      if(apiRows.length)merged=mergeHistoryRows(merged,apiRows);
    }
  }
  return merged;
}

async function domesticCupSupportHistory(f,date,base=[]){
  const support=CUP_SUPPORT_LEAGUES[f?.leagueCode]||[];
  if(!support.length)return mergeHistoryRows(base);
  let merged=mergeHistoryRows(base);
  const jobs=support.map(code=>leagueHistory(code));
  const settled=await Promise.allSettled(jobs);
  for(let i=0;i<settled.length;i++){
    const r=settled[i];
    if(r.status==="fulfilled"&&r.value?.length){
      merged=mergeHistoryRows(merged,normalizeHistorySeasonRows(r.value));
    }
  }
  // Public ESPN league histories can fill teams that Football-Data does not resolve.
  for(const code of support){
    const probe={...f,leagueCode:code};
    try{
      const rows=await espnLeagueRangeHistory(probe,date);
      if(rows?.length)merged=mergeHistoryRows(merged,rows);
    }catch{}
  }
  return merged;
}

async function preparedLeagueHistory(f,date,{allowApiFallback=true}={}){
  const code=f?.leagueCode||"UNK";
  const ck=`prepared-history:${code}:${date}:${allowApiFallback?"full":"public"}`;
  const cached=getCache(ck); if(cached)return cached;
  if(analysisHistoryPromises.has(ck))return analysisHistoryPromises.get(ck);

  const job=(async()=>{
    let allLeague=normalizeHistorySeasonRows(await leagueHistory(code));
    allLeague=normalizeRomanianHistoryRows(allLeague,code);
    allLeague=await reliableLeagueHistory(f,date,allLeague,allowApiFallback);
    if(CUP_SUPPORT_LEAGUES[code]?.length){
      allLeague=await domesticCupSupportHistory(f,date,allLeague);
    }
    if(["SA","SB","CIT"].includes(code)&&!allLeague.length){
      allLeague=await italyLeagueHistoryRecovery(f,date,allLeague);
    }

    if(code==="AUT"){
      const autH=await austriaBundesligaHistory(date);
      if(autH.length)allLeague=mergeHistoryRows(allLeague,autH);
    }
    if(code==="POL"){
      const polH=await polandEkstraklasaHistory(date);
      if(polH.length)allLeague=mergeHistoryRows(allLeague,polH);
    }
    if(code==="POLC"&&!allLeague.length){
      const polH=await polandEkstraklasaHistory(date);
      if(polH.length)allLeague=mergeHistoryRows(allLeague,polH);
    }
    if(code==="AUT2"&&!allLeague.length){
      const autH=await austriaBundesligaHistory(date);
      if(autH.length)allLeague=mergeHistoryRows(allLeague,autH);
    }

    // Cup matches use domestic league form as support data, never a league from another country.
    if(!allLeague.length&&CUP_SUPPORT_LEAGUES[code]?.length){
      const support=await Promise.all(CUP_SUPPORT_LEAGUES[code].map(c=>leagueHistory(c)));
      allLeague=mergeHistoryRows(...support);
    }

    setCache(ck,allLeague,allLeague.length?900000:30000);
    return allLeague;
  })().finally(()=>analysisHistoryPromises.delete(ck));

  analysisHistoryPromises.set(ck,job);
  return job;
}

const historyBackfillQueue=[];
let historyBackfillRunning=false;

function queueHistoryBackfill(f,date){
  if(!API_KEY||!f?.leagueCode||!LEAGUES[f.leagueCode]?.apiId)return;
  const key=`${f.leagueCode}:${date}`;
  if(historyBackfillQueue.some(x=>x.key===key))return;
  historyBackfillQueue.push({key,f,date});
  runHistoryBackfillQueue();
}
async function runHistoryBackfillQueue(){
  if(historyBackfillRunning)return;
  historyBackfillRunning=true;
  try{
    while(historyBackfillQueue.length){
      const x=historyBackfillQueue.shift();
      try{
        const rows=await preparedLeagueHistory(x.f,x.date,{allowApiFallback:true});
        if(rows?.length)setCache(`prepared-history:${x.f.leagueCode}:${x.date}:full`,rows,1800000);
      }catch(e){console.warn("History API backfill",x.f?.leagueCode,e.message)}
    }
  }finally{historyBackfillRunning=false}
}

async function prewarmAnalysisData(fixtures){
  const reps=new Map();
  for(const f of fixtures||[]){
    if(!f?.localDate||!f?.leagueCode)continue;
    const key=`${f.leagueCode}:${f.localDate}`;
    if(!reps.has(key))reps.set(key,f);
  }

  const queue=[...reps.values()];
  const workers=Array.from({length:Math.min(5,queue.length)},async()=>{
    while(queue.length){
      const f=queue.shift(),date=f.localDate;
      try{
        const rows=await preparedLeagueHistory(f,date,{allowApiFallback:false});
        const cov=teamCoverage(rows||[],f);
        if(!rows?.length||cov.home<5||cov.away<5)queueHistoryBackfill(f,date);
      }catch(e){
        console.warn("Analysis prewarm",f?.leagueCode,e.message);
        queueHistoryBackfill(f,date);
      }
    }
  });
  await Promise.all(workers);
}

const backgroundModelJobs=new Map();

function scheduleBackgroundModelEnrichment(f,date){
  queueHistoryBackfill(f,date);
}


function liveElapsedMinute(f){
  const raw=String(f?.elapsed??"").match(/\d+/);
  if(raw)return clamp(Number(raw[0]),1,120);
  const st=String(f?.status||"").toUpperCase();
  if(st==="HT")return 45;
  if(st==="2H")return 60;
  if(["ET","BT"].includes(st))return 100;
  return 0;
}
function applyLiveStateToModel(model,f){
  if(!model||!isLiveFixtureStatus(f?.status))return model;
  const homeNow=Number(f?.score?.home),awayNow=Number(f?.score?.away);
  if(!Number.isFinite(homeNow)||!Number.isFinite(awayNow))return model;

  const minute=liveElapsedMinute(f);
  const regulationMinute=Math.min(minute,90);
  const remaining=Math.max(0,90-regulationMinute);
  const baseH=Number(model.expectedGoals?.home)||1.2,baseA=Number(model.expectedGoals?.away)||1.0;

  // Remaining-goal expectation: pre-match scoring rate scaled by remaining time.
  // Slight late-game uplift for a one-goal-or-draw game, where tactical urgency normally rises.
  let urgency=1;
  if(regulationMinute>=55&&Math.abs(homeNow-awayNow)<=1)urgency=1.08;
  if(regulationMinute>=75&&Math.abs(homeNow-awayNow)<=1)urgency=1.12;
  const remH=clamp(baseH*(remaining/90)*urgency,0,3);
  const remA=clamp(baseA*(remaining/90)*urgency,0,3);
  const rm=scoreMatrix(remH,remA,7);

  const p=(fn)=>probability(rm,x=>fn(homeNow+x.h,awayNow+x.a,x));
  const pHome=p((h,a)=>h>a),pDraw=p((h,a)=>h===a),pAway=p((h,a)=>h<a);
  const pO25=p((h,a)=>h+a>=3),pO15=p((h,a)=>h+a>=2),pU25=1-pO25,pU35=p((h,a)=>h+a<=3);
  const pBTTS=(homeNow>0&&awayNow>0)?1:p((h,a)=>h>0&&a>0);
  const pHome15=homeNow>=2?1:p((h)=>h>=2);
  const pAway15=awayNow>=2?1:p((h,a)=>a>=2);
  const pNextGoal=1-Math.exp(-(remH+remA));

  const overrides={
    "1":pHome,"X":pDraw,"2":pAway,
    "1X":pHome+pDraw,"X2":pAway+pDraw,"12":pHome+pAway,
    "1.5 Üst":pO15,"2.5 Üst":pO25,"2.5 Alt":pU25,"3.5 Alt":pU35,
    "KG Var":pBTTS,"KG Yok":1-pBTTS,
    "Ev 1.5 Üst":pHome15,"Dep 1.5 Üst":pAway15
  };

  // First-half markets are settled/near-settled after HT and must not be recommended as future bets.
  const firstHalfDone=regulationMinute>=45||["HT","2H","ET","BT"].includes(String(f.status||"").toUpperCase());
  let liveMarkets=(model.markets||[]).map(x=>{
    if(firstHalfDone&&x.group==="İlk Yarı")return {...x,settled:true,liveHidden:true};
    if(Object.prototype.hasOwnProperty.call(overrides,x.name)){
      const pr=pct(clamp(overrides[x.name],0,1));
      return {...x,probability:pr,modelProbability:pr,analysisProbability:pr,
        fairOdd:pr>0?Number((100/pr).toFixed(2)):null,
        marketProbability:null,marketAgreement:null,liveAdjusted:true};
    }
    if(x.name==="2Y 0.5 Üst"&&regulationMinute>=45){
      const pr=pct(pNextGoal);return {...x,probability:pr,modelProbability:pr,analysisProbability:pr,liveAdjusted:true};
    }
    return {...x,liveContextUnchanged:true};
  }).filter(x=>!x.liveHidden);

  // Pre-match odds are not valid value prices once the match is live.
  liveMarkets=liveMarkets.map(x=>({...x,marketOdd:null,expectedValue:null,edge:null,openingOdd:null,oddsMovePct:null,impliedMovePts:null}));
  const ranked=marketAwareRecommendations(liveMarkets);
  let rec=selectVisibleRecommendations(ranked);
  const strongest=chooseStrongestSignal(liveMarkets,null);
  if(strongest)rec=[strongest,...rec.filter(x=>x.name!==strongest.name)].slice(0,7);

  const exact=rm.slice().sort((a,b)=>b.p-a.p);
  const top=exact[0];
  const finalScoreTop=top?`${homeNow+top.h}-${awayNow+top.a}`:`${homeNow}-${awayNow}`;
  const alternatives=exact.slice(1,4).map(x=>({score:`${homeNow+x.h}-${awayNow+x.a}`,probability:pct(x.p)}));

  model.markets=liveMarkets;
  model.valueMarkets=liveMarkets;
  model.recommendations=rec;
  model.betRecommendation={decision:"MODEL LEAN",reason:"live-odds-not-used"};
  model.marketAware=false;
  model.oddsInfo=null;
  model.noBet=!(strongest&&Number(strongest.analysisProbability??strongest.probability)>=BET_PROB_MIN);
  model.live={
    active:true,minute,currentScore:`${homeNow}-${awayNow}`,remainingMinutes:remaining,
    remainingExpectedGoals:+(remH+remA).toFixed(2),remainingHomeXG:+remH.toFixed(2),remainingAwayXG:+remA.toFixed(2)
  };
  model.expectedGoals={
    home:+(homeNow+remH).toFixed(2),away:+(awayNow+remA).toFixed(2),
    total:+(homeNow+awayNow+remH+remA).toFixed(2),
    remaining:+(remH+remA).toFixed(2)
  };
  model.likelyScore=finalScoreTop;
  model.likelyScoreProbability=top?pct(top.p):null;
  model.scoreAlternatives=alternatives;
  model.reasons=[
    `CANLI MODEL: ${minute}. dakika, mevcut skor ${homeNow}-${awayNow}.`,
    `Kalan ${remaining} dakika için beklenen ek gol ${Number(remH+remA).toFixed(2)}.`,
    ...(homeNow>0&&awayNow>0?[`KG Var marketi mevcut ${homeNow}-${awayNow} skoruyla gerçekleşmiş durumda (%100).`]:[]),
    ...(model.reasons||[])
  ];
  return model;
}
function isLiveFixtureStatus(status){
  return ["1H","HT","2H","ET","BT","P","INT","LIVE"].includes(String(status||"").toUpperCase());
}

async function analyzeFixtureModel(f,date){
  if(["ROU","ROUC"].includes(f?.leagueCode))f=normalizeRomanianFixture(f);
  const modelKey=`analysis-model:${f.id}:${date}`;
  const cachedModel=getCache(modelKey); if(cachedModel)return cachedModel;

  const limit=new Date(date+"T00:00:00");
  // Never wait for API-Football league/team calls on an Analyze click.
  // Use already available public/cached league history only.
  let allLeague=await preparedLeagueHistory(f,date,{allowApiFallback:false});
  const fullCached=getCache(`prepared-history:${f.leagueCode}:${date}:full`);
  if(fullCached?.length)allLeague=mergeHistoryRows(allLeague,fullCached);
  let leagueH=allLeague.filter(x=>x.date<limit);
  let resolved=await resolveTeams(f,leagueH,{allowSiblingLookup:false});
  let home=resolved.home,away=resolved.away,h=resolved.history.filter(x=>x.date<limit);

  // ESPN acts as a normalization bridge for provider-name mismatches.
  if(!home||!away||!h.length){
    const espnRange=await espnLeagueRangeHistory(f,date);
    if(espnRange.length){
      leagueH=mergeHistoryRows(leagueH,espnRange).filter(x=>x.date<limit);
      home=findTeam(f.home.name,leagueH);
      away=findTeam(f.away.name,leagueH);
      h=leagueH;
    }
  }

  // If team aliases still fail, use fixture names against the available league
  // sample. buildModel will naturally lower confidence for tiny/weak samples.
  home=home||f.home.name;
  away=away||f.away.name;

  const homeMatches=leagueH.filter(x=>x.home===home||x.away===home).length;
  const awayMatches=leagueH.filter(x=>x.home===away||x.away===away).length;

  if(!leagueH.length){
    const retry=normalizeHistorySeasonRows(await leagueHistory(f.leagueCode));
    if(retry.length){
      allLeague=mergeHistoryRows(allLeague,retry);
      leagueH=allLeague.filter(x=>x.date<limit);
    }
  }
  if(!leagueH.length&&["ROU","ROUC"].includes(f.leagueCode)){
    const ro=await romaniaLeagueHistoryRecovery(f,date,allLeague);
    if(ro.length){
      allLeague=mergeHistoryRows(allLeague,ro);
      leagueH=allLeague.filter(x=>x.date<limit);
    }
  }
  if(!leagueH.length&&CUP_SUPPORT_LEAGUES[f.leagueCode]?.length){
    const cupRows=await domesticCupSupportHistory(f,date,allLeague);
    if(cupRows.length){
      allLeague=mergeHistoryRows(allLeague,cupRows);
      leagueH=allLeague.filter(x=>x.date<limit);
    }
  }
  if(!leagueH.length&&["SA","SB","CIT"].includes(f.leagueCode)){
    const it=await italyLeagueHistoryRecovery(f,date,allLeague);
    if(it.length){
      allLeague=mergeHistoryRows(allLeague,it);
      leagueH=allLeague.filter(x=>x.date<limit);
    }
  }
  if(!leagueH.length){
    queueHistoryBackfill(f,date);
    throw new Error("DATA PREPARING");
  }

  let liveOdds=null;
  const fixtureOddsKey=f.apiFixtureId||f.id;
  const [oddsApiOdds,apiOdds,fdOdds]=await Promise.all([
    theOddsApiFixtureOdds(f),
    f.apiFixtureId?apiFixtureMarketOdds(f):Promise.resolve(null),
    footballDataFixtureOdds(f,date)
  ]);
  liveOdds=mergeOddsSources(oddsApiOdds,apiOdds,fdOdds,fixtureOddsKey);
  let model=buildModel(leagueH,home,away,leagueH,liveOdds);
  model=applyLiveStateToModel(model,f);
  model.researchSource=isLiveFixtureStatus(f.status)?"live-state-adjusted":"instant-cached-history";
  model.researchMatches={home:homeMatches,away:awayMatches};
  if(homeMatches<5||awayMatches<5){
    model.dataQuality=Math.min(Number(model.dataQuality||0),42);
    model.noBet=true;
  }
  const chartMarket=model.betRecommendation?.name||"1";
  model.oddsHistorySeries=oddsSeriesForChart(fixtureOddsKey,chartMarket);
  model.bookmakerComparison=liveOdds?.comparisonTable?.[chartMarket]||null;
  setCache(modelKey,model,isLiveFixtureStatus(f.status)?15000:(liveOdds?120000:300000));
  if(!isLiveFixtureStatus(f.status)&&f.status!=="FT")logPrediction(f,model);

  // Improve the next open silently; never block this response.
  if(homeMatches<5||awayMatches<5)scheduleBackgroundModelEnrichment(f,date);
  return model;
}



app.get("/api/debug/odds-sports",async(req,res)=>{
  try{
    if(!ODDS_API_KEY)return res.json({ok:false,error:"ODDS_API_KEY not set"});
    const map=await ensureOddsApiSportKeys();
    res.json({ok:true,resolved:map,resolvedCount:Object.keys(map).length,totalHints:Object.keys(ODDS_API_HINTS).length});
  }catch(e){res.status(500).json({ok:false,error:e.message})}
});
app.get("/api/debug/odds/:id",async(req,res)=>{
  try{
    const date=String(req.query.date||localYmdFromDate(new Date()));
    let f=null;
    const result=await fixturesForThreeDays(date);
    f=result.fixtures.find(x=>String(x.id)===String(req.params.id)||String(x.apiFixtureId)===String(req.params.id));
    if(!f)return res.status(404).json({ok:false,error:"fixture-not-found"});
    const [oddsApiOdds,apiOdds,fdOdds]=await Promise.all([theOddsApiFixtureOdds(f),f.apiFixtureId?apiFixtureMarketOdds(f):null,footballDataFixtureOdds(f,date)]);
    const merged=mergeOddsSources(oddsApiOdds,apiOdds,fdOdds,f.apiFixtureId||f.id);
    res.json({ok:true,fixture:{id:f.id,apiFixtureId:f.apiFixtureId,leagueCode:f.leagueCode,home:f.home?.name,away:f.away?.name},oddsApi:oddsApiOdds,apiOdds,footballData:fdOdds,merged});
  }catch(e){res.status(500).json({ok:false,error:e.message})}
});

app.get("/api/debug/api-coverage",async(req,res)=>{
  try{
    const code=String(req.query.code||"").toUpperCase();
    const date=String(req.query.date||localYmdFromDate(new Date()));
    const l=LEAGUES[code];
    if(!l)return res.status(400).json({ok:false,error:"unknown-league"});
    if(!API_KEY)return res.json({ok:false,error:"API_FOOTBALL_KEY missing",league:code});
    const season=Number(date.slice(0,4));
    const k=`coverage-v1:${l.apiId}:${season}`,cached=getCache(k);
    if(cached)return res.json({ok:true,cached:true,league:code,apiId:l.apiId,season,coverage:cached});
    const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),5000);
    const r=await fetch(`${API_BASE}/leagues?id=${l.apiId}&season=${season}`,{headers:{"x-apisports-key":API_KEY},signal:ctrl.signal});
    clearTimeout(timer);
    if(!r.ok)return res.status(r.status).json({ok:false,error:`HTTP ${r.status}`});
    const body=await r.json();
    const seasonRow=body.response?.[0]?.seasons?.find(x=>Number(x.year)===season)||null;
    const cov=seasonRow?.coverage||null;
    if(cov)setCache(k,cov,21600000);
    res.json({ok:true,cached:false,league:code,apiId:l.apiId,season,coverage:cov});
  }catch(e){res.status(500).json({ok:false,error:e.message})}
});

app.get("/api/data-capability",async(req,res)=>{
  const out={};
  for(const [code,l] of Object.entries(LEAGUES)){
    out[code]={
      league:l.name,country:l.country,
      fixtureSources:["API-Football",ESPN_SLUGS[code]?"ESPN":null,l.csv||NEW_LEAGUE_CSV[code]?"Football-Data":null].filter(Boolean),
      history:historyCapability(code),
      odds:{
        apiFootball:!!(API_KEY&&l.apiId),
        footballDataOpeningClosing:!!l.csv,
        markets:["1X2","O/U 2.5","BTTS when API-covered","double chance when API-covered","team goals when API-covered","1H totals when API-covered","corners when bookmaker/API supplies them"]
      }
    };
  }
  res.json({ok:true,generatedAt:new Date().toISOString(),leagues:out});
});

app.get("/api/debug/odds-store",(req,res)=>{
  const fixtures=Object.keys(oddsSnapshotStore);
  const snapshots=fixtures.reduce((n,k)=>n+(oddsSnapshotStore[k]?.length||0),0);
  res.json({ok:true,file:ODDS_SNAPSHOT_FILE,fixtures:fixtures.length,snapshots,
    persistent:!!process.env.ODDS_SNAPSHOT_FILE,
    note:"For durable opening/current history on Render, point ODDS_SNAPSHOT_FILE to a persistent disk path. Without it, redeploy/restart can reset snapshots."});
});

/* ---------------- Frontend ---------------- */
const leagueMeta=JSON.stringify(Object.entries(LEAGUES).map(([code,l])=>({code,name:l.name,emoji:l.emoji,country:l.country})));
const serverToday=localYmdFromDate(new Date());

const HTML=`<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#07111f"><title>MatchEdge Premium</title><style>
:root{
 --bg:#06111d;--panel:#0b1928;--panel2:#0e2032;--line:#1d3448;--text:#f4f7fb;
 --muted:#8e9aac;--teal:#18d5b0;--teal2:#0ca58e;--purple:#8b5cf6;--gold:#f4c542;
 --red:#ff625b;--green:#31d08b;--shadow:0 18px 50px #00000035
}
*{box-sizing:border-box}
html{background:var(--bg)}
body{margin:0;background:
 radial-gradient(circle at 80% 10%,#18255b40,transparent 30%),
 radial-gradient(circle at 20% 90%,#0d6b6540,transparent 28%),
 var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
button{font-family:inherit}.goalToast{position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:9999;background:#10253e;border:1px solid #1fd8b155;border-radius:14px;padding:12px 16px;color:#fff;font-weight:900;box-shadow:0 10px 30px #0008;display:none;max-width:90%;text-align:center}
.shell{min-height:100vh;display:grid;grid-template-columns:88px 1fr}
.sideNav{border-right:1px solid #173046;background:#071522e8;backdrop-filter:blur(18px);position:sticky;top:0;height:100vh;padding:18px 8px;display:flex;flex-direction:column;align-items:center;z-index:20}
.sideLogo{width:48px;height:48px;border:1px solid #1fd8b155;border-radius:15px;display:grid;place-items:center;color:var(--teal);font-size:25px;font-weight:1000;margin-bottom:22px;background:#0a1c2b}
.sideItem{width:72px;min-height:65px;border:0;background:transparent;color:#91a0b2;border-radius:14px;margin:4px 0;font-size:9px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px}
.sideItem i{font-style:normal;font-size:21px}.sideItem.active{color:var(--teal);background:#10263a}.sideSpacer{flex:1}
.mainWrap{min-width:0}
.topbar{height:80px;border-bottom:1px solid #173046;background:#071522cc;backdrop-filter:blur(16px);position:sticky;top:0;z-index:15;display:flex;align-items:center;justify-content:space-between;padding:0 26px}
.brand{font-weight:950;font-size:18px;letter-spacing:.2px}.brand small{display:block;font-size:9px;letter-spacing:2px;color:#aab5c3;margin-top:3px}.gold{color:var(--teal)}
.topActions{display:flex;gap:8px;align-items:center}.live{font-size:9px;color:var(--green);background:#31d08b16;border:1px solid #31d08b28;padding:7px 10px;border-radius:999px}.langSwitch{display:flex;gap:5px}.langBtn{border:1px solid #ffffff18;background:#ffffff08;color:#fff;border-radius:10px;padding:7px 9px;cursor:pointer;font-size:15px}.langBtn.active{border-color:#20d6b455;background:#20d6b414}
.app{max-width:1180px;margin:auto;padding:22px 18px 70px}
.hero{padding:18px 20px;border:1px solid var(--line);border-radius:19px;background:linear-gradient(145deg,#0e2235,#0a1827);box-shadow:var(--shadow)}
.days{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}
.day{border:1px solid #ffffff12;background:#ffffff05;color:#9ba8b8;border-radius:13px;padding:10px 6px;text-align:center;cursor:pointer}
.day b{display:block;font-size:9px}.day span{display:block;font-size:18px;color:white;margin-top:3px}.day small{display:block;font-size:8px;color:#7e8da0;margin-top:2px}
.day.active{background:linear-gradient(135deg,#f5c94d,#e7ac28);color:#0b1420;border-color:#f6cd55}.day.active span,.day.active small{color:#0b1420}
.leagues{display:flex;gap:8px;overflow:auto;padding:13px 0 8px;scrollbar-width:none}.chip{white-space:nowrap;border:1px solid #ffffff12;background:#0d1b2a;color:#aab6c5;padding:9px 12px;border-radius:99px}.chip.active{background:#132b3e;color:var(--teal);border-color:#1fd8b144}
.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:5px 0 16px}
.stat{padding:13px;border:1px solid var(--line);border-radius:14px;background:#0a1826}.stat strong{display:block;font-size:18px;color:#fff}.stat span{font-size:8px;color:#8090a2;letter-spacing:.5px}
.head{display:flex;justify-content:space-between;align-items:end}.head h2{margin:7px 0;font-size:17px}.head span{font-size:9px;color:#78899c}
.scoreboard{margin:12px 0 16px;border:1px solid var(--line);border-radius:15px;background:#0a1826;overflow:hidden}.scoreboard summary{cursor:pointer;list-style:none;padding:13px 15px;font-size:10px;font-weight:950;letter-spacing:.5px;color:var(--teal);display:flex;justify-content:space-between}.scoreboard summary::-webkit-details-marker{display:none}.scoreboardBody{padding:0 12px 12px}
.scoreboardTop{margin:0 0 16px;border:1px solid #1f5a4a;box-shadow:0 8px 24px #19dab21a}.scoreboardTop summary{background:linear-gradient(145deg,#0d2b24,#0a1826);font-size:11px}
.scoreLeague{margin-top:8px;font-size:9px;font-weight:900;color:#94a3b7;border-bottom:1px solid #ffffff0d;padding:7px 2px}.scoreRow{display:grid;grid-template-columns:48px 1fr auto 1fr;gap:8px;align-items:center;padding:10px 2px;border-bottom:1px solid #ffffff08;font-size:10px}.scoreHome{text-align:right}.scoreCenter{text-align:center;min-width:50px}.scoreMain{font-size:15px;font-weight:950}.scoreStatus{font-size:8px;color:var(--green);font-weight:900;text-align:center}.scoreHt{font-size:8px;color:#8e9aae;margin-top:2px}.scoreEmpty{padding:13px;color:#8190a2;font-size:10px;text-align:center}
.accSummary{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:6px 0}.accStat{padding:12px 6px;border-radius:12px;background:#ffffff05;text-align:center}.accStat strong{display:block;font-size:18px;color:var(--teal);font-weight:950}.accStat span{display:block;font-size:8px;color:#8e9aae;margin-top:3px;font-weight:900}
.accHint{display:block;padding:8px 2px 4px;color:#7d8ea0;font-size:8px;line-height:1.5}
.accList{margin-top:8px;border-top:1px solid #ffffff0a}.accRow{display:grid;grid-template-columns:16px 1fr auto;gap:8px;align-items:center;padding:8px 2px;border-bottom:1px solid #ffffff08;font-size:9px}.accOk{color:var(--teal);font-weight:950}.accBad{color:#ff8d88;font-weight:950}.accTeams{color:#c7d3de;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.accPick{color:#8e9aae;font-size:8px;white-space:nowrap}
.sh{text-align:right;color:#d7e1ec}.sa{text-align:left;color:#d7e1ec}.scoreNum{font-size:14px;font-weight:950;text-align:center;color:#fff}.scoreDetail{display:flex;gap:4px;justify-content:center;margin-top:3px;flex-wrap:wrap}.scorePill{font-size:7px;padding:2px 5px;border-radius:99px;background:#ffffff0c;color:#9fb0c2;font-weight:900}
.countryGroup{margin:10px 0;border:1px solid var(--line);border-radius:17px;overflow:hidden;background:#081725}.countryGroup>summary,.leagueFold>summary{cursor:pointer;list-style:none}.countryGroup>summary::-webkit-details-marker,.leagueFold>summary::-webkit-details-marker{display:none}.countryTitle{padding:14px 15px;font-size:11px;font-weight:950;display:flex;justify-content:space-between;background:#0b1d2d}.countryTitle:after,.leagueFold>summary:after{content:"＋";color:var(--teal)}.countryGroup[open]>.countryTitle:after,.leagueFold[open]>summary:after{content:"−"}
.countryBody{padding:8px}.leagueFold{margin:7px 0;border:1px solid #ffffff0f;border-radius:13px;overflow:hidden}.leagueFold>summary{padding:11px 12px;font-size:10px;font-weight:900;color:#c8d3df;display:flex;justify-content:space-between;background:#071421}.leagueMatches{padding:7px}
.fixture{padding:14px;margin:8px 0;border:1px solid #244159;border-radius:16px;background:linear-gradient(145deg,#0c1b2b,#0a1725);box-shadow:0 10px 30px #0002;position:relative;overflow:hidden}.fixture:before{content:"";position:absolute;left:0;top:0;width:3px;height:100%;background:linear-gradient(var(--purple),var(--teal))}
.fxhead{display:flex;justify-content:space-between;color:#8191a4;font-size:8px}.teams{display:grid;grid-template-columns:1fr 64px 1fr;align-items:center;margin-top:12px}.team{text-align:center;font-size:12px;font-weight:850}.team img{width:42px;height:42px;object-fit:contain;display:block;margin:0 auto 6px}.time{text-align:center;color:#fff;font-weight:950}.liveScore{font-size:18px}.liveTag{font-size:8px;color:var(--green);margin-top:3px}
.analyze,.scoreBtn{width:100%;height:41px;margin-top:12px;border:0;border-radius:11px;background:linear-gradient(135deg,#20d7b0,#11a995);font-weight:950;color:#04120f;cursor:pointer}.scoreBtn{height:34px;background:#ffffff08;color:#c4cedb;border:1px solid #ffffff10}.analyze:disabled{opacity:.6}
.analysis{border-top:1px solid #ffffff0d;margin-top:13px;padding-top:13px}
.readCard{padding:18px;border:1px solid #1f3a50;border-radius:16px;background:linear-gradient(145deg,#0c2031,#0a1725);box-shadow:0 12px 35px #0002}.readTitle{font-size:10px;font-weight:950;letter-spacing:.8px;color:#d7e1ec;margin-bottom:15px}.readTeams{display:flex;justify-content:space-between;font-size:12px;font-weight:900;margin-bottom:12px}.readRow{display:grid;grid-template-columns:120px 1fr 48px;gap:10px;align-items:center;margin:11px 0;font-size:10px}.readLabel{color:#b6c1cd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.readTrack{height:9px;border-radius:99px;background:#ffffff10;overflow:hidden}.readFill{height:100%;border-radius:99px;background:linear-gradient(90deg,#19dab2,#13a992)}.readPct{text-align:right;font-weight:950;font-size:16px}.readSub{margin-top:15px;padding-top:13px;border-top:1px solid #ffffff0d;display:grid;grid-template-columns:repeat(4,1fr);gap:7px}.readPill{padding:10px;border-radius:11px;background:#ffffff05;font-size:9px;display:flex;flex-direction:column;gap:4px}.readPill b{font-size:9px;color:#9ba9b9}.readPill span{color:var(--teal);font-weight:950;font-size:15px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:10px}.mini{padding:12px;border-radius:12px;background:#0c1d2c;border:1px solid #ffffff0f}.mini span{display:block;color:#8292a5;font-size:8px;margin-bottom:5px}.mini strong{font-size:14px}
.section{margin-top:14px;padding-top:5px;color:#dbe4ec;font-size:10px;font-weight:950;letter-spacing:.45px}
.market{display:grid;grid-template-columns:1fr 64px;padding:10px 0;border-bottom:1px solid #ffffff0b;font-size:11px}.prob{color:var(--teal);font-weight:950;text-align:right}
.kellyBox{margin-top:12px;padding:12px;border-radius:12px;background:linear-gradient(145deg,#0d2436,#0a1a28);border:1px solid #1c3a4f}.kellyTitle{font-size:9px;font-weight:950;letter-spacing:.5px;color:#9fb4c4;margin-bottom:8px}.kellyRow{display:flex;justify-content:space-between;padding:5px 0;font-size:11px;color:#c7d3de;border-bottom:1px solid #ffffff08}.kellyRow:last-of-type{border-bottom:none}.kellyRow b{color:var(--teal);font-size:13px}.kellyRow.kellyRec{background:#19dab212;margin:2px -6px;padding:6px 6px;border-radius:8px;border-bottom:none}.kellyRow.kellyRec b{font-size:15px}.kellyBox small{display:block;margin-top:8px;color:#7d8ea0;font-size:8px;line-height:1.5}
.couponAddBtn{display:block;width:100%;margin-top:10px;padding:11px;border-radius:12px;border:1px solid #1f5a4a;background:#0d2b24;color:var(--teal);font-weight:950;font-size:11px;cursor:pointer}.couponAddBtn.inCoupon{background:#19dab21c;border-color:var(--teal)}
.couponList{display:flex;flex-direction:column;gap:6px}.couponRow{display:grid;grid-template-columns:1fr auto 24px;gap:8px;align-items:center;padding:9px 8px;border-radius:10px;background:#ffffff05}.couponTeams b{display:block;font-size:10px;color:#e5edf5}.couponTeams small{color:#7d8ea0;font-size:8px}.couponPick{text-align:right;font-size:9px;color:#9fb0c2}.couponPick b{display:block;color:var(--teal);font-size:13px}.couponRemove{background:none;border:none;color:#ff8d88;font-size:14px;cursor:pointer;padding:4px}
.couponSummary{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}.couponSummary div{padding:10px;border-radius:10px;background:#ffffff05;text-align:center}.couponSummary span{display:block;font-size:8px;color:#8e9aae;font-weight:900}.couponSummary b{display:block;font-size:16px;color:var(--teal);margin-top:3px}
.couponStakeRow{display:flex;gap:8px;margin-top:10px;align-items:center}.couponStakeRow input{flex:1;padding:10px;border-radius:10px;border:1px solid var(--line);background:#0a1826;color:#fff;font-size:12px}.couponStakeRow span{font-size:9px;color:var(--teal);font-weight:900;white-space:nowrap}
.couponWarn{display:block;margin-top:8px;color:#7d8ea0;font-size:8px;line-height:1.5}
.couponClear{display:block;width:100%;margin-top:10px;padding:9px;border-radius:10px;border:1px solid #3a2020;background:transparent;color:#ff8d88;font-size:9px;font-weight:900;cursor:pointer}
.oddsChart{margin-top:10px;padding:10px;border-radius:12px;background:#0a1826;border:1px solid #1c3347}.oddsChart svg{display:block;width:100%;height:auto}.oddsChartLabels{display:flex;justify-content:space-between;font-size:8px;color:#8292a5;margin-top:4px}
.bmTable{border-radius:12px;overflow:hidden;border:1px solid #1c3347}.bmRow{display:flex;justify-content:space-between;padding:8px 10px;font-size:10px;color:#c7d3de;background:#0a1826;border-bottom:1px solid #ffffff08}.bmRow:last-child{border-bottom:none}.bmRow b{font-weight:950}.bmRow.bmBest{background:#19dab214;color:#fff}.bmRow.bmBest b{color:var(--teal);font-size:12px}
.toggleBox,.cornerBox{margin-top:11px;border:1px solid #1c3347;border-radius:13px;overflow:hidden;background:#091827}.toggleBox summary,.cornerBox summary{cursor:pointer;list-style:none;padding:13px 12px;font-size:10px;font-weight:950;color:#d9e3ec;background:#0d2030}.toggleBox summary::-webkit-details-marker,.cornerBox summary::-webkit-details-marker{display:none}.toggleBox summary:after,.cornerBox summary:after{content:"＋";float:right;color:var(--teal)}.toggleBox[open] summary:after,.cornerBox[open] summary:after{content:"−"}.toggleBody,.cornerBody{padding:10px 12px 12px}
.teamstate{display:grid;grid-template-columns:1fr 1fr;gap:8px}.state,.cornerTeam{background:#ffffff04;border:1px solid #ffffff0c;border-radius:11px;padding:10px}.state b,.cornerTeam b{font-size:10px;display:block;margin-bottom:5px}.state span,.cornerTeam span{display:block;color:#8f9caf;font-size:8px;line-height:1.55}.cornerStats{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:8px 0}.cornerExpected{font-size:9px;color:var(--gold);padding:5px 0;font-weight:900}.cornerLine{display:grid;grid-template-columns:1fr 60px 60px;gap:6px;padding:8px 0;border-bottom:1px solid #ffffff0c;font-size:10px}.cornerLine .ov,.cornerLine .un{text-align:right;font-weight:900}.cornerHint,.reason{font-size:8px;color:#8796a8;line-height:1.5;padding:5px 0}
.nobet,.error,.empty,.warn{margin-top:10px;padding:12px;border-radius:12px;font-size:9px}.nobet{background:#f2b93812;border:1px solid #f2b93828;color:#f3c95a}.error{background:#ff625b12;color:#ff8d88}.empty{text-align:center;color:#8190a2;border:1px dashed #ffffff1a}.loader{text-align:center;color:#8190a2;padding:22px}
.footerNote{margin-top:24px;font-size:8px;color:#6f7e91;line-height:1.5;text-align:center}.creatorCredit{text-align:center;margin-top:8px;font-size:8px;color:#637285}
.focusRead{padding:16px;border:1px solid #1f3a50;border-radius:18px;background:linear-gradient(145deg,#0c2031,#0a1725)}
.resultRead{padding:16px 18px;border:1px solid #1f3a50;border-radius:18px;background:linear-gradient(145deg,#0c2031,#0a1725);margin-bottom:10px}
.resultTitle{font-size:10px;font-weight:950;letter-spacing:.75px;margin-bottom:14px}
.resultGrid{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}
.resultItem{text-align:center}.resultItem b{display:block;font-size:10px;color:#dce5ee;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.resultItem strong{display:block;font-size:24px;margin:7px 0 10px}.resultItem.home strong{color:var(--teal)}.resultItem.draw strong{color:var(--gold)}.resultItem.away strong{color:var(--purple)}
.resultTrack{height:8px;background:#ffffff10;border-radius:99px;overflow:hidden}.resultTrack i{display:block;height:100%;border-radius:99px}.resultItem.home i{background:linear-gradient(90deg,var(--teal),#16aa95)}.resultItem.draw i{background:linear-gradient(90deg,var(--gold),#e0a82e)}.resultItem.away i{background:linear-gradient(90deg,var(--purple),#6548c7)}
.analysisDeck{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.analysisTile{border:1px solid #19364b;border-radius:12px;background:#0a1a29;overflow:hidden}
.analysisTile>summary{list-style:none;cursor:pointer;padding:13px;display:grid;grid-template-columns:34px 1fr 18px;gap:9px;align-items:center}
.analysisTile>summary::-webkit-details-marker{display:none}.analysisTile>summary:after{content:"›";font-size:24px;color:#8194a8}
.analysisTile[open]>summary:after{content:"⌄";font-size:16px}
.tileIcon{font-size:22px;color:var(--purple);text-align:center}.tileCopy b{display:block;font-size:10px}.tileCopy span{display:block;margin-top:3px;font-size:8px;color:#8796a8;line-height:1.35}
.tileBody{padding:0 12px 12px;border-top:1px solid #ffffff09;font-size:9px;color:#b9c5d0}
.tilePair{display:grid;grid-template-columns:1fr 1fr;gap:8px}.tileStat{padding:8px;background:#ffffff04;border-radius:9px}.tileStat span{display:block;color:#8796a8;font-size:8px}.tileStat b{display:block;margin-top:3px;font-size:11px}

.focusTitle{font-size:10px;font-weight:950;letter-spacing:.8px;margin-bottom:12px}
.focusGrid{display:grid;grid-template-columns:repeat(4,1fr);gap:9px}
.focusMetric{padding:14px 10px;border:1px solid #ffffff0e;border-radius:14px;background:#ffffff04;min-height:112px;display:flex;flex-direction:column;justify-content:space-between}
.focusMetric b{font-size:9px;color:#a8b5c4}.focusMetric strong{font-size:22px;color:var(--teal);line-height:1.05}.focusMetric small{font-size:8px;color:#8291a3}
.focusBar{height:7px;background:#ffffff10;border-radius:99px;overflow:hidden}.focusBar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--teal),#16b99d)}
.focusSummary{display:grid;grid-template-columns:1fr .8fr 1.2fr;gap:9px;margin-top:10px}
.summaryCard{padding:15px;border:1px solid #1f3a50;border-radius:15px;background:#0a1b2a;min-height:100px}.summaryCard span{display:block;font-size:8px;color:#8493a5;letter-spacing:.4px}.summaryCard strong{display:block;margin-top:8px;font-size:19px}.summaryCard small{display:block;margin-top:6px;font-size:8px;color:#8392a4}.expectedOpen{grid-column:1/-1;padding:15px;border:1px solid #1f3a50;border-radius:15px;background:#0a1b2a}.expectedTop{display:flex;justify-content:space-between;align-items:end;gap:10px}.expectedTop>div:first-child span{display:block;font-size:8px;color:#8493a5;letter-spacing:.4px}.expectedTop>div:first-child strong{display:block;margin-top:6px;font-size:22px;color:#fff}.expectedSplit{font-size:11px;color:#9aa8b8;font-weight:850}
.expectedScoreWrap{display:flex;align-items:center;gap:9px;margin-left:auto}
.expectedScoreBadge{min-width:82px;padding:8px 11px;border:1px solid #18d5b055;border-radius:12px;background:#0c2b2d;text-align:center}
.expectedScoreBadge span{display:block;font-size:8px;color:#87a2ad;letter-spacing:.45px;font-weight:900}
.expectedScoreBadge b{display:block;margin-top:3px;font-size:19px;line-height:1;color:var(--gold);font-weight:1000}
.expectedScoreNote{margin-top:9px;padding:10px 11px;border-radius:11px;background:#ffffff04;border:1px solid #ffffff0c;display:flex;justify-content:space-between;gap:10px;align-items:center}
.expectedScoreNote span{font-size:9px;color:#91a1b2;font-weight:850}
.expectedScoreNote strong{font-size:18px;color:var(--gold);letter-spacing:.4px}
@media(max-width:560px){.expectedTop{align-items:center}.expectedScoreWrap{gap:6px}.expectedScoreBadge{min-width:72px;padding:7px 9px}.expectedScoreBadge b{font-size:18px}.expectedSplit{display:none}}.expectedValuesGrid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:12px}.expectedVal{padding:10px;border-radius:11px;background:#ffffff05;border:1px solid #ffffff0c}.expectedVal span{display:block;font-size:8px;color:#8493a5}.expectedVal b{display:block;margin-top:5px;font-size:12px;color:#e8eef5}.expectedVal b em{font-style:normal;color:var(--teal)}.expectedToggle>summary{cursor:pointer;list-style:none}.expectedToggle>summary::-webkit-details-marker{display:none}.expectedToggle>summary:after{content:"＋";color:var(--teal);font-size:18px;font-weight:900;margin-left:10px}.expectedToggle[open]>summary:after{content:"−"}.expectedToggleBody{padding-top:2px}
.signalCard{border-color:#18d5b044;background:linear-gradient(145deg,#0d2a2d,#0b1d27)}.signalCard strong{color:var(--gold);font-size:17px}.signalProb{color:var(--teal)!important;font-weight:900}.signalMarketToggle{margin-top:12px;border-color:#18d5b033;background:#071b22}.signalMarketToggle summary{background:#0b2428;color:#dff9f3;padding:11px}.signalMarketToggle .toggleBody{max-height:420px;overflow:auto}.signalMarketToggle .section:first-child{margin-top:0}
.otherAnalysis{margin-top:11px;border:1px solid #1c3347;border-radius:15px;overflow:hidden;background:#091827}.otherAnalysis>summary{cursor:pointer;list-style:none;padding:15px 14px;font-size:10px;font-weight:950;letter-spacing:.45px;background:#0d2030}.otherAnalysis>summary::-webkit-details-marker{display:none}.otherAnalysis>summary:after{content:"＋";float:right;color:var(--teal);font-size:15px}.otherAnalysis[open]>summary:after{content:"−"}.otherBody{padding:12px}

.favoriteRow{display:flex;justify-content:flex-end;margin-top:7px}
.favBtn{width:38px;height:34px;border:1px solid #264057;border-radius:10px;background:#0a1c2a;color:#7f91a5;font-size:19px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center}
.favBtn.active{color:var(--gold);border-color:#d6ad4a66;background:#2a2311}
.favBtn:active{transform:scale(.96)}
.navEmpty{padding:30px 16px;text-align:center;border:1px dashed #294057;border-radius:14px;color:#8496a8;background:#091724;margin-top:12px}
.navEmpty strong{display:block;color:#dce7ee;font-size:13px;margin-bottom:6px}

.mobileNav{display:none}
@media(max-width:760px){
 .shell{display:block}.sideNav{display:none}.topbar{height:66px;padding:0 13px}.brand{font-size:16px}.app{padding:13px 9px 88px}
 .summary{grid-template-columns:repeat(3,1fr)}.stat{padding:10px 6px}.stat strong{font-size:15px}.stat span{font-size:7px}
 .grid{grid-template-columns:repeat(2,1fr)}.readSub{grid-template-columns:repeat(2,1fr)}.readRow{grid-template-columns:88px 1fr 42px}.focusGrid{grid-template-columns:repeat(2,1fr)}.focusSummary{grid-template-columns:1fr 1fr}.signalCard{grid-column:1/-1}.focusMetric{min-height:105px}.expectedValuesGrid{grid-template-columns:repeat(2,1fr)}.resultGrid{gap:10px}.resultItem strong{font-size:21px}.analysisDeck{grid-template-columns:1fr 1fr}.analysisTile>summary{grid-template-columns:28px 1fr 14px;padding:11px 9px}.tileIcon{font-size:18px}.tileCopy b{font-size:9px}.tileCopy span{font-size:7px}
 .countryBody{padding:5px}.leagueMatches{padding:4px}.fixture{padding:12px}.teams{grid-template-columns:1fr 56px 1fr}.team{font-size:11px}
 .mobileNav{display:grid;grid-template-columns:repeat(4,1fr);position:fixed;bottom:0;left:0;right:0;z-index:50;background:#071522ee;backdrop-filter:blur(18px);border-top:1px solid #173046;padding:7px 4px max(7px,env(safe-area-inset-bottom))}
 .mobileNav button{background:transparent;border:0;color:#8795a8;font-size:8px;padding:6px}.mobileNav button i{display:block;font-style:normal;font-size:19px;margin-bottom:3px}.mobileNav button.active{color:var(--teal)}
}

/* V7.19.0 — daily analysis only */
#days{display:none!important}

/* V7.19.0 — iPhone/mobile horizontal overflow guard */
html,body{max-width:100%;overflow-x:hidden}
*,*:before,*:after{box-sizing:border-box}
.mainWrap,.app,#fixtures,.countryGroup,.countryBody,.leagueFold,.leagueMatches,.fixture,.analysis,.resultRead,.focusRead,.focusSummary,.otherAnalysis{min-width:0;max-width:100%}
.resultGrid,.focusGrid,.teams{min-width:0}
.resultItem,.focusMetric,.team{min-width:0}
.resultItem b,.focusMetric b,.team{overflow-wrap:anywhere;word-break:break-word}
@media(max-width:760px){
 .app{width:100%;max-width:100%;overflow-x:hidden}
 .fixture{width:100%;max-width:100%;overflow:hidden}
 .analysis{width:100%;max-width:100%;overflow:hidden}
 .resultRead,.focusRead,.summaryCard,.expectedValues,.otherAnalysis{width:100%;max-width:100%;overflow:hidden}
 .resultGrid{grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
 .resultItem{padding:9px 5px;overflow:hidden}
 .resultItem b{display:block;max-width:100%;font-size:8px;line-height:1.25;white-space:normal;text-align:center}
 .resultItem strong{font-size:20px;white-space:nowrap}
 .resultTrack{width:100%;max-width:100%}
 .focusGrid{grid-template-columns:repeat(2,minmax(0,1fr))}
 .teams{grid-template-columns:minmax(0,1fr) 48px minmax(0,1fr)}
 .team{max-width:100%;white-space:normal}
}


/* V7.19.0 — long team names + result probability hard mobile fix */
@media(max-width:760px){
  .countryBody{padding:4px}
  .leagueMatches{padding:3px}
  .fixture{margin:6px 0;padding:12px 10px}

  .teams{
    width:100%;
    grid-template-columns:minmax(0,1fr) 42px minmax(0,1fr);
    column-gap:5px;
  }
  .team{
    width:100%;
    min-width:0;
    max-width:100%;
    font-size:10px;
    line-height:1.2;
    white-space:normal!important;
    overflow:visible!important;
    text-overflow:clip!important;
    overflow-wrap:anywhere;
    word-break:normal;
  }

  .analysis,
  .resultRead,
  .resultGrid,
  .resultItem{
    min-width:0!important;
    max-width:100%!important;
  }
  .resultRead{
    width:100%!important;
    padding:14px 8px!important;
    overflow:hidden!important;
  }
  .resultGrid{
    width:100%!important;
    display:grid!important;
    grid-template-columns:minmax(0,1fr) minmax(0,.72fr) minmax(0,1fr)!important;
    gap:4px!important;
    align-items:start;
  }
  .resultItem{
    width:100%!important;
    overflow:hidden!important;
    padding:0 2px!important;
  }
  .resultItem b{
    width:100%!important;
    min-height:28px;
    display:flex!important;
    align-items:center;
    justify-content:center;
    font-size:7.5px!important;
    line-height:1.15!important;
    white-space:normal!important;
    overflow:visible!important;
    text-overflow:clip!important;
    overflow-wrap:anywhere!important;
    word-break:normal!important;
    text-align:center;
  }
  .resultItem strong{
    width:100%!important;
    max-width:100%!important;
    display:block!important;
    margin:6px 0 9px!important;
    font-size:clamp(16px,4.7vw,20px)!important;
    line-height:1!important;
    white-space:nowrap!important;
    overflow:hidden!important;
    text-overflow:clip!important;
    text-align:center;
  }
  .resultTrack{
    width:100%!important;
    max-width:100%!important;
  }
}


.liveAnalysisBanner{margin:0 0 11px;padding:10px 12px;border:1px solid #18d5b044;border-radius:12px;background:#09282a;display:flex;justify-content:space-between;gap:10px;align-items:center}
.liveAnalysisBanner b{font-size:10px;color:var(--teal);letter-spacing:.5px}
.liveAnalysisBanner span{font-size:9px;color:#b8c7d0;text-align:right}

</style></head><body><div class="goalToast" id="goalToast"></div><div class="shell"><aside class="sideNav"><div class="sideLogo">M</div><button class="sideItem active"><i>⚽</i>Maçlar</button><button class="sideItem"><i>◉</i>Canlı</button><button class="sideItem"><i>▥</i>Analiz</button><button class="sideItem"><i>☆</i>Favoriler</button><div class="sideSpacer"></div><button class="sideItem"><i>⚙</i>Ayarlar</button></aside><div class="mainWrap"><div class="topbar"><div class="brand">MATCHEDGE <span class="gold">PREMIUM</span><small id="brandSubtitle">GÜNLÜK MAÇ ANALİZİ</small></div><div class="topActions"><div class="live">● LIVE DATA</div><div class="langSwitch"><button class="langBtn active" id="trBtn" onclick="setLang('tr')" aria-label="Türkçe">🇹🇷</button><button class="langBtn" id="enBtn" onclick="setLang('en')" aria-label="English">🇬🇧</button></div></div></div><div class="app"><details class="scoreboard scoreboardTop" id="scoreboard"><summary><span id="scoreboardTitle">⚽ Score Board</span><span>⌄</span></summary><div class="scoreboardBody" id="scoreboardBody"></div></details><details class="scoreboard scoreboardTop" id="couponPanel"><summary><span id="couponTitle">🎫 Kuponum (0)</span><span>⌄</span></summary><div class="scoreboardBody" id="couponBody"></div></details><div class="hero"><div class="days" id="days"></div></div><div class="leagues" id="leagues"></div><div class="summary"><div class="stat"><strong id="mc">—</strong><span id="sumMatches">SEÇİLİ GÜN MAÇI</span></div><div class="stat"><strong id="ac">0</strong><span id="sumAnalysis">AÇIK ANALİZ</span></div><div class="stat"><strong id="threeDayStrong">BUGÜN</strong><span id="sumDays">GÜNLÜK ANALİZ</span></div></div><div class="head"><h2 id="dayHeading">Maçlar</h2><span id="fc"></span></div><details class="scoreboard" id="accuracyPanel"><summary><span id="accuracyTitle">📊 MODEL PERFORMANSI</span><span>⌄</span></summary><div class="scoreboardBody" id="accuracyBody"></div></details><div id="fixtures"><div class="loader">Fikstür yükleniyor…</div></div><div class="footerNote" id="footerNote"></div><div class="creatorCredit" id="creatorCredit"></div></div></div></div><nav class="mobileNav" id="mobileNav">
<button class="active" data-view="home" onclick="setMobileView('home',this)"><i>⌂</i><span id="navHome">Ana Sayfa</span></button>
<button data-view="matches" onclick="setMobileView('matches',this)"><i>⚽</i><span id="navMatches">Maçlar</span></button>
<button data-view="analysis" onclick="setMobileView('analysis',this)"><i>▥</i><span id="navAnalysis">Analiz</span></button>
<button data-view="favorites" onclick="setMobileView('favorites',this)"><i>☆</i><span id="navFavorites">Favoriler</span></button>
</nav><script>
const meta=${leagueMeta};const SERVER_TODAY=${JSON.stringify(serverToday)};let selectedDate=SERVER_TODAY,selected="ALL",allFixtures=[],loadSeq=0,openAnalysisId=null,lang="tr",currentView="home";
const days=document.getElementById("days");
const leagues=document.getElementById("leagues");
const mc=document.getElementById("mc");
const ac=document.getElementById("ac");
const brandSubtitle=document.getElementById("brandSubtitle");
const threeDayStrong=document.getElementById("threeDayStrong");
const sumMatches=document.getElementById("sumMatches");
const sumAnalysis=document.getElementById("sumAnalysis");
const sumDays=document.getElementById("sumDays");
const dayHeading=document.getElementById("dayHeading");
const fc=document.getElementById("fc");
const fixtures=document.getElementById("fixtures");
const scoreboard=document.getElementById("scoreboard");
const scoreboardTitle=document.getElementById("scoreboardTitle");
const scoreboardBody=document.getElementById("scoreboardBody");
const accuracyPanel=document.getElementById("accuracyPanel");
const accuracyTitle=document.getElementById("accuracyTitle");
const accuracyBody=document.getElementById("accuracyBody");
const couponPanel=document.getElementById("couponPanel");
const couponTitle=document.getElementById("couponTitle");
const couponBody=document.getElementById("couponBody");
const footerNote=document.getElementById("footerNote");
const creatorCredit=document.getElementById("creatorCredit");
const trBtn=document.getElementById("trBtn");
const enBtn=document.getElementById("enBtn");
const goalToast=document.getElementById("goalToast");
const mobileNav=document.getElementById("mobileNav");
const navHome=document.getElementById("navHome");
const navMatches=document.getElementById("navMatches");
const navAnalysis=document.getElementById("navAnalysis");
const navFavorites=document.getElementById("navFavorites");

function loadStringSet(key){
  try{return new Set(JSON.parse(localStorage.getItem(key)||"[]").map(String));}catch{return new Set();}
}
let favoriteIds=loadStringSet("matchedge_favorites_v1");
let analyzedIds=loadStringSet("matchedge_analyzed_"+SERVER_TODAY);
function saveStringSet(key,set){try{localStorage.setItem(key,JSON.stringify([...set]));}catch{}}
function isFavorite(id){return favoriteIds.has(String(id))}
function toggleFavoriteById(id){
  id=String(id);
  if(favoriteIds.has(id))favoriteIds.delete(id); else favoriteIds.add(id);
  saveStringSet("matchedge_favorites_v1",favoriteIds);
  render();
}
function setMobileView(view,btn){
  currentView=view;
  if(mobileNav)mobileNav.querySelectorAll("button").forEach(x=>x.classList.toggle("active",x.dataset.view===view));
  closeOpenAnalysis();
  render();
  window.scrollTo({top:0,behavior:"smooth"});
}


const esc=s=>String(s??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
const I18N={
 tr:{subtitle:"GÜNLÜK MAÇ ANALİZİ",y:"DÜN",t:"BUGÜN",tm:"YARIN",all:"Tümü",fixture:"fikstür",match:"maç",matches:"maç",games:"Maçlar",noGame:"Bugün maç yok",pro:"PRO ANALİZ",closeAnalysis:"ANALİZİ KAPAT",close:"KAPAT",calc:"HESAPLANIYOR…",loading:"Takım performansı ve lig gücü modelleniyor…",fixturesLoading:"Bugünün fikstürleri yükleniyor…",fixtureFail:"Fikstür alınamadı",retry:"TEKRAR DENE",selected:"BUGÜNÜN MAÇLARI",open:"AÇIK ANALİZ",three:"BUGÜN",dayLine:"GÜNLÜK ANALİZ",expectedGoals:"BEKLENEN GOL",likelyScore:"OLASI SKOR",quality:"VERİ KALİTESİ",corners:"BEKLENEN KORNER",strong:"EN GÜÇLÜ SEÇİMLER",read:"MAÇ OKUMASI",resultProb:"MAÇ SONUCU OLASILIKLARI",draw:"Beraberlik",over25:"2.5 Üst Gol",under25:"2.5 Alt",bttsYes:"KG Var",bttsNo:"KG Yok",corner85:"8.5 Üst Korner",firstHalfGoal:"İlk Yarı Gol",highestHalf:"En Gollü Yarı",firstHalf:"İlk Yarı",secondHalf:"İkinci Yarı",equalHalves:"Eşit",strongSignal:"EN GÜÇLÜ SİNYAL",marketOddsAnalysis:"PİYASA & ORAN ANALİZİ",betDecision:"OYUN KARARI",marketOdd:"Piyasa Oranı",fairOddLabel:"Adil Oran",edgeLabel:"Edge",evLabel:"Beklenen Değer",oddsUnavailable:"Güncel oran bulunamadı · model tahmini tek başına BET sayılmaz",openingOdd:"İlk/Açılış Oranı",oddsMove:"Oran Hareketi",marketSupport:"Piyasa Hareketi",otherAnalysis:"DİĞER MAÇ ANALİZİ",signalProbability:"Olasılık",totalExpectedGoals:"Toplam Beklenen Gol",basis:"MODEL DAYANAKLARI",allMarkets:"TÜM ANA MARKETLER",cornerMarkets:"KORNER ANALİZİ · MAÇ BAŞI TAKIM VERİSİ",cornerFor:"Attığı korner/maç",cornerAgainst:"Yediği korner/maç",cornerTotalAvg:"Maç toplamı ort.",cornerSample:"Örneklem",cornerExpectedTeams:"Takım korner beklentisi",cornerOver:"ÜST",cornerUnder:"ALT",cornerMethod:"Olasılıklar son maçlardaki korner üretimi, rakibin verdiği kornerler, iç/dış saha ve Poisson dağılımı birlikte kullanılarak hesaplanır.",teamStats:"TAKIM İSTATİSTİKLERİ",league:"Lig",position:"sıra",points:"puan",homePos:"Ev sırası",awayPos:"Dep. sırası",homePPM:"Ev PPM",awayPPM:"Dep. PPM",form:"Form PPM",noBet:"NO BET · Model yeterli avantaj görmüyor.",dailyTitle:"GÜNÜN SEÇİMLERİ · RİSK BAZLI",lowRisk:"DÜŞÜK RİSK",mediumRisk:"ORTA RİSK",highRisk:"YÜKSEK RİSK",possibleCoupon:"OLASI KUPON",lowCoupon:"DÜŞÜK RİSK KUPONU",mediumCoupon:"ORTA RİSK KUPONU",highCoupon:"YÜKSEK RİSK KUPONU",modelView:"Model görünümü",loadingPicks:"Günün seçimleri modelleniyor…",noPicks:"Bugün risk filtresini geçen seçim yok.",prob:"Olasılık",conf:"Güven",qualityShort:"Veri",fairOdd:"Model Oranı",combinedOdd:"Tahmini Birleşik Oran",scoreboard:"SKOR PANOSU",notStarted:"BAŞLAMADI",finished:"BİTTİ",htShort:"İY",ftShort:"MS",noScores:"Bu gün için henüz skor yok.",result:"SONUÇ",hideResult:"SONUCU KAPAT",final:"Maç Sonucu",halftime:"İlk Yarı",liveNow:"CANLI",goalAlert:"GOL",creator:"01.09.2026 tarihinde Eddas tarafından geliştirilmiştir. © 2026 Eddas. Tüm hakları saklıdır.",kellyStake:"Önerilen Bahis (Kelly)",kellyHint:"Bankroll'ün yüzdesi olarak; agresif (Tam), dengeli (Yarım) ve temkinli (Çeyrek) Kelly Kriteri seçenekleri.",kellyFull:"Tam",kellyHalf:"Yarım",kellyQuarter:"Çeyrek",modelAccuracy:"MODEL PERFORMANSI",accuracyHint:"Geçmiş tahminlerin sonuçlarla karşılaştırması",accuracyEmpty:"Henüz sonuçlanmış tahmin yok. Maçları analiz ettikçe ve sonuçlandıkça burada birikecek.",accSettled:"Sonuçlanan",accRate:"İsabet",accBrier:"Brier Skoru",oddsMoveChart:"ORAN HAREKETİ GRAFİĞİ",valueBets:"DEĞER BAHİSLERİ",valueBetsHint:"Piyasa oranına göre modelin en güçlü avantaj gördüğü seçimler",bookmakerCompare:"BAHİS ŞİRKETİ KARŞILAŞTIRMASI",bestOdd:"En İyi Oran",cornersLabel:"Korner",shotsOnTargetLabel:"İsabetli Şut",savesLabel:"Kaleci Kurtarışı",possessionLabel:"Topla Oynama",yellowCardsLabel:"Sarı Kart",redCardsLabel:"Kırmızı Kart",throwInsLabel:"Taç Sayısı",scorersLabel:"GOL ATANLAR",penaltiesLabel:"PENALTILAR",varLabel:"VAR KARARLARI",noDetailData:"Bu maç için detaylı veri mevcut değil",loadingDetail:"Detaylar yükleniyor…",footer:"MatchEdge yalnızca istatistiksel ve model tabanlı analiz sunar; bahis tavsiyesi, kesin sonuç veya kazanç garantisi değildir. Kullanıcı kendi kararlarından ve olası kayıplardan sorumludur. MatchEdge, yürürlükteki hukukun izin verdiği ölçüde, kullanıcı kararlarından doğan kayıp veya zararlardan sorumluluk kabul etmez."},
 en:{subtitle:"DAILY MATCH ANALYSIS",y:"YESTERDAY",t:"TODAY",tm:"TOMORROW",all:"All",fixture:"fixtures",match:"match",matches:"matches",games:"Matches",noGame:"No matches today",pro:"PRO ANALYSIS",closeAnalysis:"CLOSE ANALYSIS",close:"CLOSE",calc:"CALCULATING…",loading:"Modelling team performance and league strength…",fixturesLoading:"Loading today’s fixtures…",fixtureFail:"Could not load fixtures",retry:"TRY AGAIN",selected:"TODAY’S MATCHES",open:"OPEN ANALYSIS",three:"TODAY",dayLine:"DAILY ANALYSIS",expectedGoals:"EXPECTED GOALS",likelyScore:"LIKELY SCORE",quality:"DATA QUALITY",corners:"EXPECTED CORNERS",strong:"STRONGEST PICKS",read:"MATCH READ",resultProb:"MATCH RESULT PROBABILITIES",draw:"Draw",over25:"Over 2.5 Goals",under25:"Under 2.5",bttsYes:"BTTS Yes",bttsNo:"BTTS No",corner85:"Over 8.5 Corners",firstHalfGoal:"First-Half Goal",highestHalf:"Highest-Scoring Half",firstHalf:"First Half",secondHalf:"Second Half",equalHalves:"Equal",strongSignal:"STRONGEST SIGNAL",marketOddsAnalysis:"MARKET & ODDS ANALYSIS",betDecision:"BET DECISION",marketOdd:"Market Odds",fairOddLabel:"Fair Odds",edgeLabel:"Edge",evLabel:"Expected Value",oddsUnavailable:"Current odds unavailable · model probability alone is not treated as a BET",openingOdd:"Opening/First Odd",oddsMove:"Odds Movement",marketSupport:"Market Movement",otherAnalysis:"OTHER MATCH ANALYSIS",signalProbability:"Probability",totalExpectedGoals:"Total Expected Goals",basis:"MODEL BASIS",allMarkets:"ALL MAIN MARKETS",cornerMarkets:"CORNER ANALYSIS · PER-MATCH TEAM DATA",cornerFor:"Corners won/match",cornerAgainst:"Corners conceded/match",cornerTotalAvg:"Match total avg.",cornerSample:"Sample",cornerExpectedTeams:"Expected team corners",cornerOver:"OVER",cornerUnder:"UNDER",cornerMethod:"Probabilities combine recent corner production, opponent corners conceded, home/away samples and a Poisson distribution.",teamStats:"TEAM STATISTICS",league:"League",position:"position",points:"pts",homePos:"Home position",awayPos:"Away position",homePPM:"Home PPM",awayPPM:"Away PPM",form:"Form PPM",noBet:"NO BET · The model does not identify sufficient edge.",dailyTitle:"DAILY PICKS · BY RISK",lowRisk:"LOW RISK",mediumRisk:"MEDIUM RISK",highRisk:"HIGH RISK",possibleCoupon:"POSSIBLE COUPON",lowCoupon:"LOW-RISK COUPON",mediumCoupon:"MEDIUM-RISK COUPON",highCoupon:"HIGH-RISK COUPON",modelView:"Model view",loadingPicks:"Modelling today’s picks…",noPicks:"No picks passed today’s risk filters.",prob:"Probability",conf:"Confidence",qualityShort:"Data",fairOdd:"Model Fair Odds",combinedOdd:"Estimated Combined Odds",scoreboard:"SCOREBOARD",notStarted:"NOT STARTED",finished:"FULL TIME",htShort:"HT",ftShort:"FT",noScores:"No scores yet for this day.",result:"RESULT",hideResult:"HIDE RESULT",final:"Full Time",halftime:"Half Time",liveNow:"LIVE",goalAlert:"GOAL",creator:"Developed by Eddas on 01.09.2026. © 2026 Eddas. All rights reserved.",kellyStake:"Suggested Stake (Kelly)",kellyHint:"As a % of bankroll; aggressive (Full), balanced (Half) and conservative (Quarter) Kelly Criterion options.",kellyFull:"Full",kellyHalf:"Half",kellyQuarter:"Quarter",modelAccuracy:"MODEL PERFORMANCE",accuracyHint:"Past predictions compared against actual results",accuracyEmpty:"No settled predictions yet. This fills in as matches get analyzed and finish.",accSettled:"Settled",accRate:"Accuracy",accBrier:"Brier Score",oddsMoveChart:"ODDS MOVEMENT CHART",valueBets:"VALUE BETS",valueBetsHint:"Picks where the model sees the strongest edge against market price",bookmakerCompare:"BOOKMAKER COMPARISON",bestOdd:"Best Odds",cornersLabel:"Corners",shotsOnTargetLabel:"Shots on Target",savesLabel:"Goalkeeper Saves",possessionLabel:"Possession",yellowCardsLabel:"Yellow Cards",redCardsLabel:"Red Cards",throwInsLabel:"Throw-ins",scorersLabel:"GOAL SCORERS",penaltiesLabel:"PENALTIES",varLabel:"VAR DECISIONS",noDetailData:"Detailed data is not available for this match",loadingDetail:"Loading details…",footer:"MatchEdge provides statistical and model-based analysis only. It is not betting advice and does not guarantee any result or profit. Users are responsible for their own decisions and any resulting losses. To the extent permitted by applicable law, MatchEdge accepts no liability for loss or damage arising from user decisions."}
};
const COUNTRY_EN={"Türkiye":"Turkey","İngiltere":"England","İspanya":"Spain","İtalya":"Italy","Almanya":"Germany","Fransa":"France","Hollanda":"Netherlands","Belçika":"Belgium","Portekiz":"Portugal","Yunanistan":"Greece","İskoçya":"Scotland","Rusya":"Russia","Ukrayna":"Ukraine","Finlandiya":"Finland","Norveç":"Norway","İsveç":"Sweden","Danimarka":"Denmark","İsviçre":"Switzerland","Avusturya":"Austria","Polonya":"Poland","Çekya":"Czechia","Romanya":"Romania","Hırvatistan":"Croatia","Sırbistan":"Serbia","Kıbrıs":"Cyprus","Slovakya":"Slovakia","Slovenya":"Slovenia","İsrail":"Israel","İrlanda":"Ireland","Avrupa":"Europe","Diğer":"Other"};
const LEAGUE_EN={TSL:"Süper Lig",T1L:"1. Lig",TKC:"Turkish Cup",GRE:"Super League Greece",SCL1:"League One",SCL2:"League Two"};
function t(k){return I18N[lang][k]||k}
function locale(){return lang==="en"?"en-GB":"tr-TR"}
function countryName(x){return lang==="en"?(COUNTRY_EN[x]||x):x}
function leagueName(x){return lang==="en"?(LEAGUE_EN[x.code]||x.name):x.name}
function iso(x){return x.getFullYear()+"-"+String(x.getMonth()+1).padStart(2,"0")+"-"+String(x.getDate()).padStart(2,"0")}
function shiftYmdClient(v,n){const d=new Date(v+"T12:00:00Z");d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)}
function statusFinished(s){return["FT","AET","PEN","CANC","ABD","AWD","WO"].includes(s)}
function translateMarketName(name){
 if(lang==="tr")return name;
 const map={"1X":"1X","X2":"X2","12":"12","1.5 Üst":"Over 1.5","3.5 Alt":"Under 3.5","2.5 Üst":"Over 2.5","2.5 Alt":"Under 2.5","KG Var":"BTTS Yes","KG Yok":"BTTS No","Ev 1.5 Üst":"Home Over 1.5","Dep 1.5 Üst":"Away Over 1.5","İY 0.5 Üst":"1H Over 0.5","İY 1.5 Üst":"1H Over 1.5","İY KG Var":"1H BTTS Yes","2Y 0.5 Üst":"2H Over 0.5","2Y 1.5 Üst":"2H Over 1.5","Daha Çok Gol: İlk Yarı":"More Goals: First Half","Daha Çok Gol: İkinci Yarı":"More Goals: Second Half","Yarılar Eşit":"Halves Equal","9.5 Üst":"Over 9.5","10.5 Üst":"Over 10.5","Korner 7.5 Üst":"Corners Over 7.5","Korner 7.5 Alt":"Corners Under 7.5","Korner 8.5 Üst":"Corners Over 8.5","Korner 8.5 Alt":"Corners Under 8.5","Korner 9.5 Üst":"Corners Over 9.5","Korner 9.5 Alt":"Corners Under 9.5","Korner 10.5 Üst":"Corners Over 10.5","Korner 10.5 Alt":"Corners Under 10.5","Korner 11.5 Üst":"Corners Over 11.5","Korner 11.5 Alt":"Corners Under 11.5","Korner 12.5 Üst":"Corners Over 12.5","Korner 12.5 Alt":"Corners Under 12.5"};
 if(map[name])return map[name];
 let v=String(name);
 v=v.replace(/Korner\s*/gi,"Corners ");
 v=v.replace(/\bÜst\b/gi,"Over").replace(/\bAlt\b/gi,"Under");
 return v;
}
function translateReason(x){
 if(lang==="tr")return x;
 return String(x)
  .replace(" ligde "," is ").replace(". sıra", "th in the league")
  .replace(" puan", " pts").replace("İç/dış saha gücü:", "Home/away strength:")
  .replace(" evde ", " home ").replace(" deplasmanda ", " away ")
  .replace("2026/27 güncel örneklem:", "2026/27 current sample:")
  .replace(" maç.", " matches.").replace("Elo güç farkı:", "Elo strength difference:")
  .replace(" ortak rakip karşılaştırması modele dahil edildi.", " common-opponent comparisons included in the model.")
  .replace(" düşük ağırlıkla kullanıldı.", " used at low weight.")
  .replace("İsabetli şut profili:", "Shots-on-target profile:")
  .replace("Beklenen toplam korner:", "Expected total corners:");
}
function applyStatic(){
  if(navHome)navHome.textContent=lang==="tr"?"Ana Sayfa":"Home";
  if(navMatches)navMatches.textContent=lang==="tr"?"Maçlar":"Matches";
  if(navAnalysis)navAnalysis.textContent=lang==="tr"?"Analiz":"Analysis";
  if(navFavorites)navFavorites.textContent=lang==="tr"?"Favoriler":"Favorites";

 trBtn.classList.toggle("active",lang==="tr");enBtn.classList.toggle("active",lang==="en");
 brandSubtitle.textContent=t("subtitle");sumMatches.textContent=t("selected");sumAnalysis.textContent=t("open");threeDayStrong.textContent=t("three");sumDays.textContent=t("dayLine");footerNote.textContent=t("footer");creatorCredit.textContent=t("creator");
 document.documentElement.lang=lang
}
function setLang(v){lang=v;localStorage.setItem("matchedge_lang",v);closeOpenAnalysis();applyStatic();chips();renderDays();render();renderCoupon();}
function renderDays(){
  selectedDate=SERVER_TODAY;
  days.innerHTML='<button class="day active"><strong>'+t("t")+'</strong><span>'+new Intl.DateTimeFormat(lang==="tr"?"tr-TR":"en-GB",{day:"2-digit",month:"short"}).format(new Date(SERVER_TODAY+"T12:00:00Z"))+'</span></button>';
}
function chips(){
  const activeCodes=new Set((allFixtures||[]).filter(f=>f.localDate===selectedDate).map(f=>f.leagueCode));
  if(selected!=="ALL"&&!activeCodes.has(selected))selected="ALL";
  const arr=[{code:"ALL",name:t("all"),emoji:"🌍"},...meta.filter(x=>activeCodes.has(x.code))];
  leagues.innerHTML=arr.map(x=>'<button class="chip '+(selected===x.code?'active':'')+'" data-c="'+x.code+'">'+x.emoji+' '+esc(x.code==="ALL"?x.name:leagueName(x))+'</button>').join("");
  leagues.querySelectorAll("button").forEach(b=>b.onclick=()=>{selected=b.dataset.c;closeOpenAnalysis();chips();render();});
}
function filtered(){return allFixtures.filter(f=>{if(f.localDate!==selectedDate)return false;if(selected!=="ALL"&&f.leagueCode!==selected)return false;if(selectedDate>SERVER_TODAY&&statusFinished(f.status))return false;return true;});}
function closeOpenAnalysis(){
  if(openAnalysisId!==null){const old=document.getElementById("a"+openAnalysisId);if(old)old.innerHTML="";const btn=document.querySelector('.analyze[data-id="'+openAnalysisId+'"]');if(btn){btn.textContent=t("pro");btn.disabled=false;}}
  openAnalysisId=null;ac.textContent="0";
}

function scoreKnown(f){return f?.score?.home!==null&&f?.score?.home!==undefined&&f?.score?.away!==null&&f?.score?.away!==undefined}
function isLiveStatus(s){return["1H","HT","2H","ET","BT","P","INT","LIVE"].includes(String(s||"").toUpperCase())}
function resultBlock(f){
  if(!scoreKnown(f))return"";
  const ht=(f.score.htHome!==null&&f.score.htHome!==undefined&&f.score.htAway!==null&&f.score.htAway!==undefined)?'<span>'+t("halftime")+': '+f.score.htHome+' - '+f.score.htAway+'</span>':"";
  return '<div class="scoreReveal"><span>'+t("final")+'</span><strong>'+f.score.home+' - '+f.score.away+'</strong>'+ht+'</div>';
}
function toggleResult(id,b){
  const x=document.getElementById("r"+id);if(!x)return;
  const open=x.dataset.open==="1";
  x.dataset.open=open?"0":"1";
  x.innerHTML=open?"":resultBlock(allFixtures.find(f=>String(f.id)===String(id)));
  b.textContent=open?t("result"):t("hideResult");
}
let liveBaseline=new Map(),livePollTimer=null;
function showGoalToast(text){goalToast.textContent=text;goalToast.style.display="block";clearTimeout(showGoalToast._t);showGoalToast._t=setTimeout(()=>goalToast.style.display="none",7000)}
function liveKey(f){return [f.leagueCode,normClient(f.home?.name),normClient(f.away?.name)].join("|")}
function normClient(x){return String(x||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g," ").trim()}
function applyLiveFixtures(live){
  let changed=false;
  for(const lf of live){
    const k=liveKey(lf),newTotal=scoreKnown(lf)?Number(lf.score.home)+Number(lf.score.away):null,old=liveBaseline.get(k);
    if(old!==undefined&&newTotal!==null&&newTotal>old){
      showGoalToast("⚽ "+t("goalAlert")+" · "+lf.home.name+" "+lf.score.home+" - "+lf.score.away+" "+lf.away.name);
    }
    if(newTotal!==null)liveBaseline.set(k,newTotal);
    let idx=allFixtures.findIndex(f=>liveKey(f)===k);
    if(idx<0)idx=allFixtures.findIndex(f=>sameFixtureClient(f,lf));
    if(idx>=0){
      const oldF=allFixtures[idx],os=oldF.score||{},ns=lf.score||{};
      allFixtures[idx]={...oldF,...lf,home:{...oldF.home,...lf.home},away:{...oldF.away,...lf.away},
        score:{
          home:ns.home??os.home??null,away:ns.away??os.away??null,
          htHome:ns.htHome??os.htHome??null,htAway:ns.htAway??os.htAway??null
        }};
      changed=true;
    }
  }

  // CRITICAL: live score polling must never rebuild the whole fixtures DOM.
  // Re-rendering fixtures destroys the open analysis node and closes its toggles.
  // Update only scoreboard + visible fixture score cells in place.
  if(changed){
    renderScoreboard();
    patchFixtureScores();
  }
}

function patchFixtureScores(){
  for(const f of allFixtures||[]){
    const card=document.querySelector('.fixture[data-fixture-id="'+CSS.escape(String(f.id))+'"]');
    if(!card)continue;
    const center=card.querySelector(".time");
    if(center){
      if(isLiveStatus(f.status)&&scoreKnown(f)){
        center.innerHTML='<div class="liveScore">'+f.score.home+'-'+f.score.away+'</div><div class="liveTag">'+t("liveNow")+(f.elapsed?' · '+esc(f.elapsed)+"'":"")+'</div>';
      }else if(statusFinished(f.status)&&scoreKnown(f)){
        center.innerHTML='<div class="liveScore">'+f.score.home+'-'+f.score.away+'</div><div class="liveTag">'+t("finished")+'</div>';
      }
    }
    const result=document.getElementById("r"+f.id);
    if(result&&result.dataset.open==="1")result.innerHTML=resultBlock(f);
  }
}

function sameFixtureClient(a,b){
  if(!a||!b)return false;
  if(a.localDate&&b.localDate&&a.localDate!==b.localDate)return false;
  const ah=normClient(a.home?.name),aa=normClient(a.away?.name),bh=normClient(b.home?.name),ba=normClient(b.away?.name);
  const sim=(x,y)=>x===y||x.includes(y)||y.includes(x);
  return sim(ah,bh)&&sim(aa,ba);
}
async function pollLive(){
  try{
    const r=await fetch("/api/live?date="+encodeURIComponent(selectedDate),{cache:"no-store"});
    const j=await r.json();if(j.ok)applyLiveFixtures(j.fixtures||[]);
  }catch{}
}
function startLivePolling(){if(livePollTimer)clearInterval(livePollTimer);pollLive();livePollTimer=setInterval(pollLive,30000)}
if(window.scoreboard)scoreboard.addEventListener("toggle",()=>{if(scoreboard.open)loadMissingHalftimes()});
if(window.accuracyPanel)accuracyPanel.addEventListener("toggle",()=>{if(accuracyPanel.open)loadAccuracyPanel()});
let accuracyLoaded=false;

/* ---------------- Betting coupon (client-side only, stored in localStorage) ---------------- */
let couponItems=[];
try{couponItems=JSON.parse(localStorage.getItem("matchedge_coupon")||"[]")||[];}catch{couponItems=[];}
function saveCoupon(){try{localStorage.setItem("matchedge_coupon",JSON.stringify(couponItems));}catch{}}
function isInCoupon(id){return couponItems.some(x=>String(x.id)===String(id));}
function addToCoupon(id,home,away,league,market,odd,prob){
  couponItems=couponItems.filter(x=>String(x.id)!==String(id)); // one pick per match
  couponItems.push({id:String(id),home,away,league,market,odd:Number(odd),prob:Number(prob)});
  saveCoupon();renderCoupon();
  const btn=document.querySelector('[data-coupon-btn="'+id+'"]');
  if(btn){btn.textContent="✓ "+(lang==="tr"?"Kuponda":"In Coupon");btn.classList.add("inCoupon");}
}
function removeFromCoupon(id){
  couponItems=couponItems.filter(x=>String(x.id)!==String(id));
  saveCoupon();renderCoupon();
  const btn=document.querySelector('[data-coupon-btn="'+id+'"]');
  if(btn){btn.textContent="🎫 "+(lang==="tr"?"Kupona Ekle":"Add to Coupon");btn.classList.remove("inCoupon");}
}
function clearCoupon(){couponItems=[];saveCoupon();renderCoupon();}
function updateCouponReturn(){
  const stakeEl=document.getElementById("couponStake"),retEl=document.getElementById("couponReturn");
  if(!stakeEl||!retEl)return;
  const stake=Number(stakeEl.value);
  const label=lang==="tr"?"Olası Kazanç":"Potential Return";
  if(!stake||!couponItems.length){retEl.textContent=label+": —";return;}
  const combinedOdd=couponItems.reduce((p,x)=>p*(Number(x.odd)||1),1);
  retEl.textContent=label+": "+(stake*combinedOdd).toFixed(2);
}
function renderCoupon(){
  if(!window.couponBody)return;
  couponTitle.textContent="🎫 "+(lang==="tr"?"Kuponum":"My Coupon")+" ("+couponItems.length+")";
  if(!couponItems.length){
    couponBody.innerHTML='<div class="scoreEmpty">'+(lang==="tr"?'Henüz seçim yok. Bir maçı analiz edip "Kupona Ekle" ile buraya ekle.':'No picks yet. Analyze a match and tap "Add to Coupon".')+'</div>';
    return;
  }
  const combinedOdd=couponItems.reduce((p,x)=>p*(Number(x.odd)||1),1);
  const combinedProb=couponItems.reduce((p,x)=>p*((Number(x.prob)||0)/100),1)*100;
  let html='<div class="couponList">'+couponItems.map(x=>
    '<div class="couponRow"><div class="couponTeams"><b>'+esc(x.home)+' - '+esc(x.away)+'</b><small>'+esc(x.league)+'</small></div>'+
    '<div class="couponPick">'+esc(translateMarketName(x.market))+'<b>'+Number(x.odd).toFixed(2)+'</b></div>'+
    '<button class="couponRemove" onclick="removeFromCoupon(\''+x.id+'\')">✕</button></div>'
  ).join("")+'</div>';
  html+='<div class="couponSummary"><div><span>'+(lang==="tr"?"Toplam Oran":"Combined Odds")+'</span><b>'+combinedOdd.toFixed(2)+'</b></div>'+
    '<div><span>'+(lang==="tr"?"Model Olasılığı":"Model Probability")+'</span><b>'+combinedProb.toFixed(1)+'%</b></div></div>';
  html+='<div class="couponStakeRow"><input type="number" inputmode="decimal" id="couponStake" placeholder="'+(lang==="tr"?"Miktar":"Stake")+'" oninput="updateCouponReturn()"><span id="couponReturn">'+(lang==="tr"?"Olası Kazanç":"Potential Return")+': —</span></div>';
  html+='<small class="couponWarn">'+(lang==="tr"?"Kombine oranlarda birleşik risk çok hızlı artar; bu bir bahis tavsiyesi değildir.":"Combined risk compounds fast in accumulators; this is not betting advice.")+'</small>';
  html+='<button class="couponClear" onclick="clearCoupon()">'+(lang==="tr"?"Kuponu Temizle":"Clear Coupon")+'</button>';
  couponBody.innerHTML=html;
}
async function loadAccuracyPanel(){
  if(!window.accuracyBody)return;
  accuracyTitle.textContent="📊 "+t("modelAccuracy");
  accuracyBody.innerHTML='<div class="loader">'+t("loadingDetail")+'</div>';
  try{
    const r=await fetch("/api/model-accuracy",{cache:"no-store"});
    const j=await r.json();
    if(!j.ok)throw new Error(j.error||"error");
    accuracyLoaded=true;
    if(!j.totalSettled){
      accuracyBody.innerHTML='<div class="scoreEmpty">'+t("accuracyEmpty")+'</div>';
      return;
    }
    const acc=j.accuracyPct!=null?j.accuracyPct+"%":"—";
    const brier=j.brierScore!=null?j.brierScore:"—";
    let html='<div class="accSummary">'+
      '<div class="accStat"><strong>'+j.totalSettled+'</strong><span>'+t("accSettled")+'</span></div>'+
      '<div class="accStat"><strong>'+acc+'</strong><span>'+t("accRate")+'</span></div>'+
      '<div class="accStat"><strong>'+brier+'</strong><span>'+t("accBrier")+'</span></div>'+
      '</div><small class="accHint">'+t("accuracyHint")+'</small>';
    if(j.recent&&j.recent.length){
      html+='<div class="accList">'+j.recent.map(x=>{
        const mark=x.correct?'<span class="accOk">✓</span>':'<span class="accBad">✗</span>';
        return '<div class="accRow">'+mark+'<span class="accTeams">'+esc(x.home)+' '+x.actualHome+'-'+x.actualAway+' '+esc(x.away)+'</span><span class="accPick">'+esc(x.predicted)+' · '+x.predictedProb+'%</span></div>';
      }).join("")+'</div>';
    }
    accuracyBody.innerHTML=html;
  }catch(e){
    accuracyBody.innerHTML='<div class="scoreEmpty">'+t("noDetailData")+'</div>';
  }
}

function liveMinuteValue(f){
  const e=f?.elapsed;
  if(typeof e==="number"&&Number.isFinite(e))return e;
  const m=String(e||"").match(/\d+/);return m?Number(m[0]):0;
}
function fixtureStateRank(f){
  if(isLiveStatus(f.status))return 0;
  const oldEnough=Number(f.timestamp||0)>0&&Number(f.timestamp)<Math.floor(Date.now()/1000)-7200;
  if(statusFinished(f.status)||(scoreKnown(f)&&oldEnough))return 2;
  return 1;
}
function sortScoreFixtures(a,b){
  const ra=fixtureStateRank(a),rb=fixtureStateRank(b);
  if(ra!==rb)return ra-rb;
  if(ra===0){
    const ma=liveMinuteValue(a),mb=liveMinuteValue(b);
    if(ma!==mb)return mb-ma; // live: later minute first
  }
  const ta=Number(a.timestamp||new Date(a.date||0).getTime()/1000||0);
  const tb=Number(b.timestamp||new Date(b.date||0).getTime()/1000||0);
  if(ra===1&&ta!==tb)return ta-tb; // upcoming: nearest kickoff first
  if(ra===2&&ta!==tb)return tb-ta; // finished: most recent first
  return String(a.home?.name||"").localeCompare(String(b.home?.name||""),lang==="tr"?"tr":"en");
}

let halftimeLoading=false;
async function loadMissingHalftimes(){
  if(halftimeLoading)return;
  const missing=(allFixtures||[]).filter(f=>f.localDate===selectedDate&&(statusFinished(f.status)||isLiveStatus(f.status))&&(f?.score?.htHome==null||f?.score?.htAway==null));
  if(!missing.length)return;
  halftimeLoading=true;
  try{
    await Promise.all(missing.slice(0,12).map(async f=>{
      try{
        const r=await fetch("/api/halftime/"+encodeURIComponent(f.id),{cache:"no-store"});
        const j=await r.json();
        if(j.ok&&j.score){
          f.score={
            home:j.score.home??f.score?.home??null,away:j.score.away??f.score?.away??null,
            htHome:j.score.htHome??f.score?.htHome??null,htAway:j.score.htAway??f.score?.htAway??null
          };
          if(j.status)f.status=j.status;
          renderScoreboard();
        }
      }catch{}
    }));
  }finally{halftimeLoading=false}
}
function renderScoreboard(){
  if(!window.scoreboardBody)return;
  scoreboardTitle.textContent="⚽ Score Board";
  const scored=(allFixtures||[]).filter(f=>f.localDate===selectedDate);
  if(!scored.length){scoreboardBody.innerHTML='<div class="scoreEmpty">'+t("noScores")+'</div>';return;}

  const by={};
  for(const f of scored){
    const country=(f.emoji||"")+" "+(f.country||"");
    const league=(f.league||f.leagueCode||"");
    const k=country+"|||"+league;
    (by[k]||(by[k]=[])).push(f);
  }

  const groups=Object.entries(by).map(([k,arr])=>{
    const [country,league]=k.split("|||");
    arr.sort(sortScoreFixtures);
    const liveCount=arr.filter(f=>isLiveStatus(f.status)).length;
    const nextLiveMinute=liveCount?Math.max(...arr.filter(f=>isLiveStatus(f.status)).map(liveMinuteValue)): -1;
    const nextKick=Math.min(...arr.filter(f=>fixtureStateRank(f)===1).map(f=>Number(f.timestamp||9e15)),9e15);
    return {country,league,arr,liveCount,nextLiveMinute,nextKick};
  });

  groups.sort((a,b)=>{
    if((a.liveCount>0)!==(b.liveCount>0))return a.liveCount>0?-1:1; // leagues with live matches first
    if(a.liveCount&&b.liveCount&&a.nextLiveMinute!==b.nextLiveMinute)return b.nextLiveMinute-a.nextLiveMinute;
    if(a.nextKick!==b.nextKick)return a.nextKick-b.nextKick;
    const c=a.country.localeCompare(b.country,lang==="tr"?"tr":"en");if(c)return c;
    return a.league.localeCompare(b.league,lang==="tr"?"tr":"en");
  });

  scoreboardBody.innerHTML=groups.map(g=>{
    const head=(g.country?esc(g.country)+" · ":"")+esc(g.league);
    return '<div class="scoreLeague">'+head+'</div>'+g.arr.map(f=>{
      const live=isLiveStatus(f.status),finished=statusFinished(f.status)||(!live&&scoreKnown(f)&&Number(f.timestamp||0)<Math.floor(Date.now()/1000)-7200);
      const startedNoScore=!live&&!finished&&!scoreKnown(f)&&Number(f.timestamp||0)>0&&Number(f.timestamp)<Math.floor(Date.now()/1000)-600;
      const st=live?t("liveNow")+(f.elapsed?' · '+esc(f.elapsed)+"'":""):finished?t("finished"):t("notStarted");
      const sc=live||finished?(scoreKnown(f)?f.score.home+' - '+f.score.away:'–'):'– : –';
      const htKnown=f?.score?.htHome!==null&&f?.score?.htHome!==undefined&&f?.score?.htAway!==null&&f?.score?.htAway!==undefined;
      const detail=(live||finished)&&htKnown?'<div class="scoreDetail"><span class="scorePill">'+t("htShort")+' '+f.score.htHome+'-'+f.score.htAway+'</span></div>':"";
      return '<div class="scoreRow"><div>'+esc(f.displayTime||"")+'</div><div class="sh">'+esc(f.home.name)+'</div><div><div class="scoreNum">'+sc+'</div><div class="scoreStatus">'+st+'</div>'+detail+'</div><div class="sa">'+esc(f.away.name)+'</div></div>';
    }).join("");
  }).join("");
}
function render(){
  renderScoreboard();
  if(window.scoreboard&&scoreboard.open)setTimeout(loadMissingHalftimes,0);
  const base=filtered().slice().sort(sortScoreFixtures);
  let a=base;
  if(currentView==="favorites")a=base.filter(f=>isFavorite(f.id));
  else if(currentView==="analysis")a=base.filter(f=>analyzedIds.has(String(f.id)));

  mc.textContent=base.length;
  fc.textContent=a.length+" "+t("fixture");
  const dd=new Date(selectedDate+"T12:00:00Z");
  if(currentView==="favorites")dayHeading.textContent=lang==="tr"?"Favori Maçlar":"Favorite Matches";
  else if(currentView==="analysis")dayHeading.textContent=lang==="tr"?"Analiz Ettiklerim":"Analyzed Matches";
  else dayHeading.textContent=dd.toLocaleDateString(locale(),{weekday:"long",day:"numeric",month:"long",timeZone:"UTC"})+(lang==="tr"?" maçları":" matches");
  // Build country/league groups ONLY from matches on the selected day.
  // Do not pre-populate configured leagues with 0 matches.
  const countries={};
  a.forEach(f=>{
    const country=f.country||"Diğer";
    if(!countries[country])countries[country]={emoji:f.emoji||"⚽",leagues:{}};
    if(!countries[country].leagues[f.leagueCode]){
      const lm=meta.find(x=>x.code===f.leagueCode)||{code:f.leagueCode,name:f.league,emoji:f.emoji,country:f.country};
      countries[country].leagues[f.leagueCode]={meta:lm,matches:[]};
    }
    countries[country].leagues[f.leagueCode].matches.push(f);
  });
  const matchHtml=f=>{
    const live=isLiveStatus(f.status);
    const center=live&&scoreKnown(f)?'<div class="time"><div class="liveScore">'+f.score.home+'-'+f.score.away+'</div><div class="liveTag">'+t("liveNow")+(f.elapsed?' · '+esc(f.elapsed)+"'":"")+'</div></div>':'<div class="time">'+(statusFinished(f.status)?'FT':'VS')+'</div>';
    const resultBtn=!live&&scoreKnown(f)&&statusFinished(f.status)?'<button class="scoreBtn" onclick="toggleResult('+JSON.stringify(f.id)+',this)">'+t("result")+'</button><div id="r'+f.id+'" data-open="0"></div>':"";
    return '<div class="fixture" data-fixture-id="'+esc(String(f.id))+'"><div class="fxhead"><span>'+esc(f.round||f.status||"")+'</span><span>'+esc(f.displayTime||"")+'</span></div><div class="teams"><div class="team">'+(f.home.logo?'<img src="'+esc(f.home.logo)+'" alt="">':'')+esc(f.home.name)+'</div>'+center+'<div class="team">'+(f.away.logo?'<img src="'+esc(f.away.logo)+'" alt="">':'')+esc(f.away.name)+'</div></div>'+resultBtn+
      '<div class="favoriteRow"><button class="favBtn '+(isFavorite(f.id)?'active':'')+'" data-fav-id="'+esc(String(f.id))+'" aria-label="'+(lang==="tr"?"Favoriye ekle/çıkar":"Add/remove favorite")+'">'+(isFavorite(f.id)?'★':'☆')+'</button></div>'+
      '<button class="analyze" data-id="'+f.id+'" onclick="analyze('+f.id+',this)">'+t("pro")+'</button><div id="a'+f.id+'"></div></div>';
  };
  const countryEntries=Object.entries(countries)
    .map(([country,c])=>{const count=Object.values(c.leagues).reduce((n,g)=>n+g.matches.length,0);return[country,c,count];})
    .filter(([,c,count])=>count>0&&Object.values(c.leagues).some(g=>g.matches.length>0))
    .sort((a,b)=>b[2]-a[2]||countryName(a[0]).localeCompare(countryName(b[0]),locale()));
  if(!countryEntries.length){
    if(currentView==="favorites"){
      fixtures.innerHTML='<div class="navEmpty"><strong>'+(lang==="tr"?"Henüz favori maç seçmedin":"No favorite matches yet")+'</strong>'+(lang==="tr"?"Maç kartındaki ☆ butonuna basarak favoriye ekleyebilirsin.":"Tap ☆ on a match card to add it here.")+'</div>';
    }else if(currentView==="analysis"){
      fixtures.innerHTML='<div class="navEmpty"><strong>'+(lang==="tr"?"Bugün henüz analiz açmadın":"No analyses opened today")+'</strong>'+(lang==="tr"?"Bir maçta PRO ANALİZ açtığında burada görünecek.":"Open PRO ANALYSIS on a match and it will appear here.")+'</div>';
    }else{
      fixtures.innerHTML='<div class="empty">'+t("noGame")+'</div>';
    }
  }else{
    fixtures.innerHTML=countryEntries.map(([country,c,count])=>{
      const groups=Object.values(c.leagues)
        .filter(g=>g.matches.length>0)
        .sort((a,b)=>b.matches.length-a.matches.length||leagueName(a.meta).localeCompare(leagueName(b.meta),locale()));
      const leaguesHtml=groups.map(g=>{
        const n=g.matches.length;
        return'<details class="leagueFold"><summary>'+esc(leagueName(g.meta))+' <span>'+n+' '+(n===1?t("match"):t("matches"))+'</span></summary><div class="leagueMatches">'+g.matches.map(matchHtml).join("")+'</div></details>';
      }).join("");
      return'<details class="countryGroup"><summary class="countryTitle"><span>'+esc(c.emoji+" "+countryName(country))+'</span><span>'+count+' '+(count===1?t("match"):t("matches"))+'</span></summary><div class="countryBody">'+leaguesHtml+'</div></details>';
    }).join("");
  }
  fixtures.querySelectorAll(".favBtn").forEach(btn=>{
    btn.onclick=(e)=>{e.preventDefault();e.stopPropagation();toggleFavoriteById(btn.dataset.favId);};
  });
}

async function loadThreeDays(){const seq=++loadSeq;closeOpenAnalysis();mc.textContent="—";fc.textContent="";fixtures.innerHTML='<div class="loader">'+t("fixturesLoading")+'</div>';const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),25000);try{const r=await fetch("/api/three-days?date="+encodeURIComponent(SERVER_TODAY),{cache:"no-store",signal:ctrl.signal}),j=await r.json();if(!j.ok)throw Error(j.error||t("fixtureFail"));if(seq!==loadSeq)return;allFixtures=j.fixtures||[];renderDays();chips();render();}catch(e){if(seq!==loadSeq)return;allFixtures=[];mc.textContent="—";const msg=e.name==="AbortError"?(lang==="tr"?"İstek zaman aşımına uğradı (sunucu çok yavaş yanıt verdi)":"Request timed out (server responded too slowly)"):e.message;fixtures.innerHTML='<div class="error">'+t("fixtureFail")+': '+esc(msg)+'<br><br><button class="analyze" onclick="loadThreeDays()">'+t("retry")+'</button></div>';}finally{clearTimeout(timer);}}

function marketProb(markets,name){
  const x=(markets||[]).find(v=>v.name===name);
  return x?Number(x.analysisProbability??x.probability):null;
}
function resultProbabilityCard(m,fx){
  const h=marketProb(m.markets,"1"),d=marketProb(m.markets,"X"),a=marketProb(m.markets,"2");
  const item=(cls,label,p)=>{
    const val=Number.isFinite(p)?p:null;
    return '<div class="resultItem '+cls+'"><b>'+esc(label)+'</b><strong>'+(val==null?"—":val+"%")+'</strong><div class="resultTrack"><i style="width:'+(val==null?0:Math.max(0,Math.min(100,val)))+'%"></i></div></div>';
  };
  return '<div class="resultRead"><div class="resultTitle">'+t("resultProb")+'</div><div class="resultGrid">'+
    item("home",fx.home.name,h)+item("draw",t("draw"),d)+item("away",fx.away.name,a)+
  '</div></div>';
}
function visualReadCard(m,fx){
  const o25=marketProb(m.markets,"2.5 Üst");
  const btts=marketProb(m.markets,"KG Var");
  const c85=marketProb(m.markets,"Korner 8.5 Üst");
  const fh=marketProb(m.markets,"Daha Çok Gol: İlk Yarı");
  const sh=marketProb(m.markets,"Daha Çok Gol: İkinci Yarı");
  const eq=marketProb(m.markets,"Yarılar Eşit");
  const fhGoal=marketProb(m.markets,"İY 0.5 Üst");
  const fhHomeGoal=marketProb(m.markets,"İY Ev Gol");
  const fhAwayGoal=marketProb(m.markets,"İY Dep Gol");
  const homeName=fx?.home?.name||"Ev",awayName=fx?.away?.name||"Dep";
  const fhTeamLabel=(Number.isFinite(fhHomeGoal)&&Number.isFinite(fhAwayGoal))
    ? (fhHomeGoal>=fhAwayGoal?homeName:awayName)+' ('+ (fhHomeGoal>=fhAwayGoal?fhHomeGoal:fhAwayGoal) +'%)'
    : "";
  const halves=[
    {label:t("firstHalf"),p:fh},
    {label:t("secondHalf"),p:sh},
    {label:t("equalHalves"),p:eq}
  ].filter(x=>Number.isFinite(x.p)).sort((a,b)=>b.p-a.p);
  const bestHalf=halves[0]||{label:"—",p:null};
  const metric=(label,p,sub="")=>{
    const val=Number.isFinite(p)?p:null;
    return '<div class="focusMetric"><b>'+esc(label)+'</b><strong>'+(val==null?"—":val+"%")+'</strong>'+(sub?'<small>'+esc(sub)+'</small>':'')+
      '<div class="focusBar"><i style="width:'+(val==null?0:Math.max(0,Math.min(100,val)))+'%"></i></div></div>';
  };
  return '<div class="focusRead"><div class="focusTitle">'+t("read")+'</div><div class="focusGrid">'+
    metric(t("over25"),o25)+
    metric(t("bttsYes"),btts)+
    metric(t("corner85"),c85)+
    metric(t("highestHalf"),bestHalf.p,bestHalf.label)+
    metric(t("firstHalfGoal"),fhGoal,fhTeamLabel)+
    '</div></div>';
}

function toggleCouponFromButton(btn){
  const id=btn.dataset.couponBtn;
  if(isInCoupon(id)){removeFromCoupon(id);return;}
  addToCoupon(id,btn.dataset.cHome,btn.dataset.cAway,btn.dataset.cLeague,btn.dataset.cMarket,btn.dataset.cOdd,btn.dataset.cProb);
}
function strongestSignalCard(m,fx,id){
  const x=(!m.noBet&&(m.recommendations||[]).length)?m.recommendations[0]:null;
  const signal=x
    ? '<span>'+t("strongSignal")+'</span><strong>'+esc(translateMarketName(x.name))+
      (x.decision==="BET"?' · BET':x.decision==="PLAYABLE"?' · OYNANABİLİR':x.decision==="MODEL LEAN"?' · MODEL SİNYALİ':'')+
      '</strong><small class="signalProb">'+t("signalProbability")+': '+(x.analysisProbability??x.probability)+'%'+
      (x.marketOdd?' · Odd '+Number(x.marketOdd).toFixed(2):'')+
      (x.expectedValue!=null?' · EV '+(Number(x.expectedValue)>=0?'+':'')+x.expectedValue+'%':'')+
      (x.marketProbability!=null?' · Piyasa '+x.marketProbability+'%':'')+'</small>'
    : '<span>'+t("strongSignal")+'</span><strong>NO BET</strong><small>'+t("noBet")+'</small>';

  const br=m.betRecommendation||{};
  const kellyHtml=(br.decision==="BET"&&br.kelly)
    ? '<div class="kellyBox"><div class="kellyTitle">'+t("kellyStake")+'</div>'+
      '<div class="kellyRow"><span>'+t("kellyQuarter")+'</span><b>%'+br.kelly.quarter+'</b></div>'+
      '<div class="kellyRow kellyRec"><span>'+t("kellyHalf")+'</span><b>%'+br.kelly.half+'</b></div>'+
      '<div class="kellyRow"><span>'+t("kellyFull")+'</span><b>%'+br.kelly.full+'</b></div>'+
      '<small>'+t("kellyHint")+'</small></div>'
    : '';
  const inCoupon=id!=null&&isInCoupon(id);
  const couponBtnHtml=(br.decision==="BET"&&id!=null&&fx)
    ? '<button class="couponAddBtn'+(inCoupon?' inCoupon':'')+'" data-coupon-btn="'+esc(String(id))+'" '+
      'data-c-home="'+esc(fx.home?.name||"")+'" data-c-away="'+esc(fx.away?.name||"")+'" data-c-league="'+esc(fx.league||"")+'" '+
      'data-c-market="'+esc(br.name||"")+'" data-c-odd="'+esc(String(br.marketOdd||""))+'" data-c-prob="'+esc(String(br.analysisProbability??br.probability??""))+'" '+
      'onclick="toggleCouponFromButton(this)">'+
      (inCoupon?'✓ '+(lang==="tr"?"Kuponda":"In Coupon"):'🎫 '+(lang==="tr"?"Kupona Ekle":"Add to Coupon"))+'</button>'
    : '';
  const valueHtml=br.decision==="BET"
    ? '<div class="market"><b>'+t("betDecision")+' · '+esc(translateMarketName(br.name))+'</b><span class="prob">BET</span></div>'+
      '<div class="miniGrid"><span>'+t("marketOdd")+': <b>'+Number(br.marketOdd).toFixed(2)+'</b></span><span>'+t("fairOddLabel")+': <b>'+Number(br.fairOdd).toFixed(2)+'</b></span><span>Model: <b>'+(br.modelProbability??br.probability)+'%</b></span><span>Final: <b>'+(br.analysisProbability??br.probability)+'%</b></span><span>'+t("edgeLabel")+': <b>+'+br.edge+'%</b></span><span>'+t("evLabel")+': <b>+'+br.expectedValue+'%</b></span>'+
      (br.openingOdd?'<span>'+t("openingOdd")+': <b>'+Number(br.openingOdd).toFixed(2)+'</b></span>':'')+
      (br.impliedMovePts!=null?'<span>'+t("marketSupport")+': <b>'+(br.impliedMovePts>0?'+':'')+br.impliedMovePts+' puan</b></span>':'')+
      '</div>'+(br.bookmaker?'<small>'+esc(br.bookmaker)+'</small>':'')+couponBtnHtml+kellyHtml
    : '<div class="market"><b>'+t("betDecision")+'</b><span class="prob">NO BET</span></div><small>'+t("oddsUnavailable")+'</small>';
  const chartHtml=oddsSparkline(m.oddsHistorySeries);
  const bmHtml=bookmakerCompareHtml(m.bookmakerComparison);
  const marketToggle='<details class="toggleBox signalMarketToggle"><summary>'+t("marketOddsAnalysis")+'</summary><div class="toggleBody">'+
    valueHtml+chartHtml+bmHtml+'<div class="section">'+t("strong")+'</div>'+marketRows(m.recommendations||[])+
    '<div class="section">'+t("allMarkets")+'</div>'+allMarketsBlock(m.markets||[],m)+
    '</div></details>';

  return '<div class="summaryCard signalCard">'+signal+marketToggle+'</div>';
}
function oddsSparkline(series){
  if(!series||series.length<2)return '';
  const w=280,h=64,pad=6;
  const vals=series.map(x=>x.odd);
  const min=Math.min.apply(null,vals),max=Math.max.apply(null,vals);
  const span=(max-min)||0.1;
  const stepX=(w-pad*2)/(series.length-1);
  const pts=series.map((x,i)=>{
    const px=pad+i*stepX;
    const py=h-pad-((x.odd-min)/span)*(h-pad*2);
    return px.toFixed(1)+","+py.toFixed(1);
  });
  const rising=series[series.length-1].odd>=series[0].odd;
  const color=rising?"#19dab2":"#ff8d88";
  const poly=pts.join(" ");
  const areaPts=pad.toFixed(1)+","+(h-pad)+" "+poly+" "+(w-pad).toFixed(1)+","+(h-pad);
  return '<div class="section">'+t("oddsMoveChart")+'</div><div class="oddsChart"><svg viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none">'+
    '<polygon points="'+areaPts+'" fill="'+color+'22"></polygon>'+
    '<polyline points="'+poly+'" fill="none" stroke="'+color+'" stroke-width="2"></polyline>'+
    '</svg><div class="oddsChartLabels"><span>'+series[0].odd.toFixed(2)+'</span><span>'+series[series.length-1].odd.toFixed(2)+'</span></div></div>';
}
function bookmakerCompareHtml(list){
  if(!list||list.length<2)return '';
  const max=Math.max.apply(null,list.map(x=>x.odd));
  const rows=list.map(x=>'<div class="bmRow'+(x.odd===max?' bmBest':'')+'"><span>'+esc(x.bookmaker)+'</span><b>'+x.odd.toFixed(2)+'</b></div>').join("");
  return '<div class="section">'+t("bookmakerCompare")+'</div><div class="bmTable">'+rows+'</div>';
}
function marketRows(xs){return(xs||[]).map(x=>{
  const p=x.analysisProbability??x.probability;
  const ctx=x.marketProbability!=null?' <small style="opacity:.65">Mkt '+x.marketProbability+'%</small>':'';
  return '<div class="market"><b>'+esc(translateMarketName(x.name))+ctx+'</b><span class="prob">'+p+'%</span></div>';
}).join("")}
function splitMarkets(xs){const a=xs||[];return{main:a.filter(x=>x.group!=="Korner"),corners:a.filter(x=>x.group==="Korner")}}
function allMarketsBlock(xs,m){
  const z=splitMarkets(xs),cp=m?.cornerProfile||null;
  let cornerHtml="";
  if(z.corners.length){
    let detail="";
    if(cp){
      const hn=esc(m?._homeName||""),an=esc(m?._awayName||"");
      detail='<div class="cornerExpected">'+t("cornerExpectedTeams")+': '+(cp.expectedHome??"—")+' – '+(cp.expectedAway??"—")+' · '+t("corners")+': '+(cp.expectedTotal??"—")+'</div>'+
      '<div class="cornerStats"><div class="cornerTeam"><b>'+hn+'</b><span>'+t("cornerFor")+': '+(cp.home?.forAvg??"—")+'</span><span>'+t("cornerAgainst")+': '+(cp.home?.againstAvg??"—")+'</span><span>'+t("cornerTotalAvg")+': '+(cp.home?.totalAvg??"—")+'</span><span>'+t("cornerSample")+': '+(cp.home?.matches??0)+'</span></div>'+
      '<div class="cornerTeam"><b>'+an+'</b><span>'+t("cornerFor")+': '+(cp.away?.forAvg??"—")+'</span><span>'+t("cornerAgainst")+': '+(cp.away?.againstAvg??"—")+'</span><span>'+t("cornerTotalAvg")+': '+(cp.away?.totalAvg??"—")+'</span><span>'+t("cornerSample")+': '+(cp.away?.matches??0)+'</span></div></div>';
      if(cp.lines?.length)detail+=cp.lines.map(x=>'<div class="cornerLine"><b>'+x.line+'</b><span class="ov">'+t("cornerOver")+' '+x.over+'%</span><span class="un">'+t("cornerUnder")+' '+x.under+'%</span></div>').join("");
      detail+='<div class="cornerHint">'+t("cornerMethod")+'</div>';
    }else detail=marketRows(z.corners);
    cornerHtml='<details class="cornerBox"><summary>'+t("cornerMarkets")+'</summary><div class="cornerBody">'+detail+'</div></details>';
  }
  return marketRows(z.main)+cornerHtml;
}
function expectedValuesOpen(m,fx,s){
  const pair=(label,h,a)=>'<div class="expectedVal"><span>'+esc(label)+'</span><b><em>'+esc(fx.home.name)+'</em> '+(h??"—")+' · '+esc(fx.away.name)+' '+(a??"—")+'</b></div>';
  return '<details class="expectedOpen expectedToggle">'+
    '<summary class="expectedTop">'+
      '<div><span>'+t("totalExpectedGoals")+'</span><strong>'+m.expectedGoals.total+'</strong></div>'+
      '<div class="expectedScoreWrap">'+
        '<div class="expectedSplit">'+m.expectedGoals.home+' – '+m.expectedGoals.away+'</div>'+
        '<div class="expectedScoreBadge"><span>'+t("likelyScore")+'</span><b>'+m.likelyScore+'</b><span>'+(m.likelyScoreProbability!=null?'%'+m.likelyScoreProbability:'')+'</span></div>'+
      '</div>'+
    '</summary>'+
    '<div class="expectedToggleBody">'+
      '<div class="expectedScoreNote"><span>'+t("likelyScore")+(m.scoreAlternatives?.length?' · '+(lang==="tr"?"Alternatif: ":"Alternatives: ")+m.scoreAlternatives.map(x=>x.score+' (%'+x.probability+')').join(' · '):'')+'</span><strong>'+m.likelyScore+(m.likelyScoreProbability!=null?' · %'+m.likelyScoreProbability:'')+'</strong></div>'+
      '<div class="expectedValuesGrid">'+
        pair(lang==="tr"?"Beklenen Gol (xG)":"Expected Goals (xG)",m.expectedGoals.home,m.expectedGoals.away)+
        pair(lang==="tr"?"Şut":"Shots",s.homeShots,s.awayShots)+
        pair(lang==="tr"?"İsabetli Şut":"Shots on Target",s.homeSOT,s.awaySOT)+
        pair(lang==="tr"?"Beklenen Korner":"Expected Corners",s.expectedHomeCorners,s.expectedAwayCorners)+
      '</div>'+
    '</div>'+
  '</details>';
}
function otherAnalysisDeck(m,fx,s,st,teamStats){
  const hm=Number(s.homeMatches||s.homeSample||0),am=Number(s.awayMatches||s.awaySample||0);
  const formBody='<div class="tilePair"><div class="tileStat"><span>'+esc(fx.home.name)+'</span><b>'+t("form")+': '+(s.homeFormPPG??"—")+'</b></div><div class="tileStat"><span>'+esc(fx.away.name)+'</span><b>'+t("form")+': '+(s.awayFormPPG??"—")+'</b></div></div>';
  const compareBody='<div class="tilePair"><div class="tileStat"><span>'+esc(fx.home.name)+'</span><b>SOT '+(s.homeSOT??"—")+'</b></div><div class="tileStat"><span>'+esc(fx.away.name)+'</span><b>SOT '+(s.awaySOT??"—")+'</b></div></div>';
  const h2h=(m.reasons||[]).filter(x=>/h2h|head|kafa|karşılaş/i.test(String(x))).map(x=>'<div class="reason">• '+esc(translateReason(x))+'</div>').join("")||'<div class="reason">No additional H2H edge.</div>';
  const detailed=allMarketsBlock(m.markets,m);
  const prediction='<div class="tilePair"><div class="tileStat"><span>'+t("likelyScore")+'</span><b>'+m.likelyScore+'</b></div><div class="tileStat"><span>'+t("quality")+'</span><b>'+m.dataQuality+'/100</b></div></div>';
  const tile=(icon,title,sub,body)=>'<details class="analysisTile"><summary><div class="tileIcon">'+icon+'</div><div class="tileCopy"><b>'+esc(title)+'</b><span>'+esc(sub)+'</span></div></summary><div class="tileBody">'+body+'</div></details>';
  return '<div class="analysisDeck">'+
    tile("▥",lang==="tr"?"Takım İstatistikleri":"Team Statistics",lang==="tr"?"Genel performans, form, iç saha / dış saha":"Overall performance, form, home / away",teamStats)+
    tile("⌁",lang==="tr"?"Son 5 Maç Performansı":"Last 5 Match Performance",lang==="tr"?"Takımların güncel form görünümü":"Current team form view",formBody)+
    tile("⚖",lang==="tr"?"Karşılaştırmalı Analiz":"Comparative Analysis",lang==="tr"?"Takım karşılaştırmaları ve ortalamalar":"Team comparisons and averages",compareBody)+
    tile("◎",lang==="tr"?"H2H (Kafa Kafaya)":"H2H (Head to Head)",lang==="tr"?"İki takımın karşılaşma sinyalleri":"Head-to-head signals",h2h)+
    tile("☷",lang==="tr"?"Detaylı İstatistikler":"Detailed Statistics",lang==="tr"?"Maçın tüm detaylı olasılıkları":"All detailed match probabilities",detailed)+
    tile("◎",lang==="tr"?"Tahmin & Skor Tahmini":"Prediction & Score",lang==="tr"?"Skor tahmini ve olasılık özeti":"Score prediction and probability summary",prediction)+
  '</div>';
}
async function analyze(id,b){
 const box=document.getElementById("a"+id);if(openAnalysisId===id){closeOpenAnalysis();return;}if(openAnalysisId!==null&&openAnalysisId!==id)closeOpenAnalysis();openAnalysisId=id;ac.textContent="1";b.disabled=true;b.textContent=t("calc");box.innerHTML='<div class="loader">'+t("loading")+'</div>';
 try{
  const r=await fetch("/api/analyze/"+id+"?date="+encodeURIComponent(selectedDate)),j=await r.json();
  if(!j.ok){
    if(j.error==="DATA PREPARING")throw Error(lang==="tr"?"Veri hazırlanıyor. Birkaç saniye sonra tekrar açın.":"Data is being prepared. Try again in a few seconds.");
    throw Error(j.error||"No data");
  }
  const m=j.model,s=m.stats||{},st=m.standings||{},fx=j.fixture;m._homeName=fx.home.name;m._awayName=fx.away.name;
  analyzedIds.add(String(id));saveStringSet("matchedge_analyzed_"+SERVER_TODAY,analyzedIds);
  const teamStats='<div class="teamstate"><div class="state"><b>'+esc(fx.home.name)+'</b><span>'+t("league")+': '+(st.home?.pos??"—")+'. '+t("position")+' · '+(st.home?.pts??"—")+' '+t("points")+'</span><span>'+t("homePos")+': '+(st.home?.homePos??"—")+' · '+t("homePPM")+': '+(st.home?.homePPG?.toFixed?.(2)??"—")+'</span><span>'+t("form")+': '+(s.homeFormPPG??"—")+' · SOT: '+(s.homeSOT??"—")+'</span></div><div class="state"><b>'+esc(fx.away.name)+'</b><span>'+t("league")+': '+(st.away?.pos??"—")+'. '+t("position")+' · '+(st.away?.pts??"—")+' '+t("points")+'</span><span>'+t("awayPos")+': '+(st.away?.awayPos??"—")+' · '+t("awayPPM")+': '+(st.away?.awayPPG?.toFixed?.(2)??"—")+'</span><span>'+t("form")+': '+(s.awayFormPPG??"—")+' · SOT: '+(s.awaySOT??"—")+'</span></div></div>';
  const other='<details class="otherAnalysis"><summary>'+t("otherAnalysis")+'</summary><div class="otherBody">'+otherAnalysisDeck(m,fx,s,st,teamStats)+'</div></details>';
  const liveBanner=m.live?.active?'<div class="liveAnalysisBanner"><b>● '+(lang==="tr"?"CANLI ANALİZ":"LIVE ANALYSIS")+'</b><span>'+m.live.minute+"'. · "+m.live.currentScore+' · '+(lang==="tr"?"Kalan gol beklentisi ":"Remaining xG ")+m.live.remainingExpectedGoals+'</span></div>':"";
  box.innerHTML='<div class="analysis">'+liveBanner+resultProbabilityCard(m,fx)+visualReadCard(m,fx)+
    '<div class="focusSummary">'+
      expectedValuesOpen(m,fx,s)+
      '<div class="summaryCard"><span>'+t("quality")+'</span><strong>'+m.dataQuality+'/100</strong><small>'+(m.sampleWarning?esc(m.sampleWarning):"")+'</small></div>'+
      strongestSignalCard(m,fx,id)+
    '</div>'+other+'</div>';
  b.textContent=t("closeAnalysis");
 }catch(e){box.innerHTML='<div class="error">'+esc(e.message||"No data")+'</div>';b.textContent=t("close");}finally{b.disabled=false}
}
async function boot(){
  try{
    lang=localStorage.getItem("matchedge_lang")==="en"?"en":"tr";
    applyStatic();
    renderCoupon();
    renderDays();
    await loadThreeDays();
    startLivePolling();
  }catch(e){
    console.error("MatchEdge boot error",e);
    if(fixtures)fixtures.innerHTML='<div class="error">Uygulama başlatılamadı: '+esc(e.message||String(e))+'<br><br><button class="analyze" onclick="location.reload()">TEKRAR DENE</button></div>';
  }
}
boot();
</script></body></html>`;

app.get("/",(req,res)=>res.status(200).type("html").set("Cache-Control","no-store, no-cache, must-revalidate").send(HTML));
app.use((req,res)=>res.status(404).json({ok:false,error:"Not found"}));
app.listen(PORT,"0.0.0.0",()=>console.log(`MatchEdge Premium V7.19.0 running on port ${PORT}`));
