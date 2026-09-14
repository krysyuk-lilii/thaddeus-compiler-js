import { TokenType }        from './lexer.js'
import { Parser, NodeType } from './parser.js';
import { Checker }          from './checker.js';

export class Emitter
{
  constructor(sourceCode)
  {
    this.parser             = new Parser(sourceCode);
    this.reg_counter        = 0;
    this.blockCounter       = 0;
    this.locals             = new Map();   // name -> { reg, type }
    this.blocks             = new Map();   // label -> string[]
    this.blockOrder         = [];
    this.currentBlock       = null;
    this.terminated         = new Set();
    this.usedNativeDeclares = new Set();
    this.stringPool         = new Map();   // literal -> byte offset
    this.stringBytes        = [];
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
  arrLitLLVMVal(node, declaredType)
  {
    const entry = this.parser.registry.type.get(declaredType);
    if (!entry?.isArray)
    {
      throw new Error(`unkown array type: ${declaredType}`);
    }
    if (node.elements.length === 0)
    {
      return `zeroinitializer`;
    }
    const LLVMelems = node.elements.map(x =>
    {
      const { val, type } = this.literalLlvmValue(x);
      return `${ type } ${ val}`;
    });
    while (elems.length < entry.length)
    {
      elems.push(`${ entry.elemLlvm } zeroinitializer`);
    }
    return `{ i32 ${ entry.length }, [${ entry. length } x ${extry.elemLlvm }] [${ elems.join(', ') }] }`;
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
  
  emitArrayAddr(node)
  {
    let target = node;
    while (target.type === NodeType.GROUP)
    {
      target = target.value;
    }
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