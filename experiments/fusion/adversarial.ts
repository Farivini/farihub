import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFileSync} from 'node:fs';
import {ic} from '../../tests/ironcalc-node.ts';
const require=createRequire(import.meta.url);const gp=require('./workspace/gridpath-package/engine/gridpath_engine.js');
const results:any[]=[];
function run(name:string,fn:()=>any){try{results.push({name,ok:true,...fn()});console.log('completed:',name);}catch(e:any){results.push({name,ok:false,error:e.message});}}
function timed(fn:()=>any){const t=performance.now();const value=fn();return {ms:performance.now()-t,value};}
run(`${process.argv[2]??10000} formulas depend on one global input`,()=>{
 const n=Number(process.argv[2]??10000);const old=new ic.Model('Fanout','es','America/Sao_Paulo','en');old.pauseEvaluation();old.setUserInput(0,1,1,'10');
 for(let r=1;r<=n;r++)old.setUserInput(0,r,2,`=$A$1*${r}`);old.flushSendQueue();old.resumeEvaluation();old.evaluate();
 const oldTimes=[];for(const v of [11,12,13]){oldTimes.push(timed(()=>old.setUserInput(0,1,1,String(v))).ms);assert.equal(old.getFormattedCellValue(0,n,2),String(n*v));}old.free();
 const wb=gp.Workbook.open(gp.blankXlsx(['Sheet1']));wb.setInput(0,1,1,'10');for(let r=1;r<=n;r++)wb.setInput(0,r,2,`=$A$1*${r}`);wb.evaluate();
 const times=[];const deltas=[];const engineTiming=[];for(const v of [11,12,13]){const t=timed(()=>{wb.setInput(0,1,1,String(v));return JSON.parse(wb.evaluateEdited());});times.push(t.ms);deltas.push(t.value.cells?.length);engineTiming.push(t.value.timing??null);assert.equal(JSON.parse(wb.cell(0,n,2)).value,n*v);}wb.free();
 return {rows:n,oldMs:oldTimes,gridpathMs:times,deltaCells:deltas,engineTiming};
});
run('cross sheet dependencies and row insertion',()=>{
 const wb=gp.Workbook.open(gp.blankXlsx(['Dados','Resumo']));wb.setInput(0,1,1,'10');wb.setInput(1,1,1,'=Dados!A1*2');wb.evaluate();wb.setInput(0,1,1,'21');wb.evaluateEdited();assert.equal(JSON.parse(wb.cell(1,1,1)).value,42);wb.insertRows(0,1,1);const delta=JSON.parse(wb.evaluateEdited());const c=JSON.parse(wb.cell(1,1,1));assert.equal(c.value,42);assert.equal(c.content,'=Dados!A2*2');wb.free();return {value:c.value,formula:c.content,structuralEditRequestsFullSnapshot:delta.full};
});
run('query sees data beyond initial sample',()=>{
 const wb=gp.Workbook.open(gp.blankXlsx(['Dados']));wb.setInput(0,1,1,'Regiao');wb.setInput(0,1,2,'Valor');for(let r=2;r<=100001;r++){wb.setInput(0,r,1,r===100001?'ALVO':'Sul');wb.setInput(0,r,2,r===100001?'777':'1');}wb.evaluate();
 const t=timed(()=>JSON.parse(wb.queryRows(JSON.stringify({sheet:0,header_row:1,where:[{column:'Regiao',op:'eq',value:'ALVO'}],columns:['Regiao','Valor']}))));wb.free();const s=JSON.stringify(t.value);assert.ok(s.includes('777'));return {ms:t.ms,response:t.value};
});
run('XLSX saves recalculated formula caches',()=>{
 const original=gp.patch(gp.blankXlsx(['Dados']),JSON.stringify({version:1,sheets:[{name:'Dados',cells:[{r:0,c:0,v:{t:'n',n:10}},{r:0,c:1,f:'A1*2',v:{t:'n',n:20}}]}]}));
 const wb=gp.Workbook.open(original);wb.setInput(0,1,1,'21');wb.evaluateEdited();const caches=JSON.parse(wb.recalculatedCells());const cells=caches.map((x:any)=>({r:x.r,c:x.c,cache:x.value}));cells.push({r:0,c:0,v:{t:'n',n:21}});const bytes=gp.patch(original,JSON.stringify({version:1,sheets:[{name:'Dados',cells}]}));const reopened=gp.Workbook.openDeferred(bytes);const c=JSON.parse(reopened.cell(0,1,2));assert.equal(c.value,42);wb.free();reopened.free();return {cachedAfterReopen:c};
});
run('unsupported formula with cached value is flagged',()=>{
 const bytes=gp.patch(gp.blankXlsx(['Dados']),JSON.stringify({version:1,sheets:[{name:'Dados',cells:[{r:0,c:0,f:'FARIV_UNKNOWN(1)',v:{t:'n',n:99}}]}]}));const wb=gp.Workbook.open(bytes);const c=JSON.parse(wb.cell(0,1,1));const flags=JSON.parse(wb.fileSavedCells(100));assert.ok(flags.length>0);wb.free();return {cell:c,flags};
});
run('Excel row limit rejects five million rows',()=>{const wb=gp.Workbook.open(gp.blankXlsx(['Dados']));let rejected=false;let message='';try{wb.setInput(0,5000000,1,'1');}catch(e:any){rejected=true;message=e.message;}wb.free();assert.equal(rejected,true);return {rejected,message};});
const report={scope:'Synthetic headless Node/Linux, no Excel real/UI/provider auth; no comparison of native vs WASM',results};writeFileSync(new URL(`./results/adversarial-${process.argv[2]??10000}.json`,import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(results.some(r=>!r.ok))process.exitCode=1;
