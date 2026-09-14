import { Enum } from './util.js';

export const TokenType = Enum(
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

export class Lexer
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