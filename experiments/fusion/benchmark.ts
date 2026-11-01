import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {cpus} from 'node:os';
import {buildPivotLayout} from './workspace/genoffice/packages/xlsx-gateway/src/domain/pivot-layout.ts';
import {computePivot,pivotCell} from '../../src/core/pivot.ts';
import {ic} from '../../tests/ironcalc-node.ts';
const require=createRequire(import.meta.url);
const gp=require('./workspace/gridpath-package/engine/gridpath_engine.js');
const rows=Number(process.argv[2]??100000);
const report:any={scope:'Headless Linux Node, synthetic data, no UI/Windows/AI/provider comparison',node:process.version,cpu:cpus()[0].model,rows,results:[]};
function timed(fn:()=>any){const t=performance.now();const value=fn();return {ms:performance.now()-t,value};}
// Same two inputs and one formula per row. Independent rows make dirty closure explicit.
let old=new ic.Model('Bench','es','America/Sao_Paulo','en');old.pauseEvaluation();
const oldFill=timed(()=>{for(let r=1;r<=rows;r++){old.setUserInput(0,r,1,'10');old.setUserInput(0,r,2,'20');old.setUserInput(0,r,3,`=A${r}*B${r}`);}});
old.flushSendQueue();
const oldFirst=timed(()=>{old.resumeEvaluation();old.evaluate();});
const oldEdit=[];for(let i=0;i<5;i++){const v=11+i;oldEdit.push(timed(()=>old.setUserInput(0,1,1,String(v))).ms);assert.equal(old.getFormattedCellValue(0,1,3),String(v*20));}
report.results.push({name:'Farihub IronCalc 0.9.1 WASM',fillMs:oldFill.ms,initialCalculationMs:oldFirst.ms,editMs:oldEdit});old.free();
const base=gp.blankXlsx(['Sheet1']);const wb=gp.Workbook.open(base);
const gpFill=timed(()=>{for(let r=1;r<=rows;r++){wb.setInput(0,r,1,'10');wb.setInput(0,r,2,'20');wb.setInput(0,r,3,`=A${r}*B${r}`);}});
const gpFirst=timed(()=>wb.evaluate());const gpEdit=[];let delta:any;
for(let i=0;i<5;i++){const v=11+i;const m=timed(()=>{wb.setInput(0,1,1,String(v));delta=JSON.parse(wb.evaluateEdited());});gpEdit.push(m.ms);assert.equal(JSON.parse(wb.cell(0,1,3)).value,v*20);assert.equal(delta.full,false);}
report.results.push({name:'GridPath 0.5.2 published WASM',fillMs:gpFill.ms,initialCalculationMs:gpFirst.ms,editMs:gpEdit,lastDeltaCells:delta.cells.length});wb.free();
// Pivot apples-to-apples grouping and sum. Source preparation excluded from both timings.
for(const n of [10000,10001,1000000]){
 const grid:any[]=[['Region','Amount']];for(let i=0;i<n;i++)grid.push(['R'+(i%5),10]);
 const codes=Uint32Array.from({length:n},(_,i)=>1+i%5);const amounts=new Uint32Array(n).fill(1);
 const source=new Map<any,any>([['Region',{name:'Region',codes,labels:['(vazio)','R0','R1','R2','R3','R4'],labelValues:[NaN,NaN,NaN,NaN,NaN,NaN]}],['Amount',{name:'Amount',codes:amounts,labels:['(vazio)','10'],labelValues:[NaN,10]}]]);
 const ours=timed(()=>computePivot(source,n,{rows:['Region'],columns:[],values:[{field:'Amount',aggregation:'sum'}],filters:[]}));assert.equal(pivotCell(ours.value,ours.value.rowGroups.length,0,0),n*10);
 let theirs:any;try{const x=timed(()=>buildPivotLayout(grid,{rowFields:['Region'],values:[{field:'Amount',agg:'sum'}]}));assert.equal(x.value.matrix.at(-1)?.[1],n*10);theirs={ms:x.ms,total:x.value.matrix.at(-1)?.[1]};}catch(e:any){theirs={error:e.message,code:e.code};}
 report.results.push({name:'Pivot sum by 5 regions',rows:n,farihubMs:ours.ms,genoffice:theirs});
}
writeFileSync(new URL(`./results/benchmark-${rows}.json`,import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
