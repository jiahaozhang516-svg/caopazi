# 草爬子（aihub-checkin）v2.0 技术说明

DSHM 端侧插件：两个独立任务 + 一个设置页 + 一枚完成度角标。

```
index.js          宿主：任务调度、工具、状态/配置 HTTP 接口
libseat.js        图书馆座位客户端（登录/座位表/下单/取消/选座策略）
lib/client.js     前端：角标（像素水晶）+ 设置页（草爬子）
package.json      dsh.client 声明（前端半入口）
install.sh        安装（含 patch 行、属主修正）
uninstall.sh      卸载
INSTALL.md        给使用者/助手的安装说明
```

## 任务一：AI Hub 签到

- 企业微信扫码 OAuth 拿会话 Cookie（`sid`），存在 `store.json`
- 每天 07:00 `POST /api/checkin`（先 `/api/me` 判断是否已签）
- 应用重启会补签当天

## 任务二：图书馆抢座

| 环节 | 接口 |
| --- | --- |
| 登录 | `POST /ic-web/login/user`，密码 `RSA(密码 + ";" + nonceStr)`（PKCS#1 v1.5） |
| 座位表 | `GET /ic-web/reserve?roomIds=<区域id>&resvDates=YYYYMMDD&sysKind=8` |
| 下单 | `POST /ic-web/reserve/seat`，`resvDevEncrypts=[AES-128-CBC(str(devId), key=随机串, iv="ABCDEF1234123412")]` |
| 取消 | `POST /ic-web/reserve/delete {uuid, resvId}` |

所有请求需带 `token`（登录返回）与 `lan: 1` 头；站点有反爬，请求需串行并留间隔。

选座策略（`pickSeat`）：优先列表 → 以首个目标为锚点的就近（网格距离）+ 尾数奇偶过滤 → 任意（可选）。

## 运行参数

- 抢座节拍 20 秒；开抢后 3 分钟内间隔 20 秒，之后 60 秒
- 公钥缓存 10 分钟、座位表缓存 45 秒（把重试成本压到 1 个请求）
- 每天最多 20 次尝试；业务性拒绝（时段冲突/参数错误）当天终止
- 签到节拍 60 秒；失败后 30 分钟再试

## 数据

`$DSH_HOME/aihub-checkin/store.json`：签到 Cookie、图书馆会话、两边的最近 40 条记录。
设置页读写走 `GET/POST /aihub-checkin/config`（仅本机回环）。
状态角标读 `GET /aihub-checkin/status`，返回 `tasks:{total,done,list}`。

## 风险与边界

- 应用被杀则不执行定时任务；签到会补，抢座不补。
- 图书馆预约成功后 31 分钟内未签到视为违约，座位释放。
- 前端半任何异常都被插槽错误边界与工厂 try/catch 吞掉，最坏是「不显示」，不影响签到。
