import { spawn } from 'child_process';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';

const execAsync = promisify(exec);


const sourceCode = `
extern fun print(s: str) : void
extern fun int_to_str(v: i32) : str
extern fun str_concat(a: str, b: str) : str

let base := 10
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
  print("counting: #{x}")
  become countdown(x - 1)
  ; become foo() ; should be a compile error (tail call to unmatched signature.)
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
  countdown(20)
  let r := classify(base, 20)
  var counter := 0
  counter = counter + 1
  counter = counter + r
  print("counter computed as #{counter}")
  return add(counter, 3)
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
  'ID', 'FUN', 'RET', 'LET', 'VAR', 'ASSIGN_DEF', 'ASSIGN', 'L_PAREN', 'R_PAREN',
  'PLUS', 'SUB', 'MUL', 'DIV', 'COMMA',
  'AND', 'OR', 'NOT', 'IF', 'ELSE',
  'BIT_AND', 'BIT_OR', 'BIT_XOR', 'BIT_NOT', 'SHL', 'SHR',
  'EQ_EQ', 'NEQ', 'LT', 'GT', 'LE', 'GE',
  'L_BRACE', 'R_BRACE', 'L_BRACK', 'R_BRACK',
  'COLON', 'STRING', 'INTERP', 'TRUE', 'FALSE', 'DOT', 'INCREMENT',
  'BECOME', 'EXTERN', 'CLASS', 'STRUCT', 'INT', 'REAL',
  'NULL', 'NEW', 'FREE', 'ENDL', 'ERR', 'EOF'
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
  'fun':    TokenType.FUN,
  'return': TokenType.RET,
  'let':    TokenType.LET,
  'become': TokenType.BECOME,
  'var':    TokenType.VAR,
  'true':   TokenType.TRUE,
  'false':  TokenType.FALSE,
  'null':   TokenType.NULL,
  'new':    TokenType.NEW,
  'free':   TokenType.FREE,
  'and':    TokenType.AND,
  'or':     TokenType.OR,
  'not':    TokenType.NOT,
  'if':     TokenType.IF,
  'else':   TokenType.ELSE,
  'extern': TokenType.EXTERN,
  'class':  TokenType.CLASS,
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
    for (;;)
    {
      if (this.fin())
      {
        return this.error('Unterminated string!');
      }
      const curr = this.advance();
      if (curr === '"')
      {
        return Token(TokenType.STRING, this, string); // final (or only) segment
      }
      if (curr === '#' && this.spy('{'))
      {
        this.advance(); // consume '{'
        this.interps.push(1);
        return Token(TokenType.INTERP, this, string); // segment before an interpolation; more follows
      }
      if (curr === '\\')
      {
        switch (this.look())
        {
          case 'n': string += '\n'; break;
          case 'r': string += '\r'; break;
          case 't': string += '\t'; break;
          case '"': string += '"'; break;
          case '\\': string += '\\'; break;
          case '\n': break;
          default:
            return this.error(`Unrecognized escape: \\${this.look()}`);
        }
        this.advance();
        continue;
      }
      if (curr === '\n') this.newLine();
      string += curr;
    }
  }
  scan()
  {
    this.skipUseless();
    this.start = this.curr;
    if (this.fin())
    {
      return Token(TokenType.EOF, this);
    }
    const char = this.advance();
    switch (char)
    {
      case '\n':
        this.newLine();
        return Token(TokenType.ENDL, this);
      case ':':
        if (this.match('='))
        {
          return Token(TokenType.ASSIGN_DEF, this);
        }
        return Token(TokenType.COLON, this);
      case '+':
        if (this.match('+')) return Token(TokenType.INCREMENT, this);
        return Token(TokenType.PLUS, this);
      case '-':
        return Token(TokenType.SUB, this);
      case '*':
        return Token(TokenType.MUL, this);
      case '/':
        return Token(TokenType.DIV, this);
      case ',':
        return Token(TokenType.COMMA, this);
      case '.':
        return Token(TokenType.DOT, this);
      case '&':
        return Token(TokenType.BIT_AND, this);
      case '|':
        return Token(TokenType.BIT_OR, this);
      case '^':
        return Token(TokenType.BIT_XOR, this);
      case '~':
        return Token(TokenType.BIT_NOT, this);
      case '=':
        if (this.match('=')) return Token(TokenType.EQ_EQ, this);
        return Token(TokenType.ASSIGN, this);
      case '!':
        if (this.match('=')) return Token(TokenType.NEQ, this);
        return this.error("unexpected '!' (use 'not' for logical negation)");
      case '<':
        if (this.match('<')) return Token(TokenType.SHL, this);
        return Token(this.match('=') ? TokenType.LE : TokenType.LT, this);
      case '>':
        if (this.match('>')) return Token(TokenType.SHR, this);
        return Token(this.match('=') ? TokenType.GE : TokenType.GT, this);
      case '"':
        return this.doubleString();
      case '{':
        if (this.interps.length > 0)
        {
          ++this.interps[this.interps.length - 1];
        }
        return Token(TokenType.L_BRACE, this);
      case '}':
        if (this.interps.length > 0)
        {
          --this.interps[this.interps.length - 1];
          if (this.interps[this.interps.length - 1] <= 0)
          {
            this.interps.pop();
            return this.doubleString(); // resume scanning the string body after the interpolated expr
          }
        }
        return Token(TokenType.R_BRACE, this);
      case '(':
        return Token(TokenType.L_PAREN, this);
      case ')':
        return Token(TokenType.R_PAREN, this);
      case '[':
        return Token(TokenType.L_BRACK, this);
      case ']':
        return Token(TokenType.R_BRACK, this);
      default:
      {
        if (this.isDigit(char))
        {
          let type = TokenType.INT;
          while (this.isDigit(this.look())) this.advance();
          if (this.match('.'))
          {
            type = TokenType.REAL;
            while (this.isDigit(this.look())) this.advance();
          }
          return Token(type, this);
        }
        else if (this.isAlpha(char))
        {
          while (this.isAlphaNum(this.look())) this.advance();
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

function funcSig(arg_types, ret_type)
{
  const args = arg_types.join(', ');
  return `fun(${args}) : ${ret_type}`;
}
class TypeRegistry
{
  constructor()
  {
    this.types = new Map();
    this.types.set("i32",      { isPrimitive: true, llvmString: "i32", size: 4 });
    this.types.set("f32",      { isPrimitive: true, llvmString: "float", size: 4 });
    this.types.set("bool",     { isPrimitive: true, llvmString: "i1", size: 4 });
    this.types.set("CPointer", { isPrimitive: true, llvmString: "ptr", size: 8 });
    this.types.set("str",      { isPrimitive: true, llvmString: "ptr", size: 8 });
    this.types.set("void",     { isPrimitive: true, llvmString: "void", size: 0 });
  }
  func(arg_types, ret_type)
  {
    const signature = funcSig(arg_types, ret_type);
    if (this.types.has(signature)) return this.types.get(signature);
    const functionDefinition = {
      isPrimitive: false, isFunction: true, llvmString: "ptr", size: 8,
      args: arg_types, ret_type, signature
    };
    this.types.set(signature, functionDefinition);
    return functionDefinition;
  }
  array(elementTypeName, length)
  {
    const key = `${elementTypeName}[${length}]`;
    if (this.types.has(key)) return this.types.get(key);
    const elemEntry = this.types.get(elementTypeName);
    const elemLlvm = elemEntry ? elemEntry.llvmString : 'i32';
    const elemSize = elemEntry ? elemEntry.size : 4;
    const def = {
      isPrimitive: false, isArray: true,
      elementType: elementTypeName, length, elemLlvm, elemSize,
      llvmString: `{ i32, [${length} x ${elemLlvm}] }`,
      size: 4 + length * elemSize,
    };
    this.types.set(key, def);
    return def;
  }
  isValidType(name)
  {
    return this.types.has(name);
  }
}

const NodeType = Enum(
  'BINARY', 'UNARY', 'GROUP', 'STRING', 'NULL', 'REAL', 'INT', 'GET',
  'TRUE', 'FALSE', 'AND', 'OR', 'IF', 'NOT', 'GET_PROP', 'SET_PROP', 'INTERP', 'BECOME',
  'STRUCT_LIT', 'METHOD_CALL', 'ARRAY_LIT', 'SUBSCRIPT', 'SET_SUBSCRIPT', 'NEW',
  'RETURN', 'DECLARE', 'ASSIGN', 'BLOCK', 'FUNC', 'FUNC_CALL', 'END'
);

const Node = (() =>
{
  const base = (type, line = 0, datatype = null) => ({ type, line });
  return {
    Constant: (type, token, datatype) => ({ ...base(type, token.line, datatype), value: token.value }),
    Nilary: base,
    Unary: (type, value, line = 0, datatype = null) => ({ ...base(type, line, datatype), value }),
    UnaryOp: (op, value, line = 0, datatype) => ({ ...base(NodeType.UNARY, line, datatype), value, op }),
    Binary: (type, left, right, line = 0, datatype = null) => ({ ...base(type, line, datatype), left, right }),
    BinaryOp: (op, left, right, line = 0, datatype) => ({ ...base(NodeType.BINARY, line, datatype), left, right, op }),
    Get: (token, datatype) => ({ ...base(NodeType.GET, token.line, datatype), name: token.value }),
    Func: (name, args, ret_type, sig, body, line = 0, isExtern = false) => ({
      ...base(NodeType.FUNC, line, sig), name, args, ret_type, body, isExtern
    }),
    Block: (statements, line = 0) => ({ ...base(NodeType.BLOCK, line), statements }),
    Declare: (name, declaredType, value, mutable, line = 0) => ({
      ...base(NodeType.DECLARE, line), name, declaredType, value, mutable
    }),
    Assign: (name, value, line = 0) => ({
      ...base(NodeType.ASSIGN, line), name, value
    }),
  };
})();

class Parser
{
  constructor(source)
  {
    this.source   = source;
    this.manifest = { classes: new Map(), globals: new Map(), funcs: new Map() };
    this.curr     = null;
    this.prev     = null;
    this.panic    = false;
    this.lexer    = new Lexer(source);
    this.registry = new TypeRegistry();
  }
  advance()
  {
    this.prev = this.curr;
    this.curr = this.lexer.scan();
    return this.curr;
  }
  error(token, message)
  {
    console.log(`[${token.line}:${token.col}] ${message}`);
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
      return this.prev;
    }
    this.advance();
    this.error(this.curr, error);
    return this.prev;
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
  get atEnd()
  {
    return this.sniff(TokenType.EOF);
  }
  skipBreaks()
  {
    while (this.taste(TokenType.ENDL));
  }

  // ---------- top level ----------

  parse()
  {
    this.advance();
    this.skipBreaks();
    this.topLevel();
    return this.manifest;
  }

  // Parses a type name, optionally followed by an array-size suffix
  // (e.g. 'str[10]'). Array types are registered with the TypeRegistry
  // immediately, memoized by (elementType, length) — the returned string
  // ('str[10]') IS the type's name from here on, used everywhere a plain
  // type name would be.
  parseType()
  {
    const base = this.eat(TokenType.ID, "expected type").value;
    if (this.taste(TokenType.L_BRACK))
    {
      const sizeTok = this.eat(TokenType.INT, "expected array size");
      this.eat(TokenType.R_BRACK, "expected ']'");
      const length = parseInt(sizeTok.value, 10);
      this.registry.array(base, length);
      return `${base}[${length}]`;
    }
    return base;
  }

  parseArgList()
  {
    const args = [];
    this.eat(TokenType.L_PAREN, "expected opening parenthesis");
    this.skipBreaks();
    if (this.sniff(TokenType.ID))
    {
      do
      {
        this.skipBreaks();
        const argName = this.eat(TokenType.ID, "expected identifier").value;
        this.skipBreaks();
        this.eat(TokenType.COLON, "expected colon");
        this.skipBreaks();
        const argType = this.parseType();
        args.push({ name: argName, type: argType });
        this.skipBreaks();
      } while (this.taste(TokenType.COMMA));
    }
    this.skipBreaks();
    this.eat(TokenType.R_PAREN, "expected closing parenthesis");
    return args;
  }

  topLevel()
  {
    while (!this.atEnd)
    {
      this.skipBreaks();
      if (this.atEnd) break;

      const isExtern = this.taste(TokenType.EXTERN);
      if (isExtern) this.skipBreaks();

      if (this.taste(TokenType.LET))
      {
        this.skipBreaks();
        const name = this.eat(TokenType.ID, "expected identifier after 'let'");
        let declaredType = null;
        this.skipBreaks();
        if (this.taste(TokenType.COLON))
        {
          this.skipBreaks();
          declaredType = this.parseType();
          this.skipBreaks();
        }
        this.eat(TokenType.ASSIGN_DEF, "expected ':=' in global declaration");
        this.skipBreaks();
        const value = this.expr();
        // Global initializers must be compile-time constants under this
        // model — LLVM globals need constant initializers. Runtime-computed
        // globals would need a synthesized startup function; not supported
        // yet, so just record the declared/inferred type and constant value.
        this.manifest.globals.set(name.value, { name: name.value, declaredType, value, mutable: false, line: name.line });
      }
      else if (this.taste(TokenType.FUN))
      {
        this.skipBreaks();
        const name = this.eat(TokenType.ID, "expected identifier.");
        this.skipBreaks();
        const args = this.parseArgList();
        this.skipBreaks();
        this.eat(TokenType.COLON, "expected colon.");
        this.skipBreaks();
        const retType = this.parseType();
        this.skipBreaks();

        const type = this.registry.func(args.map(a => a.type), retType);

        if (isExtern)
        {
          this.manifest.funcs.set(name.value, Node.Func(name.value, args, retType, type.signature, null, name.line, true));
        }
        else
        {
          const body = this.parseBlock();
          this.manifest.funcs.set(name.value, Node.Func(name.value, args, retType, type.signature, body, name.line, false));
        }
      }
      else
      {
        this.error(this.curr, `unexpected token '${this.curr.value}'.`);
        this.advance();
      }
      this.skipBreaks();
    }
  }

  parseBlock()
  {
    this.eat(TokenType.L_BRACE, "expected opening brace");
    const statements = [];
    this.skipBreaks();
    while (!this.taste(TokenType.R_BRACE))
    {
      if (this.atEnd)
      {
        this.error(this.curr, "unexpected end of file");
        return Node.Block(statements);
      }
      statements.push(this.stmt());
      this.skipBreaks();
    }
    return Node.Block(statements);
  }

  // ---------- statements ----------

  stmt()
  {
    if (this.taste(TokenType.RET))
    {
      this.skipBreaks();
      if (this.sniff(TokenType.R_BRACE) || this.atEnd)
      {
        return Node.Unary(NodeType.RETURN, null);
      }
      return Node.Unary(NodeType.RETURN, this.expr());
    }
    if (this.taste(TokenType.BECOME))
    {
      this.skipBreaks();
      const target = this.expr();

      // Grouping parens are pure passthrough (no computation of their own —
      // see emitNode's GROUP case), so a call buried under one or more
      // layers of '(...)' is exactly as valid a tail-call target as a bare
      // call. Unwrap down to the real call before validating.
      let unwrapped = target;
      while (unwrapped.type === NodeType.GROUP)
      {
        unwrapped = unwrapped.value;
      }

      if (unwrapped.type !== NodeType.FUNC_CALL && unwrapped.type !== NodeType.METHOD_CALL)
      {
        this.error(this.prev, "'become' must be followed by a function or method call (parentheses around it are fine)");
      }
      return { type: NodeType.BECOME, target: unwrapped, line: this.prev.line };
    }
    if (this.sniff(TokenType.IF))
    {
      return this.ifStmt();
    }
    if (this.sniff(TokenType.LET, TokenType.VAR))
    {
      const isVar = this.sniff(TokenType.VAR);
      this.advance();
      const name = this.eat(TokenType.ID, `expected identifier after '${isVar ? 'var' : 'let'}'`);
      let declaredType = null;
      this.skipBreaks();
      if (this.taste(TokenType.COLON))
      {
        this.skipBreaks();
        declaredType = this.parseType();
        this.skipBreaks();
      }
      this.eat(TokenType.ASSIGN_DEF, "expected ':=' in declaration");
      this.skipBreaks();
      const value = this.expr();
      return Node.Declare(name.value, declaredType, value, isVar, name.line);
    }
    // Reassignment: `name = expr`, `name[index] = expr`, or `name++` —
    // enforced later in the semantic-check pass (name resolution isn't
    // complete until the whole program has been parsed).
    if (this.sniff(TokenType.ID))
    {
      const savedCurr = this.curr, savedPrev = this.prev, savedLexerCurr = this.lexer.curr,
            savedLexerLine = this.lexer.line, savedLexerCol = this.lexer.col;
      const name = this.curr;
      this.advance();

      if (this.taste(TokenType.ASSIGN))
      {
        this.skipBreaks();
        const value = this.expr();
        return Node.Assign(name.value, value, name.line);
      }
      if (this.taste(TokenType.INCREMENT))
      {
        // Desugars to `name = name + 1` — reuses existing Assign/BinaryOp
        // nodes, no new emitter case needed at all.
        const one = { type: NodeType.INT, line: name.line, value: '1' };
        return Node.Assign(name.value, Node.BinaryOp(TokenType.PLUS, Node.Get(name), one, name.line), name.line);
      }
      if (this.taste(TokenType.L_BRACK))
      {
        const indexExpr = this.expr();
        this.eat(TokenType.R_BRACK, "expected ']'");
        if (this.taste(TokenType.ASSIGN))
        {
          this.skipBreaks();
          const value = this.expr();
          return { type: NodeType.SET_SUBSCRIPT, object: Node.Get(name), index: indexExpr, value, line: name.line };
        }
        // 'name[index]' with no following '=' — not an assignment after
        // all (e.g. it's a bare subscript-read expression statement).
        // Fall through by rewinding completely and reparsing as an
        // ordinary expression.
      }

      // Not an assignment of any recognized shape — rewind and fall
      // through to ordinary expression parsing.
      this.curr = savedCurr;
      this.prev = savedPrev;
      this.lexer.curr = savedLexerCurr;
      this.lexer.line = savedLexerLine;
      this.lexer.col = savedLexerCol;
    }
    return this.expr();
  }

  ifStmt()
  {
    this.eat(TokenType.IF, "expected 'if'");
    const cond = this.expr();
    this.skipBreaks();
    const thenBranch = this.parseBlock();
    let elseBranch = null;
    const savedCurr = this.curr, savedPrev = this.prev, savedLexerCurr = this.lexer.curr,
          savedLexerLine = this.lexer.line, savedLexerCol = this.lexer.col;
    this.skipBreaks();
    if (this.taste(TokenType.ELSE))
    {
      this.skipBreaks();
      elseBranch = this.sniff(TokenType.IF) ? this.ifStmt() : this.parseBlock();
    }
    else
    {
      this.curr = savedCurr;
      this.prev = savedPrev;
      this.lexer.curr = savedLexerCurr;
      this.lexer.line = savedLexerLine;
      this.lexer.col = savedLexerCol;
    }
    return { type: NodeType.IF, cond, thenBranch, elseBranch, isExpr: false };
  }

  // ---------- expressions, loosest to tightest ----------

  expr()
  {
    const value = this.orExpr();
    if (this.taste(TokenType.IF))
    {
      const cond = this.orExpr();
      this.eat(TokenType.ELSE, "expected 'else' in if-expression");
      const elseExpr = this.expr();
      return { type: NodeType.IF, thenExpr: value, cond, elseExpr, isExpr: true };
    }
    return value;
  }

  orExpr()
  {
    let left = this.andExpr();
    while (this.taste(TokenType.OR))
    {
      this.skipBreaks();
      left = Node.Binary(NodeType.OR, left, this.andExpr());
    }
    return left;
  }

  andExpr()
  {
    let left = this.bitwiseExpr();
    while (this.taste(TokenType.AND))
    {
      this.skipBreaks();
      left = Node.Binary(NodeType.AND, left, this.bitwiseExpr());
    }
    return left;
  }

  bitwiseExpr()
  {
    let left = this.comparison();
    while (this.sniff(TokenType.BIT_AND, TokenType.BIT_OR, TokenType.BIT_XOR, TokenType.SHL, TokenType.SHR))
    {
      this.advance();
      const op = this.prev.type;
      this.skipBreaks();
      left = Node.BinaryOp(op, left, this.comparison());
    }
    return left;
  }

  comparison()
  {
    let left = this.term();
    while (this.sniff(TokenType.LT, TokenType.GT, TokenType.LE, TokenType.GE, TokenType.EQ_EQ, TokenType.NEQ))
    {
      this.advance();
      const op = this.prev.type;
      this.skipBreaks();
      left = Node.BinaryOp(op, left, this.term());
    }
    return left;
  }

  term()
  {
    let left = this.factorExpr();
    while (this.sniff(TokenType.PLUS, TokenType.SUB))
    {
      this.advance();
      const op = this.prev.type;
      this.skipBreaks();
      left = Node.BinaryOp(op, left, this.factorExpr());
    }
    return left;
  }

  factorExpr()
  {
    let left = this.unary();
    while (this.sniff(TokenType.MUL, TokenType.DIV))
    {
      this.advance();
      const op = this.prev.type;
      this.skipBreaks();
      left = Node.BinaryOp(op, left, this.unary());
    }
    return left;
  }

  unary()
  {
    if (this.sniff(TokenType.SUB, TokenType.NOT, TokenType.BIT_NOT, TokenType.PLUS))
    {
      this.advance();
      const token = this.prev;
      this.skipBreaks();
      return Node.UnaryOp(token.type, this.unary(), token.line);
    }
    return this.atom();
  }

  atom()
  {
    let result;
    if (this.taste(TokenType.INT))
    {
      result = Node.Constant(NodeType.INT, this.prev);
    }
    else if (this.taste(TokenType.REAL))
    {
      result = Node.Constant(NodeType.REAL, this.prev);
    }
    else if (this.taste(TokenType.STRING))
    {
      result = Node.Constant(NodeType.STRING, this.prev);
    }
    else if (this.taste(TokenType.INTERP))
    {
      // First segment already consumed; parse the interpolated expression,
      // then keep alternating string-segment/expression until a plain
      // STRING token (no more interpolation) closes it out.
      const parts = [{ kind: 'str', value: this.prev.value }];
      parts.push({ kind: 'expr', node: this.expr() });
      while (this.taste(TokenType.INTERP))
      {
        parts.push({ kind: 'str', value: this.prev.value });
        parts.push({ kind: 'expr', node: this.expr() });
      }
      this.eat(TokenType.STRING, "expected closing string segment after interpolation");
      parts.push({ kind: 'str', value: this.prev.value });
      result = { type: NodeType.INTERP, parts, line: this.prev.line };
    }
    else if (this.taste(TokenType.TRUE))
    {
      result = Node.Nilary(NodeType.TRUE, this.prev.line);
    }
    else if (this.taste(TokenType.FALSE))
    {
      result = Node.Nilary(NodeType.FALSE, this.prev.line);
    }
    else if (this.taste(TokenType.NULL))
    {
      result = Node.Nilary(NodeType.NULL, this.prev.line);
    }
    else if (this.taste(TokenType.NEW))
    {
      this.skipBreaks();
      const inner = this.unary(); // 'new' binds like a unary prefix operator
      result = { type: NodeType.NEW, inner, line: this.prev.line };
    }
    else if (this.taste(TokenType.L_BRACE))
    {
      // Array literal: { e1, e2, ... } or empty {} (type comes from context,
      // e.g. a 'let arr : str[10] := {}' declaration).
      const elements = [];
      this.skipBreaks();
      if (!this.sniff(TokenType.R_BRACE))
      {
        do
        {
          this.skipBreaks();
          elements.push(this.expr());
          this.skipBreaks();
        } while (this.taste(TokenType.COMMA));
      }
      this.eat(TokenType.R_BRACE, "expected '}'");
      result = { type: NodeType.ARRAY_LIT, elements, line: this.prev.line };
    }
    else if (this.taste(TokenType.ID))
    {
      const name = this.prev;
      if (this.taste(TokenType.L_PAREN))
      {
        const args = [];
        this.skipBreaks();
        if (!this.sniff(TokenType.R_PAREN))
        {
          do
          {
            this.skipBreaks();
            args.push(this.expr());
            this.skipBreaks();
          } while (this.taste(TokenType.COMMA));
        }
        this.eat(TokenType.R_PAREN, "expected closing parenthesis");
        result = { type: NodeType.FUNC_CALL, name: name.value, args, line: name.line };
      }
      else
      {
        result = Node.Get(name);
      }
    }
    else if (this.taste(TokenType.L_PAREN))
    {
      this.skipBreaks();
      const inner = this.expr();
      this.skipBreaks();
      this.eat(TokenType.R_PAREN, 'Expected closing parenthesis.');
      result = Node.Unary(NodeType.GROUP, inner, this.prev.line);
    }
    else
    {
      this.error(this.curr, `unexpected token: ${this.curr.str}`);
      this.advance();
      result = Node.Nilary(NodeType.NULL, this.curr.line);
    }

    // Postfix subscript: arr[index], chainable (arr[i][j] if ever needed).
    // Structured as a loop so '.' (field/method access) can join this same
    // postfix chain later without restructuring.
    while (this.sniff(TokenType.L_BRACK))
    {
      this.advance();
      const indexExpr = this.expr();
      this.eat(TokenType.R_BRACK, "expected ']'");
      result = { type: NodeType.SUBSCRIPT, object: result, index: indexExpr, line: this.prev.line };
    }

    return result;
  }
}

function literalDatatype(node)
{
  switch (node.type)
  {
    case NodeType.INT:    return 'i32';
    case NodeType.REAL:   return 'float';
    case NodeType.STRING: return 'str';
    case NodeType.TRUE:
    case NodeType.FALSE:  return 'bool';
    case NodeType.NULL:   return 'CPointer';
    default:              return null; // non-constant global initializer — not supported yet
  }
}

class Checker
{
  constructor(manifest, registry)
  {
    this.manifest = manifest;
    this.errors   = [];
    this.registry = registry;
    this.currFunc = null;
    this.symbols  = { funcs: new Map(), globals: new Map(), registry };
  }
  error(node, msg)
  {
    this.errors.push(`[line ${node.line}] ${msg}`);
  }
  buildSymbolTable()
  {
    for (const [name, funcNode] of this.manifest.funcs)
    {
      this.symbols.funcs.set(name, {
        paramTypes: funcNode.args.map(a => a.type),
        returnType: funcNode.ret_type,
        signature:  funcSig(funcNode.args.map(a => a.type), funcNode.ret_type),
      });
    }
    for (const [name, globalNode] of this.manifest.globals)
    {
      const inferred = globalNode.declaredType ?? literalDatatype(globalNode.value);
      this.symbols.globals.set(name, { type: inferred, mutable: !!globalNode.mutable });
    }
  }
  check()
  {
    this.buildSymbolTable(); // Pass A
    for (const [, funcNode] of this.manifest.funcs)
    {
      if (funcNode.isExtern) continue; // no body to check
      this.currFunc = funcNode;
      const scope = new Map(funcNode.args.map(a => [a.name, { type: a.type, mutable: false }]));
      this.checkBlock(funcNode.body, scope); // Pass B
    }
    if (this.errors.length > 0)
    {
      throw new Error(`Semantic errors:\n${this.errors.join('\n')}`);
    }
  }
  resolveName(name, scope)
  {
    if (scope.has(name))
    {
      return { ...scope.get(name), kind: 'local' };
    }
    if (this.symbols.globals.has(name))
    {
      return { ...this.symbols.globals.get(name), kind: 'global' };
    }
    return null;
  }
  checkBlock(block, scope)
  {
    // Fresh scope layer per block so sibling blocks (e.g. if/else arms) don't
    // leak declarations into each other, while still seeing everything the
    // parent scope already had.
    const localScope = new Map(scope);
    let terminated = false;
    for (const stmt of block.statements)
    {
      if (terminated)
      {
        this.error(stmt, `unreachable code after 'return'/'become'`);
      }
      this.checkNode(stmt, localScope);
      if (stmt.type === NodeType.RETURN || stmt.type === NodeType.BECOME)
      {
        terminated = true;
      }
    }
  }
  checkNode(node, scope)
  {
    switch (node.type)
    {
      case NodeType.DECLARE:
      {
        // An empty (or partially-typed) array literal initializer carries no
        // type information of its own — thread the declared type down before
        // checking, so `let arr : str[10] := {}` knows what it's an array of.
        if (node.value.type === NodeType.ARRAY_LIT && node.declaredType)
        {
          node.value.expectedType = node.declaredType;
        }

        // Check the initializer BEFORE adding this name to scope: this makes
        // `let x := x` (self-reference in its own initializer) correctly
        // resolve against any outer/global 'x' rather than the not-yet-bound
        // local, and correctly fail as undeclared if no such outer binding
        // exists.
        this.checkNode(node.value, scope);

        if (this.symbols.globals.has(node.name))
        {
          this.error(node,
            `local '${node.name}' has the same name as a global — ` +
            `this is almost always a mistake (e.g. a 'let ${node.name}' meant to appear ` +
            `earlier in this function). Rename one of them.`
          );
        }

        node.datatype = node.value.datatype ?? node.declaredType;
        scope.set(node.name, { type: node.datatype, mutable: !!node.mutable });
        return;
      }

      case NodeType.ASSIGN:
      {
        const binding = this.resolveName(node.name, scope);
        this.checkNode(node.value, scope);
        if (!binding)
        {
          this.error(node, `assignment to undeclared name '${node.name}'`);
        }
        else if (!binding.mutable)
        {
          this.error(node, `cannot assign to '${node.name}': declared with 'let', not 'var'`);
        }
        else if (binding.type && node.value.datatype && binding.type !== node.value.datatype)
        {
          this.error(node, `cannot assign ${node.value.datatype} to '${node.name}' (declared ${binding.type})`);
        }
        return;
      }

      case NodeType.RETURN:
        if (node.value === null)
        {
          if (this.currFunc?.ret_type !== 'void')
          {
            this.error(node, `bare 'return' requires a void function (this returns ${this.currFunc.ret_type})`);
          }
          return;
        }
        this.checkNode(node.value, scope);
        if (this.currFunc.ret_type && node.value.datatype && node.value.datatype !== this.currFunc.ret_type)
        {
          this.error(node, `return type mismatch: expected ${this.currFunc.ret_type}, got ${node.value.datatype}`);
        }
        return;

      case NodeType.BECOME:
      {
        let targetCall = node.target;
        while (targetCall && targetCall.type === NodeType.GROUP)
        {
          targetCall = targetCall.value;
        }
        this.checkNode(targetCall, scope);
        const callee = this.symbols.funcs.get(targetCall.name);
        const calleeName = targetCall.name;
        const calleeSig = callee?.signature;
        const outerSig  = this.symbols.funcs.get(this.currFunc?.name)?.signature;

        if (targetCall.type === NodeType.METHOD_CALL)
        {
          const receiver = node.target.object;
          const isSelf = receiver.type === NodeType.GET && receiver.name === 'self';
          if (!isSelf)
          {
            const receiverDesc = receiver.type === NodeType.GET ? `'${receiver.name}'` : 'this expression';
            this.error(node,
              `'become' may only tail-call a method on 'self', not on ${receiverDesc}`
            );
          }
        }
        if (calleeSig && outerSig)
        {
          console.log(`\x1b[36m${calleeSig}, ${outerSig}\x1b[0m`);
          if (calleeSig !== outerSig)
          {
            this.error(node, 
              `'become' requires an identical signature: '${calleeName}' is ${calleeSig}, ` +
              `but '${this.currFunc.name}' is ${outerSig}`
            );
          }
        }
        
        // Stamping the datatype ensures the Emitter knows the exact layout size
        node.datatype = targetCall.datatype;
        return;
      }

      case NodeType.BLOCK:
        this.checkBlock(node, scope);
        return;

      case NodeType.BINARY:
      {
        this.checkNode(node.left, scope);
        this.checkNode(node.right, scope);
        if (node.left.datatype && node.right.datatype && node.left.datatype !== node.right.datatype)
        {
          this.error(node, `type mismatch: ${node.left.datatype} vs ${node.right.datatype}`);
        }
        const cmpOps = new Set([TokenType.LT, TokenType.GT, TokenType.LE, TokenType.GE, TokenType.EQ_EQ, TokenType.NEQ]);
        node.datatype = cmpOps.has(node.op) ? 'bool' : node.left.datatype;
        return;
      }

      case NodeType.AND:
      case NodeType.OR:
        this.checkNode(node.left, scope);
        this.checkNode(node.right, scope);
        node.datatype = 'bool';
        return;

      case NodeType.UNARY:
      case NodeType.GROUP:
        this.checkNode(node.value, scope);
        node.datatype = node.value.datatype;
        return;

      case NodeType.IF:
        this.checkNode(node.cond, scope);
        if (node.isExpr)
        {
          this.checkNode(node.thenExpr, scope);
          this.checkNode(node.elseExpr, scope);
          if (node.thenExpr.datatype !== node.elseExpr.datatype)
          {
            this.error(node, `if-expression branches have mismatched types: ${node.thenExpr.datatype} vs ${node.elseExpr.datatype}`);
          }
          node.datatype = node.thenExpr.datatype;
        }
        else
        {
          this.checkBlock(node.thenBranch, scope);
          if (node.elseBranch)
          {
            node.elseBranch.type === NodeType.BLOCK
              ? this.checkBlock(node.elseBranch, scope)
              : this.checkNode(node.elseBranch, scope); // else-if chain
          }
        }
        return;

      case NodeType.FUNC_CALL:
      {

        const sig = this.symbols.funcs.get(node.name);
        if (!sig)
        {
          this.error(node, `call to undefined function '${node.name}'`);
          for (const arg of node.args) this.checkNode(arg, scope);
          node.datatype = null;
          return;
        }
        node.args.forEach((arg, i) =>
        {
          this.checkNode(arg, scope);
          if (sig.paramTypes[i] && arg.datatype && arg.datatype !== sig.paramTypes[i])
          {
            this.error(node, `argument ${i} to '${node.name}': expected ${sig.paramTypes[i]}, got ${arg.datatype}`);
          }
        });
        if (node.args.length !== sig.paramTypes.length)
        {
          this.error(node, `'${node.name}' expects ${sig.paramTypes.length} argument(s), got ${node.args.length}`);
        }
        node.datatype = sig.returnType;
        return;
      }

      case NodeType.ARRAY_LIT:
      {
        const expected = node.expectedType; // e.g. 'str[10]', set by DECLARE when available
        const typeEntry = expected && this.symbols.registry?.types.get(expected);
        for (const el of node.elements)
        {
          this.checkNode(el, scope);
          if (typeEntry && el.datatype && el.datatype !== typeEntry.elementType)
          {
            this.error(node, `array element has type ${el.datatype}, expected ${typeEntry.elementType}`);
          }
        }
        if (typeEntry && node.elements.length > typeEntry.length)
        {
          this.error(node, `array literal has ${node.elements.length} elements, exceeds declared size ${typeEntry.length}`);
        }
        node.datatype = expected ?? null;
        if (!node.datatype)
        {
          this.error(node, `cannot infer array type for '{}' — annotate with a declared type (e.g. 'let x : T[N] := {...}')`);
        }
        return;
      }

      case NodeType.SUBSCRIPT:
      {
        this.checkNode(node.object, scope);
        this.checkNode(node.index, scope);
        const typeEntry = this.symbols.registry?.types.get(node.object.datatype);
        if (!typeEntry || !typeEntry.isArray)
        {
          this.error(node, `cannot index into non-array type '${node.object.datatype}'`);
          return;
        }
        node.datatype = typeEntry.elementType;
        return;
      }

      case NodeType.SET_SUBSCRIPT:
      {
        this.checkNode(node.object, scope);
        this.checkNode(node.index, scope);
        this.checkNode(node.value, scope);
        const typeEntry = this.symbols.registry?.types.get(node.object.datatype);
        if (!typeEntry || !typeEntry.isArray)
        {
          this.error(node, `cannot index into non-array type '${node.object.datatype}'`);
          return;
        }
        if (node.value.datatype && node.value.datatype !== typeEntry.elementType)
        {
          this.error(node, `cannot assign ${node.value.datatype} into array of ${typeEntry.elementType}`);
        }
        return;
      }

      case NodeType.NEW:
        this.checkNode(node.inner, scope);
        node.datatype = node.inner.datatype; // 'new "..."' is still a str/CPointer, just heap-backed
        return;

      case NodeType.GET:
      {
        const binding = this.resolveName(node.name, scope);
        if (!binding)
        {
          this.error(node, `use of undeclared name '${node.name}'`);
          return;
        }
        node.datatype = binding.type;
        return;
      }

      case NodeType.INT:    node.datatype = 'i32'; return;
      case NodeType.REAL:   node.datatype = 'float'; return;
      case NodeType.STRING: node.datatype = 'str'; return;

      case NodeType.INTERP:
      {
        for (const part of node.parts)
        {
          if (part.kind === 'expr')
          {
            this.checkNode(part.node, scope);
          }
        }
        node.datatype = 'str';
        return;
      }
      case NodeType.TRUE:
      case NodeType.FALSE:  node.datatype = 'bool'; return;
      case NodeType.NULL:   node.datatype = 'CPointer'; return;

      default:
        // Unknown node types are not a check-phase failure — new node kinds
        // should be added here as the language grows, but silently skipping
        // is safer than crashing the whole check pass over a language feature
        // this pass hasn't been taught about yet.
        return;
    }
  }
}

class Emitter
{
  constructor(sourceCode)
  {
    this.parser = new Parser(sourceCode);
    this.reg_counter   = 0;
    this.blockCounter  = 0;
    this.locals        = new Map();   // name -> { reg, type }
    this.blocks        = new Map();   // label -> string[]
    this.blockOrder    = [];
    this.currentBlock  = null;
    this.terminated    = new Set();
    this.usedNativeDeclares = new Set();
    this.stringPool    = new Map();   // literal -> byte offset
    this.stringBytes   = [];
  }

  llvmType(name)
  {
    const entry = this.parser.registry.types.get(name);
    return entry ? entry.llvmString : 'i32';
  }

  nextRegister() { return `%${this.reg_counter++}`; }
  newBlock(prefix = 'block') { return `${prefix}.${this.blockCounter++}`; }

  startBlock(label)
  {
    if (!this.blocks.has(label))
    {
      this.blocks.set(label, []);
      this.blockOrder.push(label);
    }
    this.currentBlock = label;
    return label;
  }

  emitInstr(line)
  {
    if (this.terminated.has(this.currentBlock))
    {
      throw new Error(`Attempted to emit into terminated block '${this.currentBlock}': ${line}`);
    }
    this.blocks.get(this.currentBlock).push(line);
  }

  terminate(line)
  {
    this.emitInstr(line);
    this.terminated.add(this.currentBlock);
  }

  internString(value)
  {
    if (this.stringPool.has(value)) return this.stringPool.get(value);
    const offset = this.stringBytes.length;
    const utf8 = Array.from(Buffer.from(value, 'utf8'));
    const len = utf8.length;
    this.stringBytes.push(len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >> 24) & 0xff);
    for (const byte of utf8) this.stringBytes.push(byte);
    this.stringPool.set(value, offset);
    return offset;
  }

  // ---------- top level ----------

  compile()
  {
    this.parser.parse();
    const checker = new Checker(this.parser.manifest, this.parser.registry);
    checker.check();
    return this.emit();
  }

  emit()
  {
    const declares = [];
    const defines = [];
    const globalDefs = [];

    for (const [name, globalNode] of this.parser.manifest.globals)
    {
      const type = this.llvmType(globalNode.declaredType ?? this.literalLlvmValue(globalNode.value).type);
      const { val } = this.literalLlvmValue(globalNode.value);
      globalDefs.push(`@${name} = global ${type} ${val}`);
    }

    for (const [, funcNode] of this.parser.manifest.funcs)
    {
      if (funcNode.isExtern)
      {
        declares.push(this.emitExternDecl(funcNode));
      }
      else
      {
        defines.push(this.emitFunc(funcNode));
      }
    }

    const header = [
      'target datalayout = "e-m:e-p:32:32-p10:32:32-p20:32:32-i64:64-n32:64-S128-ni:1:10:20"',
      'target triple = "wasm32-unknown-unknown"',
      ''
    ].join('\n');

    let strBufGlobal = '';
    if (this.stringBytes.length > 0)
    {
      const cStr = this.stringBytes.map(b => `\\${b.toString(16).padStart(2, '0')}`).join('');
      strBufGlobal = `@.strbuf = private unnamed_addr constant [${this.stringBytes.length} x i8] c"${cStr}", align 4\n\n`;
    }

    return `${header}\n${strBufGlobal}${globalDefs.join('\n')}\n\n${declares.join('\n')}\n\n${defines.join('\n\n')}`;
  }

  // Global initializers must currently be compile-time constant literals —
  // LLVM globals need constant initializers, and runtime-computed globals
  // would need a synthesized startup function, which isn't built yet.
  literalLlvmValue(node)
  {
    switch (node.type)
    {
      case NodeType.INT:  return { val: String(node.value), type: 'i32' };
      case NodeType.REAL: return { val: String(node.value), type: 'float' };
      case NodeType.TRUE: return { val: '1', type: 'i1' };
      case NodeType.FALSE: return { val: '0', type: 'i1' };
      default:
        throw new Error(`Global initializers must be constant literals (got ${NodeType[node.type]})`);
    }
  }

  emitExternDecl(node)
  {
    const retType = this.llvmType(node.ret_type);
    const argTypes = node.args.map(a => this.llvmType(a.type)).join(', ');
    const attrIndex = this.usedNativeDeclares.size;
    this.usedNativeDeclares.add(node.name);
    return `declare ${retType} @${node.name}(${argTypes}) #${attrIndex}\n` +
           `attributes #${attrIndex} = { "wasm-import-module"="env" "wasm-import-name"="${node.name}" }`;
  }

  emitFunc(node)
  {
    this.reg_counter  = 0;
    this.blockCounter = 0;
    this.locals       = new Map();
    this.blocks       = new Map();
    this.blockOrder   = [];
    this.terminated   = new Set();

    const llvmRetType = this.llvmType(node.ret_type);
    const funcName = node.name;

    const paramText = node.args.map(arg =>
    {
      const llvmArgType = this.llvmType(arg.type);
      const reg = this.nextRegister();
      this.locals.set(arg.name, { reg, type: llvmArgType });
      return `${llvmArgType} ${reg}`;
    }).join(', ');

    this.startBlock(this.newBlock('entry'));
    this.emitNode(node.body);

    if (!this.terminated.has(this.currentBlock))
    {
      // Implicit fallthrough with no return: emit a safe default terminator
      // rather than producing invalid IR.
      if (llvmRetType === 'void')
      {
        this.terminate('ret void');
      }
      else
      {
        this.terminate(`ret ${llvmRetType} zeroinitializer`);
      }
    }

    const blockText = this.blockOrder.map(label =>
    {
      const instrs = this.blocks.get(label).map(l => `  ${l}`).join('\n');
      return `${label}:\n${instrs}`;
    }).join('\n');

    return `define ${llvmRetType} @${funcName}(${paramText}) {\n${blockText}\n}`;
  }

  // ---------- node dispatch ----------

  emitNode(node)
  {
    switch (node.type)
    {
      case NodeType.BLOCK:     return this.emitBlock(node);
      case NodeType.RETURN:    return this.emitReturn(node);
      case NodeType.BECOME:    return this.emitBecome(node);
      case NodeType.DECLARE:   return this.emitDeclare(node);
      case NodeType.ASSIGN:    return this.emitAssign(node);
      case NodeType.INT:       return { val: String(node.value), type: 'i32' };
      case NodeType.STRING:    return this.emitStringLiteral(node);
      case NodeType.INTERP:    return this.emitInterp(node);
      case NodeType.TRUE:      return { val: '1', type: 'i1' };
      case NodeType.FALSE:     return { val: '0', type: 'i1' };
      case NodeType.GET:       return this.emitGet(node);
      case NodeType.BINARY:    return this.emitBinary(node);
      case NodeType.AND:       return this.emitLogicalAnd(node);
      case NodeType.OR:        return this.emitLogicalOr(node);
      case NodeType.IF:        return node.isExpr ? this.emitIfExpr(node) : this.emitIfStmt(node);
      case NodeType.FUNC_CALL: return this.emitCall(node);
      case NodeType.GROUP:     return this.emitNode(node.value);
      default:
        throw new Error(`Unhandled AST node type: ${NodeType[node.type]}`);
    }
  }

  emitBlock(node)
  {
    for (const stmt of node.statements)
    {
      this.emitNode(stmt);
    }
  }

  emitReturn(node)
  {
    if (node.value === null)
    {
      this.terminate('ret void');
      return;
    }
    const exprResult = this.emitNode(node.value);
    this.terminate(`ret ${exprResult.type} ${exprResult.val}`);
  }

  // 'become' guarantees tail-call elimination via LLVM's musttail — no new
  // stack frame is created; the current frame is reused. Handles both
  // ordinary function calls and method calls (which need the receiver
  // pointer as an extra leading argument).
  emitBecome(node)
  {
    const call = node.target;
    let calleeName, llvmRet, argText;

    if (call.type === NodeType.FUNC_CALL)
    {
      const funcNode = this.parser.manifest.funcs.get(call.name);
      llvmRet = this.llvmType(funcNode.ret_type);
      const argVals = call.args.map(a => this.emitNode(a));
      argText = argVals.map(a => `${a.type} ${a.val}`).join(', ');
      calleeName = call.name;
    }
    else // NodeType.METHOD_CALL
    {
      const objVal = this.emitNode(call.object);
      const argVals = call.args.map(a => this.emitNode(a));
      argText = ['ptr ' + objVal.val, ...argVals.map(a => `${a.type} ${a.val}`)].join(', ');
      calleeName = call.resolvedName;
      llvmRet = this.llvmType(call.datatype);
    }

    if (llvmRet === 'void')
    {
      this.emitInstr(`musttail call void @${calleeName}(${argText})`);
      this.terminate(`ret void`);
      return;
    }
    const reg = this.nextRegister();
    this.emitInstr(`${reg} = musttail call ${llvmRet} @${calleeName}(${argText})`);
    this.terminate(`ret ${llvmRet} ${reg}`);
  }

  emitDeclare(node)
  {
    const value = this.emitNode(node.value);
    if (!node.mutable)
    {
      // 'let': just an alias for whatever SSA value initialized it —
      // no memory needed at all, since it can never be reassigned.
      this.locals.set(node.name, { kind: 'ssa', reg: value.val, type: value.type, mutable: false });
      return;
    }
    // 'var': needs a real memory slot so it can be reassigned later.
    // Emitted as a naive alloca/store; trust LLVM's mem2reg optimization
    // pass to promote this back to efficient SSA/phi form.
    const slot = this.nextRegister();
    this.emitInstr(`${slot} = alloca ${value.type}`);
    this.emitInstr(`store ${value.type} ${value.val}, ptr ${slot}`);
    this.locals.set(node.name, { kind: 'alloca', slot, type: value.type, mutable: true });
  }

  emitAssign(node)
  {
    const local = this.locals.get(node.name);
    if (!local)
    {
      throw new Error(`Assignment to undeclared name: ${node.name}`);
    }
    // Mutability is enforced in the semantic-check pass (checkProgram),
    // which runs before emission ever starts — by this point the program
    // is assumed valid, so this is just codegen, not validation.
    const value = this.emitNode(node.value);
    this.emitInstr(`store ${value.type} ${value.val}, ptr ${local.slot}`);
    return { val: null, type: 'void' };
  }

  emitGet(node)
  {
    const local = this.locals.get(node.name);
    if (local)
    {
      if (local.kind === 'alloca')
      {
        const reg = this.nextRegister();
        this.emitInstr(`${reg} = load ${local.type}, ptr ${local.slot}`);
        return { val: reg, type: local.type };
      }
      return { val: local.reg, type: local.type };
    }

    const globalNode = this.parser.manifest.globals.get(node.name);
    if (globalNode)
    {
      const type = this.llvmType(node.datatype ?? globalNode.declaredType);
      const reg = this.nextRegister();
      this.emitInstr(`${reg} = load ${type}, ptr @${node.name}`);
      return { val: reg, type };
    }

    throw new Error(`Unresolved identifier: ${node.name}`);
  }

  emitStringLiteral(node)
  {
    const offset = this.internString(node.value);
    const val = `getelementptr inbounds (i8, ptr @.strbuf, i32 ${offset})`;
    return { val, type: 'ptr' };
  }

  // String interpolation lowers to a left-to-right chain of runtime
  // str_concat calls, with non-string pieces first converted via
  // int_to_str. Both are ordinary externs (see source: extern fun
  // int_to_str / str_concat) — no compiler magic, just calls.
  emitInterp(node)
  {
    let current = null; // { val, type: 'ptr' }
    const appendPiece = (piece) =>
    {
      if (current === null) { current = piece; return; }
      const reg = this.nextRegister();
      this.emitInstr(`${reg} = call ptr @str_concat(ptr ${current.val}, ptr ${piece.val})`);
      current = { val: reg, type: 'ptr' };
    };

    for (const part of node.parts)
    {
      if (part.kind === 'str')
      {
        if (part.value === '') continue; // skip empty segments (e.g. "...#{x}" with nothing after)
        const offset = this.internString(part.value);
        appendPiece({ val: `getelementptr inbounds (i8, ptr @.strbuf, i32 ${offset})`, type: 'ptr' });
      }
      else
      {
        const exprVal = this.emitNode(part.node);
        if (part.node.datatype === 'i32')
        {
          const reg = this.nextRegister();
          this.emitInstr(`${reg} = call ptr @int_to_str(i32 ${exprVal.val})`);
          appendPiece({ val: reg, type: 'ptr' });
        }
        else if (part.node.datatype === 'CPointer')
        {
          appendPiece({ val: exprVal.val, type: 'ptr' });
        }
        else
        {
          throw new Error(`Cannot interpolate a value of type '${part.node.datatype}' (line ${node.line})`);
        }
      }
    }

    // All-empty interpolation (degenerate, e.g. "#{}"): fall back to an
    // empty interned string rather than returning nothing.
    return current ?? { val: `getelementptr inbounds (i8, ptr @.strbuf, i32 ${this.internString('')})`, type: 'ptr' };
  }

  emitBinary(node)
  {
    const left = this.emitNode(node.left);
    const right = this.emitNode(node.right);

    const arithOps = {
      [TokenType.PLUS]: 'add', [TokenType.SUB]: 'sub',
      [TokenType.MUL]:  'mul', [TokenType.DIV]: 'sdiv',
      [TokenType.BIT_AND]: 'and', [TokenType.BIT_OR]: 'or', [TokenType.BIT_XOR]: 'xor',
      [TokenType.SHL]: 'shl', [TokenType.SHR]: 'ashr',
    };
    const cmpOps = {
      [TokenType.LT]: 'slt', [TokenType.GT]: 'sgt',
      [TokenType.LE]: 'sle', [TokenType.GE]: 'sge',
      [TokenType.EQ_EQ]: 'eq', [TokenType.NEQ]: 'ne',
    };

    if (arithOps[node.op])
    {
      if (left.type !== right.type)
      {
        throw new Error(`Type mismatch in binary op: ${left.type} vs ${right.type}`);
      }
      const reg = this.nextRegister();
      this.emitInstr(`${reg} = ${arithOps[node.op]} ${left.type} ${left.val}, ${right.val}`);
      return { val: reg, type: left.type };
    }
    if (cmpOps[node.op])
    {
      const reg = this.nextRegister();
      this.emitInstr(`${reg} = icmp ${cmpOps[node.op]} ${left.type} ${left.val}, ${right.val}`);
      return { val: reg, type: 'i1' };
    }
    throw new Error(`Unhandled binary operator: ${TokenType[node.op]}`);
  }

  // ---------- short-circuit and/or ----------

  emitLogicalAnd(node)
  {
    const left = this.emitNode(node.left);
    const entryBlock = this.currentBlock;

    const rhsLabel = this.newBlock('and.rhs');
    const mergeLabel = this.newBlock('and.merge');

    this.terminate(`br i1 ${left.val}, label %${rhsLabel}, label %${mergeLabel}`);

    this.startBlock(rhsLabel);
    const right = this.emitNode(node.right);
    const rhsEndBlock = this.currentBlock;
    this.terminate(`br label %${mergeLabel}`);

    this.startBlock(mergeLabel);
    const reg = this.nextRegister();
    this.emitInstr(`${reg} = phi i1 [ false, %${entryBlock} ], [ ${right.val}, %${rhsEndBlock} ]`);
    return { val: reg, type: 'i1' };
  }

  emitLogicalOr(node)
  {
    const left = this.emitNode(node.left);
    const entryBlock = this.currentBlock;

    const rhsLabel = this.newBlock('or.rhs');
    const mergeLabel = this.newBlock('or.merge');

    this.terminate(`br i1 ${left.val}, label %${mergeLabel}, label %${rhsLabel}`);

    this.startBlock(rhsLabel);
    const right = this.emitNode(node.right);
    const rhsEndBlock = this.currentBlock;
    this.terminate(`br label %${mergeLabel}`);

    this.startBlock(mergeLabel);
    const reg = this.nextRegister();
    this.emitInstr(`${reg} = phi i1 [ true, %${entryBlock} ], [ ${right.val}, %${rhsEndBlock} ]`);
    return { val: reg, type: 'i1' };
  }

  // ---------- if (statement and expression forms) ----------

  emitIfStmt(node)
  {
    const cond = this.emitNode(node.cond);
    const thenLabel = this.newBlock('if.then');
    const mergeLabel = this.newBlock('if.merge');
    const elseLabel = node.elseBranch ? this.newBlock('if.else') : mergeLabel;

    this.terminate(`br i1 ${cond.val}, label %${thenLabel}, label %${elseLabel}`);

    this.startBlock(thenLabel);
    this.emitNode(node.thenBranch);
    if (!this.terminated.has(this.currentBlock))
    {
      this.terminate(`br label %${mergeLabel}`);
    }

    if (node.elseBranch)
    {
      this.startBlock(elseLabel);
      this.emitNode(node.elseBranch);
      if (!this.terminated.has(this.currentBlock))
      {
        this.terminate(`br label %${mergeLabel}`);
      }
    }

    this.startBlock(mergeLabel);
  }

  emitIfExpr(node)
  {
    const cond = this.emitNode(node.cond);
    const thenLabel = this.newBlock('ifexpr.then');
    const elseLabel = this.newBlock('ifexpr.else');
    const mergeLabel = this.newBlock('ifexpr.merge');

    this.terminate(`br i1 ${cond.val}, label %${thenLabel}, label %${elseLabel}`);

    this.startBlock(thenLabel);
    const thenVal = this.emitNode(node.thenExpr);
    const thenEndBlock = this.currentBlock;
    this.terminate(`br label %${mergeLabel}`);

    this.startBlock(elseLabel);
    const elseVal = this.emitNode(node.elseExpr);
    const elseEndBlock = this.currentBlock;
    this.terminate(`br label %${mergeLabel}`);

    if (thenVal.type !== elseVal.type)
    {
      throw new Error(`if-expression branches have mismatched types: ${thenVal.type} vs ${elseVal.type}`);
    }

    this.startBlock(mergeLabel);
    const reg = this.nextRegister();
    this.emitInstr(`${reg} = phi ${thenVal.type} [ ${thenVal.val}, %${thenEndBlock} ], [ ${elseVal.val}, %${elseEndBlock} ]`);
    return { val: reg, type: thenVal.type };
  }

  // ---------- calls ----------

  emitCall(node)
  {
    const funcNode = this.parser.manifest.funcs.get(node.name);
    if (!funcNode)
    {
      throw new Error(`Call to undefined function: ${node.name}`);
    }
    const retType = this.llvmType(funcNode.ret_type);
    const argResults = node.args.map(a => this.emitNode(a));
    const argText = argResults.map(a => `${a.type} ${a.val}`).join(', ');

    if (retType === 'void')
    {
      this.emitInstr(`call void @${node.name}(${argText})`);
      return { val: null, type: 'void' };
    }
    const reg = this.nextRegister();
    this.emitInstr(`${reg} = call ${retType} @${node.name}(${argText})`);
    return { val: reg, type: retType };
  }
}

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