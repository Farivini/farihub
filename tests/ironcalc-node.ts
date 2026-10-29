import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as ironcalc from '@ironcalc/wasm';

/** The same WASM build the browser worker loads, instantiated synchronously under Node. */
const output = ironcalc.initSync({ module: readFileSync(createRequire(import.meta.url).resolve('@ironcalc/wasm/wasm_bg.wasm')) });
export const ic = ironcalc;
export const wasmMemoryBytes = () => output.memory.buffer.byteLength;
