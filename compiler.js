import { spawn } from 'child_process';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';

const execAsync = promisify(exec);
const sourceCode = `
fun init() : i32
{
  return 42
  }
  `;
// Your LLVM IR defined directly as a JavaScript string
const llvmIRString = `
target datalayout = "e-m:e-p:32:32-p10:32:32-p20:32:32-i64:64-n32:64-S128-ni:1:10:20"
target triple = "wasm32-unknown-unknown"

define i32 @add(i32 %a, i32 %b) {
      %result = add i32 %a, %b
                  ret i32 %result
                  }
                  `;
const Enum = (...args) =>
{
    const result = {};
    for (let i = 0; i < args.length; ++i)
      {
            const key = args[i];
            if (!isNaN(key))
              {
                      throw new Error(`Enum key "${key}" cannot be a number.`);
                    }
            result[result[i] = key] = i;
          }
    return Object.freeze(result);
};
const TokenType = Enum(
    'ID', 'FUN', 'RET', 'L_PAREN', 'R_PAREN',
    'L_BRACE', 'R_BRACE', 'L_BRACK', 'R_BRACK', 'COLON',
    'STRING', 'INTERP', 'ERR', 'ENDL', 'EOF'
);
const Token = (type, lexer, value = null) => ({
    type,
    line: lexer.line,
    col: lexer.col,
    value: value ?? lexer.source.substring(lexer.start, lexer.curr),
    get str()
    {
          return `[${TokenType[this.type]}, '${this.value}']`;
        }
});
const keywords = Object.freeze({
    'fun':    Token.FUN,
    'return': Token.RET,
});
class Lexer
{
    constructor(source)
    {
          this.source  = source;
          this.line    = 1;
          this.col     = 1;
          this.start   = 0;
          this.curr    = 0;
          this.interps = [];
        }
    newLine()
    {
          ++this.line;
          this.col = 1;
        }
    fin()
    {
          return this.curr >= this.source.length;
        }
    advance()
    {
          ++this.col;
          return this.source[this.curr++];
        }
    back()
    {
          return this.source[this.curr--];
        }
    look()
    {
          return this.source[this.curr];
        }
    spy(x)
    {
          return this.look() === x;
        }
    match(x)
    {
          if (this.fin())
            {
                    return false;
                  }
          if (this.spy(x))
            {
                    this.advance();
                    return true;
                  }
          return false;
        }
    skipUseless()
    {
          for (;;)
            {
                    switch (this.look())
                    {
                              case ' ':
                                case '\t':
                                case '\r':
                                case '\f':
                                  this.advance();
                                  break;
                                case ';':
                                  while (!this.fin() && !this.spy('\n'))
                                    {
                                                  this.advance();
                                                }
                                  break;
                                case '`':
                                  {
                                                let depth = 1;
                                                for (;;)
                                                {
                                                                const char = this.advance();
                                                                if (this.fin())
                                                                  {
                                                                                    break;
                                                                                  }
                                                                if (char === '.')
                                                                  {
                                                                                    if (this.match('`'))
                                                                                      {
                                                                                                          --depth;
                                                                                                        }
                                                                                  }
                                                                else if (this.match('`'))
                                                                  {
                                                                                    ++depth;
                                                                                  }
                                                                if (depth <= 0)
                                                                  {
                                                                                    break;
                                                                                  }
                                                              }
                                                break;
                                              }
                                default: return;
                              }
                  }
        }
    isAlpha(x)
    {
          return !this.fin() && (x === '_' || RegExp(/^\p{L}/, 'u').test(x));
        }
    isDigit(x)
    {
          return !this.fin() && /[0-9]/.test(x);
        }
    isAlphaNum(x)
    {
          return !this.fin() && (this.isAlpha(x) || this.isDigit(x));
        }
    error(message)
    {
          return Token(TokenType.ERR, this, message);
        }
    doubleString()
    {
          let string = '';
          let done = false;
          let type = TokenType.STRING;
          do
            {
                    if (this.fin())
                      {
                                return this.error('Unterminated string!');
                              }
                    const curr = this.advance();
                    switch (curr)
                    {
                                // The terminator:
                              case '"':
                                  done = true;
                                  break;
                                  // Escape sequences:
                                case '\\':
                                  {
                                                switch (this.look())
                                                {
                                                                case 'n':
                                                                    string += '\n';
                                                                    break;
                                                                  case 'r':
                                                                    string += '\r';
                                                                    break;
                                                                  case 'f':
                                                                    string += '\f';
                                                                    break;
                                                                  case 't':
                                                                    string += '\t';
                                                                    break;
                                                                  case 'v':
                                                                    string += '\v';
                                                                    break;
                                                                  case 'a':
                                                                    string += '\a';
                                                                    break;
                                                                  case 'b':
                                                                    string += '\b';
                                                                    break;
                                                                  case '"':
                                                                    string += '"';
                                                                    break;
                                                                  case '\\':
                                                                    string += '\\';
                                                                    break;
                                                                  case '\n':
                                                                    break;
                                                                  default:
                                                                    return this.error(`Unrecognized escape: \\${this.look()}`);
                                                                }
                                                this.advance();
                                                break;
                                              }
                                default:
                                  {
                                                if (curr == '\n')
                                                  {
                                                                  this.newLine();
                                                                }
                                                string += curr;
                                                break;
                                              }
                              }
                  } while (!done);
          return Token(type, this, string);
        }
    singleString()
    {
          let string = '';
          let done = false;
          let type = TokenType.STRING;
          do
            {
                    if (this.fin())
                      {
                                return this.error('Unterminated string!');
                              }
                    const curr = this.advance();
                    switch (curr)
                    {
                                // The terminator:
                              case '\'':
                                  done = true;
                                  break;
                                  // Escape sequences:
                                case '\\':
                                  {
                                                switch (this.look())
                                                {
                                                                case 'n':
                                                                    string += '\n';
                                                                    break;
                                                                  case 'r':
                                                                    string += '\r';
                                                                    break;
                                                                  case 'f':
                                                                    string += '\f';
                                                                    break;
                                                                  case 't':
                                                                    string += '\t';
                                                                    break;
                                                                  case 'v':
                                                                    string += '\v';
                                                                    break;
                                                                  case 'a':
                                                                    string += '\a';
                                                                    break;
                                                                  case 'b':
                                                                    string += '\b';
                                                                    break;
                                                                  case '\'':
                                                                    string += '\'';
                                                                    break;
                                                                  case '#':
                                                                    string += '#';
                                                                    break;
                                                                  case '\\':
                                                                    string += '\\';
                                                                    break;
                                                                  case '\n':
                                                                    break;
                                                                  default:
                                                                    return this.error(`Unrecognized escape: \\${this.look()}`);
                                                                }
                                                this.advance();
                                                break;
                                              }
                                  // Interpolation:
                                case '#':
                                  {
                                                if (this.match('{'))
                                                {
                                                                type = TokenType.INTERP;
                                                                this.interps.push(1);
                                                                done = true;
                                                                break;
                                                              }
                                                // Fall-through
                                              }
                                default:
                                  {
                                                if (curr == '\n')
                                                  {
                                                                  this.newLine();
                                                                }
                                                string += curr;
                                                break;
                                              }
                              }
                  } while (!done);
          return Token(type, this, string);
        }
    scan()
    {
          this.skipUseless();
          this.start = this.curr;
          if (this.fin())
            {
                    if (this.interps.length > 0)
                      {
                                return this.error('Unclosed interpolation!');
                              }
                    return Token(TokenType.EOF, this);
                  }
          const char = this.advance();
          switch (char)
          {
                  case '\n':
                      this.newLine();
                      return Token(TokenType.ENDL, this);
                    case ':':
                      return Token(TokenType.FUN, this);
                    case '{':
                      if (this.interps.length > 0)
                        {
                                    ++this.interps[this.interps.length - 1];
                                  }
                      return Token(TokenType.LBRACE, this);
                    case '}':
                      if (this.interps.length > 0)
                        {
                                    --this.interps[this.interps.length - 1];
                                    if (this.interps[this.interps.length - 1] <= 0)
                                      {
                                                    this.interps.pop();
                                                    return this.singleString();
                                                  }
                                  }
                      return Token(TokenType.RBRACE, this);
                    case '(':
                      return Token(TokenType.LPAREN, this);
                    case ')':
                      return Token(TokenType.RPAREN, this);
                    case '[':
                      return Token(TokenType.LBRACK, this);
                    case ']':
                      return Token(TokenType.RBRACK, this);
                    default:
                      {
                                  if (this.isDigit(char))
                                    {
                                                  let type = TokenType.INT;
                                                  while (this.isDigit(this.look()))
                                                    {
                                                                    this.advance();
                                                                  }
                                                  if (this.match('.'))
                                                    {
                                                                    type = TokenType.REAL;
                                                                    while (this.isDigit(this.look()))
                                                                      {
                                                                                        this.advance();
                                                                                      }
                                                                  }
                                                  return Token(type, this)
                                                }
                                  else if (this.isAlpha(char))
                                    {
                                                  while (this.isAlphaNum(this.look()))
                                                    {
                                                                    this.advance();
                                                                  }
                                                  const ident = this.source.substring(this.start, this.curr);
                                                  if (ident in keywords)
                                                    {
                                                                    return Token(keywords[ident], this);
                                                                  }
                                                  return Token(TokenType.ID, this);
                                                }
                                  return this.error(`Unrecognized character: '${char}'`);
                                }
                  }
        }
}
class TypeRegistry {
    constructor() {
          this.types = new Map();

          // Pre-seed your language's native primitives
          this.types.set("i32", { isPrimitive: true, llvmString: "i32", size: 4 });
          this.types.set("f32", { isPrimitive: true, llvmString: "float", size: 4 });

          // CPointer maps straight to your opaque FFI handle byte pointer
          this.types.set("CPointer", { isPrimitive: true, llvmString: "i8*", size: 8 });
        }

