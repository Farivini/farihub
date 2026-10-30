import { readFileSync } from 'node:fs';
import * as bridge from '../vendor/xlsx-bridge/xlsx_bridge.js';

/** The same converter WASM the browser loads, instantiated synchronously under Node. */
const output = bridge.initSync({ module: readFileSync(new URL('../vendor/xlsx-bridge/xlsx_bridge_bg.wasm', import.meta.url)) });
export const xlsxBridge = bridge;
export const bridgeMemoryBytes = () => output.memory.buffer.byteLength;
