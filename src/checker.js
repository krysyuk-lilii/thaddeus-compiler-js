import { TokenType } from './lexer.js';
import { NodeType }  from './parser.js';

export function funcSig(arg_types, ret_type)
{
  const args = arg_types.join(', ');
  return `fun(${args}) : ${ret_type}`;
}
export class TypeRegistry
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

export function literalDatatype(node)
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

export class Checker
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