    registerClass(name, definition) {
          this.types.set(name, {
                  isPrimitive: false,
                  llvmString: `%class.${name}`,
                  ...definition
                });
        }

    isValidType(name) {
          return this.types.has(name);
        }
}

const NodeType = Enum(
    'BINARY',     'UNARY',         'GROUP',
    'STRING',     'INTERP',        'NULL',
    'REAL',       'INT',           'GET',
    'TRUE',       'FALSE',         'AND',
    'OR',         'ELSE',          'OPTIONAL',
    'IF',         'SET',           'LBRACE',
    'RBRACE',     'COMP',          'NOT',
    'NULL',       'FOR',           'PASS',
    'WHILE',      'BREAK',         'CONTINUE',
    'THIS',       'CALL',          'MATCH',
    'RETURN',     'DECLARE',       'BLOCK',
    'FUNC_BLOCK', 'FUNC',          'HASH',
    'SUBSCRIPT',  'SET_SUBSCRIPT', 'ASSIGN',
    'OBJ',        'EXPR',          'FUNC_CALL',
    'ARRAY',      'IMPORT',        'GET_PROP',
    'SET_PROP',   'COAL',          'FIN');
const Node = (() =>
  {
      const base = (type, line = 0) => ({
            type, line,
          });
      return {
            Constant: (type, token) => ({
                    ...base(type, token.line),
                    value: token.value,
                  }),
            Nilary: base,
            Unary: (type, value, line = 0) => ({
                    ...base(type, line),
                    value,
                  }),
            UnaryOp: (op, value, line = 0) => ({
                    ...base(NodeType.UNARY, line),
                    value, op,
                  }),
            Binary: (type, left, right, line = 0) => ({
                    ...base(type, line),
                    left, right,
                  }),
            BinaryOp: (op, left, right, line = 0) => ({
                    ...base(NodeType.BINARY, line),
                    left, right, op,
                  }),
            Trinary: (type, left, middle, right, line = 0) => ({
                    ...base(type, line),
                  }),
            Get: (token) => ({
                    ...base(NodeType.GET, token.line),
                    name: token.value,
                  }),
            // EVERY function will be lifted to a global level, and thus be given names by the parser (eg init.lambda.line.12.1)
            Func: (name, args, ret_type, body, line = 0) => ({
                    ...Base(NodeType.FUNC, line),
                    args, ret_type, body
                  }),
          };
  })();
