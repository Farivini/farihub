/**
 * Structured pt-BR formula layer.
 *
 * IronCalc 0.9.1 has no Portuguese language pack (pt, pt-BR and pt-PT are rejected),
 * but its `es` locale already uses the pt-BR number syntax: comma decimal separator and
 * semicolon argument separator. The engine therefore runs with locale `es` and language
 * `en`, and this module only translates the tokens whose spelling differs:
 * function names, boolean literals and error literals.
 *
 * The translation is token based. Strings ("..."), quoted sheet names ('...'),
 * structured references ([...]), array constants ({...}), numbers, cell references,
 * ranges, sheet prefixes and defined names are copied verbatim.
 */

/** [English name used by the engine, Excel pt-BR name]. Pending confrontation with Excel pt-BR. */
export const FUNCTION_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['SUM', 'SOMA'], ['AVERAGE', 'MÉDIA'], ['AVERAGEA', 'MÉDIAA'], ['AVERAGEIF', 'MÉDIASE'],
  ['AVERAGEIFS', 'MÉDIASES'], ['IF', 'SE'], ['IFS', 'SES'], ['IFERROR', 'SEERRO'], ['IFNA', 'SENÃODISP'],
  ['SUMIF', 'SOMASE'], ['SUMIFS', 'SOMASES'], ['SUMPRODUCT', 'SOMARPRODUTO'], ['SUMSQ', 'SOMAQUAD'],
  ['COUNT', 'CONT.NÚM'], ['COUNTA', 'CONT.VALORES'], ['COUNTBLANK', 'CONTAR.VAZIO'], ['COUNTIF', 'CONT.SE'],
  ['COUNTIFS', 'CONT.SES'], ['MAX', 'MÁXIMO'], ['MAXA', 'MÁXIMOA'], ['MAXIFS', 'MÁXIMOSES'], ['MIN', 'MÍNIMO'],
  ['MINA', 'MÍNIMOA'], ['MINIFS', 'MÍNIMOSES'], ['MEDIAN', 'MED'], ['MODE', 'MODO'], ['STDEV', 'DESVPAD'],
  ['STDEV.S', 'DESVPAD.A'], ['STDEV.P', 'DESVPAD.P'], ['VAR', 'VAR'], ['LARGE', 'MAIOR'], ['SMALL', 'MENOR'],
  ['RANK', 'ORDEM'], ['RANK.EQ', 'ORDEM.EQ'], ['VLOOKUP', 'PROCV'], ['HLOOKUP', 'PROCH'], ['XLOOKUP', 'PROCX'],
  ['LOOKUP', 'PROC'], ['INDEX', 'ÍNDICE'], ['MATCH', 'CORRESP'], ['XMATCH', 'CORRESPX'], ['CHOOSE', 'ESCOLHER'],
  ['OFFSET', 'DESLOC'], ['INDIRECT', 'INDIRETO'], ['ROW', 'LIN'], ['ROWS', 'LINS'], ['COLUMN', 'COL'],
  ['COLUMNS', 'COLS'], ['TRANSPOSE', 'TRANSPOR'], ['UNIQUE', 'ÚNICO'], ['FILTER', 'FILTRO'], ['SORT', 'CLASSIFICAR'],
  ['SEQUENCE', 'SEQUÊNCIA'], ['HYPERLINK', 'HIPERLINK'], ['FORMULATEXT', 'FÓRMULATEXTO'], ['ROUND', 'ARRED'],
  ['ROUNDUP', 'ARREDONDAR.PARA.CIMA'], ['ROUNDDOWN', 'ARREDONDAR.PARA.BAIXO'], ['MROUND', 'MARRED'],
  ['TRUNC', 'TRUNCAR'], ['INT', 'INT'], ['MOD', 'MOD'], ['QUOTIENT', 'QUOCIENTE'], ['ABS', 'ABS'], ['SIGN', 'SINAL'],
  ['POWER', 'POTÊNCIA'], ['SQRT', 'RAIZ'], ['EXP', 'EXP'], ['LN', 'LN'], ['LOG', 'LOG'], ['LOG10', 'LOG10'], ['PI', 'PI'],
  ['RAND', 'ALEATÓRIO'], ['RANDBETWEEN', 'ALEATÓRIOENTRE'], ['PRODUCT', 'MULT'], ['FACT', 'FATORIAL'],
  ['COMBIN', 'COMBIN'], ['GCD', 'MDC'], ['LCM', 'MMC'], ['EVEN', 'PAR'], ['ODD', 'ÍMPAR'], ['CEILING', 'TETO'],
  ['FLOOR', 'ARREDMULTB'], ['CEILING.MATH', 'TETO.MAT'], ['FLOOR.MATH', 'ARREDMULTB.MAT'], ['AND', 'E'], ['OR', 'OU'],
  ['NOT', 'NÃO'], ['XOR', 'XOU'], ['TRUE', 'VERDADEIRO'], ['FALSE', 'FALSO'], ['SWITCH', 'PARÂMETRO'], ['LET', 'LET'],
  ['LAMBDA', 'LAMBDA'], ['CONCATENATE', 'CONCATENAR'], ['CONCAT', 'CONCAT'], ['TEXTJOIN', 'UNIRTEXTO'],
  ['LEFT', 'ESQUERDA'], ['RIGHT', 'DIREITA'], ['MID', 'EXT.TEXTO'], ['LEN', 'NÚM.CARACT'], ['UPPER', 'MAIÚSCULA'],
  ['LOWER', 'MINÚSCULA'], ['PROPER', 'PRI.MAIÚSCULA'], ['TRIM', 'ARRUMAR'], ['CLEAN', 'TIRAR'],
  ['SUBSTITUTE', 'SUBSTITUIR'], ['REPLACE', 'MUDAR'], ['FIND', 'PROCURAR'], ['SEARCH', 'LOCALIZAR'], ['TEXT', 'TEXTO'],
  ['VALUE', 'VALOR'], ['NUMBERVALUE', 'VALORNUMÉRICO'], ['EXACT', 'EXATO'], ['REPT', 'REPT'], ['CHAR', 'CARACT'],
  ['CODE', 'CÓDIGO'], ['UNICHAR', 'CARACTUNICODE'], ['UNICODE', 'UNICODE'], ['T', 'T'], ['N', 'N'],
  ['TEXTBEFORE', 'TEXTOANTES'], ['TEXTAFTER', 'TEXTODEPOIS'], ['TODAY', 'HOJE'], ['NOW', 'AGORA'], ['DATE', 'DATA'],
  ['DATEVALUE', 'DATA.VALOR'], ['TIME', 'TEMPO'], ['TIMEVALUE', 'VALOR.TEMPO'], ['YEAR', 'ANO'], ['MONTH', 'MÊS'],
  ['DAY', 'DIA'], ['HOUR', 'HORA'], ['MINUTE', 'MINUTO'], ['SECOND', 'SEGUNDO'], ['WEEKDAY', 'DIA.DA.SEMANA'],
  ['WEEKNUM', 'NÚMSEMANA'], ['ISOWEEKNUM', 'NÚMSEMANAISO'], ['EOMONTH', 'FIMMÊS'], ['EDATE', 'DATAM'],
  ['DATEDIF', 'DATADIF'], ['DAYS', 'DIAS'], ['NETWORKDAYS', 'DIATRABALHOTOTAL'], ['WORKDAY', 'DIATRABALHO'],
  ['YEARFRAC', 'FRAÇÃOANO'], ['PMT', 'PGTO'], ['FV', 'VF'], ['PV', 'VP'], ['NPV', 'VPL'], ['IRR', 'TIR'], ['RATE', 'TAXA'],
  ['NPER', 'NPER'], ['ISBLANK', 'ÉCÉL.VAZIA'], ['ISNUMBER', 'ÉNÚM'], ['ISTEXT', 'ÉTEXTO'], ['ISERROR', 'ÉERROS'],
  ['ISERR', 'ÉERRO'], ['ISNA', 'É.NÃO.DISP'], ['ISLOGICAL', 'ÉLÓGICO'], ['ISEVEN', 'ÉPAR'], ['ISODD', 'ÉIMPAR'],
  ['ISFORMULA', 'ÉFÓRMULA'], ['NA', 'NÃO.DISP'], ['SHEET', 'PLAN'], ['TYPE', 'TIPO'], ['ERROR.TYPE', 'TIPO.ERRO'],
];

