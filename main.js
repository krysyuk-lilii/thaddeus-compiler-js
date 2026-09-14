import { spawn } from 'child_process';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import { Emitter } from './src/emitter.js';

const execAsync = promisify(exec);


const sourceCode = `
extern fun print(s: str) : void
extern fun int_to_str(v: i32) : str
extern fun str_concat(a: str, b: str) : str

let base := 10
let arr : str[10] = {}

fun isEven(x : i32) : bool
{
  return (x & 1) == 0
}
fun foo() : void
{}
fun countdown(x: i32) : void
{
  if x < 0 {
    return
  }
  if x < len(arr) {
    arr[x] = new "counting: #{x}"
  }
  become countdown(x - 1)
  ; become foo() ; should be a compile error (tail call to unmatched signature.)
}
fun printAndFreeArr(x: i32) : void
{
  if x < len(arr) {
    print(arr[x])
    free arr[x]
  }
  if x <= 0 {
    return
  }
  become printAndFreeArr(x - 1)
}
fun classify(x: i32, y: i32) : i32
{
  if x <= y and isEven(y) {
    return 1
  }
  return 0
}
fun add(a: i32, b: i32) : i32
{
  return a + b * 2
}
fun init() : i32
{
  let x := len(arr)
  countdown(x)
  printAndFeeArr(x)
  let r := classify(base, 20)
  var counter := 0
  counter = counter + 1
  counter = counter + r
  print("counter computed as #{counter}")
  return add(counter, 3)
}
`;

async function compileString()
{
  try
  {
    console.log(sourceCode);
    const emitter = new Emitter(sourceCode);
    const llvmIR = emitter.compile();
    console.log(llvmIR);
    const llc = spawn('llc', [
      '-mtriple=wasm32-unknown-unknown', 
      '-filetype=obj', 
      '-mattr=+tail-call', // ◄ Add this flag right here
      '-', 
      '-o', 
      'prog.o'
    ], { stdio: ['pipe', 'pipe', 'inherit'] });
    llc.stdin.write(llvmIR);
    llc.stdin.end();
    await new Promise((resolve, reject) =>
    {
      llc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`llc exited with code ${code}`)));
      llc.on('error', reject);
    });

    console.log('Linking...');
    await execAsync('wasm-ld --no-entry --export-all --allow-undefined prog.o -o prog.wasm');
    console.log('Success! program has been generated.');

    const wasmBuffer = await fs.readFile('./prog.wasm');
    let memoryRef;

    // Simple bump allocator for runtime-constructed strings (interpolation
    // results). Starts well past the module's static data; grown explicitly
    // below since default initial memory is too small to hold it.
    
    function scratchAlloc(byteLen)
    {
      const ptr = scratchOffset;
      scratchOffset += byteLen;
      return ptr;
    }
    function readLengthPrefixedString(ptr)
    {
      const len = new DataView(memoryRef.buffer, ptr, 4).getInt32(0, true);
      return new Uint8Array(memoryRef.buffer, ptr + 4, len);
    }

    const imports = {
      env: {
        print(ptr) {
          const view = new DataView(memoryRef.buffer, ptr, 4);
          const len = view.getInt32(0, true); // little-endian, matches internString's encoding
          const bytes = new Uint8Array(memoryRef.buffer, ptr + 4, len);
          console.log('[script print]', new TextDecoder().decode(bytes));
        },
        int_to_str(v) {
          const digits = new TextEncoder().encode(String(v));
          const ptr = scratchAlloc(4 + digits.length);
          new DataView(memoryRef.buffer, ptr, 4).setInt32(0, digits.length, true);
          new Uint8Array(memoryRef.buffer, ptr + 4, digits.length).set(digits);
          return ptr;
        },
        str_concat(aPtr, bPtr) {
          const a = readLengthPrefixedString(aPtr);
          const b = readLengthPrefixedString(bPtr);
          const totalLen = a.length + b.length;
          const ptr = scratchAlloc(4 + totalLen);
          new DataView(memoryRef.buffer, ptr, 4).setInt32(0, totalLen, true);
          const out = new Uint8Array(memoryRef.buffer, ptr + 4, totalLen);
          out.set(a, 0);
          out.set(b, a.length);
          return ptr;
        },
      },
    };
    const wasmModule = await WebAssembly.instantiate(wasmBuffer, imports);
    memoryRef = wasmModule.instance.exports.memory;

    let scratchOffset = memoryRef.buffer.byteLength; // guaranteed past every static/reserved region
    memoryRef.grow(4);
    const { init } = wasmModule.instance.exports;

    console.log(`Running: ${init()}`);
  }
  catch (error)
  {
    console.error('Compilation failed:', error.message);
  }
}

compileString();