import { Enum }             from './util.js';
import { Lexer, TokenType } from './lexer.js';
import { TypeRegistry }     from './checker.js';

export const NodeType = Enum(
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

export class Parser
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
  parseLet()
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
      this.eat(TokenType.ASSIGN, `expected '=' after type in global declaration`);
    }
    else
    {
      this.eat(TokenType.ASSIGN_DEF, "expected ':=' in global declaration");
    }
    this.skipBreaks();
    const value = this.expr();
    this.manifest.globals.set(name.value, { name: name.value, declaredType, value, mutable: false, line: name.line });
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
        this.parseLet();
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