/** [engine error literal, pt-BR error literal]. #ERROR! is IronCalc specific (Excel has no equivalent). */
export const ERROR_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['#DIV/0!', '#DIV/0!'], ['#VALUE!', '#VALOR!'], ['#REF!', '#REF!'], ['#NAME?', '#NOME?'], ['#NUM!', '#NÚM!'],
  ['#N/A', '#N/D'], ['#NULL!', '#NULO!'], ['#SPILL!', '#DESPEJAR!'], ['#CALC!', '#CALC!'], ['#ERROR!', '#ERRO!'],
  ['#CIRC!', '#CIRC!'], ['#N/IMPL!', '#N/IMPL!'],
];

const upper = (text: string) => text.toLocaleUpperCase('pt-BR');
const stripAccents = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '');

const ptToEn = new Map<string, string>();
const enToPt = new Map<string, string>();
for (const [en, pt] of FUNCTION_NAMES) {
  ptToEn.set(upper(pt), en);
  enToPt.set(en, pt);
}
// Unaccented spellings (MEDIA, MAXIMO, NAO...) are accepted on input only, never shown.
for (const [en, pt] of FUNCTION_NAMES) {
  const plain = stripAccents(upper(pt));
  if (!ptToEn.has(plain) && !enToPt.has(plain)) ptToEn.set(plain, en);
}
const errorPtToEn = new Map(ERROR_NAMES.map(([en, pt]) => [upper(pt), en]));
const errorEnToPt = new Map(ERROR_NAMES.map(([en, pt]) => [en, pt]));
const errorLiterals = [...new Set(ERROR_NAMES.flat())].sort((a, b) => b.length - a.length);