class Parser
{
    constructor(source)
    {
          this.source  = source;
          this.manifest = {
                  classes: {},
                  globals: {},
                  funcs:   {},
                };
          this.curr    = null;
          this.prev    = null;
          this.panic   = false;
          this.lexer   = new Lexer(source);
          this.types   = new TypeRegistry();
        }
    advance()
    {
          this.prev = this.curr;
          this.curr = scan();
          // Lexical errors will be handled here.
          return this.curr;
        }
    error(token, message)
    {
          log(`[${token.line}:${token.col}] ${message}`);
          this.panic = true;
        }
    sniff(...types)
    {
          return types.indexOf(this.curr.type) >= 0;
        }
    eat(type, error)
    {
          if (this.sniff(type))
            {
                    this.advance();
                    return;
                  }
          this.advance();
          this.error(this.curr, error);
        }
    taste(...types)
    {
          if (this.sniff(...types))
            {
                    this.advance();
                    return true;
                  }
          return false;
        }
    skipBreaks()
    {
          while (this.taste(TokenType.ENDL));
        }
    topLevel()
    {
          const lexer = new Lexer(this.source);
        }

}
async function compileString() {
    try {
          console.log('Step 1: Pipelining LLVM IR string directly into llc via stdin...');

          // Pass "-" as the input filename to instruct llc to read from stdin
          const llc = spawn('llc', ['-mtriple=wasm32-unknown-unknown', '-filetype=obj', '-', '-o', 'add.o']);

          // Write your string to llc's standard input stream and close it
          llc.stdin.write(llvmIRString);
          llc.stdin.end();

          // Wait for llc compilation to finish
          await new Promise((resolve, reject) => {
                  llc.on('close', (code) => {
                            if (code === 0) resolve();
                            else reject(new Error(`llc exited with code ${code}`));
                          });
                  llc.on('error', reject);
                });

          console.log('Step 2: Linking Object file to standalone Wasm (.wasm)...');
          await execAsync('wasm-ld --no-entry --export-all add.o -o add.wasm');

          console.log('Success! add.wasm has been generated.');

          // Step 3: Verify and execute
          const wasmBuffer = await fs.readFile('./add.wasm');
          const wasmModule = await WebAssembly.instantiate(wasmBuffer);
          const { add } = wasmModule.instance.exports;

          console.log(`Result of add(40, 2): ${add(40, 2)}`); // Expected: 42

        } catch (error) {
              console.error('Compilation failed:', error.message);
            }
}

compileString();

