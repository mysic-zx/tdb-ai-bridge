import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePairUrl } from "../dist/config.js";
import { TdbClient } from "../dist/client/tdbClient.js";
import { formatDuration, formatTable, formatTimecode, maskToken } from "../dist/cli/format.js";

test("配对串解析：tdb:// 协议", () => {
  const pair = parsePairUrl("tdb://pair?host=192.168.1.23&port=8765&token=abc123");
  assert.deepEqual(pair, { host: "192.168.1.23:8765", token: "abc123" });
});

test("配对串解析：缺 port 用默认 8765，缺 token 报错", () => {
  const pair = parsePairUrl("tdb://pair?host=192.168.1.23&token=x");
  assert.equal(pair.host, "192.168.1.23:8765");

  assert.throws(() => parsePairUrl("tdb://pair?host=192.168.1.23"), /缺少 host 或 token/);
});

test("配对串解析：http(s) 形式", () => {
  const pair = parsePairUrl("http://192.168.1.5:9000/?token=tt");
  assert.deepEqual(pair, { host: "192.168.1.5:9000", token: "tt" });
});

test("配对串解析：格式错误报中文提示", () => {
  assert.throws(() => parsePairUrl("not-a-url"), /配对串格式不对/);
});

test("baseUrl 拼接：自动补 http 和 /api/ai 前缀", () => {
  const make = (host) =>
    new TdbClient({ host, token: "", timeout: 1000, pollInterval: 100 }).baseUrl;

  assert.equal(make("192.168.1.23:8765"), "http://192.168.1.23:8765/api/ai");
  assert.equal(make("http://192.168.1.23:8765/"), "http://192.168.1.23:8765/api/ai");
});

test("baseUrl：没配 host 时报 NO_HOST 而不是拼出垃圾 URL", () => {
  assert.throws(
    () => new TdbClient({ host: "", token: "", timeout: 1000, pollInterval: 100 }).baseUrl,
    /还没有配置设备地址/,
  );
});

test("表格对齐：中文按两格宽计算", () => {
  // JS 的 .length 是 code unit 数，中文一个字占 1 个 code unit 却显示 2 格，
  // 所以对齐断言要按显示宽度算，不能直接比 .length
  const width = (s) => [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);

  const table = formatTable(["名称", "时长"], [["英文.mp3", "1:00"], ["a.mp3", "2:00"]]);
  const lines = table.split("\n");
  // 分割线与两行数据的显示宽度一致，说明列宽按显示宽度补齐了
  assert.equal(width(lines[1]), width(lines[2]));
  assert.equal(width(lines[1]), width(lines[3]));
  // 两行数据的第二列起始显示位置相同（"英文.mp3" 显示宽 8）
  const secondColumn = (line, cell) => width(line.slice(0, line.indexOf(cell)));
  assert.equal(secondColumn(lines[2], "1:00"), 10);
  assert.equal(secondColumn(lines[3], "2:00"), 10);
});

test("时长格式化", () => {
  assert.equal(formatDuration(62), "01:02");
  assert.equal(formatDuration(3672), "1:01:12");
});

test("时间码格式化", () => {
  assert.equal(formatTimecode(0), "00:00.00");
  assert.equal(formatTimecode(75.4), "01:15.40");
});

test("token 脱敏", () => {
  assert.equal(maskToken("abcdefgh"), "abcd***gh");
  assert.equal(maskToken(""), "(未设置)");
});