export type TokenKind = 'string' | 'sheet' | 'bracket' | 'array' | 'error' | 'number' | 'name' | 'other';
export interface Token { kind: TokenKind; text: string; start: number }

const NAME_START = /[\p{L}_\\$]/u;
const NAME_PART = /[\p{L}\p{N}_.$\\]/u;

/** Lexes formula text without the leading '='. Unterminated literals run to the end. */
export function tokenize(formula: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (kind: TokenKind, start: number, end: number) => tokens.push({ kind, text: formula.slice(start, end), start });
  while (i < formula.length) {
    const start = i;
    const ch = formula[i];
    if (ch === '"' || ch === "'") {
      i++;
      while (i < formula.length) {
        if (formula[i] === ch) {
          if (formula[i + 1] === ch) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      push(ch === '"' ? 'string' : 'sheet', start, i);
    } else if (ch === '[' || ch === '{') {
      const close = ch === '[' ? ']' : '}';
      let depth = 0;
      while (i < formula.length) {
        const current = formula[i];
        if (current === '"') { // strings inside array constants may contain the closing bracket
          i++;
          while (i < formula.length) {
            if (formula[i] === '"') {
              if (formula[i + 1] === '"') { i += 2; continue; }
              i++;
              break;
            }
            i++;
          }
          continue;
        }
        i++;
        if (current === ch) depth++;
        else if (current === close && --depth === 0) break;
      }
      push(ch === '[' ? 'bracket' : 'array', start, i);
    } else if (ch === '#') {
      const rest = upper(formula.slice(i));
      const literal = errorLiterals.find(candidate => rest.startsWith(upper(candidate)));
      i += literal ? literal.length : 1;
      push(literal ? 'error' : 'other', start, i);
    } else if (/[0-9]/.test(ch) || (ch === '.' || ch === ',') && /[0-9]/.test(formula[i + 1] ?? '')) {
      i++;
      while (i < formula.length && /[0-9.,]/.test(formula[i])) {
        // A separator only belongs to the number when a digit follows (1,5 vs 1;5 vs A1,B1).
        if (/[.,]/.test(formula[i]) && !/[0-9]/.test(formula[i + 1] ?? '')) break;
        i++;
      }
      if (/[eE]/.test(formula[i] ?? '') && /[0-9+-]/.test(formula[i + 1] ?? '')) {
        i += 2;
        while (i < formula.length && /[0-9]/.test(formula[i])) i++;
      }
      // Row ranges such as 1:3 and names like 2026Vendas stay intact.
      while (i < formula.length && NAME_PART.test(formula[i])) i++;
      push('number', start, i);
    } else if (NAME_START.test(ch)) {
      i++;
      while (i < formula.length && NAME_PART.test(formula[i])) i++;
      push('name', start, i);
    } else {
      i++;
      push('other', start, i);
    }
  }
  return tokens;
}

function nextSignificant(tokens: Token[], index: number): string {
  for (let i = index + 1; i < tokens.length; i++) {
    if (tokens[i].kind !== 'other' || tokens[i].text.trim() !== '') return tokens[i].text;
  }
  return '';
}

function translate(formula: string, toEngine: boolean): string {
  const tokens = tokenize(formula);
  let out = '';
  tokens.forEach((token, index) => {
    if (token.kind === 'error') {
      const key = upper(token.text);
      out += toEngine ? errorPtToEn.get(key) ?? token.text : errorEnToPt.get(key) ?? token.text;
      return;
    }
    if (token.kind !== 'name') { out += token.text; return; }
    const next = nextSignificant(tokens, index);
    if (next === '!' || next === '[') { out += token.text; return; } // sheet prefix or table name
    const prefix = /^_xlfn\./i.test(token.text) ? token.text.slice(0, 6) : '';
    const bare = upper(token.text.slice(prefix.length));
    const isCall = next === '(';
    const isBoolean = !isCall && (toEngine ? ['VERDADEIRO', 'FALSO'] : ['TRUE', 'FALSE']).includes(bare);
    if (!isCall && !isBoolean) { out += token.text; return; }
    const mapped = toEngine ? ptToEn.get(bare) ?? ptToEn.get(stripAccents(bare)) : enToPt.get(bare);
    out += mapped ? prefix + mapped : token.text;
  });
  return out;
}

/** pt-BR user input (formula or literal) -> input accepted by the engine (locale es, language en). */
export function toEngineInput(input: string): string {
  if (input.startsWith('=') && input.length > 1) return '=' + translate(input.slice(1), true);
  const key = upper(input.trim());
  if (key === 'VERDADEIRO') return 'TRUE';
  if (key === 'FALSO') return 'FALSE';
  return input;
}

/** Engine cell content -> text shown in the pt-BR formula bar. */
export function toDisplayInput(content: string): string {
  if (content.startsWith('=') && content.length > 1) return '=' + translate(content.slice(1), false);
  return content;
}

/** Engine formatted value of an error or boolean cell -> pt-BR text. */
export function localizeValue(value: string, kind: 'boolean' | 'error'): string {
  if (kind === 'boolean') return value === 'TRUE' ? 'VERDADEIRO' : value === 'FALSE' ? 'FALSO' : value;
  return errorEnToPt.get(value) ?? value;
}

export function ptFunctionName(engineName: string): string | undefined {
  return enToPt.get(upper(engineName));
}
