import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFileSync} from 'node:fs';
import JSZip from 'jszip';
import {buildPivotLayout} from './workspace/genoffice/packages/xlsx-gateway/src/domain/pivot-layout.ts';
import {createBufferEntrySource,planCellEditsToXlsx} from './workspace/genoffice/packages/xlsx-gateway/src/gateway/xlsx-gateway.ts';
const require=createRequire(import.meta.url);const engine=require('./workspace/gridpath-package/engine/gridpath_engine.js');
async function main(){
const rows:any[][]=[['Regiao','Quantidade','Preco','Receita'],['Sul',2,10,null],['Norte',3,20,null],['Sul',4,10,null]];
const cells=rows.flatMap((row,r)=>row.map((v,c)=>r>0&&c===3?{r,c,f:`B${r+1}*C${r+1}`,v:{t:'n',n:0}}:v===null?{r,c,clear:true}:{r,c,v:typeof v==='number'?{t:'n',n:v}:{t:'s',s:v}}));
const input=engine.patch(engine.blankXlsx(['Dados']),JSON.stringify({version:1,sheets:[{name:'Dados',cells}]}));
const wb=engine.Workbook.open(input);for(let r=2;r<=4;r++)rows[r-1][3]=JSON.parse(wb.cell(0,r,4)).value;
const layout=buildPivotLayout(rows,{rowFields:['Regiao'],values:[{field:'Receita',agg:'sum'}]},{subtotal:'Subtotal',grandTotal:'Total geral'});
assert.equal(layout.matrix.at(-1)?.[1],120);
const edits:any[]=rows.slice(1).map((row,i)=>({sheetName:'Dados',row:i+1,column:3,writeValue:true,cell:{value:row[3],formula:`=B${i+2}*C${i+2}`}}));
layout.matrix.forEach((row,r)=>row.forEach((value,c)=>edits.push({sheetName:'Dados',row:r,column:c+5,writeValue:true,cell:{value}})));
const pivot={...layout.definition,sheetName:'Dados',sourceSheetName:'Dados',sourceArea:{startRow:0,startColumn:0,endRow:3,endColumn:3},location:{startRow:0,startColumn:5,endRow:layout.height-1,endColumn:5+layout.width-1},name:'ReceitaPorRegiao'};
const plan=await planCellEditsToXlsx(await createBufferEntrySource(Buffer.from(input)),edits,[],[],undefined,[],[],[],[],[],null,[],[],[],[],[pivot]);
const zip=await JSZip.loadAsync(input);for(const p of plan.removedEntries)zip.remove(p);for(const [p,v]of plan.replaced)zip.file(p,v);for(const [p,v]of plan.added)zip.file(p,v);for(const [p,v]of plan.addedBinary)zip.file(p,v);
const output=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});const reopened=engine.Workbook.open(output);assert.equal(JSON.parse(reopened.cell(0,4,4)).value,40);
const check=await JSZip.loadAsync(output);const pivotParts=Object.keys(check.files).filter(p=>p.startsWith('xl/pivotTables/')&&p.endsWith('.xml'));assert.equal(pivotParts.length,1);
const summary={scope:'Headless composition proof; native pivot XML present; NOT verified in Excel',inputRows:3,totalRevenue:120,formulaAfterReopen:JSON.parse(reopened.cell(0,4,4)),pivotParts,bytes:output.length};
writeFileSync(new URL('./results/fusion-proof.xlsx',import.meta.url),output);writeFileSync(new URL('./results/composition.json',import.meta.url),JSON.stringify(summary,null,2));console.log(summary);wb.free();reopened.free();}
main().catch(e=>{console.error(e);process.exitCode=1});
