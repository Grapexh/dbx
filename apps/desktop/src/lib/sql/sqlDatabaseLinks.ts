import type { DatabaseType } from "@/types/database";
import { isDamengReservedKeyword, isOracleReservedKeyword } from "@/lib/sql/sqlIdentifier";
import { tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";

const ORACLE_OBJECT_PREFIX_KEYWORDS = new Set(["from", "join", "update", "into", "table", "delete"]);
const ORACLE_TABLE_LIST_BOUNDARIES = new Set(["select", "from", "where", "group", "having", "order", "connect", "start", "union", "intersect", "minus", "for", "returning", "set", "values"]);

// 仅服务 SQL 解析，不扩展 Oracle 元数据或 UI 能力。每批扫描一次并保留原始位置，
// 参数替换和 @set 展开共同保护对象链接，避免宽松前缀判断吞掉表达式或 DDL 参数。
export function collectSqlDatabaseLinkStarts(sql: string, databaseType?: DatabaseType): Set<number> {
  const links = new Set<number>();
  if ((databaseType !== "oracle" && databaseType !== "oceanbase-oracle" && databaseType !== "dameng") || !sql.includes("@")) return links;
  const isReservedKeyword = databaseType === "dameng" ? isDamengReservedKeyword : isOracleReservedKeyword;
  const tokens = tokenizeSqlSemantic(sql, "oracle")
    .filter((token) => token.kind !== "comment")
    .flatMap((token) => {
      const marker = token.kind === "word" ? token.text.indexOf("@") : -1;
      if (marker <= 0) return [token];
      // 紧邻 object@link 在语义 tokenizer 中是单个 word；拆分后也必须经过
      // 相同的对象上下文判定，不能把 CONTENT@value 等表达式误当链接。
      return [
        { ...token, text: token.text.slice(0, marker), normalized: token.normalized.slice(0, marker), span: { ...token.span, end: token.span.start + marker } },
        { ...token, text: token.text.slice(marker), normalized: token.normalized.slice(marker), span: { ...token.span, start: token.span.start + marker } },
      ];
    });
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.kind !== "word" || !token.text.startsWith("@")) continue;
    const isObjectIdentifier = (position: number) => {
      const candidate = tokens[position];
      return candidate && ((candidate.kind === "quoted_identifier" && candidate.quote === '"') || (candidate.kind === "word" && /^[\p{L}_][\p{L}\p{N}_$#]*$/u.test(candidate.text) && !isReservedKeyword(candidate.text)));
    };
    if (!isObjectIdentifier(i - 1)) continue;
    let objectStart = i - 1;
    while (tokens[objectStart - 1]?.text === "." && isObjectIdentifier(objectStart - 2)) objectStart -= 2;
    const prefix = tokens[objectStart - 1]?.normalized ?? "";
    // 只识别表对象上下文或远程调用；CONTENT、BODY、LINK 等表达式/DDL
    // 关键字及带引号的普通表达式后仍允许使用真实模板参数。
    const object = tokens[i - 1];
    // DM8 的保留字表未列 THEN，但 THEN @fn(...) 是模板表达式；只排除
    // 未限定的裸关键字，仍允许 "THEN" 对象及 HR.then@link(...) 远程调用。
    const damengThenExpression = databaseType === "dameng" && objectStart === i - 1 && object.kind === "word" && object.normalized === "then";
    let sqlXmlExpression = false;
    if (objectStart === i - 1 && object.kind === "word" && ["content", "document", "passing"].includes(object.normalized)) {
      // 只检查最近一层 SQL/XML 函数中的语法位置，不能把同名真实远程函数
      // 当关键字；例如 CONTENT content@link(...) 中第二个 content 是对象。
      for (let j = objectStart - 1; j >= 0; j -= 1) {
        const before = tokens[j];
        if (before.text === ";" || before.depth < object.depth - 1) break;
        if (before.text !== "(" || before.depth !== object.depth - 1) continue;
        const enclosingFunction = tokens[j - 1];
        if (enclosingFunction?.kind === "word" && tokens[j - 2]?.text !== ".") {
          if (enclosingFunction.normalized === "xmlserialize") {
            sqlXmlExpression = objectStart === j + 1 && (object.normalized === "content" || object.normalized === "document");
          } else if (enclosingFunction.normalized === "xmlquery" && object.normalized === "passing" && objectStart > j + 1) {
            // PASSING 前必须有 XQuery 表达式，且同层只能把首个 PASSING 当子句。
            sqlXmlExpression = !tokens.slice(j + 1, objectStart).some((item) => item.depth === object.depth && item.kind === "word" && item.normalized === "passing");
          }
        }
        break;
      }
    }
    const routineCall = !damengThenExpression && !sqlXmlExpression && tokens[i + 1]?.text === "(" && (object.kind === "quoted_identifier" || !isReservedKeyword(object.text));
    let objectContext = (ORACLE_OBJECT_PREFIX_KEYWORDS.has(prefix) && !(prefix === "update" && tokens[objectStart - 2]?.normalized === "for")) || routineCall;
    // A comma can separate tables or expressions. Only a FROM list makes the
    // following non-reserved keyword an object name, including after subqueries.
    if (prefix === ",") {
      for (let j = objectStart - 2; j >= 0; j -= 1) {
        const before = tokens[j];
        if (before.depth < token.depth || before.text === ";") break;
        if (before.depth === token.depth && before.kind === "word" && ORACLE_TABLE_LIST_BOUNDARIES.has(before.normalized)) {
          objectContext = before.normalized === "from" || routineCall;
          break;
        }
      }
    }
    if (objectContext) links.add(token.span.start);
  }
  return links;
}
