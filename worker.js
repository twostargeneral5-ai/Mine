// worker.js — runs in a worker thread, loads WASM, mines keccak256
const { workerData, parentPort } = require("worker_threads");
const fs = require("fs");
const path = require("path");

// ── WASM helpers ────────────────────────────────────────
let wasm;
let cachedU8 = null;
let cachedDV = null;
let WASM_VEC_LEN = 0;
let heap = new Array(1024).fill(undefined);
heap.push(undefined, null, true, false);
let heap_next = heap.length;

const dec = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });

function u8() {
  if (!cachedU8 || cachedU8.byteLength === 0)
    cachedU8 = new Uint8Array(wasm.memory.buffer);
  return cachedU8;
}
function dv() {
  if (!cachedDV || cachedDV.buffer !== wasm.memory.buffer)
    cachedDV = new DataView(wasm.memory.buffer);
  return cachedDV;
}
function addHeap(obj) {
  if (heap_next === heap.length) heap.push(heap.length + 1);
  const i = heap_next; heap_next = heap[i]; heap[i] = obj; return i;
}
function dropHeap(i) { if (i < 1028) return; heap[i] = heap_next; heap_next = i; }
function takeHeap(i) { const r = heap[i]; dropHeap(i); return r; }
function wasm_str(ptr, len) { return dec.decode(u8().subarray(ptr >>> 0, (ptr >>> 0) + len)); }
function pass_u8(arg) {
  const ptr = wasm.__wbindgen_export(arg.length, 1) >>> 0;
  u8().set(arg, ptr); WASM_VEC_LEN = arg.length; return ptr;
}
function get_u8(ptr, len) { return u8().subarray(ptr >>> 0, (ptr >>> 0) + len); }

function hex_to_u8(hex, len = 32) {
  hex = hex.replace("0x", "").padStart(len * 2, "0");
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16);
  return b;
}
// ────────────────────────────────────────────────────────

async function init() {
  const bytes = fs.readFileSync(path.join(__dirname, "hash_miner_bg.wasm"));
  const imports = {
    "./hash_miner_bg.js": {
      __wbg___wbindgen_throw_9c31b086c2b26051(a0, a1) { throw new Error(wasm_str(a0, a1)); },
      __wbindgen_cast_0000000000000001(a0, a1) { return addHeap(wasm_str(a0, a1)); },
    },
  };
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  wasm = instance.exports;
  cachedU8 = null; cachedDV = null;
}

function create_miner(challenge_hex, difficulty_str, thread_id) {
  const challenge  = hex_to_u8(challenge_hex, 32);
  const diff_big   = BigInt(difficulty_str);
  const diff_hex   = diff_big.toString(16).padStart(64, "0");
  const difficulty = hex_to_u8(diff_hex, 32);

  // 24-byte nonce prefix — unique per thread so workers cover different spaces
  const prefix = new Uint8Array(24);
  const pdv = new DataView(prefix.buffer);
  pdv.setUint32(0, thread_id, false);
  // Fill remaining bytes with a random salt so re-launches don't overlap
  for (let i = 4; i < 24; i++) prefix[i] = Math.floor(Math.random() * 256);

  const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
  try {
    const p0 = pass_u8(challenge);  const l0 = WASM_VEC_LEN;
    const p1 = pass_u8(difficulty); const l1 = WASM_VEC_LEN;
    const p2 = pass_u8(prefix);     const l2 = WASM_VEC_LEN;
    wasm.miner_new(retptr, p0, l0, p1, l1, p2, l2);
    const r0 = dv().getInt32(retptr,      true);
    const r1 = dv().getInt32(retptr +  4, true);
    const r2 = dv().getInt32(retptr +  8, true);
    if (r2) throw takeHeap(r1);
    return r0; // miner pointer
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16);
  }
}

function search_batch(miner_ptr, start_counter, iterations) {
  const ret = wasm.miner_search(miner_ptr, start_counter, iterations);
  if (ret === 0) return null;

  // Extract nonce from SearchResult
  const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
  try {
    wasm.searchresult_nonce(retptr, ret);
    const r0 = dv().getInt32(retptr,     true);
    const r1 = dv().getInt32(retptr + 4, true);
    const nonce = get_u8(r0, r1).slice();
    wasm.__wbindgen_export2(r0, r1, 1);
    wasm.__wbg_searchresult_free(ret, 0);
    return nonce;
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16);
  }
}

async function run() {
  await init();

  const { challenge, difficulty, threadId } = workerData;
  const miner_ptr = create_miner(challenge, difficulty, threadId);

  const BATCH = BigInt(50000);
  let counter = BigInt(0);

  while (true) {
    const nonce_bytes = search_batch(miner_ptr, counter, BATCH);
    counter += BATCH;

    if (nonce_bytes) {
      const nonce_hex = "0x" + Array.from(nonce_bytes)
        .map(b => b.toString(16).padStart(2, "0")).join("");
      parentPort.postMessage({ found: true, nonce: nonce_hex });
      wasm.__wbg_miner_free(miner_ptr, 0);
      return;
    }

    parentPort.postMessage({ found: false, tries: Number(BATCH) });
  }
}

run().catch(err => {
  console.error("Worker error:", err.message);
  process.exit(1);
});
