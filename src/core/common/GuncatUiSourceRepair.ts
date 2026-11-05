// guncat-ui lang 源码修复: 模型输出的「代码标点」与字符串引号容错。
//
// 为什么需要这一层:
//   guncat-ui lang 的词法器按 ASCII 语法分词。模型偶发会把字符串里的双引号
//   原样写出来(不转义), 例如:
//     CardHeader("销售复盘", "2024 Q3 "实际" 数据 · 来自 sales.csv")
//   词法器会在「实际」前面的引号处提前结束字符串, 后面的中文因为不在字符串里,
//   会被当成未知字符直接跳过 —— 用户看到的就是「副标题只显示前半截」。
//   同类问题还有全角引号 / 全角逗号 / 全角括号 / 反引号包字符串 / 缺逗号:
//   它们要么让参数错位(甚至把后面的组件吞掉), 要么让整块程序不被识别。
//
// 这一层只做「把模型想写但写歪了的源代码修回合法形态」, 不改写字符串正文:
//   · 字符串内部: 只把未转义的内部引号补上反斜杠(按成对引号判断), 正文原样保留;
//   · 字符串外部: 全角标点归一成 ASCII, 反引号/弯引号当作字符串定界符;
//   · 结构字符(括号/逗号/分号)归一后, 后续 AutoClose / Lexer 就能按正常语法工作。
//
// 性能: 单趟字符扫描, 只替换异常字符; 正常源码走无替换快速路径直接返回原串,
//       不产生中间副本。字符串拼接用「连续片段 + 替换点」的方式, 避免逐字符建串。
export class GuncatUiSourceRepair {
  // 字符串结束后允许出现的结构字符(ASCII)。引号本身也算: 相邻字符串缺逗号时,
  // 前一个引号仍应正常收口, 而不是把后一个字符串吞进来。
  private static readonly BOUNDARY: string = ',)]}+-*/%<>=!&|?:.[#;"\'';
  // 全角/中文的结构字符: 判断「这个引号是不是收口」时要一起看,
  // 否则 `"文本"，下一项` 这类写法会被误判成字符串还没结束。
  private static readonly BOUNDARY_FULL: string = '）］｝，、：；＝＋－＊／％＜＞！？＆｜．」』”’';
  // 结构归一后长度必须保持不变(1 个字符换 1 个字符), 供「先探测、再按原偏移切分」的
  // looksLikeProgram / firstStatementLine 共用。
  private static readonly SUSPECT: RegExp = /[\u3000\u3001\u2018-\u201D\u300C-\u300F\uFF01-\uFF5E`]/;

  /** 源码里是否有需要「结构归一」的全角/弯引号字符(不检查字符串内部的未转义引号) */
  static hasStructuralSuspect(source: string): boolean {
    return GuncatUiSourceRepair.SUSPECT.test(source);
  }

  /**
   * 只做结构字符归一, 长度逐字符保持不变。
   * 用于「先判断这段文本像不像界面程序」—— 判断阶段不能改变原文偏移,
   * 所以这里不补字符串转义(补转义会插入字符、让后续切分偏移错位)。
   */
  static normalizeStructure(source: string): string {
    if (source === '' || !GuncatUiSourceRepair.hasStructuralSuspect(source)) {
      return source;
    }
    // 只收集真正发生替换的位置, 未变化的片段整段拷贝 —— 200KB 程序也不会逐字符建串。
    let out: string[] = [];
    let runStart: number = 0;
    for (let i: number = 0; i < source.length; i++) {
      let c: string = source.charAt(i);
      let mapped: string = GuncatUiSourceRepair.structuralChar(c);
      if (mapped !== c) {
        if (i > runStart) {
          out.push(source.substring(runStart, i));
        }
        out.push(mapped);
        runStart = i + 1;
      }
    }
    if (out.length === 0) {
      return source;
    }
    if (runStart < source.length) {
      out.push(source.substring(runStart));
    }
    return out.join('');
  }

  /**
   * 完整修复: 结构字符归一 + 字符串内部未转义引号补转义 + 弯引号/反引号定界符归一。
   * 返回的源码可直接交给 UiAutoClose / UiLexer。
   */
  static repair(source: string): string {
    if (source === '' || source === null || source === undefined) {
      return source;
    }
    // 快速路径: 没有引号、也没有任何可疑标点时, 不可能需要修
    if (source.indexOf('"') < 0 && source.indexOf('\'') < 0 &&
      !GuncatUiSourceRepair.hasStructuralSuspect(source)) {
      return source;
    }

    let n: number = source.length;
    let out: string[] = [];
    let runStart: number = 0;
    let changed: boolean = false;
    let quote: string = '';
    let closers: string = '';
    let internalOpen: boolean = false;
    let depth: number = 0;

    let pushReplacement = (start: number, end: number, text: string): void => {
      if (start > runStart) {
        out.push(source.substring(runStart, start));
      }
      out.push(text);
      runStart = end;
      changed = true;
    };

    let i: number = 0;
    while (i < n) {
      let c: string = source.charAt(i);

      if (quote === '') {
        // 注释行原样跳过: 注释里的撇号 / 引号不能被当成字符串定界符,
        // 否则一个英文缩写(It's)就能把后面几行程序全吞进字符串里。
        if (c === '/' && i + 1 < n && source.charAt(i + 1) === '/') {
          let nl: number = source.indexOf('\n', i);
          if (nl < 0) {
            break;
          }
          i = nl;
          continue;
        }
        if (c === '#') {
          let nl2: number = source.indexOf('\n', i);
          if (nl2 < 0) {
            break;
          }
          i = nl2;
          continue;
        }
        // 1) 弯引号 / 书名号 / 反引号: 当作字符串定界符
        let opened: string[] | null = GuncatUiSourceRepair.smartOpen(c);
        if (opened !== null && GuncatUiSourceRepair.canOpenString(source, i)) {
          pushReplacement(i, i + 1, opened[0]);
          quote = opened[0];
          closers = opened[1];
          internalOpen = false;
          i++;
          continue;
        }
        // 2) ASCII 引号: 只有出现在「值的位置」才当字符串起点。
        //    散文里的 `他说"你好"` 不会因为一个引号把后面的程序整段吞掉。
        if ((c === '"' || c === '\'') && GuncatUiSourceRepair.canOpenString(source, i)) {
          quote = c;
          closers = c;
          internalOpen = false;
          i++;
          continue;
        }
        // 3) 全角标点: 逐字符映射成 ASCII(长度不变)
        let code: number = source.charCodeAt(i);
        if (code >= 0xFF01 && code <= 0xFF5E) {
          let ascii: string = String.fromCharCode(code - 0xFEE0);
          if (ascii === '#') {
            let nl3: number = source.indexOf('\n', i);
            if (nl3 < 0) {
              break;
            }
            i = nl3;
            continue;
          }
          if (ascii === ';') {
            ascii = depth > 0 ? ',' : '\n';
          }
          if (ascii === '"' || ascii === '\'' || ascii === '`') {
            if (!GuncatUiSourceRepair.canOpenString(source, i)) {
              i++;
              continue;
            }
            let delimiter: string = ascii === '`' ? '"' : ascii;
            pushReplacement(i, i + 1, delimiter);
            quote = delimiter;
            // 记住原来的全角定界符: 模型用 ＂标题＂ / ＇正文＇ 时, 收口也得认全角
            closers = delimiter + c;
            internalOpen = false;
            i++;
            continue;
          }
          pushReplacement(i, i + 1, ascii);
          depth = GuncatUiSourceRepair.nextDepth(ascii, depth);
          i++;
          continue;
        }
        // 4) 中文顿号 / 全角空格 / 半角分号
        if (c === '、') {
          pushReplacement(i, i + 1, ',');
          i++;
          continue;
        }
        if (c === '\u3000') {
          pushReplacement(i, i + 1, ' ');
          i++;
          continue;
        }
        if (c === ';') {
          // 括号内当参数分隔, 括号外当语句分隔 —— 模型偶尔用分号断句
          pushReplacement(i, i + 1, depth > 0 ? ',' : '\n');
          i++;
          continue;
        }
        depth = GuncatUiSourceRepair.nextDepth(c, depth);
        i++;
        continue;
      }

      // ===== 字符串内部 =====
      if (c === '\\') {
        // 已有的转义序列原样保留(包括流式半截的末尾反斜杠)
        i += i + 1 < n ? 2 : 1;
        continue;
      }
      if (closers.indexOf(c) >= 0) {
        // 英文所有格: 'It's' / 'students' work' —— 不能当成字符串收口
        if (quote === '\'' && GuncatUiSourceRepair.isApostrophe(source, i)) {
          pushReplacement(i, i + 1, '\\\'');
          i++;
          continue;
        }
        // 英寸/英尺记号或词中间的引号: 5"3" / 3" 的管道 / A"B。前一个字符是
        // ASCII 字母数字、后面又接着正文时, 它是正文里的字面记号, 不参与内部引号配对。
        if (!internalOpen && GuncatUiSourceRepair.isWordMark(source, i)) {
          pushReplacement(i, i + 1, '\\' + quote);
          i++;
          continue;
        }
        // 成对内部引号的后半个: 它是正文, 补转义但不改变配对状态
        if (internalOpen) {
          pushReplacement(i, i + 1, '\\' + quote);
          internalOpen = false;
          i++;
          continue;
        }
        // 后面跟结构字符 -> 字符串真的收口; 后面跟正文 -> 这是正文里的内部引号
        if (GuncatUiSourceRepair.isStringEnd(source, i + 1)) {
          if (c !== quote) {
            pushReplacement(i, i + 1, quote);
          }
          quote = '';
          closers = '';
          i++;
          continue;
        }
        pushReplacement(i, i + 1, '\\' + quote);
        // 单引号/落单引号: 本行后面没有第二根引号与它配对时, 它只是正文里的
        // 字面记号(引号没成对), 不能把后面真正的收口当成它的下半截。
        if (GuncatUiSourceRepair.hasPairAhead(source, i + 1, quote, closers)) {
          internalOpen = true;
        }
        i++;
        continue;
      }
      i++;
    }

    if (!changed) {
      return source;
    }
    if (runStart < n) {
      out.push(source.substring(runStart, n));
    }
    return out.join('');
  }

  // 弯引号 / 书名号 / 反引号 -> [输出的定界符, 可接受的收口字符]
  private static smartOpen(c: string): string[] | null {
    if (c === '\u201C' || c === '\u201D') {
      return ['"', '"' + '\u201D'];
    }
    if (c === '\u2018' || c === '\u2019') {
      return ['\'', '\'' + '\u2019'];
    }
    if (c === '\u300C' || c === '\u300D') {
      return ['"', '"' + '\u300D'];
    }
    if (c === '\u300E' || c === '\u300F') {
      return ['"', '"' + '\u300F'];
    }
    if (c === '`') {
      return ['"', '`\uFF40'];
    }
    return null;
  }

  private static structuralChar(c: string): string {
    if (c === '\u201C' || c === '\u201D' || c === '\u300C' || c === '\u300D' ||
      c === '\u300E' || c === '\u300F' || c === '`') {
      return '"';
    }
    if (c === '\u2018' || c === '\u2019') {
      return '\'';
    }
    if (c === '\u3001') {
      return ',';
    }
    if (c === '\u3000') {
      return ' ';
    }
    let code: number = c.charCodeAt(0);
    if (code >= 0xFF01 && code <= 0xFF5E) {
      return String.fromCharCode(code - 0xFEE0);
    }
    return c;
  }

  // 引号是否出现在「值的位置」。合法程序里字符串前面一定是空白 / 开括号 / 逗号 /
  // 冒号 / 运算符 / 等号 / 另一个引号; 前缀是字母或汉字时, 那多半是散文里的引号,
  // 不能让它开启一个跨行的字符串把程序吞掉。
  private static canOpenString(source: string, i: number): boolean {
    if (i <= 0) {
      return true;
    }
    let prev: string = source.charAt(i - 1);
    if (prev === ' ' || prev === '\t' || prev === '\n' || prev === '\r') {
      return true;
    }
    if ('([{,:=+\\-*/%<>!&|?;'.indexOf(prev) >= 0) {
      return true;
    }
    if ('"\'`'.indexOf(prev) >= 0) {
      return true;
    }
    // 全角版本(源码里还没被替换; 全角开括号/逗号/冒号/等号等)
    if ('（［｛，、：；＝＋－＊／％＜＞！？＆｜'.indexOf(prev) >= 0) {
      return true;
    }
    return false;
  }

  private static nextDepth(c: string, depth: number): number {
    if (c === '(' || c === '[' || c === '{') {
      return depth + 1;
    }
    if (c === ')' || c === ']' || c === '}') {
      return depth > 0 ? depth - 1 : 0;
    }
    return depth;
  }

  // 引号后面的第一个非空白字符是否是「结构边界」。
  // 是 -> 这个引号是字符串收口; 否 -> 它更像是正文里引用别人说的话, 要留在字符串里。
  private static isStringEnd(source: string, from: number): boolean {
    let j: number = from;
    while (j < source.length) {
      let c: string = source.charAt(j);
      if (c === ' ' || c === '\t') {
        j++;
        continue;
      }
      if (c === '\n' || c === '\r') {
        return true;
      }
      return GuncatUiSourceRepair.BOUNDARY.indexOf(c) >= 0 ||
        GuncatUiSourceRepair.BOUNDARY_FULL.indexOf(c) >= 0;
    }
    return true;
  }

  // 单引号字符串里的英文所有格(It's / students' work)。
  // 只有「前一个字符是 ASCII 字母数字, 后一个字符也是」时才认定为所有格,
  // 避免把 '中文' 这种正常单引号字符串误当成正文。
  private static isApostrophe(source: string, i: number): boolean {
    if (i <= 0 || i + 1 >= source.length) {
      return false;
    }
    let prev: string = source.charAt(i - 1);
    let next: string = source.charAt(i + 1);
    if (!GuncatUiSourceRepair.isAsciiWord(prev) || !GuncatUiSourceRepair.isAsciiWord(next)) {
      return false;
    }
    return true;
  }

  // 从 from 往后看「本行」还有没有能与当前引号配对的第二根引号。
  // 引号总数(含本行末尾那个真正的收口)为偶数时, 当前这根才像成对引文的上半截;
  // 为奇数时它只是落单的字面引号, 不能把后面真正的收口吞掉。
  // 只看到行尾: 界面程序按行书写, 字符串跨行的写法极少; 这样也不会把下一行的参数引号算进来。
  private static hasPairAhead(source: string, from: number, quote: string, closers: string): boolean {
    let count: number = 0;
    // 扫描预算 4KB: 正常语句远小于这个长度; 万一模型写出一条几十万字符、几千根引号的
    // 畸形长行, 也不会把「每个引号都往后扫一遍」拖成 O(n²) 卡住渲染。
    let limit: number = Math.min(source.length, from + 4096);
    for (let j: number = from; j < limit; j++) {
      let c: string = source.charAt(j);
      if (c === '\n' || c === '\r') {
        break;
      }
      if (c === '\\') {
        j++;
        continue;
      }
      if (closers.indexOf(c) >= 0) {
        if (quote === '\'' && GuncatUiSourceRepair.isApostrophe(source, j)) {
          continue;
        }
        count++;
      }
    }
    return count % 2 === 0;
  }

  // 引号前一个字符是 ASCII 字母数字、后面又接着正文(不是逗号/括号/换行):
  // 这是正文里的字面记号(英寸/英尺/词中引号), 不参与内部引号配对。
  // 与 isApostrophe 的区别是它对双引号也生效, 且不要求后一个字符也是字母数字。
  private static isWordMark(source: string, i: number): boolean {
    if (i <= 0) {
      return false;
    }
    if (!GuncatUiSourceRepair.isAsciiWord(source.charAt(i - 1))) {
      return false;
    }
    return !GuncatUiSourceRepair.isStringEnd(source, i + 1);
  }

  private static isAsciiWord(c: string): boolean {
    let code: number = c.charCodeAt(0);
    return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  }
}
